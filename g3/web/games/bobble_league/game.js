/* Bobble League: the client.  Registers with the lobby (G3.registerGame) and is mounted when the host starts the game.
 *
 * A top-down tactics game.  Every team is six bobbles, shared out evenly between its players (1 v 1: six each, 2 v 2: three
 * each, ...).  Each round BOTH teams plan at the same time: drag a bobble back (like a slingshot or a carrom striker) to set
 * which way and how hard it will be flicked, do that for as many of your bobbles as you like, then LOCK IN.  When everybody
 * has locked in (or the time is up) every flick happens at once and the bobbles slide, collide and rebound until all has
 * stopped; then the next round of planning starts.  Your plans are private: nobody else is ever sent them.
 *
 *   host   runs the simulation (sim.js) and streams snapshots through the room's game channel;
 *   guests send their plans to the host ({k:'plan', i, ax, ay, _h:true}, {k:'ready', v, _h:true}) and draw interpolated snapshots.
 *
 * Every match opens on the game menu: the host picks the gameplay style (MODES below), then each team's captain picks the
 * team name and mascot; the match starts when both captains are ready.  The game always fills the window and asks for real
 * fullscreen as soon as the browser allows it.
 */
(function () {
  'use strict';
  const Sim = window.BobbleSim, C = Sim.C;

  // The view is the pitch plus a margin for the nets (sides), the scoreboard (top) and the banner (bottom).
  const MX = C.NET + 40, TM = 78, BM = 74;
  const VW = C.W + 2 * MX, VH = TM + C.H + BM;
  const MAXPULL = 170, MINPULL = 14;                              // drag length (pitch px) for full power / to count as a plan

  const TEAM = [
    { name: 'CYAN', main: '#27d3f2', dark: '#0a7a96', light: '#b5f6ff', rgb: '39,211,242' },
    { name: 'MAGENTA', main: '#f046d8', dark: '#97198a', light: '#ffc0f5', rgb: '240,70,216' },
  ];
  // The team mascots on offer (the sim only stores the index, so this list may grow up to C.MASCOTS).
  const MASCOTS = [['🦊', 'FOX'], ['🐻', 'BEAR'], ['🐸', 'FROG'], ['🦁', 'LION'], ['🐙', 'OCTOPUS'], ['🐼', 'PANDA'],
                   ['🐯', 'TIGER'], ['🦉', 'OWL'], ['🐲', 'DRAGON'], ['🦈', 'SHARK'], ['🦄', 'UNICORN'], ['🐧', 'PENGUIN']];
  const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  // Gameplay styles offered on the menu.  Add one here and it shows up as a card; `id` is sent to the guests with the start.
  const MODES = [
    { id: 'classic', name: 'CLASSIC', blurb: 'Top-down tactics. Six bobbles a team, shared between the players. Everyone plans a flick for each bobble at the same time, locks in, and they all fly at once. First to 3 wins.' },
  ];
  const RATE = { lan: 30, relay: 20, online: 15, lora: 4 };     // snapshots per second while things move, at most
  const IDLE_RATE = 5;                                            // ...and while everyone is planning
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function mount(ctx) {
    const room0 = ctx.room();
    const isHost = !!(room0 && room0.host);
    const root = ctx.root;

    // The game fills the whole window, always.  The wrapper lives on <body>, not in the lobby panel, so no themed
    // ancestor (CRT filter, flicker) can pin it inside a smaller box.
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'bl bl-full';
    wrap.id = 'blWrap';
    wrap.innerHTML = `
      <div class="bl-top">
        <span>&gt; BOBBLE_LEAGUE.EXE // <span class="text-[#ffd43b]" id="blMode">MODE SELECT</span> // <span class="text-[#00eefc]" id="blRole">${isHost ? 'HOSTING THE MATCH' : 'GUEST'}</span></span>
        <span id="blHint">DRAG A BOBBLE BACK TO PLAN ITS FLICK // SPACE: LOCK IN // F: FULLSCREEN</span>
      </div>
      <div class="bl-stage">
        <canvas id="blCanvas"></canvas>
        <div class="bl-over bl-menu" id="blMenu"></div>
        <div class="bl-over hidden" id="blOver"></div>
      </div>
      <div class="bl-bar">
        <button data-bl="ready" id="blReady" class="bl-lock" style="display:none"></button>
        <button data-bl="fs">[ FULLSCREEN ]</button>
        ${isHost ? '<button data-bl="lobby">[ BACK TO LOBBY ]</button>' : ''}
        <button data-bl="leave" class="bl-danger">${isHost ? '[ CLOSE ROOM ]' : '[ LEAVE ROOM ]'}</button>
      </div>`;
    document.body.appendChild(wrap);
    document.documentElement.classList.add('bl-open');
    const canvas = wrap.querySelector('#blCanvas'), over = wrap.querySelector('#blOver'), menu = wrap.querySelector('#blMenu');
    const readyBtn = wrap.querySelector('#blReady');
    const g = canvas.getContext('2d');
    try { document.fonts.load('16px "Press Start 2P"'); } catch (e) { /* cosmetic */ }

    const slotOf = (id) => { const r = ctx.room(); return r && r.slots.find((q) => q.id === id); };
    const you = () => { const r = ctx.room(); return r ? r.you : 0; };
    const mascotOf = (m) => (MASCOTS[m] || MASCOTS[0])[0];

    // ------------------------------------------------------------------ simulation (host) / snapshots (guest)
    let sim = null, acc = 0, lastTick = performance.now(), sinceSnap = 0, outEv = [], forceSnap = false;
    let ticker = null, timer = null;

    // guest side
    const snaps = [];
    let base = null, ivl = 50, lastTk = -1, latest = null;

    // ------------------------------------------------------------------ the menu: mode, then team names and mascots
    let stage = 'menu', modeId = null, selMode = 0;               // 'menu' -> 'teams' -> 'play'
    const T = { names: [TEAM[0].name, TEAM[1].name], mascots: [0, 1], ready: [false, false] };      // what the team setup screen shows
    const modeName = () => { const m = MODES.find((q) => q.id === modeId); return m ? m.name : 'MODE SELECT'; };
    const setModeLabel = () => { const el = wrap.querySelector('#blMode'); if (el) el.textContent = modeName(); };

    // the captain of a team (its first player) picks its name and mascot; alone in the room you are everybody's captain
    function captainOf(side) {
      const r = ctx.room();
      if (!r) return -1;
      if (r.slots.length < 2) return r.you;
      const list = r.slots.filter((s, i) => i % 2 === side);
      return list.length ? list[0].id : -1;
    }
    const canEdit = (side) => captainOf(side) === you();
    const playersOf = (side) => { const r = ctx.room(); return r ? (r.slots.length < 2 ? r.slots : r.slots.filter((s, i) => i % 2 === side)) : []; };

    function renderStage() { if (stage === 'menu') renderMenu(); else if (stage === 'teams') renderSetup(false); }

    function renderMenu() {
      menu.classList.remove('hidden', 'teams');
      if (!isHost) {
        menu.innerHTML = `<h2 class="bl-title">BOBBLE LEAGUE</h2>
          <div class="bl-sub">THE HOST IS CHOOSING THE GAMEPLAY STYLE<span class="cursor-blink">_</span></div>`;
        return;
      }
      menu.innerHTML = `<h2 class="bl-title">BOBBLE LEAGUE</h2>
        <div class="bl-sub">SELECT YOUR GAMEPLAY STYLE</div>
        <div class="bl-modes">${MODES.map((m, i) => `<button class="bl-mode ${i === selMode ? 'sel' : ''}" data-bl="mode" data-i="${i}"><b>${m.name}</b><span>${m.blurb}</span></button>`).join('')}
          <div class="bl-mode soon"><b>MORE MODES</b><span>COMING SOON</span></div></div>
        <div class="bl-sub">CLICK OR PRESS ENTER TO CONTINUE // THE GAME OPENS FULL SCREEN</div>`;
    }

    function panelHTML(s) {
      const can = canEdit(s), cap = slotOf(captainOf(s));
      const who = playersOf(s).map((p) => '@' + esc(p.n)).join(' ');
      return `<div class="bl-team t${s}">
        <div class="bl-team-head"><span class="bl-team-em" data-em="${s}">${mascotOf(T.mascots[s])}</span><b>TEAM ${s + 1}</b><span class="bl-sub">${who || '-'}</span></div>
        <label class="bl-field">TEAM NAME<input class="bl-name" data-side="${s}" maxlength="${C.NAME_MAX}" spellcheck="false" autocomplete="off" value="${esc(T.names[s])}" ${can ? '' : 'disabled'}></label>
        <div class="bl-field">TEAM MASCOT</div>
        <div class="bl-mascots">${MASCOTS.map((m, i) => `<button data-bl="mascot" data-side="${s}" data-i="${i}" title="${m[1]}" class="${T.mascots[s] === i ? 'sel' : ''}" ${can ? '' : 'disabled'}>${m[0]}</button>`).join('')}</div>
        <button class="bl-ready ${T.ready[s] ? 'on' : ''}" data-bl="teamready" data-side="${s}" ${can ? '' : 'disabled'}>${T.ready[s] ? '[ ✔ READY ]' : '[ READY ]'}</button>
        <div class="bl-sub" data-note="${s}">${can ? 'you are the captain' : `waiting for captain @${esc(cap ? cap.n : '?')}`}</div>
      </div>`;
    }

    function renderSetup(force) {
      if (stage !== 'teams') return;
      menu.classList.remove('hidden'); menu.classList.add('teams');
      const typing = !force && menu.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      if (typing) { patchSetup(); return; }                       // keep the cursor where it is
      menu.innerHTML = `<h2 class="bl-title small">${esc(modeName())}: PICK YOUR TEAMS</h2>
        <div class="bl-teams">${panelHTML(0)}${panelHTML(1)}</div>
        <div class="bl-sub">THE MATCH STARTS WHEN BOTH CAPTAINS ARE READY${isHost ? '' : ''}</div>
        ${isHost ? '<div class="bl-row"><button data-bl="back">[ &lt; BACK TO MODES ]</button></div>' : ''}`;
    }
    function patchSetup() {
      for (const s of [0, 1]) {
        menu.querySelectorAll(`[data-bl="mascot"][data-side="${s}"]`).forEach((b) => b.classList.toggle('sel', +b.dataset.i === T.mascots[s]));
        const em = menu.querySelector(`[data-em="${s}"]`); if (em) em.textContent = mascotOf(T.mascots[s]);
        const rb = menu.querySelector(`[data-bl="teamready"][data-side="${s}"]`);
        if (rb) { rb.classList.toggle('on', T.ready[s]); rb.textContent = T.ready[s] ? '[ ✔ READY ]' : '[ READY ]'; }
        const inp = menu.querySelector(`.bl-name[data-side="${s}"]`);
        if (inp && document.activeElement !== inp && inp.value !== T.names[s]) inp.value = T.names[s];
      }
    }

    // host: the mode was picked, now the teams
    function chooseMode(i) {
      const m = MODES[i];
      if (!isHost || !m || stage !== 'menu') return;
      modeId = m.id; selMode = i; stage = 'teams';
      T.ready = [false, false];
      for (const s of [0, 1]) { T.names[s] = sim.teams[s].name; T.mascots[s] = sim.teams[s].mascot; }
      setModeLabel(); broadcastSetup(); renderSetup(true);
      goFullscreen();
      G3.beep(660, 0.1, 'square');
    }
    function broadcastSetup() { ctx.send({ k: 'setup', mode: modeId, names: T.names.slice(), mascots: T.mascots.slice(), ready: T.ready.slice() }); }

    // host: a captain changed their team (or pressed READY)
    function applyTeam(from, d) {
      if (!isHost || stage !== 'teams' || !d || typeof d !== 'object') return;
      const s = d.side === 1 ? 1 : 0;
      if (captainOf(s) !== from) return;
      if (typeof d.name === 'string' || d.mascot !== undefined) {
        Sim.setTeam(sim, s, typeof d.name === 'string' ? d.name : undefined, d.mascot);
        T.names[s] = sim.teams[s].name; T.mascots[s] = sim.teams[s].mascot;
        T.ready[s] = false;                                       // changing anything un-readies
      }
      if (typeof d.ready === 'boolean') T.ready[s] = d.ready;
      broadcastSetup();
      renderSetup(false);
      if (T.ready[0] && T.ready[1]) beginMatch();
    }
    // a captain's edit: tell the host (or be the host)
    function sendTeam(side, fields) {
      if (!canEdit(side)) return;
      if (isHost) applyTeam(you(), Object.assign({ side }, fields));
      else {
        if (fields.mascot !== undefined) T.mascots[side] = fields.mascot;
        if (fields.name !== undefined) T.names[side] = String(fields.name).toUpperCase();
        if (fields.mascot !== undefined || fields.name !== undefined) T.ready[side] = false;
        if (fields.ready !== undefined) T.ready[side] = fields.ready;
        patchSetup();
        ctx.send(Object.assign({ k: 'team', side }, fields), true);
      }
    }
    let nameTimer = null;
    menu.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.classList || !el.classList.contains('bl-name')) return;
      el.value = el.value.toUpperCase();
      const side = +el.dataset.side;
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => sendTeam(side, { name: el.value }), 150);
    });

    function beginMatch() {                                        // host: both captains are ready
      stage = 'play'; plans = {}; lastRound = -1;
      menu.classList.add('hidden'); over.classList.add('hidden'); shownOver = false;
      Sim.restart(sim); acc = 0; lastTick = performance.now(); sinceSnap = 1e9; forceSnap = true;
      ctx.send({ k: 'begin', mode: modeId, names: T.names.slice(), mascots: T.mascots.slice() });
      goFullscreen();
      G3.beep(880, 0.12, 'square');
    }

    function showMenu() {                                         // host: back to the modes (also from a finished match)
      if (!isHost) return;
      stage = 'menu'; modeId = null; drag = null; plans = {};
      over.classList.add('hidden'); shownOver = false;
      setModeLabel(); renderMenu();
      ctx.send({ k: 'menu' });
    }

    if (isHost) {
      sim = Sim.create({ players: room0.slots.map((s, i) => ({ id: s.id, side: i % 2 })) });
      try {
        // a worker's timer isn't throttled when the window is covered, so the match keeps running for everyone
        const url = URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},8)'], { type: 'text/javascript' }));
        ticker = new Worker(url);
        ticker.onmessage = hostTick;
        URL.revokeObjectURL(url);
      } catch (e) { timer = setInterval(hostTick, 8); }
    }

    function snapInterval() {
      const r = ctx.room();
      if (sim && (sim.phase === 'plan' || sim.phase === 'over')) return 1000 / IDLE_RATE;     // nothing moves: a slow trickle keeps the timer honest
      const guests = Math.max(1, (r ? r.slots.length : 2) - 1);
      let rate = RATE[r && r.transport] || 15;
      if (r && r.transport === 'online') rate = clamp(40 / guests, 4, rate);      // every guest is its own publish to every broker
      else if (r && r.transport === 'relay') rate = clamp(80 / guests, 6, rate);
      return 1000 / rate;
    }

    const LOUD = new Set(['exec', 'goal', 'plan', 'end', 'go', 'pass', 'ot', 'kick-off', 'c']);       // worth a snapshot right now
    function hostTick() {
      if (!sim || stage !== 'play') return;
      const now = performance.now();
      acc += Math.min(0.25, (now - lastTick) / 1000);
      sinceSnap += now - lastTick;
      lastTick = now;
      let n = 0;
      while (acc >= C.STEP && n < 8) {
        Sim.step(sim); acc -= C.STEP; n++;
        for (const e of Sim.takeEvents(sim)) {
          fx(e, { ball: sim.ball, owners: sim.owner });
          if (outEv.length < 14) outEv.push(e);
          if (LOUD.has(e[0])) forceSnap = true;
        }
      }
      if (n === 8) acc = 0;
      if (forceSnap || sinceSnap >= snapInterval()) {
        sinceSnap = 0; forceSnap = false;
        ctx.send(Sim.snapshot(sim, outEv));
        outEv = [];
      }
    }

    function onSnapshot(d) {
      if (d.tk <= lastTk) return;                                 // late or duplicate
      const now = performance.now(), hostMs = d.tk * 1000 / 60;
      const v = Sim.parseSnapshot(d);
      if (snaps.length) {
        const dh = hostMs - snaps[snaps.length - 1].h;
        if (dh < 150) ivl = ivl * 0.8 + clamp(dh, 8, 150) * 0.2;  // only the moving-phase rate says how far behind to draw
      }
      const off = now - hostMs;
      base = base === null ? off : Math.min(base + 0.3, off);      // best-case latency; creeps up so it can recover from a slow patch
      lastTk = d.tk;
      snaps.push({ h: hostMs, v });
      while (snaps.length > 60 || (snaps.length > 2 && snaps[0].h < hostMs - 3000)) snaps.shift();
      latest = v;
      for (const e of v.ev) fx(e, v);
    }

    function currentView() {
      if (isHost) {
        const alpha = clamp((acc + (performance.now() - lastTick) / 1000) / C.STEP, 0, 1);
        return Sim.view(sim, alpha);
      }
      if (!snaps.length) return null;
      const delay = clamp(ivl * 1.7 + 20, 70, 300);
      const t = performance.now() - base - delay;
      const first = snaps[0], last = snaps[snaps.length - 1];
      if (t <= first.h) return first.v;
      if (t >= last.h) return last.v;
      let i = snaps.length - 2;
      while (i > 0 && snaps[i].h > t) i--;
      const a = snaps[i], b = snaps[i + 1];
      return Sim.lerpView(a.v, b.v, clamp((t - a.h) / Math.max(1, b.h - a.h), 0, 1));
    }

    // ------------------------------------------------------------------ input: plan a flick for each of your bobbles, lock in
    let plans = {}, lastRound = -1;                               // my plans: bobble index -> { ax, ay } (private: only the host is told)
    let drag = null, hover = -1, lastView = null;                 // drag: { i, cx, cy, px, py } in pitch coordinates
    const iAmReady = (v) => !!v && v.ready.includes(you());
    const canPlan = (v) => !!v && stage === 'play' && v.ph === 'plan' && !iAmReady(v);
    const mineDisc = (v, d) => v.owners[d.i] === you();
    function toPitch(e) {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * VW - MX, y: (e.clientY - r.top) / r.height * VH - TM };
    }
    function discAt(v, p) {
      let best = null, bd = C.DR * 1.45;
      for (const d of v.discs) {
        if (!mineDisc(v, d)) continue;
        const dd = Math.hypot(d.x - p.x, d.y - p.y);
        if (dd < bd) { bd = dd; best = d; }
      }
      return best;
    }
    function setPlan(i, ax, ay) {
      if (ax || ay) plans[i] = { ax, ay }; else delete plans[i];
      if (isHost) Sim.setPlan(sim, 0, i, ax, ay);
      else ctx.send({ k: 'plan', i, ax, ay }, true);
    }
    function setReady(v) {
      if (isHost) { Sim.setReady(sim, 0, v); forceSnap = true; }
      else ctx.send({ k: 'ready', v }, true);
    }
    function toggleReady() {
      const v = lastView;
      if (!v || stage !== 'play' || v.ph !== 'plan') return;
      setReady(!iAmReady(v));
      G3.beep(iAmReady(v) ? 400 : 700, 0.06, 'square');
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const v = lastView;
      if (!canPlan(v)) return;
      const p = toPitch(e), d = discAt(v, p);
      if (!d) return;
      drag = { i: d.i, cx: d.x, cy: d.y, px: p.x, py: p.y };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      e.preventDefault();
      G3.beep(520, 0.04, 'triangle');
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = toPitch(e);
      if (drag) { drag.px = p.x; drag.py = p.y; return; }
      const v = lastView, d = canPlan(v) ? discAt(v, p) : null;
      hover = d ? d.i : -1;
      canvas.style.cursor = d ? 'grab' : 'default';
    });
    function release(e) {
      if (!drag) return;
      const d = drag; drag = null;
      if (e.type === 'pointercancel') return;
      const dx = d.cx - d.px, dy = d.cy - d.py, len = Math.hypot(dx, dy);
      if (len < MINPULL) { if (plans[d.i]) { setPlan(d.i, 0, 0); G3.beep(300, 0.05, 'triangle'); } return; }      // a click on a planned bobble clears its plan
      const power = Math.min(1, len / MAXPULL);
      setPlan(d.i, +(dx / len * power).toFixed(3), +(dy / len * power).toFixed(3));
      G3.beep(620 + 200 * power, 0.05, 'triangle');
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    const typing = (e) => e.target && e.target.matches && e.target.matches('input,textarea,select');
    function onKeyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      autoFullscreen();
      if (e.code === 'KeyF') { e.preventDefault(); if (!e.repeat) toggleFullscreen(); return; }
      if (stage === 'menu') {
        if (!isHost) return;
        const k = e.code;
        if (k === 'Enter' || k === 'Space' || k === 'NumpadEnter') { e.preventDefault(); chooseMode(selMode); }
        else if (['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA'].includes(k)) { e.preventDefault(); selMode = (selMode + MODES.length - 1) % MODES.length; renderMenu(); }
        else if (['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD'].includes(k)) { e.preventDefault(); selMode = (selMode + 1) % MODES.length; renderMenu(); }
        return;
      }
      if (stage !== 'play') return;
      if (e.code === 'Escape' && drag) drag = null;                // changed your mind: cancel the drag
      else if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); toggleReady(); }
    }
    window.addEventListener('keydown', onKeyDown);

    // Browsers only allow real fullscreen after a click or key press.  We try on arrival (works when the START click was
    // just now), then on the first press in here, and again when a mode is picked; the window-filling layout is the
    // fallback.  If the player leaves fullscreen themselves, we stop asking until they press the button or F.
    let fsDone = false, fsDeclined = false, wasFs = false;
    function goFullscreen() {
      if (document.fullscreenElement || !wrap.requestFullscreen) return;
      try { const p = wrap.requestFullscreen({ navigationUI: 'hide' }); if (p && p.then) p.then(() => { fsDone = true; }, () => {}); } catch (e) { /* not allowed yet */ }
    }
    function autoFullscreen() { if (!fsDone && !fsDeclined) goFullscreen(); }
    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen(); else { fsDeclined = false; goFullscreen(); }
    }
    const onFsChange = () => {
      const on = !!document.fullscreenElement;
      if (wasFs && !on) fsDeclined = true;
      wasFs = on;
    };
    const onPress = () => autoFullscreen();
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('pointerdown', onPress, true);
    goFullscreen();
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bl]');
      if (!b || b.disabled) return;
      const a = b.dataset.bl;
      if (a === 'fs') toggleFullscreen();
      else if (a === 'mode') chooseMode(+b.dataset.i);
      else if (a === 'mascot') sendTeam(+b.dataset.side, { mascot: +b.dataset.i });
      else if (a === 'teamready') sendTeam(+b.dataset.side, { ready: !T.ready[+b.dataset.side] });
      else if (a === 'back' || a === 'menu') showMenu();
      else if (a === 'ready') toggleReady();
      else if (a === 'lobby') ctx.backToLobby();
      else if (a === 'leave') ctx.leave();
      else if (a === 'rematch' && sim) { Sim.restart(sim); plans = {}; lastRound = -1; acc = 0; lastTick = performance.now(); forceSnap = true; shownOver = false; over.classList.add('hidden'); }
    });

    // ------------------------------------------------------------------ sound and particles
    const beep = (f, d, t) => G3.beep(f, d, t);
    const parts = [];
    let shake = 0, wash = null, goalT = 0, kickT = 0;
    function fx(e, v) {
      const ball = v.ball;
      switch (e[0]) {
        case 'c': beep(440, 0.12, 'square'); break;
        case 'go': beep(880, 0.3, 'square'); kickT = 1; break;
        case 'plan': if (v.owners.includes(you())) { beep(740, 0.07, 'square'); setTimeout(() => beep(990, 0.07, 'square'), 90); } break;
        case 'exec': beep(130 + 12 * e[1], 0.18, 'sawtooth'); shake = Math.max(shake, 3); break;
        case 'kick':
          beep(260 + 400 * e[1], 0.08, 'square'); shake = Math.max(shake, e[1] * 6);
          for (let i = 0; i < 3 + e[1] * 8; i++) spark(ball.x, ball.y, '#ffffff', 240 * e[1] + 90);
          break;
        case 'hit': beep(170 + 200 * e[1], 0.04, 'triangle'); break;
        case 'wall': beep(110, 0.05, 'triangle'); break;
        case 'post': beep(1500, 0.07, 'square'); for (let i = 0; i < 6; i++) spark(ball.x, ball.y, '#ffd43b', 220); break;
        case 'goal': {
          [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'square'), i * 110));
          shake = 14; goalT = C.GOAL_PAUSE; wash = TEAM[e[1]].rgb;
          const x = e[1] === 0 ? C.W : 0;
          for (let i = 0; i < 120; i++) spark(x, C.H / 2, [TEAM[e[1]].main, '#fff', '#ffd43b', TEAM[e[1]].light][i % 4], 650, true);
          break;
        }
        case 'kick-off': kickT = 1; break;
        case 'pass': beep(210, 0.15, 'sawtooth'); break;
        case 'ot': beep(330, 0.4, 'sawtooth'); break;
        case 'end': [392, 330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'triangle'), i * 160)); break;
        default: break;
      }
    }
    function spark(x, y, color, speed, confetti) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: confetti ? 1.4 + Math.random() : 0.3 + Math.random() * 0.25, c: color, s: confetti ? 6 + Math.random() * 5 : 3, rot: Math.random() * 6, f: confetti ? 1.2 : 3.5 });
    }

    // ------------------------------------------------------------------ drawing
    const trail = [];
    let ballRot = 0, bg = null, k = 1, shownOver = false, prevT = performance.now(), raf = 0, barText = '';

    function resize() {
      const w = canvas.clientWidth || 800, dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(w * dpr);
      if (canvas.width === pw) return;
      canvas.width = pw; canvas.height = Math.round(pw * VH / VW);
      k = canvas.width / VW;
      bg = document.createElement('canvas'); bg.width = canvas.width; bg.height = canvas.height;
      const b = bg.getContext('2d'); b.setTransform(k, 0, 0, k, MX * k, TM * k);
      paintBackground(b);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function paintBackground(c) {
      const rnd = mulberry(99), X0 = -MX, Y0 = -TM;
      const ring = c.createLinearGradient(0, Y0, 0, Y0 + VH);                      // the dark surround
      ring.addColorStop(0, '#0d0a2e'); ring.addColorStop(0.5, '#071225'); ring.addColorStop(1, '#0d0a2e');
      c.fillStyle = ring; c.fillRect(X0, Y0, VW, VH);
      // the grass: mowing stripes, then a soft pool of light
      for (let i = 0; i < 10; i++) { c.fillStyle = i % 2 ? '#1b9d55' : '#168c4a'; c.fillRect(i * 100, 0, 100, C.H); }
      for (let n = 0; n < 900; n++) { c.fillStyle = `rgba(255,255,255,${0.015 + rnd() * 0.02})`; c.fillRect(rnd() * C.W, rnd() * C.H, 2, 2 + rnd() * 3); }
      const lit = c.createRadialGradient(C.W / 2, C.H / 2, 60, C.W / 2, C.H / 2, C.W * 0.65);
      lit.addColorStop(0, 'rgba(255,255,255,.1)'); lit.addColorStop(1, 'rgba(0,12,30,.38)');
      c.fillStyle = lit; c.fillRect(0, 0, C.W, C.H);
      // the nets
      for (const s of [0, 1]) {
        const x0 = s ? C.W : -C.NET, x1 = s ? C.W + C.NET : 0, t = TEAM[s];
        c.fillStyle = 'rgba(4,8,26,.72)'; c.fillRect(x0, C.GY0, C.NET, C.GY1 - C.GY0);
        c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1.5;
        for (let x = x0; x <= x1; x += 14) { c.beginPath(); c.moveTo(x, C.GY0); c.lineTo(x, C.GY1); c.stroke(); }
        for (let y = C.GY0; y <= C.GY1; y += 14) { c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); }
        c.lineCap = 'round'; c.strokeStyle = t.main; c.shadowColor = t.main; c.shadowBlur = 14; c.lineWidth = 7;
        c.beginPath(); c.moveTo(x1, C.GY0); c.lineTo(s ? x1 : x0, C.GY0); c.lineTo(s ? x1 : x0, C.GY1); c.lineTo(x1, C.GY1); c.stroke();
        c.shadowBlur = 0; c.strokeStyle = '#fff'; c.lineWidth = 2.5;
        c.beginPath(); c.moveTo(x1, C.GY0); c.lineTo(s ? x1 : x0, C.GY0); c.lineTo(s ? x1 : x0, C.GY1); c.lineTo(x1, C.GY1); c.stroke();
        c.lineCap = 'butt';
      }
      // the markings
      c.strokeStyle = 'rgba(255,255,255,.82)'; c.lineWidth = 4;
      c.strokeRect(0, 0, C.W, C.H);
      c.beginPath(); c.moveTo(C.W / 2, 0); c.lineTo(C.W / 2, C.H); c.stroke();
      c.beginPath(); c.arc(C.W / 2, C.H / 2, 92, 0, 7); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(C.W / 2, C.H / 2, 6, 0, 7); c.fill();
      for (const s of [0, 1]) {
        const x = s ? C.W : 0, d = s ? -1 : 1;
        c.strokeRect(s ? C.W - 160 : 0, C.H / 2 - 190, 160, 380);
        c.strokeRect(s ? C.W - 60 : 0, C.H / 2 - 120, 60, 240);
        c.beginPath(); c.arc(x + d * 110, C.H / 2, 5, 0, 7); c.fill();
        c.beginPath(); c.arc(x + d * 110, C.H / 2, 82, s ? Math.PI - 0.88 : -0.88, s ? Math.PI + 0.88 : 0.88); c.stroke();
      }
      // the posts
      for (const [px, py, s] of [[0, C.GY0, 0], [0, C.GY1, 0], [C.W, C.GY0, 1], [C.W, C.GY1, 1]]) {
        c.fillStyle = TEAM[s].main; c.beginPath(); c.arc(px, py, C.POST + 3, 0, 7); c.fill();
        c.fillStyle = '#fff'; c.beginPath(); c.arc(px, py, C.POST, 0, 7); c.fill();
      }
    }

    const emoji = (ch, x, y, size) => { g.font = `${size}px ${EMOJI_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, x, y + size * 0.06); };

    function draw(v, dt) {
      resize();
      if (!bg) return;
      if (v.round !== lastRound) { plans = {}; lastRound = v.round; drag = null; }          // a new round: plan afresh
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(bg, 0, 0);
      const sx = shake > 0.3 ? (Math.random() - 0.5) * shake : 0, sy = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
      g.setTransform(k, 0, 0, k, MX * k + sx * k, TM * k + sy * k);
      shake *= Math.pow(0.001, dt);

      if (wash && goalT > 0) {                                      // the whole stadium flashes the scoring team's colour
        g.fillStyle = `rgba(${wash},${0.2 * Math.min(1, goalT)})`; g.fillRect(-MX, -TM, VW, VH);
      }
      const t = performance.now() / 1000, planning = canPlan(v);
      if (drag && !planning) drag = null;                           // the round started under your finger, or you locked in

      // shadows, ball trail
      for (const d of v.discs) { g.fillStyle = 'rgba(0,0,0,.34)'; g.beginPath(); g.ellipse(d.x + 4, d.y + 7, C.DR, C.DR * 0.92, 0, 0, 7); g.fill(); }
      g.fillStyle = 'rgba(0,0,0,.34)'; g.beginPath(); g.ellipse(v.ball.x + 3, v.ball.y + 5, C.BR, C.BR * 0.9, 0, 0, 7); g.fill();
      trail.push({ x: v.ball.x, y: v.ball.y });
      if (trail.length > 12) trail.shift();
      const sp = Math.hypot(v.ball.vx, v.ball.vy);
      if (sp > 350) for (let i = 0; i < trail.length - 1; i++) {
        const q = trail[i];
        g.fillStyle = `rgba(255,255,255,${(i / trail.length) * 0.24 * Math.min(1, sp / 1100)})`;
        g.beginPath(); g.arc(q.x, q.y, C.BR * (0.4 + 0.6 * i / trail.length), 0, 7); g.fill();
      }
      if (v.ph === 'plan') drawRings(v, t);
      for (const d of v.discs) drawDisc(d, v);
      drawBall(v.ball, dt);
      if (v.ph === 'plan') drawPlans(v);
      if (drag) drawAim(drag);
      drawParts(dt);
      drawHud(v, t);
      goalT = Math.max(0, goalT - dt); kickT = Math.max(0, kickT - dt);
    }

    // which bobbles are mine to plan: bright gold when they still need a plan, green once planned; my teammates' are outlined in the team colour
    function drawRings(v, t) {
      const me = you(), ready = iAmReady(v);
      for (const d of v.discs) {
        const owner = v.owners[d.i];
        if (owner === me) {
          const planned = !!plans[d.i], hot = d.i === hover || (drag && drag.i === d.i);
          g.strokeStyle = ready ? 'rgba(124,242,154,.9)' : hot ? '#ffffff' : planned ? '#7cf29a' : '#ffd43b';
          g.lineWidth = hot ? 4 : 3;
          g.globalAlpha = hot || ready || planned ? 1 : 0.55 + 0.35 * Math.sin(t * 6 + d.i);
          g.beginPath(); g.arc(d.x, d.y, C.DR + 7 + (hot ? 3 : planned || ready ? 0 : 2 * Math.sin(t * 6 + d.i)), 0, 7); g.stroke();
          g.globalAlpha = 1;
        } else if (owner >= 0 && d.side === (myTeamSide(v))) {
          g.strokeStyle = `rgba(${TEAM[d.side].rgb},.55)`; g.lineWidth = 2.5; g.setLineDash([5, 5]);
          g.beginPath(); g.arc(d.x, d.y, C.DR + 6, 0, 7); g.stroke(); g.setLineDash([]);
        }
      }
    }
    function myTeamSide(v) { const i = v.owners.indexOf(you()); return i < 0 ? -1 : (i < C.TEAM ? 0 : 1); }

    function drawDisc(d, v) {
      const col = TEAM[d.side], r = C.DR;
      const grad = g.createRadialGradient(d.x - r * 0.32, d.y - r * 0.38, 3, d.x, d.y, r * 1.1);
      grad.addColorStop(0, col.light); grad.addColorStop(0.4, col.main); grad.addColorStop(1, col.dark);
      g.fillStyle = grad; g.strokeStyle = 'rgba(6,8,38,.92)'; g.lineWidth = 3.5;
      g.beginPath(); g.arc(d.x, d.y, r, 0, 7); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2.5;
      g.beginPath(); g.arc(d.x, d.y, r * 0.78, 0, 7); g.stroke();
      // the team mascot, glancing towards the ball
      const bx = v.ball.x - d.x, by = v.ball.y - d.y, bd = Math.hypot(bx, by) || 1;
      g.fillStyle = '#fff';
      emoji(mascotOf(v.teams[d.side].mascot), d.x + bx / bd * 2.5, d.y + by / bd * 2.5, r * 1.12);
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.beginPath(); g.ellipse(d.x - r * 0.45, d.y - r * 0.55, r * 0.2, r * 0.1, -0.7, 0, 7); g.fill();
    }

    function drawBall(b, dt) {
      ballRot += Math.hypot(b.vx, b.vy) * dt / C.BR * 0.8;
      const r = C.BR;
      g.save();
      g.shadowColor = 'rgba(255,255,255,.85)'; g.shadowBlur = 16;
      const grad = g.createRadialGradient(b.x - r * 0.35, b.y - r * 0.4, 2, b.x, b.y, r * 1.1);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.7, '#dfe9ff'); grad.addColorStop(1, '#9db4e8');
      g.fillStyle = grad; g.beginPath(); g.arc(b.x, b.y, r, 0, 7); g.fill();
      g.restore();
      g.strokeStyle = 'rgba(6,8,38,.9)'; g.lineWidth = 2.5; g.beginPath(); g.arc(b.x, b.y, r, 0, 7); g.stroke();
      g.fillStyle = '#2b2f6b';
      for (let i = 0; i < 6; i++) {                                 // the patches roll with the ball
        const a = ballRot + i * Math.PI / 3, rr = i ? r * 0.7 : 0;
        const px = b.x + Math.cos(a) * rr, py = b.y + Math.sin(a) * rr, s = i ? r * 0.27 : r * 0.34;
        g.beginPath();
        for (let j = 0; j < 5; j++) { const q = a + j * 2 * Math.PI / 5 - Math.PI / 2; g[j ? 'lineTo' : 'moveTo'](px + Math.cos(q) * s, py + Math.sin(q) * s); }
        g.closePath(); g.fill();
      }
    }

    // an arrow for a flick: from the bobble's rim, `ux,uy` unit direction, power 0..1
    function arrow(cx, cy, ux, uy, power, solid) {
      const col = `hsl(${Math.round(120 - 120 * power)},95%,58%)`;           // green to red with power
      const reach = 60 + power * 280, x0 = cx + ux * (C.DR + 5), y0 = cy + uy * (C.DR + 5), ax = cx + ux * reach, ay = cy + uy * reach;
      g.lineCap = 'round'; g.strokeStyle = col; g.lineWidth = solid ? 4 : 5;
      if (!solid) g.setLineDash([14, 11]);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(ax, ay); g.stroke();
      g.setLineDash([]);
      g.fillStyle = col; g.beginPath();
      g.moveTo(ax + ux * 14, ay + uy * 14); g.lineTo(ax - uy * 11, ay + ux * 11); g.lineTo(ax + uy * 11, ay - ux * 11); g.closePath(); g.fill();
      g.lineCap = 'butt';
    }

    function drawPlans(v) {                                         // my plans stay on screen until the round starts
      for (const i in plans) {
        const d = v.discs[+i], p = plans[i];
        if (!d) continue;
        const power = Math.hypot(p.ax, p.ay);
        g.globalAlpha = drag && drag.i === +i ? 0.3 : 0.9;
        arrow(d.x, d.y, p.ax / power, p.ay / power, power, true);
        g.globalAlpha = 1;
      }
    }

    function drawAim(dr) {
      const pdx = dr.px - dr.cx, pdy = dr.py - dr.cy, len = Math.hypot(pdx, pdy);
      if (len < 2) return;
      const shown = Math.min(len, MAXPULL), ux = pdx / len, uy = pdy / len, power = Math.min(1, len / MAXPULL);
      const col = `hsl(${Math.round(120 - 120 * power)},95%,58%)`;
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3;                // the band you are pulling
      g.beginPath(); g.moveTo(dr.cx, dr.cy); g.lineTo(dr.cx + ux * shown, dr.cy + uy * shown); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.arc(dr.cx + ux * shown, dr.cy + uy * shown, 7, 0, 7); g.fill();
      arrow(dr.cx, dr.cy, -ux, -uy, power, false);
      g.font = '12px "Press Start 2P", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(4,6,30,.8)'; g.fillRect(dr.cx + ux * (shown + 34) - 34, dr.cy + uy * (shown + 34) - 11, 68, 22);
      g.fillStyle = col; g.fillText(`${Math.round(power * 100)}%`, dr.cx + ux * (shown + 34), dr.cy + uy * (shown + 34) + 1);
      g.lineCap = 'butt';
    }

    function drawParts(dt) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const q = parts[i];
        q.life -= dt; if (q.life <= 0) { parts.splice(i, 1); continue; }
        const damp = Math.pow(0.04, dt * q.f / 3); q.vx *= damp; q.vy *= damp;
        q.x += q.vx * dt; q.y += q.vy * dt; q.rot += dt * 9;
        g.globalAlpha = clamp(q.life / 0.5, 0, 1);
        g.fillStyle = q.c;
        g.save(); g.translate(q.x, q.y); g.rotate(q.rot); g.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2); g.restore();
      }
      g.globalAlpha = 1;
    }

    function drawHud(v, t) {
      const cx = C.W / 2, y = -TM + 10;
      const pix = (px) => `${px}px "Press Start 2P", monospace`;
      // scoreboard
      g.fillStyle = 'rgba(4,6,30,.85)'; g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3;
      g.beginPath(); g.roundRect ? g.roundRect(cx - 290, y, 580, 56, 14) : g.rect(cx - 290, y, 580, 56); g.fill(); g.stroke();
      for (const s of [0, 1]) {
        const x0 = s ? cx + 40 : cx - 290, tm = v.teams[s];
        g.fillStyle = `rgba(${TEAM[s].rgb},${v.locked[s] ? 0.5 : 0.22})`; g.fillRect(x0 + (s ? 0 : 3), y + 4, 247, 48);
        g.fillStyle = '#fff'; emoji(mascotOf(tm.mascot), s ? x0 + 225 : x0 + 24, y + 19, 22);
        g.fillStyle = TEAM[s].main; g.textBaseline = 'middle'; g.textAlign = s ? 'right' : 'left'; g.font = pix(tm.name.length > 9 ? 9 : 11);
        g.fillText(tm.name, s ? x0 + 203 : x0 + 46, y + 19);
        g.fillStyle = '#fff'; g.font = pix(24); g.textAlign = s ? 'left' : 'right';
        g.fillText(String(v.score[s]), s ? cx + 56 : cx - 56, y + 37);
        if (v.locked[s]) { g.font = pix(7); g.fillStyle = '#7cf29a'; g.textAlign = s ? 'right' : 'left'; g.fillText('LOCKED', s ? x0 + 240 : x0 + 8, y + 45); }
      }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (v.ot) { g.fillStyle = Math.floor(t * 3) % 2 ? '#ffd43b' : '#fff'; g.font = pix(8); g.fillText('SUDDEN', cx, y + 22); g.fillText('DEATH', cx, y + 38); }
      else { const s = Math.ceil(v.clock); g.fillStyle = s <= 15 ? '#ff5c7a' : '#fff'; g.font = pix(18); g.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, cx, y + 26); g.font = pix(7); g.fillStyle = '#9fb0ff'; g.fillText('FIRST TO ' + C.GOAL_LIMIT, cx, y + 46); }

      // the banner under the pitch
      const by = C.H + 14, bw = 800, planning = canPlan(v), ready = iAmReady(v);
      g.fillStyle = 'rgba(4,6,30,.85)'; g.strokeStyle = planning ? '#ffd43b' : ready ? '#7cf29a' : 'rgba(255,255,255,.4)'; g.lineWidth = planning || ready ? 3 : 2;
      g.beginPath(); g.roundRect ? g.roundRect(cx - bw / 2, by, bw, 46, 12) : g.rect(cx - bw / 2, by, bw, 46); g.fill(); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (v.ph === 'plan') {
        const mineN = v.discs.filter((d) => mineDisc(v, d)).length, n = Object.keys(plans).length;
        g.fillStyle = ready ? '#7cf29a' : '#ffd43b'; g.font = pix(10);
        g.fillText(mineN === 0 ? `ROUND ${v.round}: WATCHING` : ready ? `ROUND ${v.round}: LOCKED IN` : `ROUND ${v.round}: PLAN YOUR MOVES  ${n}/${mineN}`, cx, by + 14);
        g.fillStyle = '#9fb0ff'; g.font = '14px "Share Tech Mono", monospace';
        const st = (s) => `${mascotOf(v.teams[s].mascot)} ${v.teams[s].name}: ${v.locked[s] ? 'LOCKED IN' : 'planning...'}`;
        g.fillText(`${st(0)}     ${st(1)}`, cx, by + 31);
        const f = clamp(v.t / C.PLAN_TIME, 0, 1);
        g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(cx - bw / 2 + 12, by + 41, bw - 24, 3);
        g.fillStyle = f < 0.2 ? '#ff5c7a' : '#ffd43b'; g.fillRect(cx - bw / 2 + 12, by + 41, (bw - 24) * f, 3);
      } else if (v.ph === 'roll') {
        g.fillStyle = '#9fb0ff'; g.font = pix(10); g.fillText('EVERYTHING MOVES AT ONCE...', cx, by + 23);
      } else if (v.ph === 'goal') {
        g.fillStyle = TEAM[v.lastGoal] ? TEAM[v.lastGoal].light : '#fff'; g.font = pix(10); g.fillText(`${v.teams[v.lastGoal] ? v.teams[v.lastGoal].name : ''} SCORES`, cx, by + 23);
      } else if (v.ph === 'countdown') {
        g.fillStyle = '#fff'; g.font = pix(10); g.fillText('GET READY', cx, by + 23);
      }

      // big centre messages
      g.lineJoin = 'round';
      const big = (txt, size, fill, stroke, yy) => { g.font = pix(size); g.lineWidth = size / 4; g.strokeStyle = stroke; g.strokeText(txt, cx, yy); g.fillStyle = fill; g.fillText(txt, cx, yy); };
      if (v.ph === 'countdown' && v.t > 0) {
        const pulse = 1 + 0.25 * (v.t % 1);
        big(String(Math.ceil(v.t)), 90 * pulse, '#ffd43b', '#1b0f4d', C.H / 2 - 60);
      } else if (v.ph === 'goal') {
        const col = TEAM[v.lastGoal] || TEAM[0], bounce = 1 + 0.08 * Math.sin(t * 12);
        big('GOAL!', 80 * bounce, '#fff', col.dark, C.H / 2 - 40);
      } else if (kickT > 0 && v.ph === 'plan') {
        big('PLAN!', 40, '#7cf29a', '#1b0f4d', C.H / 2 - 120);
      }
      g.lineJoin = 'miter';
    }

    // the LOCK IN button under the pitch follows the round
    function syncBar(v) {
      const show = stage === 'play' && !!v && v.ph === 'plan' && v.owners.includes(you());
      readyBtn.style.display = show ? '' : 'none';
      if (!show) return;
      const ready = iAmReady(v), n = Object.keys(plans).length;
      const txt = ready ? '[ ✔ LOCKED IN: CLICK TO EDIT ]' : `[ LOCK IN${n ? ` ${n} MOVE${n === 1 ? '' : 'S'}` : ''} ]`;
      if (barText !== txt) { barText = txt; readyBtn.textContent = txt; }
      readyBtn.classList.toggle('on', ready);
    }

    // ------------------------------------------------------------------ overlay + frame loop
    function updateOverlay(v) {
      const isOver = v.ph === 'over';
      if (isOver === shownOver) return;
      shownOver = isOver;
      if (!isOver) { over.classList.add('hidden'); return; }
      const win = v.winner, tm = v.teams;
      const title = win < 0 ? 'DRAW!' : `${mascotOf(tm[win].mascot)} ${esc(tm[win].name)} WINS!`;
      const r = ctx.room(), solo = r && r.slots.length < 2, me = v.owners.indexOf(you());
      const mineSide = me < 0 ? -1 : (me < C.TEAM ? 0 : 1);
      const sub = win < 0 ? 'NOBODY COULD BREAK THE DEADLOCK' : solo || mineSide < 0 ? '' : mineSide === win ? 'YOUR TEAM TAKES THE CUP' : 'BETTER LUCK NEXT MATCH';
      over.innerHTML = `
        <h2 style="color:${win < 0 ? '#ffd43b' : TEAM[win].main}">${title}</h2>
        <div class="bl-final"><span style="color:${TEAM[0].main}">${mascotOf(tm[0].mascot)} ${esc(tm[0].name)} ${v.score[0]}</span><span> - </span><span style="color:${TEAM[1].main}">${v.score[1]} ${esc(tm[1].name)} ${mascotOf(tm[1].mascot)}</span></div>
        <div class="bl-sub">${sub}</div>
        <div class="bl-row">${isHost
          ? '<button data-bl="rematch" class="bl-big">[ REMATCH ]</button><button data-bl="menu">[ CHANGE MODE / TEAMS ]</button><button data-bl="lobby">[ BACK TO LOBBY ]</button>'
          : '<span class="bl-sub">WAITING FOR THE HOST...</span>'}</div>`;
      over.classList.remove('hidden');
    }

    function frame(ts) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (ts - prevT) / 1000); prevT = ts;
      if (stage !== 'play') { resize(); if (bg) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); } syncBar(null); return; }
      const v = currentView();
      lastView = v;
      if (!v) {
        resize();
        if (bg) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); g.setTransform(k, 0, 0, k, MX * k, TM * k); g.font = '18px "Press Start 2P", monospace'; g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText('CONNECTING TO THE MATCH...', C.W / 2, C.H / 2); }
        return;
      }
      draw(v, dt);
      syncBar(v);
      updateOverlay(latest && !isHost ? latest : v);
    }
    renderMenu();
    raf = requestAnimationFrame(frame);

    // ------------------------------------------------------------------ the lobby's handle on us
    function toPlay(d) {                                           // a guest: the match is on
      if (d.names) { T.names = d.names.slice(); T.mascots = d.mascots.slice(); }
      if (d.mode) modeId = d.mode;
      stage = 'play'; menu.classList.add('hidden'); setModeLabel();
    }
    return {
      onMessage(from, d) {
        if (!d || typeof d !== 'object') return;
        if (isHost) {
          if (d.k === 'plan' && stage === 'play') Sim.setPlan(sim, from, d.i, d.ax, d.ay);
          else if (d.k === 'ready' && stage === 'play') { Sim.setReady(sim, from, !!d.v); forceSnap = true; }
          else if (d.k === 'team') applyTeam(from, d);
          return;
        }
        if (from !== 0) return;
        if (d.k === 's') {
          if (stage !== 'play') toPlay(d);                          // missed the 'begin' message: the match itself says it began
          onSnapshot(d);
        } else if (d.k === 'setup') {
          if (stage === 'play') return;
          stage = 'teams'; modeId = d.mode || modeId;
          T.names = d.names.slice(); T.mascots = d.mascots.slice(); T.ready = d.ready.slice();
          setModeLabel(); renderSetup(false);
        } else if (d.k === 'begin') {
          plans = {}; lastRound = -1;
          toPlay(d);
        } else if (d.k === 'menu') {
          stage = 'menu'; modeId = null; drag = null; plans = {};
          snaps.length = 0; base = null; ivl = 50; lastTk = -1; latest = null;
          over.classList.add('hidden'); shownOver = false;
          setModeLabel(); renderMenu();
        }
      },
      onRoom(r) {
        if (sim) for (const id of sim.members[0].concat(sim.members[1])) if (!r.slots.some((s) => s.id === id)) Sim.removePlayer(sim, id);
        if (stage === 'teams') renderSetup(false);                 // a captain may have left
      },
      destroy() {
        cancelAnimationFrame(raf);
        clearTimeout(nameTimer);
        if (ticker) ticker.terminate();
        if (timer) clearInterval(timer);
        ro.disconnect();
        window.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('fullscreenchange', onFsChange);
        window.removeEventListener('pointerdown', onPress, true);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        document.documentElement.classList.remove('bl-open');
        wrap.remove();
        root.innerHTML = '';
      },
    };
  }

  G3.registerGame('bobble_league', { mount });
}());
