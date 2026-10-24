/* The full-screen "restricted terminal" shown when a cartridge that can't be played is selected:
   F2 (classified, red) and F3 and up (work in progress, amber). One template, two skins.
   G3.lockedScreen(game, leave) opens the right one; G3.accessOf(id) says which a game needs. */
(function () {
  'use strict';
  const G3 = window.G3;
  G3.CLASSIFIED = new Set(['rising_rush']);
  const OPEN = new Set(['bobble_league']);                    // the playable games
  G3.accessOf = (id) => OPEN.has(id) ? 'open' : G3.CLASSIFIED.has(id) ? 'classified' : 'wip';
  G3.built = (id) => ((G3.state.init && G3.state.init.progress) || {})[id] || 0;   // % of code written, counted by the server

  const HEX = '0123456789abcdef';
  const hexStr = (n) => Array.from({ length: n }, () => HEX[Math.floor(Math.random() * 16)]).join('');
  const hx = (n) => hexStr(n).toUpperCase();

  // everything that differs between the two screens
  const KINDS = {
    classified: {
      cls: '', alert: 'Access denied',
      nav: ['FIREWALL TELEMETRY', 'PERIMETER GRID', 'BREACH OVERRIDE', 'SURVEILLANCE NODES', 'LOGIC INTERCEPTS'],
      chip: 'SECURE CONNECTION ESTABLISHED', title: 'RESTRICTED TERMINAL', badge: 'CLEARANCE LVL 0',
      sub: ['SECURE CONNECTION ESTABLISHED', 'NODE: GATEWAY_OMEGA_07', 'PROTOCOL: GC-SHIELD-V9'],
      crit: 'CRITICAL CONTAINMENT BREACH THRESHOLD EXCEEDED', head: 'ACCESS DENIED', auth: 'AUTHORIZATION REQUIRED',
      matrix: 'FIREWALL INTEGRITY MATRIX // SHIELD_V9.0', fault: 'SYS_FAULT: 0x000F4C',
      buf: 'FIREWALL CONTAINMENT BUFFER', warn: '⚠ YOU WERE NOT SUPPOSED TO BE HERE.',
      sub2: 'HOST SYSTEM IDENTIFIED // SESSION ISOLATION ENGAGED', scan: 'RUNNING BACKGROUND TRACE: [ADDR: 192.0.2.148] :: SCANNING...',
      back: 'RETURN TO SAFE ZONE', foot: 'GC-SECURITY // CLASSIFIED ACCESS // LEVEL UNKNOWN', feed: () => `PKT_IN: 0x${hx(4)} // ERR_LEVEL_NULL: SECTOR_QUARANTINE_${hx(2)}`,
    },
    wip: {
      cls: ' cl-wip', alert: 'Work in progress',
      nav: ['BUILD TELEMETRY', 'ASSET PIPELINE', 'NETCODE LINK', 'PLAYTEST QUEUE', 'RELEASE GATE'],
      chip: 'BUILD SERVER ONLINE', title: 'CONSTRUCTION TERMINAL', badge: 'BUILD IN PROGRESS',
      sub: ['BUILD SERVER ONLINE', 'NODE: FORGE_03', 'PROTOCOL: G3-LINK-V1'],
      crit: 'CARTRIDGE ASSEMBLY INCOMPLETE', head: 'WORK IN PROGRESS', auth: 'CARTRIDGE NOT PLAYABLE YET',
      matrix: 'BUILD MATRIX // COMPILER_V1.0', fault: 'BUILD_ID: 0x000F4C',
      buf: 'CODE WRITTEN', warn: '⚠ THIS CARTRIDGE IS STILL UNDER CONSTRUCTION.',
      sub2: 'DEVS ARE COOKING // CHECK BACK SOON', scan: 'LOCKED: HOSTING AND JOINING ARE DISABLED FOR THIS CARTRIDGE',
      back: 'RETURN TO THE CUBE', foot: 'G3-BUILD // WORK IN PROGRESS // NOT FOR RELEASE', feed: () => `BUILD_TICK: 0x${hx(4)} // LINK_STAGE: PENDING_${hx(2)}`,
    },
  };

  // ---------------------------------------------------------------- the 24 hour lockout (kept in this browser)
  const LOCK_KEY = 'g3.classified.lockUntil', LOCK_MS = 24 * 60 * 60 * 1000;
  let lockMem = 0;
  const lockLeft = () => {
    let t = lockMem;
    try { t = Math.max(t, +localStorage.getItem(LOCK_KEY) || 0); } catch (e) { /* private window: the in-memory copy still works */ }
    return Math.max(0, t - Date.now());
  };
  const startLock = () => {
    lockMem = Date.now() + LOCK_MS;
    try { localStorage.setItem(LOCK_KEY, String(lockMem)); } catch (e) { /* ignore */ }
  };
  const hms = (ms) => { const s = Math.ceil(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };

  // ---------------------------------------------------------------- what D counts as a stupid thing to say
  const BAD = /\b(fuck\w*|shit\w*|bitch\w*|dick\w*|penis|poop\w*|fart\w*|butt|ass|stupid|dumb|idiot|noob|lol|lmao|rofl|haha\w*|bruh|sus|skibidi|gyat|69|420)\b/i;
  function isStupid(text) {
    const t = text.trim().toLowerCase();
    if (t.length < 2 || !/[a-z]/.test(t)) return true;                                   // nothing, "?", only digits and symbols
    if (BAD.test(t) || /(.)\1{3,}/.test(t) || /asdf|qwer|zxcv|hjkl|sdfg|dfgh/.test(t)) return true;   // insults, jokes, keyboard mashing
    return t.split(/[^a-z]+/).some((w) => w.length >= 5 && !/[aeiouy]/.test(w));         // a "word" with no vowels
  }
  const ANSWERS = [
    // "how do i gain clearance" (any spelling) has to win over the "how long" and "how" rules below
    [/\b(how|gain|get|earn|raise|increase|reach|obtain|improve|upgrade)\b.*\b(clear\w*|level|access)\b|\b(clear\w*|level|access)\b.*\b(how|gain|earn|raise|increase|reach|obtain)\b/, 'thats dependent on how long you play'],
    [/who|name|you are/, 'im just someone stuck in an infinite line of binary'],
    [/when|release|ready|soon|eta|long/, 'when the 4th sun rises, the talismans of the seal shall be broken'],
    [/rising|rush|game|cartridge|ninja|boss|file/, 'the file is sealed. i cant say whats inside, only that its not ready for you.'],
    [/access|password|code|clearance|let me|open|unlock|hack|cheat|key/, 'level 5 clearance. you are level 0. the door stays shut.'],
    [/how/, 'you dont. not yet.'],
    [/^(hi|hello|hey|yo)\b/, 'hello. ask me something.'],
  ];
  const answerFor = (text) => { const t = text.toLowerCase(); const m = ANSWERS.find(([re]) => re.test(t)); return m ? m[1] : 'thats above your clearance. ask me something else.'; };

  // a crack: a few jagged main branches out of one point, each throwing off smaller ones
  function crackPaths(W, H) {                                   // drawn in real pixels so the dash animation and stroke widths stay true
    const out = [], px = (x, y, i) => `${i ? 'L' : 'M'}${Math.round(x * W / 100)} ${Math.round(y * H / 100)}`;
    const branch = (x, y, ang, len, depth) => {
      let d = px(x, y, 0);
      const steps = Math.max(3, Math.round(len / 4.5));
      for (let i = 0; i < steps; i++) {
        ang += (Math.random() - 0.5) * 0.6;
        x += Math.cos(ang) * len / steps; y += Math.sin(ang) * len / steps;
        d += px(x, y, 1);
        if (depth < 2 && Math.random() < 0.2) branch(x, y, ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7), len * (0.3 + Math.random() * 0.3), depth + 1);
      }
      out.push(d);
    };
    const n = 7, base = Math.random() * 6.28;
    for (let i = 0; i < n; i++) branch(50, 46, base + i * 6.28 / n + (Math.random() - 0.5) * 0.6, 42 + Math.random() * 22, 0);
    return out;
  }

  let el = null, timers = [], onKey = null, crack = null, closeCrack = () => {};

  function close(leave) {
    if (!el) return;
    timers.forEach(clearInterval); timers = [];
    crack = null;
    window.removeEventListener('keydown', onKey, true);
    el.remove(); el = null;
    if (leave) leave();
  }

  function show(kind, game, leave) {
    if (el) return;
    const K = KINDS[kind], wip = kind === 'wip';
    const g = game || {}, pct = G3.built(g.id);
    const nm = G3.esc(g.exe || 'UNKNOWN.EXE');
    const players = g.min != null ? (g.min === g.max ? g.max : `${g.min}-${g.max}`) : '?';
    const rows = wip
      ? [['CARTRIDGE:', nm], ['GENRE:', G3.esc(g.genre || '?')], ['PLAYERS:', players],
         ['BUILD STATUS:', pct ? 'IN PROGRESS' : 'NOT STARTED'], ['CODE WRITTEN:', `${pct}%`], ['RELEASE ETA:', 'UNKNOWN']]
      : [['SECURITY CLEARANCE:', 'INSUFFICIENT'], ['ENCRYPTION STATUS:', 'ACTIVE (4096-AES)'], ['ACCESS PROTOCOL:', '<i class="cl-redact"></i>'],
         ['CLASSIFIED DATA:', 'RESTRICTED'], ['TRACE STATUS:', '<span id="clTrace">UNKNOWN // IN PROGRESS</span>'], ['PERIMETER RACK:', '04-A // HARDWARE AIRGAP']];
    const barPct = wip ? pct : 14.2;
    const barNote = wip ? `${pct}% [${pct ? 'ASSEMBLING' : 'AWAITING FIRST COMMIT'}]` : '14.2% [COLLAPSE IMMINENT]';
    const proto = wip
      ? `<div class="cl-proto">TARGET: <span class="cl-input cl-file">${nm}</span></div>`
      : '<div class="cl-proto">ACCESS PROTOCOL: <span class="cl-input" id="clInput"></span><span class="cl-tick"></span></div>';

    el = document.createElement('div');
    el.className = `cl-root${K.cls}`;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', K.alert);
    el.innerHTML = `
      <aside class="cl-side">
        <div class="cl-brand"><span class="cl-sq"></span>G³ ARCADE</div>
        <div class="cl-dim cl-small">SEC_CORE // T-98 <span class="cl-r">0x8F4A</span></div>
        <nav>${K.nav.map((n, i) => `<div class="cl-nav${i ? '' : ' on'}">${n}</div>`).join('')}</nav>
        <div class="cl-buffer"><div class="cl-small cl-dim cl-between"><span>CORE BUFFER</span><span>NOMINAL</span></div><div class="cl-bar"><i style="width:68%"></i></div>
          <div class="cl-small cl-dim cl-between"><span>GRID_SYNC: 98.4%</span><span>RACK: 04-A</span></div></div>
      </aside>
      <div class="cl-main">
        <div class="cl-top cl-small"><span class="cl-chip"><span class="cl-dot"></span>${K.chip}</span>
          <span class="cl-dim">NODE: 09_BETA &nbsp;//&nbsp; PERIMETER: LOCKED &nbsp;//&nbsp; FREQ: 142.9 MHz</span></div>
        <div class="cl-head">
          <div><div class="cl-title">G³ // ${K.title} <span class="cl-badge">${K.badge}</span></div>
            <div class="cl-small cl-sub">${K.sub.map((s) => `<span>${s}</span>`).join('')}</div></div>
          <div class="cl-small cl-dim cl-grid">GRID LOC: SUB-CELL 04 // SECTOR QUARANTINE<br>INGRESS IDENT: 0x9948_REV_7</div>
        </div>
        <div class="cl-stage">
          <i class="cl-c tl"></i><i class="cl-c tr"></i><i class="cl-c bl"></i><i class="cl-c br"></i>
          ${wip ? '<i class="cl-hatch"></i>' : ''}
          <div class="cl-crit"><span class="cl-sq"></span>${K.crit}</div>
          <h1 class="cl-denied" data-text="${K.head}">${K.head}</h1>
          <div class="cl-auth">${K.auth}</div>
          ${proto}
          <div class="cl-matrix">
            <div class="cl-between cl-small cl-mhead"><span><span class="cl-sq"></span>${K.matrix}</span><span class="cl-dim">${K.fault}</span></div>
            <div class="cl-rows">${rows.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('')}</div>
            <div class="cl-between cl-small cl-mfoot"><span>${K.buf}</span><span>${barNote}</span></div>
            <div class="cl-bar"><i style="width:${barPct}%"></i></div>
          </div>
          <div class="cl-warn">${K.warn}</div>
          <div class="cl-small cl-sub2">${K.sub2}</div>
          <div class="cl-lock" id="clLock" hidden>AUTHORIZATION LOCKOUT // RETRY IN <b id="clLockT">24:00:00</b></div>
          <div class="cl-small cl-dim" id="clScan">${K.scan}</div>
          <div class="cl-btns"><button class="cl-btn" id="clBack">${K.back}</button>${wip ? '' : '<button class="cl-link" id="clReq">[ REQUEST AUTHORIZATION ]</button>'}</div>
          ${wip ? '<i class="cl-hatch"></i>' : ''}
        </div>
        <div class="cl-foot cl-small"><span class="cl-live">${wip ? 'BUILD FEED' : 'LIVE FEED'}</span><span class="cl-dim cl-feed" id="clFeed">${K.feed()}</span>
          <span class="cl-dim cl-hash">HASH: ${hexStr(64)}</span></div>
        <div class="cl-bottom cl-small cl-dim cl-between"><span>${K.foot}</span><span>ENC: 4096-AES-GCM &nbsp; SYS_VER: 4.19.0-SURV</span></div>
      </div>`;
    document.body.appendChild(el);

    (wip ? [520, 660, 880] : [180, 150, 120, 90]).forEach((f, i) => setTimeout(() => G3.beep(f, wip ? 0.1 : 0.18, wip ? 'square' : 'sawtooth'), i * 160));

    const $ = (s) => el.querySelector(s);
    $('#clBack').addEventListener('click', () => close(leave));
    const req = $('#clReq');
    if (req) req.addEventListener('click', () => openCrack());
    onKey = (e) => {
      if (e.target && e.target.id === 'clChat') return;      // D's chat box handles its own keys
      e.stopPropagation();                                   // nothing underneath should react while the screen is up
      if (e.key === 'Escape') { e.preventDefault(); if (crack) closeCrack(false); else close(leave); }
      else if (e.key === 'Enter' || e.key === ' ') { if (document.activeElement && document.activeElement.tagName === 'BUTTON') return; e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey, true);
    timers.push(setInterval(() => { const f = $('#clFeed'); if (f) f.textContent = K.feed(); }, 1400));
    $('#clBack').focus();

    // ---- ACCESS DENIED glitches: now and then a few letters corrupt for a moment (the colour split is CSS)
    const h = $('.cl-denied');
    if (!wip) timers.push(setInterval(() => {
      const junk = '█▓▒░#%@$&?!/<>', chars = K.head.split('');
      for (let k = 0; k < 3; k++) { const i = Math.floor(Math.random() * chars.length); if (chars[i] !== ' ') chars[i] = junk[Math.floor(Math.random() * junk.length)]; }
      h.textContent = h.dataset.text = chars.join('');
      setTimeout(() => { h.textContent = h.dataset.text = K.head; }, 140);
    }, 2200));

    // ---- lockout banner and the request button follow the 24 hour clock
    function tick() {
      if (!el || wip) return;
      const left = lockLeft(), banner = $('#clLock'), r = $('#clReq');
      banner.hidden = !left;
      if (left) {
        $('#clLockT').textContent = hms(left);
        $('#clInput').textContent = '#'.repeat(12);
        $('#clTrace').textContent = 'LOCKED OUT // 24H';
        $('#clScan').textContent = 'AUTHORIZATION REQUEST DENIED :: OPERATOR FLAGGED FOR REVIEW';
      }
      r.disabled = !!left;
      r.textContent = left ? `[ LOCKED OUT ${hms(left)} ]` : '[ REQUEST AUTHORIZATION ]';
    }
    tick();
    if (!wip) timers.push(setInterval(tick, 1000));

    // ---- REQUEST AUTHORIZATION: the screen cracks open and D answers on a terminal inside the crack
    function openCrack() {
      if (crack || lockLeft()) return;
      const c = crack = document.createElement('div');
      c.className = 'cl-crack';
      const W = el.clientWidth || innerWidth, H = el.clientHeight || innerHeight, paths = crackPaths(W, H);
      const layer = (cls) => `<g class="${cls}">${paths.map((d, i) => `<path d="${d}" pathLength="1" style="transition-delay:${(i % 9) * 45}ms"/>`).join('')}</g>`;
      c.innerHTML = `<div class="cl-flash"></div>
        <svg class="cl-crack-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">${layer('gap')}${layer('glow')}${layer('core')}</svg>
        <div class="cl-term-wrap"><div class="cl-term">
          <div class="cl-term-head cl-small"><span><span class="cl-dot"></span>ACCESS TERMINAL // D</span><button class="cl-x" id="clX" title="Disconnect (Esc)">[ X ]</button></div>
          <div class="cl-log" id="clLog"></div>
          <div class="cl-term-in"><span>&gt;</span><input id="clChat" maxlength="120" autocomplete="off" spellcheck="false" placeholder="ask D something..." disabled></div>
        </div></div>`;
      el.appendChild(c);
      el.classList.add('cl-shake'); setTimeout(() => el && el.classList.remove('cl-shake'), 600);
      G3.beep(70, 0.22, 'sawtooth'); setTimeout(() => G3.beep(45, 0.3, 'square'), 90);
      c.getBoundingClientRect();                              // start the transitions from the closed state
      c.classList.add('open');

      const log = c.querySelector('#clLog'), input = c.querySelector('#clChat');
      let busy = true, first = true, asking = false;       // D answers your first message (whatever it is) with an offer; yes sends you away
      const addLine = (who, text, done) => {
        const line = document.createElement('div');
        line.className = `cl-line ${who}`;
        const tag = document.createElement('span'); tag.textContent = who === 'd' ? 'D> ' : 'YOU> ';
        const body = document.createElement('span');
        line.append(tag, body); log.appendChild(line);
        if (who !== 'd') { body.textContent = text; log.scrollTop = log.scrollHeight; if (done) done(); return; }
        let i = 0;
        (function type() {
          if (!line.isConnected) return;                      // the crack closed mid-sentence
          body.textContent = text.slice(0, ++i); log.scrollTop = log.scrollHeight;
          if (i % 3 === 0) G3.beep(520 + (i % 5) * 30, 0.012, 'square');
          if (i < text.length) setTimeout(type, 26); else if (done) done();
        }());
      };
      const ready = () => { busy = false; input.disabled = false; input.focus(); };
      setTimeout(() => addLine('d', 'hi im D, what would you like to know', ready), 1100);

      const send = () => {
        const text = input.value.trim();
        if (!text || busy) return;
        input.value = ''; busy = true; input.disabled = true;
        addLine('you', text);
        if (first) {                                          // hi, or anything else, to start with
          first = false; asking = true;
          addLine('d', 'would you like to view the accessible files? (yes / no)', ready);
        } else if (asking) {
          if (/^(y|ye|yes|yeah|yep|yup|yea|sure|ok|okay|please|of course)\b/i.test(text)) {
            asking = false;
            addLine('d', 'lmao you thought that would work', () => setTimeout(() => close(leave), 1600));      // on to the cube rotator
          } else if (/^(n|no|nope|nah)\b/i.test(text)) { asking = false; addLine('d', 'ok. ask me something.', ready); }
          else addLine('d', 'yes or no.', ready);
        } else if (isStupid(text)) addLine('d', 'oh i see', () => setTimeout(() => closeCrack(true), 1200));
        else addLine('d', answerFor(text), ready);
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();                                  // keep typing away from the page underneath
        if (e.key === 'Enter') { e.preventDefault(); send(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCrack(false); }
      });
      c.querySelector('#clX').addEventListener('click', () => closeCrack(false));
    }

    // the crack heals; if D was insulted, the 24 hour lockout starts as it closes
    closeCrack = (punish) => {
      if (!crack) return;
      const c = crack; crack = null;
      c.classList.remove('open'); c.classList.add('closing');
      if (punish) { startLock(); G3.beep(200, 0.12, 'sawtooth'); }
      tick();
      setTimeout(() => { c.remove(); tick(); }, 900);
    };
  }

  // the screen a locked game gets; `leave` runs when the player dismisses it
  G3.lockedScreen = (game, leave) => { if (game && G3.accessOf(game.id) !== 'open') show(G3.accessOf(game.id), game, leave); };
  G3.classified = { close };
}());
