/* Bobble League: the client.  Registers with the lobby (G3.registerGame) and is mounted when the host starts the game.
 *
 *   host   runs the simulation (sim.js) and streams snapshots through the room's game channel;
 *   guests send their key state to the host ({k:'in', m:mask, _h:true}) and draw interpolated snapshots.
 *
 * Controls: A/D or arrows move, W / up / space jump (hold for a high jump), S / down / shift slides, F fullscreen.
 *
 * Every match opens on the game menu, where the host picks the gameplay style (MODES below; guests wait and watch).
 * The game always fills the window and asks for real fullscreen as soon as the browser allows it.
 */
(function () {
  'use strict';
  const Sim = window.BobbleSim, C = Sim.C;

  // The view is the pitch plus a margin for the nets (sides), the scoreboard (top) and the grass apron (bottom).
  const MX = 110, TM = 80, BM = 90;
  const VW = C.W + 2 * MX, VH = TM + C.FLOOR + BM;

  const TEAM = [
    { name: 'CYAN', main: '#27d3f2', dark: '#0a7a96', light: '#b5f6ff', rgb: '39,211,242' },
    { name: 'MAGENTA', main: '#f046d8', dark: '#97198a', light: '#ffc0f5', rgb: '240,70,216' },
  ];
  const KEYS = {
    ArrowLeft: 1, KeyA: 1, ArrowRight: 2, KeyD: 2, ArrowUp: 4, KeyW: 4, Space: 4,
    ArrowDown: 8, KeyS: 8, ShiftLeft: 8, ShiftRight: 8,
  };
  // Gameplay styles offered on the menu.  Add one here and it shows up as a card; `id` is sent to the guests with the start.
  const MODES = [
    { id: 'classic', name: 'CLASSIC', blurb: 'Two teams, one ball. Most goals in 2:00 wins; a draw goes to golden goal.' },
  ];
  const RATE = { lan: 30, relay: 20, online: 15, lora: 4 };     // snapshots per second, at most
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
        <span id="blHint">MOVE: A/D  JUMP: W/SPACE  SLIDE: S/SHIFT  FULLSCREEN: F</span>
      </div>
      <div class="bl-stage">
        <canvas id="blCanvas"></canvas>
        <div class="bl-over bl-menu" id="blMenu"></div>
        <div class="bl-over hidden" id="blOver"></div>
      </div>
      <div class="bl-bar">
        <button data-bl="fs">[ FULLSCREEN ]</button>
        ${isHost ? '<button data-bl="lobby">[ BACK TO LOBBY ]</button>' : ''}
        <button data-bl="leave" class="bl-danger">${isHost ? '[ CLOSE ROOM ]' : '[ LEAVE ROOM ]'}</button>
      </div>`;
    document.body.appendChild(wrap);
    document.documentElement.classList.add('bl-open');
    const canvas = wrap.querySelector('#blCanvas'), over = wrap.querySelector('#blOver'), menu = wrap.querySelector('#blMenu');
    const g = canvas.getContext('2d');
    try { document.fonts.load('16px "Press Start 2P"'); } catch (e) { /* cosmetic */ }

    const nameOf = (id) => { const r = ctx.room(); const s = r && r.slots.find((q) => q.id === id); return s ? s.n : '?'; };
    const slotOf = (id) => { const r = ctx.room(); return r && r.slots.find((q) => q.id === id); };
    const you = () => { const r = ctx.room(); return r ? r.you : 0; };

    // ------------------------------------------------------------------ simulation (host) / snapshots (guest)
    let sim = null, acc = 0, lastTick = performance.now(), sinceSnap = 0, outEv = [], forceSnap = false;
    const lastIn = {};
    let ticker = null, timer = null;

    // guest side
    const snaps = [];
    let base = null, ivl = 50, lastTk = -1, latest = null;

    // ------------------------------------------------------------------ the game menu
    let stage = 'menu', modeId = null, selMode = 0;               // 'menu' until the host picks a style, then 'play'
    const modeName = () => { const m = MODES.find((q) => q.id === modeId); return m ? m.name : 'MODE SELECT'; };
    const setModeLabel = () => { const el = wrap.querySelector('#blMode'); if (el) el.textContent = modeName(); };

    function renderMenu() {
      menu.classList.remove('hidden');
      if (!isHost) {
        menu.innerHTML = `<h2 class="bl-title">BOBBLE LEAGUE</h2>
          <div class="bl-sub">THE HOST IS CHOOSING THE GAMEPLAY STYLE<span class="cursor-blink">_</span></div>`;
        return;
      }
      menu.innerHTML = `<h2 class="bl-title">BOBBLE LEAGUE</h2>
        <div class="bl-sub">SELECT YOUR GAMEPLAY STYLE</div>
        <div class="bl-modes">${MODES.map((m, i) => `<button class="bl-mode ${i === selMode ? 'sel' : ''}" data-bl="mode" data-i="${i}"><b>${m.name}</b><span>${m.blurb}</span></button>`).join('')}
          <div class="bl-mode soon"><b>MORE MODES</b><span>COMING SOON</span></div></div>
        <div class="bl-sub">CLICK OR PRESS ENTER TO PLAY // THE GAME OPENS FULL SCREEN</div>`;
    }

    function startMode(i) {                                       // host only
      const m = MODES[i];
      if (!isHost || !m || stage === 'play') return;
      modeId = m.id; stage = 'play'; selMode = i;
      menu.classList.add('hidden'); over.classList.add('hidden'); shownOver = false;
      setModeLabel();
      Sim.restart(sim); acc = 0; lastTick = performance.now(); sinceSnap = 1e9; forceSnap = true;
      ctx.send({ k: 'mode', id: modeId });
      goFullscreen();
      G3.beep(660, 0.1, 'square');
    }

    function showMenu() {                                         // host: back from a finished match
      if (!isHost) return;
      stage = 'menu'; modeId = null;
      over.classList.add('hidden'); shownOver = false;
      setModeLabel(); renderMenu();
      ctx.send({ k: 'menu' });
    }

    if (isHost) {
      sim = Sim.create({ players: room0.slots.map((s, i) => ({ id: s.id, team: i % 2 })) });
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
      const guests = Math.max(1, (r ? r.slots.length : 2) - 1);
      let rate = RATE[r && r.transport] || 15;
      if (r && r.transport === 'online') rate = clamp(40 / guests, 4, rate);      // every guest is its own publish to every broker
      else if (r && r.transport === 'relay') rate = clamp(80 / guests, 6, rate);
      return 1000 / rate;
    }

    function hostTick() {
      if (!sim || stage !== 'play') return;
      const now = performance.now();
      acc += Math.min(0.25, (now - lastTick) / 1000);
      sinceSnap += now - lastTick;
      lastTick = now;
      for (const id in lastIn) if (now - lastIn[id] > 1500) { Sim.setInput(sim, +id, 0); delete lastIn[id]; }   // a guest went quiet: let go of their keys
      let n = 0;
      while (acc >= C.STEP && n < 8) {
        Sim.step(sim, C.STEP); acc -= C.STEP; n++;
        for (const e of Sim.takeEvents(sim)) {
          fx(e, { x: sim.ball.x, y: sim.ball.y }, sim.score);
          if (outEv.length < 14) outEv.push(e);
          if (e[0] === 'goal' || e[0] === 'end' || e[0] === 'go') forceSnap = true;
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
      if (snaps.length) ivl = ivl * 0.8 + clamp(hostMs - snaps[snaps.length - 1].h, 8, 500) * 0.2;
      const off = now - hostMs;
      base = base === null ? off : Math.min(base + 0.3, off);      // best-case latency; creeps up so it can recover from a slow patch
      lastTk = d.tk;
      snaps.push({ h: hostMs, v });
      while (snaps.length > 60 || (snaps.length > 2 && snaps[0].h < hostMs - 3000)) snaps.shift();
      latest = v;
      for (const e of v.ev) fx(e, v.ball, v.score);
    }

    function currentView() {
      if (isHost) {
        const alpha = clamp((acc + (performance.now() - lastTick) / 1000) / C.STEP, 0, 1);
        return Sim.view(sim, alpha);
      }
      if (!snaps.length) return null;
      const delay = clamp(ivl * 1.7 + 20, 70, 400);
      const t = performance.now() - base - delay;
      const first = snaps[0], last = snaps[snaps.length - 1];
      if (t <= first.h) return first.v;
      if (t >= last.h) {                                          // ran out of snapshots: carry on a little along the velocities
        const dt = Math.min(0.12, (t - last.h) / 1000), v = last.v;
        return Object.assign({}, v, {
          ball: Object.assign({}, v.ball, { x: v.ball.x + v.ball.vx * dt, y: Math.min(C.FLOOR - C.BR, v.ball.y + v.ball.vy * dt) }),
          players: v.players.map((p) => Object.assign({}, p, { x: clamp(p.x + p.vx * dt, C.PR, C.W - C.PR), y: Math.min(C.FLOOR - C.PR, p.y + p.vy * dt) })),
        });
      }
      let i = snaps.length - 2;
      while (i > 0 && snaps[i].h > t) i--;
      const a = snaps[i], b = snaps[i + 1];
      return Sim.lerpView(a.v, b.v, clamp((t - a.h) / Math.max(1, b.h - a.h), 0, 1));
    }

    // ------------------------------------------------------------------ input
    const held = new Set();
    let mask = 0, sentMask = -1, sentAt = 0;
    function computeMask() {
      let m = 0;
      for (const code of held) m |= KEYS[code] || 0;
      return m;
    }
    const typing = (e) => e.target && e.target.matches && e.target.matches('input,textarea,select');
    function onKeyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      autoFullscreen();
      if (e.code === 'KeyF') { e.preventDefault(); if (!e.repeat) toggleFullscreen(); return; }
      if (stage === 'menu') {
        if (!isHost) return;
        const k = e.code;
        if (k === 'Enter' || k === 'Space' || k === 'NumpadEnter') { e.preventDefault(); startMode(selMode); }
        else if (['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA'].includes(k)) { e.preventDefault(); selMode = (selMode + MODES.length - 1) % MODES.length; renderMenu(); }
        else if (['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD'].includes(k)) { e.preventDefault(); selMode = (selMode + 1) % MODES.length; renderMenu(); }
        return;
      }
      if (!KEYS[e.code]) return;
      e.preventDefault();
      held.add(e.code); pushInput();
    }
    function onKeyUp(e) { if (held.delete(e.code)) pushInput(); }
    function onBlur() { held.clear(); pushInput(); }
    function pushInput() {
      mask = computeMask();
      if (isHost) { if (sim) Sim.setInput(sim, 0, mask); } else sendInput(true);
    }
    function sendInput(changed) {
      const now = performance.now();
      if (!changed && !(mask && now - sentAt >= 100) && now - sentAt < 500) return;
      ctx.send({ k: 'in', m: mask }, true);
      sentMask = mask; sentAt = now;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    const heart = isHost ? null : setInterval(() => sendInput(false), 50);

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
      if (!b) return;
      const a = b.dataset.bl;
      if (a === 'fs') toggleFullscreen();
      else if (a === 'mode') startMode(+b.dataset.i);
      else if (a === 'menu') showMenu();
      else if (a === 'lobby') ctx.backToLobby();
      else if (a === 'leave') ctx.leave();
      else if (a === 'rematch' && sim) { Sim.restart(sim); acc = 0; forceSnap = true; shownOver = false; over.classList.add('hidden'); }
    });

    // ------------------------------------------------------------------ sound and particles
    const beep = (f, d, t) => G3.beep(f, d, t);
    const parts = [];
    let shake = 0, wash = null, goalT = 0, goT = 0, countT = 0, countN = 0;
    function fx(e, ball, score) {
      switch (e[0]) {
        case 'c': beep(440, 0.12, 'square'); countN = e[1]; countT = 0.9; break;
        case 'go': beep(880, 0.3, 'square'); goT = 0.8; countN = 0; break;
        case 'jump': beep(560, 0.05, 'triangle'); break;
        case 'slide': beep(250, 0.1, 'sawtooth'); break;
        case 'hit':
          beep(170 + 330 * e[1], 0.07, 'square'); shake = Math.max(shake, e[1] * 7);
          for (let i = 0; i < 4 + e[1] * 8; i++) spark(ball.x, ball.y, '#ffffff', 260 * e[1] + 80);
          break;
        case 'wall': beep(110, 0.06, 'triangle'); break;
        case 'goal': {
          [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'square'), i * 110));
          shake = 16; goalT = C.GOAL_PAUSE; wash = TEAM[e[1]].rgb;
          const x = e[1] === 0 ? C.W : 0;
          for (let i = 0; i < 110; i++) spark(x, C.FLOOR - 80, [TEAM[e[1]].main, '#fff', '#ffd43b', TEAM[e[1]].light][i % 4], 700, true);
          break;
        }
        case 'ot': beep(330, 0.4, 'sawtooth'); break;
        case 'end': [392, 330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'triangle'), i * 160)); break;
        default: break;
      }
    }
    function spark(x, y, color, speed, confetti) {
      const a = confetti ? -Math.PI / 2 + (Math.random() - 0.5) * 2.4 : Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: confetti ? 1.6 + Math.random() : 0.35 + Math.random() * 0.25, max: 2.4, c: color, s: confetti ? 6 + Math.random() * 5 : 3, g: confetti ? 900 : 300, rot: Math.random() * 6 });
    }

    // ------------------------------------------------------------------ drawing
    const fxs = {};                                                // per-slime animation state
    const trail = [];
    let ballRot = 0, bg = null, k = 1, shownOver = false, prevT = performance.now(), raf = 0;

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
      const rnd = mulberry(1234), X0 = -MX, X1 = C.W + MX, Y0 = -TM;
      const sky = c.createLinearGradient(0, Y0, 0, C.FLOOR);
      sky.addColorStop(0, '#12073a'); sky.addColorStop(0.5, '#2b1270'); sky.addColorStop(1, '#0d3a72');
      c.fillStyle = sky; c.fillRect(X0, Y0, VW, TM + C.FLOOR);
      for (const [x, col] of [[60, '39,211,242'], [C.W / 2, '255,255,255'], [C.W - 60, '240,70,216']]) {
        const gl = c.createRadialGradient(x, -30, 10, x, -30, 520);
        gl.addColorStop(0, `rgba(${col},.45)`); gl.addColorStop(1, `rgba(${col},0)`);
        c.fillStyle = gl; c.fillRect(X0, Y0, VW, TM + C.FLOOR);
      }
      // stands: tiers of little cheering blobs
      const palette = ['#27d3f2', '#f046d8', '#ffd43b', '#7cf29a', '#ff8a5c', '#9b8cff'];
      for (let row = 0; row < 10; row++) {
        const y = 100 + row * 28;
        c.fillStyle = row % 2 ? 'rgba(10,8,40,.55)' : 'rgba(22,14,70,.55)';
        c.fillRect(X0, y - 14, VW, 28);
        for (let x = X0 + 8 + (row % 2) * 10; x < X1; x += 22) {
          c.globalAlpha = 0.55;
          c.fillStyle = palette[Math.floor(rnd() * palette.length)];
          c.beginPath(); c.arc(x + (rnd() - 0.5) * 6, y + (rnd() - 0.5) * 6, 7 + rnd() * 2, 0, 7); c.fill();
        }
      }
      c.globalAlpha = 1;
      const fade = c.createLinearGradient(0, 60, 0, 400);
      fade.addColorStop(0, 'rgba(18,7,58,.75)'); fade.addColorStop(1, 'rgba(18,7,58,0)');
      c.fillStyle = fade; c.fillRect(X0, 60, VW, 340);
      // advertising boards
      c.fillStyle = '#080c2a'; c.fillRect(X0, 400, VW, C.FLOOR - 400);
      const ads = ['BOBBLE LEAGUE', 'G3 ARCADE', 'SLIME SODA', 'GOAL!', 'APPLE //E CUP'];
      for (let i = 0, x = X0; x < X1; i++, x += 200) {
        const t = TEAM[i % 2];
        c.fillStyle = `rgba(${t.rgb},.16)`; c.fillRect(x + 6, 410, 188, C.FLOOR - 424);
        c.strokeStyle = t.main; c.lineWidth = 2; c.strokeRect(x + 6, 410, 188, C.FLOOR - 424);
        c.fillStyle = t.light; c.font = '14px "Press Start 2P", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(ads[i % ads.length], x + 100, 410 + (C.FLOOR - 424) / 2);
      }
      // grass apron with mowing stripes
      for (let i = 0, x = X0; x < X1; i++, x += 100) {
        c.fillStyle = i % 2 ? '#17a45a' : '#12934f'; c.fillRect(x, C.FLOOR, 100, BM);
      }
      const shade = c.createLinearGradient(0, C.FLOOR, 0, C.FLOOR + BM);
      shade.addColorStop(0, 'rgba(255,255,255,.14)'); shade.addColorStop(1, 'rgba(0,10,30,.5)');
      c.fillStyle = shade; c.fillRect(X0, C.FLOOR, VW, BM);
      c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 4;
      c.beginPath(); c.moveTo(X0, C.FLOOR); c.lineTo(X1, C.FLOOR); c.stroke();
      c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.5)';
      c.beginPath(); c.moveTo(C.W / 2, C.FLOOR); c.lineTo(C.W / 2, C.FLOOR + BM); c.stroke();
      c.beginPath(); c.ellipse(C.W / 2, C.FLOOR + BM * 0.5, 150, 34, 0, 0, 7); c.stroke();
      for (const s of [0, 1]) {                                               // the penalty boxes, in perspective
        const x = s ? C.W : 0, d = s ? -1 : 1;
        c.beginPath(); c.moveTo(x, C.FLOOR + 6); c.lineTo(x + d * 190, C.FLOOR + 22); c.lineTo(x + d * 190, C.FLOOR + BM - 14); c.lineTo(x, C.FLOOR + BM - 4); c.stroke();
      }
      // goals
      for (const s of [0, 1]) {
        const t = TEAM[s], x0 = s ? C.W : -C.NET, x1 = s ? C.W + C.NET : 0;
        c.fillStyle = 'rgba(5,10,30,.55)'; c.fillRect(x0, C.BAR, C.NET, C.FLOOR - C.BAR);
        c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 1.5;
        for (let x = x0; x <= x1; x += 15) { c.beginPath(); c.moveTo(x, C.BAR); c.lineTo(x, C.FLOOR); c.stroke(); }
        for (let y = C.BAR; y <= C.FLOOR; y += 15) { c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); }
        c.lineCap = 'round';
        c.strokeStyle = t.main; c.lineWidth = 11;
        c.shadowColor = t.main; c.shadowBlur = 16;
        c.beginPath(); c.moveTo(x0, C.BAR); c.lineTo(x1, C.BAR); c.stroke();
        c.beginPath(); c.moveTo(s ? x0 : x1, C.BAR); c.lineTo(s ? x0 : x1, C.FLOOR); c.stroke();
        c.shadowBlur = 0; c.strokeStyle = '#fff'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(x0, C.BAR); c.lineTo(x1, C.BAR); c.stroke();
        c.beginPath(); c.moveTo(s ? x0 : x1, C.BAR); c.lineTo(s ? x0 : x1, C.FLOOR); c.stroke();
        c.lineCap = 'butt';
      }
    }

    function draw(v, dt) {
      resize();
      if (!bg) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(bg, 0, 0);
      const sx = shake > 0.3 ? (Math.random() - 0.5) * shake : 0, sy = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
      g.setTransform(k, 0, 0, k, MX * k + sx * k, TM * k + sy * k);
      shake *= Math.pow(0.001, dt);

      if (wash && goalT > 0) {                                      // the whole stadium flashes the scoring team's colour
        g.fillStyle = `rgba(${wash},${0.22 * Math.min(1, goalT)})`; g.fillRect(-MX, -TM, VW, VH);
      }
      const me = you();
      const t = performance.now() / 1000;

      // trail + shadows
      for (const p of v.players) shadow(p.x, p.y + C.PR, C.PR);
      shadow(v.ball.x, v.ball.y + C.BR, C.BR);
      trail.push({ x: v.ball.x, y: v.ball.y, a: 1 });
      if (trail.length > 14) trail.shift();
      const sp = Math.hypot(v.ball.vx, v.ball.vy);
      if (sp > 350) {
        for (let i = 0; i < trail.length - 1; i++) {
          const q = trail[i];
          g.fillStyle = `rgba(255,255,255,${(i / trail.length) * 0.22 * Math.min(1, sp / 900)})`;
          g.beginPath(); g.arc(q.x, q.y, C.BR * (0.4 + 0.6 * i / trail.length), 0, 7); g.fill();
        }
      }
      for (const p of v.players) drawSlime(p, v, me, t, dt);
      drawBall(v.ball, dt);
      drawParts(dt);
      drawHud(v, t);
      goalT = Math.max(0, goalT - dt); goT = Math.max(0, goT - dt); countT = Math.max(0, countT - dt);
    }

    function shadow(x, bottom, r) {
      const h = Math.max(0, C.FLOOR - bottom), s = clamp(1 - h / 500, 0.35, 1);
      g.fillStyle = `rgba(0,0,0,${0.35 * s})`;
      g.beginPath(); g.ellipse(x, C.FLOOR + 8, r * 1.05 * s, r * 0.28 * s, 0, 0, 7); g.fill();
    }

    function drawSlime(p, v, me, t, dt) {
      const col = TEAM[p.team];
      let f = fxs[p.id];
      if (!f) f = fxs[p.id] = { squash: 0, wasAir: false, vyAir: 0, blink: 0, run: 0 };
      if (!p.ground) { f.wasAir = true; f.vyAir = p.vy; }
      else if (f.wasAir) { f.squash = clamp(f.vyAir / 1500, 0.05, 0.4); f.wasAir = false; }
      f.squash = Math.max(0, f.squash - dt * 2.2);
      f.run += Math.abs(p.vx) * dt * 0.05;
      f.blink -= dt; if (f.blink < -3.2) f.blink = 0.12;

      let sx = 1, sy = 1;
      if (p.slide) { sx = 1.25; sy = 0.72; }
      else if (!p.ground) { sy = 1 + clamp(Math.abs(p.vy) / 5200, 0, 0.18); sx = 1 / sy; }
      if (f.squash > 0) { sy *= 1 - f.squash * 0.7; sx *= 1 + f.squash * 0.6; }
      const rx = C.PR * sx, ry = C.PR * sy, cx = p.x, cy = p.y + C.PR - ry, fd = p.face;

      if (p.slide) {                                                // speed lines
        g.strokeStyle = `rgba(${col.rgb},.55)`; g.lineWidth = 4; g.lineCap = 'round';
        for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(cx - fd * (rx + 8), cy - 10 + i * 12); g.lineTo(cx - fd * (rx + 46 + i * 10), cy - 10 + i * 12); g.stroke(); }
        g.lineCap = 'butt';
      }
      // feet
      g.fillStyle = col.dark;
      const stride = p.ground && Math.abs(p.vx) > 40 ? Math.sin(f.run * 3) * 7 : 0;
      for (const o of [-1, 1]) { g.beginPath(); g.ellipse(cx + o * rx * 0.45 + o * stride * 0.4, cy + ry - 3 - (o * stride > 0 ? 3 : 0), 11 * sx, 7, 0, 0, 7); g.fill(); }
      // body
      const grad = g.createRadialGradient(cx - rx * 0.3, cy - ry * 0.45, 4, cx, cy, Math.max(rx, ry) * 1.1);
      grad.addColorStop(0, col.light); grad.addColorStop(0.35, col.main); grad.addColorStop(1, col.dark);
      g.fillStyle = grad; g.strokeStyle = 'rgba(6,8,38,.92)'; g.lineWidth = 3.5;
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 7); g.fill(); g.stroke();
      // headband (clipped to the body) with a tail that flutters behind
      g.save();
      g.beginPath(); g.ellipse(cx, cy, rx - 1, ry - 1, 0, 0, 7); g.clip();
      g.fillStyle = '#fff'; g.fillRect(cx - rx, cy - ry * 0.52, rx * 2, ry * 0.2);
      g.fillStyle = col.main; g.fillRect(cx - rx, cy - ry * 0.4, rx * 2, ry * 0.045);
      g.restore();
      const wob = Math.sin(t * 14 + p.id) * 3 + clamp(-p.vy / 200, -5, 5);
      g.fillStyle = '#fff'; g.strokeStyle = 'rgba(6,8,38,.8)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - fd * rx * 0.92, cy - ry * 0.44);
      g.lineTo(cx - fd * (rx + 17), cy - ry * 0.44 + wob - 5); g.lineTo(cx - fd * (rx + 13), cy - ry * 0.3 + wob);
      g.lineTo(cx - fd * (rx * 0.9), cy - ry * 0.36); g.closePath(); g.fill(); g.stroke();
      // shine
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.beginPath(); g.ellipse(cx - rx * 0.42, cy - ry * 0.62, rx * 0.2, ry * 0.11, -0.6, 0, 7); g.fill();
      // eyes follow the ball
      const bx = v.ball.x - cx, by = v.ball.y - cy, bd = Math.hypot(bx, by) || 1;
      const er = Math.max(5, ry * 0.2), eyeY = cy - ry * 0.02;
      const blink = f.blink > 0;
      for (const o of [-0.24, 0.3]) {
        const ex = cx + fd * rx * 0.2 + o * rx;
        g.fillStyle = '#fff'; g.strokeStyle = 'rgba(6,8,38,.85)'; g.lineWidth = 2;
        g.beginPath(); g.ellipse(ex, eyeY, er * 0.85, blink ? 1.5 : er * 1.1, 0, 0, 7); g.fill(); g.stroke();
        if (!blink) { g.fillStyle = '#111a33'; g.beginPath(); g.arc(ex + bx / bd * er * 0.35, eyeY + by / bd * er * 0.4, er * 0.5, 0, 7); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(ex + bx / bd * er * 0.35 - 1.5, eyeY + by / bd * er * 0.4 - 2, er * 0.16, 0, 7); g.fill(); }
      }
      // cheeks and mouth
      g.fillStyle = 'rgba(255,120,170,.5)';
      for (const o of [-0.5, 0.58]) { g.beginPath(); g.ellipse(cx + fd * rx * 0.2 + o * rx, cy + ry * 0.2, rx * 0.12, ry * 0.07, 0, 0, 7); g.fill(); }
      const near = bd < 130 || !p.ground || p.slide;
      const mx = cx + fd * rx * 0.24, my = cy + ry * 0.3;
      g.strokeStyle = 'rgba(6,8,38,.9)'; g.lineWidth = 2.5;
      if (near) { g.fillStyle = '#7a1230'; g.beginPath(); g.ellipse(mx, my + 2, rx * 0.14, ry * 0.13, 0, 0, 7); g.fill(); g.stroke(); }
      else { g.beginPath(); g.arc(mx, my - 3, rx * 0.15, 0.2, Math.PI - 0.2); g.stroke(); }
      // name tag
      const slot = slotOf(p.id), isMe = p.id === me;
      const label = `${slot ? G3.AVATARS[slot.av % G3.AVATARS.length] : ''} ${slot ? slot.n : '?'}`.trim();
      g.font = '15px "Share Tech Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(label).width + 14, ty = p.y - C.PR - 24;
      g.fillStyle = 'rgba(4,6,30,.72)'; g.beginPath(); g.roundRect ? g.roundRect(cx - tw / 2, ty - 11, tw, 22, 11) : g.rect(cx - tw / 2, ty - 11, tw, 22); g.fill();
      g.strokeStyle = isMe ? '#ffd43b' : col.main; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = isMe ? '#ffd43b' : '#fff'; g.fillText(label, cx, ty + 1);
      if (isMe) { g.fillStyle = '#ffd43b'; const by2 = ty - 20 + Math.sin(t * 6) * 3; g.beginPath(); g.moveTo(cx - 8, by2 - 6); g.lineTo(cx + 8, by2 - 6); g.lineTo(cx, by2 + 5); g.closePath(); g.fill(); }
    }

    function drawBall(b, dt) {
      ballRot += (b.vx * dt) / C.BR;
      const r = C.BR;
      g.save();
      g.shadowColor = 'rgba(255,255,255,.9)'; g.shadowBlur = 20;
      const grad = g.createRadialGradient(b.x - r * 0.35, b.y - r * 0.4, 2, b.x, b.y, r * 1.1);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.7, '#dfe9ff'); grad.addColorStop(1, '#9db4e8');
      g.fillStyle = grad; g.beginPath(); g.arc(b.x, b.y, r, 0, 7); g.fill();
      g.restore();
      g.strokeStyle = 'rgba(6,8,38,.9)'; g.lineWidth = 3; g.beginPath(); g.arc(b.x, b.y, r, 0, 7); g.stroke();
      g.fillStyle = '#2b2f6b';
      for (let i = 0; i < 6; i++) {                                 // the patches roll with the ball
        const a = ballRot + i * Math.PI / 3, rr = i ? r * 0.72 : 0;
        const px = b.x + Math.cos(a) * rr, py = b.y + Math.sin(a) * rr, s = i ? r * 0.27 : r * 0.34;
        if (i && Math.cos(a - ballRot) < -2) continue;
        g.beginPath();
        for (let j = 0; j < 5; j++) { const q = a + j * 2 * Math.PI / 5 - Math.PI / 2; g[j ? 'lineTo' : 'moveTo'](px + Math.cos(q) * s, py + Math.sin(q) * s); }
        g.closePath(); g.fill();
      }
    }

    function drawParts(dt) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const q = parts[i];
        q.life -= dt; if (q.life <= 0) { parts.splice(i, 1); continue; }
        q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += dt * 9;
        if (q.y > C.FLOOR + BM - 6) { q.y = C.FLOOR + BM - 6; q.vy *= -0.3; q.vx *= 0.8; }
        g.globalAlpha = clamp(q.life / 0.5, 0, 1);
        g.fillStyle = q.c;
        g.save(); g.translate(q.x, q.y); g.rotate(q.rot); g.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2); g.restore();
      }
      g.globalAlpha = 1;
    }

    function drawHud(v, t) {
      const cx = C.W / 2, y = -TM + 12;
      const pix = (px) => `${px}px "Press Start 2P", monospace`;
      // scoreboard
      g.fillStyle = 'rgba(4,6,30,.82)'; g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3;
      g.beginPath(); g.roundRect ? g.roundRect(cx - 290, y, 580, 58, 14) : g.rect(cx - 290, y, 580, 58); g.fill(); g.stroke();
      g.textBaseline = 'middle';
      for (const s of [0, 1]) {
        const x0 = s ? cx + 40 : cx - 290;
        g.fillStyle = `rgba(${TEAM[s].rgb},.3)`; g.fillRect(x0 + (s ? 0 : 3), y + 4, 247, 50);
        g.fillStyle = TEAM[s].main; g.textAlign = s ? 'right' : 'left'; g.font = pix(12);
        g.fillText(TEAM[s].name, s ? cx + 275 : cx - 275, y + 18);
        g.fillStyle = '#fff'; g.font = pix(26); g.textAlign = s ? 'left' : 'right';
        g.fillText(String(v.score[s]), s ? cx + 56 : cx - 56, y + 33);
      }
      g.textAlign = 'center';
      if (v.ot) { g.fillStyle = Math.floor(t * 3) % 2 ? '#ffd43b' : '#fff'; g.font = pix(10); g.fillText('GOLDEN', cx, y + 22); g.fillText('GOAL', cx, y + 40); }
      else { const s = Math.ceil(v.clock); g.fillStyle = s <= 10 ? '#ff5c7a' : '#fff'; g.font = pix(20); g.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, cx, y + 30); }

      // big centre messages
      g.textBaseline = 'middle'; g.lineJoin = 'round';
      const big = (txt, size, fill, stroke, yy) => { g.font = pix(size); g.lineWidth = size / 4; g.strokeStyle = stroke; g.strokeText(txt, cx, yy); g.fillStyle = fill; g.fillText(txt, cx, yy); };
      if (v.ph === 'countdown' && v.t > 0) {
        const n = Math.ceil(v.t), pulse = 1 + 0.25 * (v.t % 1);
        big(String(n), 90 * pulse, '#ffd43b', '#1b0f4d', 250);
        if (v.score[0] + v.score[1] === 0 && v.clock === C.MATCH) big('GET READY', 18, '#fff', '#1b0f4d', 350);
      } else if (v.ph === 'play' && goT > 0) {
        big('GO!', 90, '#7cf29a', '#1b0f4d', 250);
      } else if (v.ph === 'goal') {
        const col = TEAM[v.lastGoal] || TEAM[0];
        const bounce = 1 + 0.08 * Math.sin(t * 12);
        big('GOAL!', 80 * bounce, '#fff', col.dark, 230);
        big(col.name + ' SCORES', 16, col.light, '#1b0f4d', 320);
      }
      g.lineJoin = 'miter';
    }

    // ------------------------------------------------------------------ overlay + frame loop
    function updateOverlay(v) {
      const isOver = v.ph === 'over';
      if (isOver === shownOver) return;
      shownOver = isOver;
      if (!isOver) { over.classList.add('hidden'); return; }
      const win = v.winner;
      const title = win < 0 ? 'DRAW!' : `${TEAM[win].name} WINS!`;
      const mine = (() => { const me = v.players.find((p) => p.id === you()); return me ? me.team : -1; })();
      const sub = win < 0 ? 'NOBODY COULD BREAK THE DEADLOCK' : mine < 0 ? '' : mine === win ? 'YOUR TEAM TAKES THE CUP' : 'BETTER LUCK NEXT MATCH';
      over.innerHTML = `
        <h2 style="color:${win < 0 ? '#ffd43b' : TEAM[win].main}">${title}</h2>
        <div class="bl-final"><span style="color:${TEAM[0].main}">${TEAM[0].name} ${v.score[0]}</span><span> - </span><span style="color:${TEAM[1].main}">${v.score[1]} ${TEAM[1].name}</span></div>
        <div class="bl-sub">${sub}</div>
        <div class="bl-row">${isHost
          ? '<button data-bl="rematch" class="bl-big">[ REMATCH ]</button><button data-bl="menu">[ CHANGE MODE ]</button><button data-bl="lobby">[ BACK TO LOBBY ]</button>'
          : '<span class="bl-sub">WAITING FOR THE HOST...</span>'}</div>`;
      over.classList.remove('hidden');
    }

    function frame(ts) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (ts - prevT) / 1000); prevT = ts;
      if (stage === 'menu') { resize(); if (bg) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); } return; }
      const v = currentView();
      if (!v) {
        resize();
        if (bg) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); g.setTransform(k, 0, 0, k, MX * k, TM * k); g.font = '18px "Press Start 2P", monospace'; g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText('CONNECTING TO THE MATCH...', C.W / 2, 260); }
        return;
      }
      draw(v, dt);
      updateOverlay(latest && !isHost ? latest : v);
    }
    renderMenu();
    raf = requestAnimationFrame(frame);

    // ------------------------------------------------------------------ the lobby's handle on us
    return {
      onMessage(from, d) {
        if (!d || typeof d !== 'object') return;
        if (d.k === 'in' && isHost) { Sim.setInput(sim, from, d.m | 0); lastIn[from] = performance.now(); }
        else if (d.k === 's' && !isHost && from === 0) {
          if (stage === 'menu') { stage = 'play'; menu.classList.add('hidden'); setModeLabel(); }   // missed the 'mode' message: the match itself says it began
          onSnapshot(d);
        } else if (d.k === 'mode' && !isHost && from === 0) {
          modeId = d.id; stage = 'play'; menu.classList.add('hidden'); setModeLabel();
        } else if (d.k === 'menu' && !isHost && from === 0) {
          stage = 'menu'; modeId = null;
          snaps.length = 0; base = null; ivl = 50; lastTk = -1; latest = null;
          over.classList.add('hidden'); shownOver = false;
          setModeLabel(); renderMenu();
        }
      },
      onRoom(r) {
        if (sim) for (const p of sim.players.slice()) if (!r.slots.some((s) => s.id === p.id)) Sim.removePlayer(sim, p.id);
      },
      destroy() {
        cancelAnimationFrame(raf);
        if (ticker) ticker.terminate();
        if (timer) clearInterval(timer);
        if (heart) clearInterval(heart);
        ro.disconnect();
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
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
