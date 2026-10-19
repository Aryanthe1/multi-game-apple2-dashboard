/* Settings: profile, CRT display, audio, key bindings, alerts, network link, diagnostics. */
(function () {
  'use strict';
  const { $, $$, esc } = G3;

  const ON = 'px-2 py-1 bg-primary-container text-surface-container-lowest text-[11px]';
  const OFF = 'px-2 py-1 bg-surface-container-highest text-on-surface-variant text-[11px] hover:text-on-surface';
  const ACTIONS = [
    ['prev', 'CUBE ROTATE: PREVIOUS CARTRIDGE (+ A / W)'],
    ['next', 'CUBE ROTATE: NEXT CARTRIDGE (+ D / S)'],
    ['exec', 'PRIMARY EXECUTE (+ SPACE)'],
    ['back', 'EMERGENCY ABORT / BACK TO LAUNCHER'],
    ['ready', 'TOGGLE READY (ROOM LOBBY)'],
    ['chat', 'FOCUS THE CHAT LINE (+ /)'],
  ];
  const DEFAULT_KEYS = { prev: 'ArrowLeft', next: 'ArrowRight', exec: 'Enter', back: 'Escape', ready: 'KeyR', chat: 'KeyT' };
  const NET_FIELDS = [
    ['LAN PORT (TCP)', 'lan_port', 'number'], ['RELAY ADDRESS', 'relay', 'text'], ['RELAY ROOM CODE', 'relay_room', 'text'],
    ['ONLINE ROOM CODE', 'room_code', 'text'], ['LORA SERIAL PORT', 'lora_device', 'text'], ['LORA ROOM CODE', 'lora_room', 'text'],
  ];
  let capturing = null, captureTimer = null, editingName = false, purgeArmed = false, initAt = 0, ports = [];
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const patch = (p) => G3.send('settings', { patch: p });

  // ---------------------------------------------------------------- 01 profile
  function renderProfile() {
    const s = G3.state.settings, r = G3.state.room, sum = G3.summary();
    if (!s.name) return;
    const av = s.avatar | 0, [bg, fg] = G3.AV_COLORS[av % G3.AV_COLORS.length];
    const big = $('#avatarBig'); big.textContent = G3.AVATARS[av]; big.style.background = bg; big.style.color = fg;
    set('hdrAvatar', G3.AVATARS[av]); $('#hdrAvatar').style.background = bg;
    set('handle', `@${s.name}`);
    const role = r ? (r.host ? 'HOST' : 'GUEST') : 'OFFLINE';
    set('statusLine', r ? `[${role}] STATUS: IN ROOM (${sum.players})` : '[OFFLINE] STATUS: IDLE');
    set('navRole', `[${role}]`);
    set('sessionBadge', r ? '[ ACTIVE SESSION ]' : '[ NO SESSION ]');
    set('clientId', `CLIENT_ID: ${s.client_id}`);
    $('#nameRow').innerHTML = editingName
      ? `<div class="flex items-center gap-2 flex-1"><span class="text-on-surface-variant font-label-md text-[11px]">DISPLAY NAME:</span>
           <input id="nameInput" maxlength="24" class="flex-1 bg-surface-container-lowest text-primary px-2 py-1 font-title-sm focus:outline-none border border-primary-container" value="${esc(s.name)}" autocomplete="off" spellcheck="false" style="user-select:text"></div>
         <div class="flex gap-2"><button class="px-space-sm py-1 bg-primary-container text-surface-container-lowest font-title-sm text-[11px]" data-name="save">[ SAVE ]</button>
         <button class="px-space-sm py-1 bg-surface-container-highest text-on-surface-variant font-title-sm text-[11px]" data-name="cancel">[ CANCEL ]</button></div>`
      : `<div class="flex items-center gap-2"><span class="text-on-surface-variant font-label-md text-[11px]">DISPLAY NAME:</span>
           <div class="font-title-sm text-primary tracking-wide flex items-center"><span>${esc(s.name)}</span><span class="inline-block w-2 h-4 bg-primary-container animate-pulse ml-0.5"></span></div></div>
         <button class="px-space-sm py-1 bg-surface-container-highest hover:bg-primary-container hover:text-surface-container-lowest text-primary-container font-title-sm text-[11px] transition-colors self-start sm:self-auto" data-name="edit">[ EDIT ]</button>`;
    if (editingName) { const i = $('#nameInput'); if (document.activeElement !== i) { i.focus(); i.select(); } }
    const leave = $('#btn-leave');
    leave.disabled = !r;
    leave.classList.toggle('opacity-40', !r);
    set('leaveLabel', !r ? '[ NO ACTIVE SESSION ]' : r.host ? '[ CLOSE ROOM ]' : '[ LEAVE SESSION ]');
  }

  // ---------------------------------------------------------------- 02-03 display & audio
  function renderPrefs() {
    const p = G3.prefs;
    ['scan', 'bloom', 'readable'].forEach((k) => {
      $(`[data-toggle=${k}]`).innerHTML = `<button class="${p[k] ? ON : OFF}" data-v="1">[ ON ]</button><button class="${p[k] ? OFF : ON}" data-v="0">[ OFF ]</button>`;
    });
    set('theme-label', `[ ${G3.THEMES[p.theme][0]} ]`);
    set('navTheme', `[P${[1, 3, 4, 'C'][p.theme]}]`);
    set('scan-val', `${p.scanOp}%`); set('scan-bar', G3.bar(p.scanOp));
    set('sfx-val', `${p.sfx}%`); set('sfx-bar', G3.bar(p.sfx));
    set('bgm-val', p.bgm ? `${p.bgm}%` : 'OFF'); set('bgm-bar', G3.bar(p.bgm));
    set('music-val', p.music ? `${p.music}%` : 'OFF'); set('music-bar', G3.bar(p.music));
    set('navAudio', p.beep ? `[${p.sfx}%]` : '[MUTE]');
    set('btn-audio-chip', `[ ◄ ${G3.CHIPS[p.chip].name} ► ]`);
    $$('[data-alert]').forEach((b) => {
      const k = b.dataset.alert, on = k === 'beep' ? p.beep : p.alerts[k];
      b.className = `px-2 py-0.5 font-title-sm text-[11px] ${on ? 'bg-primary-container text-surface-container-lowest' : 'bg-surface-container-highest text-on-surface-variant'}`;
      b.textContent = on ? '[ ON ]' : '[ OFF ]';
    });
    renderKeys();
  }

  function renderKeys() {
    const K = G3.prefs.keys;
    $('#keyRows').innerHTML = ACTIONS.map(([k, label]) => `<div class="grid grid-cols-12 items-center py-1.5 px-1 hover:bg-surface-container transition-colors">
      <div class="col-span-7 text-primary flex items-center gap-1.5"><span class="text-primary-container">&gt;</span><span>${label}</span></div>
      <div class="col-span-5 text-right"><button data-key="${k}" class="px-2 py-0.5 ${capturing === k ? 'bg-primary-container text-surface-container-lowest' : 'bg-surface-container-high ' + (k === 'back' ? 'text-error' : 'text-primary-fixed')} font-title-sm text-[11px]">[ ${capturing === k ? 'PRESS ANY KEY...' : esc(G3.keyName(K[k]))} ]</button></div></div>`).join('');
    const custom = ACTIONS.some(([k]) => K[k] !== DEFAULT_KEYS[k]);
    set('mapProfile', `CUSTOM MAP PROFILE: ${custom ? 'CUSTOM.MAP' : 'USER_DEFAULT.MAP'}`);
    set('keysMapped', `[ ${ACTIONS.length + 6} KEYS MAPPED ]`);
  }

  function slider(el, evt) {
    const key = el.dataset.slider, bar = $(`#${key === 'scanOp' ? 'scan' : key}-bar`);
    const r = bar.getBoundingClientRect();
    const n = Math.max(0, Math.min(14, Math.round((evt.clientX - r.left) / r.width * 14)));
    const pct = Math.round(n / 14 * 100);
    if (key === 'bgm' && pct > 0) G3.audio();
    G3.setPref(key, key === 'scanOp' ? Math.max(5, pct) : pct);
    G3.beep(500 + n * 40, 0.03);
    flashSaved();
  }

  // ---------------------------------------------------------------- 06 network, telemetry
  function renderNet() {
    const s = G3.state.settings, host = $('#netForm');
    if (!s.name) return;
    if (!host.children.length) {
      host.innerHTML = NET_FIELDS.map(([label, key, type]) => `<label class="bg-surface-container p-space-sm text-[11px] space-y-1 block"><span class="text-on-surface-variant font-label-md">${label}:</span>
        <input class="w-full bg-surface-container-lowest text-primary px-2 py-1 focus:outline-none border border-transparent focus:border-primary-container" data-set="${key}" type="${type}" ${key === 'lora_device' ? 'list="portlist"' : ''} autocomplete="off" spellcheck="false" style="user-select:text"></label>`).join('')
        + '<datalist id="portlist"></datalist>';
    }
    NET_FIELDS.forEach(([, key]) => { const i = $(`[data-set="${key}"]`); if (i && document.activeElement !== i) i.value = s[key] ?? ''; });
    $('#portlist').innerHTML = ports.map((p) => `<option value="${esc(p[0])}">${esc(p[1] || '')}</option>`).join('');
    set('ipList', G3.state.ips.join('   ') || '---');
  }

  function tele() {
    const sum = G3.summary(), r = G3.state.room, init = G3.state.init;
    set('teleBridge', G3.state.online ? 'ONLINE' : 'OFFLINE');
    set('crumbBridge', G3.state.online ? 'ONLINE' : 'OFFLINE');
    set('teleLink', sum.link); set('navLink', `[${sum.link}]`);
    set('teleRoom', r ? (r.code || 'LAN') : '---');
    set('telePlayers', sum.players);
    set('telePing', sum.ping);
    set('netNow', r ? `${sum.link} // ${r.host ? 'HOSTING' : 'GUEST'} // ${sum.players} PLAYERS` : sum.state);
    if (init) {
      const up = init.uptime + Math.floor((Date.now() - initAt) / 1000);
      const t = `${String(Math.floor(up / 3600)).padStart(2, '0')}:${String(Math.floor(up / 60) % 60).padStart(2, '0')}:${String(up % 60).padStart(2, '0')}`;
      set('teleUp', t); set('aboutUp', t);
      set('crumbVer', `v${init.version}`); set('navVer', `[v${init.version}]`); set('aboutVer', `${init.version}-alpha`); set('footVer', `${init.version}-alpha`);
      set('aboutPy', init.python);
    }
    const pings = G3.state.pings;
    if (pings.length) {
      const hi = Math.max(5, ...pings), ramp = '▁▂▃▄▅▆▇█';
      set('spark', pings.map((v) => ramp[Math.min(7, Math.floor(v / hi * 7.99))]).join(' '));
      set('spark-max', `MAX ${Math.max(...pings)}ms`);
    }
  }

  function flashSaved() {
    set('saveBadge', '[ NVRAM: WRITING ]');
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => set('saveBadge', '[ NVRAM: SAVED ]'), 500);
  }

  // ---------------------------------------------------------------- terminal commands
  function runCommand(line) {
    const words = line.trim().split(/\s+/), cmd = words[0].toUpperCase(), arg = words.slice(1).join(' ');
    const sum = G3.summary(), r = G3.state.room;
    G3.beep(1040, 0.04);
    switch (cmd) {
      case 'HELP': G3.toast('AVAILABLE: STATUS, IPS, NAME <X>, THEME, BEEP, PING, LEAVE, CLEAR'); break;
      case 'STATUS': G3.toast(`LINK ${sum.link} // ${sum.state} // PLAYERS ${sum.players} // PING ${sum.ping}`); break;
      case 'IPS': G3.toast('ADDR: ' + (G3.state.ips.join(', ') || 'NONE')); break;
      case 'NAME':
        if (!arg) G3.toast(`NAME IS ${G3.state.settings.name}`); else { patch({ name: arg }); G3.toast(`NAME -> ${arg.slice(0, 24)}`); }
        break;
      case 'THEME': G3.setPref('theme', (G3.prefs.theme + 1) % G3.THEMES.length); G3.toast(`DISPLAY COLORWAY: ${G3.THEMES[G3.prefs.theme][0]}`); break;
      case 'BEEP': G3.beep(1500, 0.1); G3.toast('BEEP OK.'); break;
      case 'PING': G3.toast(`BRIDGE PING ${G3.state.ping == null ? '--' : G3.state.ping + 'ms'}`); break;
      case 'LEAVE': if (r) { G3.send('leave'); G3.toast('LEAVING THE ROOM...'); } else G3.toast('NOT IN A ROOM'); break;
      case 'CLEAR': $('#diagOut').classList.add('hidden'); G3.toast('READY.'); break;
      default: G3.toast(`ERR: UNRECOGNIZED SYNTAX '${cmd}'`, 'err');
    }
  }

  function selfTest() {
    const out = $('#diagOut'), samples = [], N = 5;
    out.classList.remove('hidden'); out.textContent = `LINK SELF-TEST: ${N} PINGS TO THE BRIDGE...\n`;
    let sent = 0;
    const onPong = (m) => {
      samples.push(G3.state.ping);
      out.textContent += `  #${samples.length}: ${G3.state.ping}ms\n`;
      if (samples.length >= N) done(); else next();
    };
    const next = () => { sent += 1; G3.send('ping', { ts: performance.now() }); };
    const done = () => {
      off();
      const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
      out.textContent += `RESULT: AVG ${avg}ms  MIN ${Math.min(...samples)}ms  MAX ${Math.max(...samples)}ms  LOSS 0/${N}\n`;
      G3.toast(`SELF-TEST PASS: AVG ${avg}ms`);
    };
    const list = G3.listeners.pong, off = () => { const i = list.indexOf(onPong); if (i >= 0) list.splice(i, 1); clearTimeout(t); };
    list.push(onPong);
    const t = setTimeout(() => { off(); out.textContent += `TIMEOUT: ${samples.length}/${N} REPLIES. IS THE BRIDGE RUNNING?\n`; G3.toast('SELF-TEST FAILED', 'err'); }, 6000);
    next();
  }

  // ---------------------------------------------------------------- wiring
  G3.on('init', (m) => {
    initAt = Date.now();
    G3.send('diag');
    if (m.serial) G3.send('ports');
    renderAll();
  });
  G3.on('settings', () => { renderProfile(); renderNet(); flashSaved(); });
  ['room', 'closed', 'status', 'pong', 'conn'].forEach((t) => G3.on(t, () => { tele(); renderProfile(); }));
  G3.on('ports', (m) => { ports = m.ports; renderNet(); });
  G3.on('diag', (m) => {
    set('dataDir', m.data);
    const out = $('#diagOut');
    if (out.dataset.want) {
      out.classList.remove('hidden');
      out.textContent = m.log ? m.log : '(no online room log yet: it is written when you host or join with a room code)';
      delete out.dataset.want;
    }
  });
  G3.on('prefs', renderPrefs);

  function renderAll() { renderProfile(); renderPrefs(); renderNet(); tele(); }

  document.addEventListener('DOMContentLoaded', () => {
    renderPrefs();
    // left nav + top tabs scroll to their section
    $$('.nav-btn').forEach((b) => b.addEventListener('click', () => {
      $$('.nav-btn').forEach((o) => {
        const on = o === b;
        o.setAttribute('aria-current', on ? 'true' : 'false');
        o.classList.toggle('text-on-surface-variant', !on);
        o.querySelector('.nav-cursor').classList.toggle('opacity-0', !on);
      });
      document.getElementById(b.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    $$('[data-goto]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      $$('#topnav [data-goto]').forEach((o) => {
        const on = o === a;
        o.classList.toggle('bg-primary-container', on); o.classList.toggle('text-on-primary-container', on);
        o.classList.toggle('text-on-surface-variant', !on);
      });
      document.getElementById(a.dataset.goto).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    document.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const tog = t.parentElement && t.parentElement.dataset.toggle;
      if (tog) { G3.setPref(tog, t.dataset.v === '1'); G3.toast({ scan: G3.prefs.scan ? 'SCANLINES: ACTIVE // 525-LINE SYNC OK.' : 'SCANLINES: DISABLED // FLAT RASTER.',
        bloom: G3.prefs.bloom ? 'PHOSPHOR BLOOM: ENGAGED.' : 'PHOSPHOR BLOOM: DISENGAGED.',
        readable: G3.prefs.readable ? 'READABLE TEXT: ON.' : 'READABLE TEXT: OFF // ORIGINAL SMALL PRINT.' }[tog]); flashSaved(); return; }
      if (t.dataset.alert) {
        const k = t.dataset.alert, cur = k === 'beep' ? G3.prefs.beep : G3.prefs.alerts[k];
        G3.setPref(k === 'beep' ? 'beep' : `alerts.${k}`, !cur); flashSaved(); return;
      }
      if (t.dataset.name) {
        const a = t.dataset.name;
        if (a === 'edit') { editingName = true; renderProfile(); }
        else if (a === 'cancel') { editingName = false; renderProfile(); }
        else if (a === 'save') saveName();
        return;
      }
      if (t.dataset.key) {
        capturing = t.dataset.key; renderKeys(); clearTimeout(captureTimer);
        captureTimer = setTimeout(() => { capturing = null; renderKeys(); }, 6000);
        G3.toast('PRESS ANY KEY TO BIND, OR WAIT TO CANCEL...');
        return;
      }
      switch (t.id) {
        case 'theme-prev': case 'theme-next': {
          const n = G3.THEMES.length, d = t.id === 'theme-next' ? 1 : -1;
          G3.setPref('theme', (G3.prefs.theme + d + n) % n);
          G3.toast(`DISPLAY COLORWAY SWITCHED TO: ${G3.THEMES[G3.prefs.theme][0]}`); flashSaved(); break;
        }
        case 'btn-audio-chip': {
          const n = G3.CHIPS.length, d = e.shiftKey ? -1 : 1;
          G3.setPref('chip', (G3.prefs.chip + d + n) % n); G3.beep(640, 0.06);
          G3.toast(`HARDWARE LATCHED: ${G3.CHIPS[G3.prefs.chip].name}`); flashSaved(); break;
        }
        case 'btn-change-avatar': {
          const n = G3.AVATARS.length, cur = G3.state.settings.avatar | 0;
          G3.send('avatar', { i: (cur + (e.shiftKey ? -1 : 1) + n) % n }); break;
        }
        case 'btn-leave': G3.send('leave'); G3.toast('SIGNAL: CLOSE PACKET SENT.'); break;
        case 'btn-purge':
          if (!purgeArmed) {
            purgeArmed = true; set('purgeLabel', '[ CLICK AGAIN TO CONFIRM ]');
            setTimeout(() => { purgeArmed = false; set('purgeLabel', '[ RESET LOCAL DATA ]'); }, 4000);
          } else {
            purgeArmed = false; set('purgeLabel', '[ RESET LOCAL DATA ]');
            G3.send('reset'); G3.resetPrefs(); G3.toast('ARCHIVE PURGED: ALL SETTINGS RESTORED TO DEFAULTS.');
          }
          break;
        case 'btn-remap':
          ACTIONS.forEach(([k]) => { G3.prefs.keys[k] = DEFAULT_KEYS[k]; });
          G3.setPref('keys', Object.assign({}, DEFAULT_KEYS)); G3.toast('KEY MAP RESET TO USER_DEFAULT.MAP'); break;
        case 'btn-self-test': selfTest(); break;
        case 'btn-dump-log': $('#diagOut').dataset.want = '1'; G3.send('diag'); break;
        case 'cmd-submit-btn': { const i = $('#terminal-cmd'); if (i.value.trim()) { runCommand(i.value); i.value = ''; } break; }
        default: break;
      }
    });

    $$('[data-slider]').forEach((el) => el.addEventListener('click', (e) => slider(el, e)));

    // capture the next key for a remap
    window.addEventListener('keydown', (e) => {
      if (!capturing) return;
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
      e.preventDefault(); e.stopPropagation();
      const taken = ACTIONS.find(([k]) => k !== capturing && G3.prefs.keys[k] === e.code);
      if (taken) G3.toast(`${G3.keyName(e.code)} IS ALREADY BOUND TO: ${taken[1].split(' (')[0]}`, 'err');
      else { G3.setPref(`keys.${capturing}`, e.code); G3.toast(`BOUND ${capturing.toUpperCase()} -> ${G3.keyName(e.code)}`); flashSaved(); }
      capturing = null; clearTimeout(captureTimer); renderKeys();
    }, true);

    // text inputs: name editing, network fields, command tape
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'nameInput') saveName();
      else if (e.target.id === 'terminal-cmd' && e.target.value.trim()) { runCommand(e.target.value); e.target.value = ''; }
      else if (e.target.dataset && e.target.dataset.set) e.target.blur();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editingName) { e.stopPropagation(); editingName = false; renderProfile(); } });
    document.addEventListener('change', (e) => {
      const key = e.target.dataset && e.target.dataset.set;
      if (!key) return;
      const v = e.target.type === 'number' ? parseInt(e.target.value, 10) : e.target.value.trim();
      patch({ [key]: v }); G3.toast(`SAVED ${key.toUpperCase()}`);
    });
    // Esc (or the bound key) goes back to the launcher when nothing else is happening
    window.addEventListener('keydown', (e) => {
      if (capturing || editingName || (e.target.matches && e.target.matches('input,textarea'))) return;
      if (e.code === G3.prefs.keys.back) location.href = 'index.html';
    });

    setInterval(tele, 1000);
    renderAll();
  });

  function saveName() {
    const i = $('#nameInput');
    const name = i ? i.value.trim() : '';
    if (!name) { G3.toast('A NAME CAN NOT BE EMPTY', 'err'); return; }
    patch({ name }); editingName = false; renderProfile(); G3.toast(`DISPLAY NAME -> ${name.slice(0, 24)}`);
  }
}());
