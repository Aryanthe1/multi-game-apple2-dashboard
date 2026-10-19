/* G3 shared client: bridge connection, state, preferences, audio, theming. */
(function () {
  'use strict';

  const G3 = window.G3 = {
    state: { init: null, status: { state: 'idle', msg: '', hosts: [] }, room: null, settings: {},
             catalog: [], chat: [], sys: [], ips: [], online: false, ping: null, pings: [] },
    listeners: {},
  };

  // ---------------------------------------------------------------- helpers
  G3.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  G3.$ = (sel, root = document) => root.querySelector(sel);
  G3.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  G3.on = (t, fn) => { (G3.listeners[t] = G3.listeners[t] || []).push(fn); };
  function emit(t, d) { (G3.listeners[t] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } }); }
  G3.emit = emit;

  G3.AVATARS = ['👑', '🎮', '🛡️', '⚡', '🎲', '🔍', '🕹️', '👾', '🚀', '🦊', '🐙', '🔥'];
  G3.AV_COLORS = [
    ['#33FF66', '#050d06'], ['#00eefc', '#050d06'], ['#ffb2ba', '#670020'], ['#FFB000', '#050d06'],
    ['#7B2CBF', '#ffffff'], ['#00dbe9', '#050d06'], ['#FFDD00', '#050d06'], ['#6dff7f', '#050d06'],
    ['#FF3366', '#050d06'], ['#ffd9dc', '#400011'], ['#7df4ff', '#002022'], ['#ffd4d7', '#c40044'],
  ];
  G3.TRANSPORTS = { lan: 'WI-FI/LAN', online: 'ROOM_CODE', relay: 'RELAY', lora: 'LORA_RADIO' };
  const WORDS = ['ember', 'tide', 'fern', 'gale', 'stone', 'spark', 'dusk', 'dawn', 'forge', 'cinder', 'brook', 'moss',
    'storm', 'flint', 'volt', 'shade', 'glow', 'ash', 'reef', 'thorn', 'cloud', 'slate', 'bolt', 'gloom', 'flare',
    'wave', 'root', 'wind', 'ore', 'zap', 'night', 'sun'];
  G3.newRoomCode = () => {
    const r = new Uint32Array(4); crypto.getRandomValues(r);
    return `${WORDS[r[0] % 32]}-${WORDS[r[1] % 32]}-${WORDS[r[2] % 32]}-${String(r[3] % 1000).padStart(3, '0')}`.toUpperCase();
  };
  G3.game = (id) => G3.state.catalog.find((g) => g.id === id) || null;
  // Game modules (web/games/<id>/game.js) register here; see web/games/README.md for the contract.
  G3.games = {};
  G3.registerGame = (id, mod) => { G3.games[id] = mod; };
  G3.me = () => {
    const r = G3.state.room;
    return r && r.slots ? r.slots.find((s) => s.id === r.you) || null : null;
  };
  G3.send = (c, data) => {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(Object.assign({ c }, data || {}))); return true; }
    return false;
  };
  G3.keyName = (code) => String(code || '').replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', '').replace('Slash', '/')
    .replace('Escape', 'ESC').replace('Backquote', '`').toUpperCase();

  // ---------------------------------------------------------------- preferences (this browser)
  const DEFAULT_PREFS = {
    beep: true, readable: true, scan: true, scanOp: 55, bloom: true, theme: 0, sfx: 80, bgm: 0, chip: 0,
    alerts: { chat: true, join: true },
    keys: { prev: 'ArrowLeft', next: 'ArrowRight', exec: 'Enter', back: 'Escape', ready: 'KeyR', chat: 'KeyT' },
  };
  G3.THEMES = [
    ['P1 GREEN PHOSPHOR', 'none'],
    ['P3 AMBER MONOCHROME', 'grayscale(1) sepia(1) saturate(5) hue-rotate(-12deg) brightness(1.1)'],
    ['P4 WHITE PHOSPHOR', 'grayscale(1) brightness(1.15)'],
    ['CYBER CYAN ARCADE', 'hue-rotate(60deg)'],
  ];
  G3.CHIPS = [
    { name: 'MOCKINGBOARD II (STEREO)', type: 'square', dur: 1, gain: 1 },
    { name: 'APPLE DISK MOTOR SFX', type: 'sawtooth', dur: 1.6, gain: 0.75 },
    { name: 'BUILT-IN 1-BIT CLICKER', type: 'square', dur: 0.4, gain: 1 },
    { name: 'SOUND CHOPPER DUAL-SID', type: 'triangle', dur: 1.2, gain: 1.3 },
  ];
  G3.LEVELS = [0, 15, 35, 55, 70, 85, 100];
  G3.bar = (pct, n = 14) => { const f = Math.round(pct / 100 * n); return '█'.repeat(f) + '░'.repeat(n - f); };

  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('g3.prefs') || '{}'); } catch (e) { /* private mode */ }
    return Object.assign({}, DEFAULT_PREFS, p, {
      alerts: Object.assign({}, DEFAULT_PREFS.alerts, p.alerts), keys: Object.assign({}, DEFAULT_PREFS.keys, p.keys),
    });
  }
  G3.prefs = loadPrefs();
  G3.setPref = (k, v) => {
    if (k.includes('.')) { const [a, b] = k.split('.'); G3.prefs[a][b] = v; } else G3.prefs[k] = v;
    try { localStorage.setItem('g3.prefs', JSON.stringify(G3.prefs)); } catch (e) { /* ignore */ }
    applyPrefs();
    emit('prefs', G3.prefs);
  };
  G3.resetPrefs = () => {
    try { localStorage.removeItem('g3.prefs'); } catch (e) { /* ignore */ }
    G3.prefs = loadPrefs(); applyPrefs(); emit('prefs', G3.prefs);
  };
  function applyPrefs() {
    const root = document.documentElement, p = G3.prefs;
    root.classList.toggle('no-scan', !p.scan);
    root.classList.toggle('no-bloom', !p.bloom);
    root.classList.toggle('readable', !!p.readable);
    root.style.setProperty('--scan-op', (p.scanOp / 100 * 0.57).toFixed(3));
    root.style.setProperty('--theme-filter', G3.THEMES[p.theme % G3.THEMES.length][1]);
    G3.$$('[data-beep-label]').forEach((b) => { b.textContent = p.beep ? '[ ♪ BEEP:ON ]' : '[ ♪ BEEP:OFF ]'; });
    bgmSync();
  }

  // ---------------------------------------------------------------- audio (WebAudio square-wave beeps + a tiny chiptune loop)
  let actx = null, bgmTimer = null, bgmStep = 0;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  G3.audio = audio;
  G3.beep = (freq = 600, dur = 0.08, type) => {
    const p = G3.prefs; if (!p.beep || p.sfx <= 0) return;
    const ctx = audio(); if (!ctx) return;
    const chip = G3.CHIPS[p.chip % G3.CHIPS.length];
    try {
      const o = ctx.createOscillator(), g = ctx.createGain(), d = dur * chip.dur, t = ctx.currentTime;
      o.type = type || chip.type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.07 * (p.sfx / 100) * chip.gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + d);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(t + d);
    } catch (e) { /* audio blocked */ }
  };
  const ARP = [220, 261.63, 329.63, 440, 329.63, 261.63, 392, 329.63];
  function bgmNote() {
    const p = G3.prefs, ctx = actx; if (!ctx || p.bgm <= 0 || ctx.state !== 'running') return;
    const t = ctx.currentTime, vol = 0.05 * (p.bgm / 100);
    const note = (f, type, len, gain) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(vol * gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + len);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(t + len);
    };
    note(ARP[bgmStep % 8] * (Math.floor(bgmStep / 16) % 2 ? 0.75 : 1), 'square', 0.16, 1);
    if (bgmStep % 8 === 0) note(ARP[0] / 2 * (Math.floor(bgmStep / 16) % 2 ? 0.75 : 1), 'triangle', 0.6, 1.6);
    bgmStep++;
  }
  function bgmSync() {
    if (G3.prefs.bgm > 0 && actx && !bgmTimer) bgmTimer = setInterval(bgmNote, 190);
    if (G3.prefs.bgm <= 0 && bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  }
  // browsers only allow audio after a gesture
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (G3.prefs.bgm > 0) { audio(); bgmSync(); } }, { passive: true }));

  // ---------------------------------------------------------------- the tape (status line at the bottom of each page)
  let tapeTimer = null;
  G3.toast = (msg, kind = 'ok') => {
    const el = document.getElementById('tape');
    if (el) {
      el.dataset.base = el.dataset.base || el.textContent;
      el.textContent = msg;
      el.style.color = kind === 'err' ? '#FF3366' : '#00eefc';
      clearTimeout(tapeTimer);
      tapeTimer = setTimeout(() => { el.textContent = el.dataset.base; el.style.color = ''; }, 6000);
    }
    if (kind === 'err') G3.beep(180, 0.16, 'sawtooth');
  };

  // ---------------------------------------------------------------- connection
  let ws = null, retry = 400, pingTimer = null;
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      retry = 400; G3.state.online = true;
      const off = document.getElementById('offline'); if (off) off.style.display = 'none';
      emit('conn', true);
      clearInterval(pingTimer);
      const ping = () => G3.send('ping', { ts: performance.now() });
      ping(); pingTimer = setInterval(ping, 3000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } handle(m); };
    ws.onclose = () => {
      G3.state.online = false; clearInterval(pingTimer);
      const off = document.getElementById('offline');
      if (off) { off.textContent = 'BRIDGE OFFLINE // IS "python -m g3" STILL RUNNING? RETRYING...'; off.style.display = 'block'; }
      emit('conn', false);
      setTimeout(connect, retry); retry = Math.min(retry * 1.6, 5000);
    };
  }

  function handle(m) {
    const S = G3.state;
    switch (m.t) {
      case 'init':
        Object.assign(S, { init: m, catalog: m.catalog, settings: m.settings, status: m.status, room: m.room,
                           chat: m.chat || [], sys: m.sys || [], ips: m.ips || [] });
        break;
      case 'status': S.status = m; break;
      case 'settings': S.settings = m.settings; break;
      case 'room': S.room = m; break;
      case 'closed':
        S.room = null; S.chat = []; S.sys = [];
        break;
      case 'chat':
        S.chat.push(m); if (S.chat.length > 100) S.chat.shift();
        if (G3.prefs.alerts.chat && S.room && m.id !== S.room.you) G3.beep(980, 0.05);
        break;
      case 'sys':
        S.sys.push(m); if (S.sys.length > 60) S.sys.shift();
        if (G3.prefs.alerts.join) G3.beep(/joined/.test(m.m) ? 760 : 420, 0.07);
        break;
      case 'pong':
        if (typeof m.ts === 'number') {
          S.ping = Math.max(0, Math.round(performance.now() - m.ts));
          S.pings.push(S.ping); if (S.pings.length > 24) S.pings.shift();
        }
        break;
      case 'toast': G3.toast(m.m, m.k); break;
      default: break;
    }
    emit(m.t, m);
    emit('any', m);
  }

  // ---------------------------------------------------------------- shared header / summary bindings
  G3.summary = () => {
    const r = G3.state.room, me = G3.me();
    const ping = r && me && !r.host && me.ping != null ? me.ping : G3.state.ping;
    return {
      link: r ? (G3.TRANSPORTS[r.transport] || r.transport.toUpperCase()) : 'NONE',
      players: r ? `${r.slots.length}/${r.max}` : '0/0',
      ping: ping == null ? '--' : `${ping}ms`,
      state: r ? (r.link === 'up' ? (r.phase === 'playing' ? 'IN_GAME' : 'LINKED') : 'OPENING') : (G3.state.status.state || 'idle').toUpperCase(),
    };
  };
  function bindChips() {
    const s = G3.summary();
    G3.$$('[data-bind]').forEach((el) => { const v = s[el.dataset.bind]; if (v != null) el.textContent = v; });
  }
  ['init', 'room', 'status', 'pong', 'closed', 'conn'].forEach((t) => G3.on(t, bindChips));

  // ---------------------------------------------------------------- who is logged in (the server also guards the pages)
  function authChip() {
    fetch('/api/auth/status', { cache: 'no-store' }).then((r) => r.json()).then((s) => {
      if (!s.enabled) return;
      if (!s.cleared) { location.href = 'login.html'; return; }
      const d = document.createElement('div');
      d.id = 'authChip';
      d.style.cssText = 'position:fixed;left:10px;bottom:8px;z-index:60;font:11px "Share Tech Mono",monospace;color:#22aa44;background:rgba(5,13,6,.92);border:1px solid #156628;padding:3px 8px';
      d.innerHTML = `OPERATOR <b style="color:#33FF66">${G3.esc(s.name)}</b> // <span style="color:#FFB000">${G3.esc(s.rank)} L${s.level}</span> // <a href="login.html" id="authOut" style="color:#FF3366">LOGOUT</a>`;
      document.body.appendChild(d);
      d.querySelector('#authOut').addEventListener('click', (e) => {
        e.preventDefault();
        fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .finally(() => { location.href = 'login.html'; });
      });
    }).catch(() => { /* server gone: the offline banner says so */ });
  }

  document.addEventListener('DOMContentLoaded', () => {
    authChip();
    applyPrefs();
    G3.$$('[data-beep-label]').forEach((b) => b.addEventListener('click', () => {
      G3.setPref('beep', !G3.prefs.beep); if (G3.prefs.beep) G3.beep(880, 0.1);
    }));
    // every clickable terminal control gets a little chirp
    document.addEventListener('click', (e) => { if (e.target.closest('button,a,[data-chirp]')) G3.beep(640, 0.04); }, true);
    bindChips();
    connect();
  });
})();
