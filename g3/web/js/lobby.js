/* Lobby: link setup (host / join over LAN, room code, relay, LoRa), the room itself,
   the roster and chat tape, and the stand-in screen while a game "runs". */
(function () {
  'use strict';
  const { $, $$, esc } = G3;

  const BLURBS = {
    bobble_league: ['Two teams of slimes and one glowing ball.', 'Bounce, head and slide the ball into the other goal.', 'Most goals when the clock runs out wins.'],
    sketch_rumble: ['1 player draws the secret prompt.', 'Everyone else guesses the word in real time.', 'The fastest correct guesses win the most points.'],
    kart_odyssey: ['Cosmic grand-prix racing for up to 4 puffers.', 'Drift through nebula tracks, grab boosts, take the cup.'],
    letter_league: ['A co-op word puzzle on one shared board.', 'Longer words and combos score for the whole team.'],
    liars_bar: ['Deck bluffing and dice for 2-4 players.', 'Play cards face-down, call a bluff, outlast the table.'],
    whos_away: ['A co-op mystery escape room in an empty mansion.', 'Search rooms, combine clues and crack the lock together.'],
  };

  const ui = { mode: 'online', role: 'host', code: '', addr: '', rroom: '', device: '', lroom: 'FORGE', ip: '', max: 8, ports: null, game: null };
  let log = [];
  let hadRoom = false, ready = false, pulses = [], pulseN = 0;
  const params = new URLSearchParams(location.search);

  const roomOf = () => G3.state.room;
  const gid = () => { const r = roomOf(); return r ? r.game : (ui.game || G3.state.settings.game); };
  const gameNow = () => G3.game(gid());
  const isHost = () => { const r = roomOf(); return !r || r.host; };
  const busy = () => ['connecting', 'searching'].includes(G3.state.status.state);

  const chip = (label, on, attrs, cls = '') => `<button ${attrs} class="border px-1.5 py-0.5 ${on
    ? 'border-[#33FF66] bg-[#33FF66] text-[#050d06] font-bold shadow-[0_0_6px_#33FF66]'
    : 'border-[#156628] text-[#22aa44] hover:text-[#33FF66] hover:border-[#33FF66]'} ${cls}">${label}</button>`;
  const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const clock = (ts) => { const d = ts ? new Date(ts * 1000) : null; return d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '--:--'; };

  // ---------------------------------------------------------------- hero, boot bar, footer
  function renderTop() {
    const r = roomOf(), g = gameNow(), s = G3.summary(), st = G3.state.status;
    if (!g) return;
    const idx = G3.state.catalog.indexOf(g);
    $('#heroImg').src = $('#heroBlur').src = `assets/covers/${g.id}.png`;
    $('#heroTape').textContent = `┌── GAME_CARTRIDGE_PREVIEW // FACET_F${idx + 1} ──────────────────────┐`;
    const lan = r && r.transport === 'lan';
    const where = r ? (r.code || (lan ? `${G3.state.ips[0] || '?'}:${G3.state.settings.lan_port || ''}` : '---')) : '---';
    $('#badgeTransport').textContent = r ? s.link : '---';
    $('#badgePlayers').textContent = `${g.min}-${g.max}`;
    $('#badgeRoom').textContent = where;
    const phase = !r ? 'IDLE' : r.link !== 'up' ? 'LINKING' : r.phase === 'playing' ? 'RUNNING' : 'IN_LOBBY';
    $('#bootTitle').textContent = `BOOT // ${g.exe}: ${phase}`;
    $('#bootRoom').textContent = `ROOM: ${where}`;
    $('#bootPhase').textContent = `PHASE: ${phase}`;
    $('#bootLoad').textContent = `> LOADING ${g.exe}...`;
    const n = r ? r.slots.length : 0, max = r ? r.max : 0;
    const f = max ? Math.round(n / max * 20) : 0;
    $('#bootBar').textContent = `[${'█'.repeat(f)}${'░'.repeat(20 - f)}] ${n} / ${max} SLOTS`;
    $('#bootMsg').textContent = st.state === 'error' ? `> ERROR: ${st.msg}` : st.msg ? `> ${st.msg}` : r ? `> LINK ${r.link === 'up' ? 'ESTABLISHED' : 'OPENING'} // ${s.players} PLAYERS` : '> STATUS: NO LINK';
    $('#hdr-sub').textContent = G3.state.online ? `G3_LINK_HUB: BRIDGE OK // v${G3.state.init ? G3.state.init.version : '?'}` : 'G3_LINK_HUB: BRIDGE OFFLINE';
    $('#bridgeState').textContent = G3.state.online ? 'ONLINE' : 'OFFLINE';
    $('#footConn').textContent = `CONNECTION: ${r ? (r.link === 'up' ? 'STABLE' : 'OPENING') : 'NONE'}`;
    const can = isHost() && !(r && r.phase === 'playing');
    $('#facets').innerHTML = G3.state.catalog.map((c, i) => c.id === g.id
      ? `<span class="border border-[#33FF66] bg-[#33FF66] text-[#050d06] px-1.5 py-0.5 font-bold shadow-[0_0_8px_#33FF66]">[■ F${i + 1} ACTIVE]</span>`
      : `<button ${can ? `data-act="game" data-id="${c.id}"` : 'disabled'} title="${esc(c.exe)}" class="border border-[#156628] px-1.5 py-0.5 text-[#22aa44] hover:border-[#33FF66]">[F${i + 1}]</button>`).join('');
  }

  // ---------------------------------------------------------------- the main panel
  function readoutHTML(r, g) {
    const gmax = r ? r.gmax : g.max;
    const opts = [2, 4, 8, 16].filter((v) => v <= gmax);
    const cur = r ? r.max : ui.max;
    if (!opts.includes(cur)) opts.push(cur);
    opts.sort((a, b) => a - b);
    const host = isHost();
    const chips = opts.map((v) => {
      const lab = v === 16 ? '16 MAX' : `${v} PLAYERS${v === cur ? ' - ACTIVE' : ''}`;
      return host ? chip(`[ ${lab} ]`, v === cur, `data-act="max" data-v="${v}"`) : chip(`[ ${lab} ]`, v === cur, 'disabled');
    }).join(' ');
    const s = G3.summary();
    const where = r ? (r.code ? `#${r.code}` : `${G3.state.ips[0] || '?'}:${G3.state.settings.lan_port}`) : '---';
    return `<div class="border border-[#156628] bg-[#071208] p-2.5 text-[11px] md:text-xs leading-relaxed space-y-1">
      <div class="flex flex-wrap items-center justify-between"><span class="text-[#33FF66] font-bold">GAME: ${esc(g.name.split('/')[0].trim())}</span><span class="text-[#22aa44]">GENRE: ${esc(g.genre)}</span></div>
      <div class="text-[#22aa44] flex flex-wrap items-center gap-1.5 pt-1"><span>MODE:</span>${chips}</div>
      <div class="flex flex-wrap items-center justify-between text-[10px] md:text-[11px] text-[#22aa44] pt-1 border-t border-[#156628]/60">
        <span>PING: <span class="text-[#33FF66]">${esc(s.ping)}</span> // LINK: <span class="text-[#33FF66]">${esc(r ? s.link : 'NONE')}</span></span>
        <span>CHANNEL: <span class="text-[#00eefc] selectable">${esc(where)}</span></span>
      </div>
      ${r ? `<div class="text-[10px] md:text-[11px] text-[#FFB000] font-pixel pt-0.5">LOBBY: ${r.slots.length} / ${r.max} PLAYERS CONNECTED</div>` : ''}
    </div>`;
  }

  function slotsHTML(r) {
    const cells = [];
    for (let i = 0; i < r.max; i++) {
      const s = r.slots[i];
      if (!s) {
        cells.push(`<div class="border border-dashed border-[#156628] bg-[#020703] p-1.5 flex flex-col items-center justify-center text-center" style="opacity:${Math.max(0.3, 0.7 - i * 0.05)}">
          <div class="w-8 h-8 border border-dashed border-[#156628] text-[#156628] flex items-center justify-center font-pixel text-xs mb-1"><span class="cursor-blink">_</span></div>
          <span class="text-[8px] font-mono text-[#156628] truncate w-full">[EMPTY_SLOT]</span><span class="text-[7px] font-mono text-[#156628] mt-1">OPEN</span></div>`);
        continue;
      }
      const [bg, fg] = G3.AV_COLORS[s.av % G3.AV_COLORS.length], you = s.id === r.you, host = s.role === 'HOST';
      const kick = r.host && !host ? `<button data-act="kick" data-id="${s.id}" title="Remove ${esc(s.n)} from the room" class="absolute top-0 right-0 text-[8px] leading-none px-1 py-0.5 border border-[#156628] text-[#FF3366] hover:bg-[#FF3366] hover:text-[#050d06]">X</button>` : '';
      cells.push(`<div class="relative border ${you ? 'border-[#00eefc]' : 'border-[#33FF66]'} bg-[#071509] p-1.5 flex flex-col items-center justify-center text-center shadow-[0_0_6px_rgba(51,255,102,0.3)] hover:bg-[#0c2410] transition-colors">
        ${kick}${host ? '<span class="absolute top-0 left-0.5 text-[10px] leading-none">👑</span>' : ''}
        <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm mb-1" style="background:${bg};color:${fg};box-shadow:0 0 6px ${bg}">${G3.AVATARS[s.av % G3.AVATARS.length]}</div>
        <span class="text-[9px] font-mono text-[#33FF66] font-bold truncate w-full" title="${esc(s.n)}">@${esc(s.n)}</span>
        ${host ? '<span class="text-[8px] font-pixel text-[#FFB000] leading-tight mt-0.5">(HOST)</span>'
               : `<span class="text-[8px] font-mono text-[#22aa44] mt-0.5">${s.ping == null ? '--' : s.ping + 'ms'}</span>`}
        <span class="text-[7px] font-mono ${host || s.ready ? 'text-[#33FF66]' : 'text-[#FFB000]'}">[${host || s.ready ? 'READY' : 'WAITING'}]${you ? ' YOU' : ''}</span></div>`);
    }
    return cells.join('');
  }

  function canStart(r, g) {
    if (r.link !== 'up') return [false, 'THE LINK IS STILL OPENING'];
    if (r.slots.length < g.min) return [false, `${g.exe} NEEDS ${g.min}+ PLAYERS`];
    const wait = r.slots.filter((s) => s.role !== 'HOST' && !s.ready).map((s) => '@' + s.n);
    if (wait.length) return [false, 'WAITING FOR: ' + wait.join(', ')];
    return [true, 'ALL PLAYERS READY'];
  }

  const bigBtn = (attrs, label, sub = '', dis = false) => `<button ${attrs} ${dis ? 'disabled' : ''} class="w-full border-2 border-[#33FF66] bg-[#050d06] hover:bg-[#33FF66] hover:text-[#050d06] font-pixel text-sm md:text-base py-3.5 px-4 text-center tracking-wider transition-all duration-150 box-glow-green active:scale-[0.99] flex items-center justify-center gap-2">
      <span class="text-base">▶</span><span class="tracking-widest font-bold">${label}</span></button>${sub ? `<div class="text-center text-[12px] text-[#FFB000]">${sub}</div>` : ''}`;
  const small = (attrs, label, col = '#33FF66') => `<button ${attrs} class="border border-[#156628] hover:border-[${col}] hover:bg-[${col}] hover:text-[#050d06] bg-[#071208] text-[${col}] py-2 px-2 text-center transition-colors font-mono">${label}</button>`;

  function joinInfo(r) {
    const st = G3.state.settings;
    if (r.transport === 'lan') {
      const all = G3.state.ips.map((ip) => `${ip}:${st.lan_port}`);
      return ['SAME WI-FI/NETWORK ONLY', all[0] || '?', 'Friends run G3 > WI-FI/LAN > JOIN > SEARCH LAN, or type this address.' + (all.length > 1 ? ` If it fails, try: ${all.slice(1).join('  ')}` : '')];
    }
    if (r.transport === 'online') return ['ROOM CODE (WORKS FROM ANYWHERE)', r.code, 'Friends run G3 > ROOM CODE > JOIN A ROOM, type this code, press JOIN ROOM.'];
    if (r.transport === 'relay') return ['RELAY ROOM', `${r.code}  @  ${st.relay}`, 'Friends run G3 > RELAY > JOIN A ROOM with this address and room code.'];
    return ['RADIO ROOM', r.code, 'Your friend picks LORA RADIO > JOIN A ROOM with the same room code.'];
  }

  function lobbyHTML(r, g) {
    const me = G3.me(), [ok, why] = canStart(r, g);
    const [invLabel, invValue, invHow] = joinInfo(r);
    const invite = r.host && r.slots.length < r.max ? `<div class="border border-[#FFB000] bg-[#071208] p-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div class="min-w-0"><div class="text-[10px] text-[#FFB000] font-bold">&gt; INVITE FRIENDS // ${invLabel}</div>
          <div class="text-base md:text-lg text-[#00eefc] font-bold break-all selectable">${esc(invValue)}</div>
          <div class="text-[11px] text-[#22aa44]">${esc(invHow)}</div></div>
        ${small('data-act="invite"', '[ COPY INVITE ]', '#FFB000')}</div>` : '';
    const host = r.host;
    const primary = host
      ? bigBtn('data-act="start"', '[ PRESS TO ENTER GAME ]', `> ${why}`, !ok)
      : bigBtn('data-act="ready"', me && me.ready ? '[ ✔ READY - PRESS TO UNREADY ]' : '[ PRESS WHEN READY ]', me && me.ready ? '> WAITING FOR THE HOST TO START' : '> THE HOST STARTS WHEN EVERYONE IS READY');
    return `${r.link !== 'up' ? `<div class="border border-[#FFB000] text-[#FFB000] bg-[#071208] p-2 text-[11px]">&gt; LINK OPENING: ${esc(G3.state.status.msg || 'please wait')}</div>` : ''}
      ${invite}${readoutHTML(r, g)}
      <div><div class="text-[10px] font-mono text-[#22aa44] mb-1.5 flex justify-between"><span>ACTIVE_LOBBY_SLOTS [${r.max}-AXIS_PARTICIPANTS]:</span><span class="text-[#33FF66]">STATUS: ${ok ? 'ALL_READY' : 'READY_CHECK'}</span></div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${slotsHTML(r)}</div></div>
      <div class="pt-2 space-y-2.5">${primary}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] md:text-xs">
          ${small('data-act="invite"', '[ + COPY INVITE ]')}${small('data-act="rules"', '[ ? VIEW RULES ]', '#00eefc')}
          <a href="index.html" class="border border-[#156628] hover:border-[#FFB000] hover:bg-[#FFB000] hover:text-[#050d06] bg-[#071208] text-[#FFB000] py-2 px-2 text-center transition-colors">[ &lt; BACK TO CUBE ROTATOR ]</a>
          ${small('data-act="leave"', host ? '[ CLOSE ROOM ]' : '[ LEAVE ROOM ]', '#FF3366')}
        </div></div>`;
  }

  function playingHTML(r, g) {
    const names = Object.fromEntries(r.slots.map((s) => [s.id, s.n]));
    const feed = pulses.slice(-6).map((p) => `<div>&gt; PULSE #${p.n} FROM <span class="text-[#00eefc]">@${esc(p.from === r.you ? 'YOU' : names[p.from] || '?')}</span></div>`).join('') || '<div class="text-[#156628]">&gt; (no pulses yet)</div>';
    return `<div class="border border-[#33FF66] bg-[#071208] p-3 space-y-2 text-[11px] md:text-xs">
      <div class="text-[#33FF66] text-[12px] select-none">╔══ GAME_MODULE // ${esc(g.exe)} ═══════════════════╗</div>
      <div class="text-[#22aa44]">&gt; LINK ESTABLISHED // ${r.slots.length} PLAYERS // ROOM SEED <span class="text-[#00eefc]">${hex(r.seed)}</span></div>
      <div class="text-[#FFB000]">&gt; GAME MODULE NOT INSTALLED IN THIS BUILD.</div>
      <div class="text-[#22aa44]">&gt; The launcher, the lobby and the multiplayer link are live. A game plugs into the room's game channel: every JSON message a player sends is relayed through the host to everybody else.</div>
      <div class="border border-[#156628] bg-[#020703] p-2 space-y-0.5 text-[#22aa44]"><div class="text-[#33FF66] font-pixel text-[9px] mb-1">LINK_TEST // GAME CHANNEL</div>${feed}</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        ${small('data-act="pulse"', '[ SEND TEST PULSE ]', '#00eefc')}
        ${r.host ? small('data-act="stopgame"', '[ BACK TO LOBBY ]', '#FFB000') : '<div class="border border-[#156628] text-[#156628] py-2 px-2 text-center">[ WAITING FOR HOST ]</div>'}
      </div></div>
      <div class="pt-1">${small('data-act="leave"', r.host ? '[ CLOSE ROOM ]' : '[ LEAVE ROOM ]', '#FF3366')}</div>`;
  }

  function setupHTML(g) {
    const st = G3.state.status, host = ui.role === 'host';
    if (busy()) {
      return `${readoutHTML(null, g)}
        <div class="border border-[#33FF66] bg-[#071208] p-4 text-center space-y-3">
          <div class="font-pixel text-[11px] text-[#33FF66] glow-green">${st.state === 'searching' ? 'SCANNING THE NETWORK' : 'ESTABLISHING LINK'}<span class="cursor-blink">_</span></div>
          <div class="text-[11px] text-[#22aa44]">${esc(st.msg || 'working...')}</div>
          ${small('data-act="cancel"', '[ ■ CANCEL ]', '#FF3366')}</div>`;
    }
    const MODES = [['online', 'ROOM CODE: ANYWHERE'], ['lan', 'WI-FI/LAN: SAME NETWORK'], ['relay', 'RELAY: YOUR SERVER'], ['lora', 'LORA RADIO']];
    const modeChips = MODES.map(([k, label]) => chip(`[ ${label} ]`, ui.mode === k, `data-act="mode" data-v="${k}"`)).join(' ');
    const roleChips = [['host', 'HOST A ROOM'], ['join', 'JOIN A ROOM']].map(([k, label]) => chip(`[ ${label} ]`, ui.role === k, `data-act="role" data-v="${k}"`)).join(' ');
    const field = (label, key, ph, extra = '') => `<label class="block text-[10px] text-[#22aa44] space-y-0.5"><span>${label}</span><input class="t-input" data-field="${key}" value="${esc(ui[key])}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false" ${extra}></label>`;
    const ports = ui.ports === null ? '<option>(looking for serial ports...)</option>'
      : ['<option value="">(type a port below)</option>'].concat(ui.ports.map((p) => `<option value="${esc(p[0])}" ${p[0] === ui.device ? 'selected' : ''}>${esc(p[0])} ${esc(p[1] || '')}</option>`)).join('');
    let fields = '', hint = '';
    if (ui.mode === 'lan') {
      const addrs = G3.state.ips.map((ip) => `${ip}:${G3.state.settings.lan_port}`).join('  ');
      if (host) hint = `Only for people on the same Wi-Fi/network. They run G3, pick WI-FI/LAN > JOIN > SEARCH LAN (or type one of: <span class="text-[#00eefc] selectable">${esc(addrs)}</span>). If Windows asks about the firewall, allow Python on private networks.`;
      else {
        const rows = st.state === 'results' ? (st.hosts.length ? st.hosts.map((h) => `<div class="flex items-center justify-between border border-[#156628] hover:border-[#33FF66] px-2 py-1"><span class="text-[#33FF66]">@${esc(h.name)} <span class="text-[#22aa44]">${esc(h.ip)} ${h.players != null ? `${h.players}/${h.max}` : ''}</span></span>${small(`data-act="joinhost" data-ip="${esc(h.ip)}"`, '[ JOIN ]')}</div>`).join('')
          : '<div class="text-[#FFB000]">&gt; NO ROOMS FOUND ON THIS NETWORK</div>') : '';
        fields = `<div class="flex gap-2 items-end"><div class="flex-1">${field('HOST ADDRESS (ip or ip:port)', 'ip', '192.168.1.20')}</div>${small('data-act="search"', '[ SEARCH LAN ]', '#00eefc')}</div><div class="space-y-1 text-[11px]">${rows}</div>`;
      }
    } else if (ui.mode === 'online') {
      fields = `<div class="flex gap-2 items-end"><div class="flex-1">${field('ROOM CODE', 'code', 'EMBER-TIDE-FERN-042')}</div>${host ? small('data-act="newcode"', '[ NEW CODE ]', '#00eefc') : ''}</div>`;
      hint = host ? 'Press OPEN ROOM, then INVITE FRIENDS to copy the code and send it. Each friend runs G3 on their own computer, picks ROOM CODE > JOIN and types it. Works over the internet; no router setup. Everything is encrypted with a key made from the code, so keep the generated one. Some school/office networks block the public servers.'
        : 'Type the code your friend sent. They must have opened their room first.';
    } else if (ui.mode === 'relay') {
      fields = `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${field('RELAY ADDRESS', 'addr', 'myrelay.example.com:47900')}${field('ROOM CODE', 'rroom', 'MY-ROOM-1')}</div>`;
      hint = 'Run <span class="text-[#00eefc]">python -m game.relay</span> on a machine everyone can reach. It only forwards bytes; any number of players can share a room.';
    } else {
      fields = `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2"><label class="block text-[10px] text-[#22aa44] space-y-0.5"><span>SERIAL PORT</span><select class="t-input" data-field="device">${ports}</select></label>${field('ROOM CODE', 'lroom', 'FORGE')}</div>${field('OR TYPE A PORT', 'device', 'COM5 or /dev/ttyUSB0')}`;
      hint = 'LoRa rooms hold exactly two players (host + one radio). Set the module to your country\'s licence-free band first (India: 865-867 MHz).' + (G3.state.init && !G3.state.init.serial ? ' <span class="text-[#FFB000]">pyserial is not installed: pip install pyserial</span>' : '');
    }
    return `${readoutHTML(null, g)}
      <div class="space-y-2">
        <div class="text-[10px] text-[#22aa44] flex flex-wrap items-center gap-1.5"><span>LINK_MODE:</span>${modeChips}</div>
        <div class="text-[10px] text-[#22aa44] flex flex-wrap items-center gap-1.5"><span>ROLE:</span>${roleChips}</div>
        ${st.state === 'error' ? `<div class="border border-[#FF3366] text-[#FF3366] bg-[#071208] p-2 text-[11px]">&gt; ERROR: ${esc(st.msg)}</div>` : ''}
        ${fields}
        ${hint ? `<div class="text-[10px] text-[#22aa44] leading-snug">&gt; ${hint}</div>` : ''}
      </div>
      <div class="pt-1 space-y-2.5">
        ${bigBtn('data-act="go"', host ? '[ OPEN ROOM ]' : '[ JOIN ROOM ]', host ? '> YOU HOST; FRIENDS CONNECT TO YOU' : '> CONNECT TO A FRIEND\'S ROOM')}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] md:text-xs">
          ${small('data-act="rules"', '[ ? VIEW RULES ]', '#00eefc')}
          <a href="index.html" class="border border-[#156628] hover:border-[#FFB000] hover:bg-[#FFB000] hover:text-[#050d06] bg-[#071208] text-[#FFB000] py-2 px-2 text-center transition-colors">[ &lt; BACK TO CUBE ROTATOR ]</a>
        </div></div>`;
  }

  function renderPanel() {
    const r = roomOf(), g = gameNow();
    if (!g) return;
    $('#panel').innerHTML = !r ? setupHTML(g) : r.phase === 'playing' ? playingHTML(r, g) : lobbyHTML(r, g);
  }

  // ---------------------------------------------------------------- right column: roster, chat
  function renderAside() {
    const r = roomOf(), st = G3.state.status, s = G3.summary();
    const rows = $('#roster');
    if (r) {
      $('#asideTitle').textContent = 'CATALOG: //G3/LOGS/ROSTER.TXT';
      $('#asideBadge').textContent = `[${r.slots.length} ENTRIES FOUND]`;
      $('#asideHead').innerHTML = '<span class="col-span-1">SLOT</span><span class="col-span-5">PLAYER_HANDLE</span><span class="col-span-3 text-right">PING</span><span class="col-span-3 text-right">STATE</span>';
      rows.innerHTML = r.slots.map((m, i) => {
        const you = m.id === r.you, host = m.role === 'HOST';
        return `<div class="border ${you ? 'border-[#33FF66] bg-[#0c2410] shadow-[0_0_8px_rgba(51,255,102,0.25)]' : 'border-[#156628] bg-[#050d06] hover:border-[#33FF66]'} p-2 hover:bg-[#0c2410] transition-colors flex items-center justify-between">
          <div class="flex items-center gap-2"><span class="text-[10px] font-pixel ${i === 0 ? 'text-[#FFB000]' : 'text-[#22aa44]'}">#${i + 1}</span>
            <div><div class="text-xs font-mono text-[#33FF66] font-bold flex items-center gap-1">${you ? '&gt; ' : ''}@${esc(m.n)}${you ? '<span class="text-[8px] bg-[#33FF66] text-[#050d06] px-1 font-bold">YOU</span>' : ''}</div>
              <div class="text-[8px] font-pixel mt-0.5 ${host ? 'text-[#FFB000]' : 'text-[#00eefc]'}">[${host ? 'ROOM HOST' : 'GUEST'}]</div></div></div>
          <div class="text-right"><div class="text-xs font-bold text-[#33FF66]">${m.ping == null ? '--' : m.ping + 'ms'}</div>
            <div class="text-[8px] font-pixel mt-0.5 ${host || m.ready ? 'text-[#33FF66]' : 'text-[#FFB000]'}">[${r.phase === 'playing' ? 'IN GAME' : host ? 'HOST' : m.ready ? 'READY' : 'WAITING'}]</div></div></div>`;
      }).join('');
      $('#asideFoot1').textContent = `LINK: ${s.link} // ${r.link === 'up' ? 'UP' : 'OPENING'}`;
      $('#asideFoot2').textContent = `HOST: ${(r.slots[0] || {}).n || '---'}`;
    } else if (st.state === 'results') {
      $('#asideTitle').textContent = 'CATALOG: //G3/LAN/ROOMS.TXT';
      $('#asideBadge').textContent = `[${st.hosts.length} ENTRIES FOUND]`;
      $('#asideHead').innerHTML = '<span class="col-span-1">#</span><span class="col-span-5">HOST_HANDLE</span><span class="col-span-3 text-right">PLAYERS</span><span class="col-span-3 text-right">ADDR</span>';
      rows.innerHTML = st.hosts.map((h, i) => `<button data-act="joinhost" data-ip="${esc(h.ip)}" class="w-full border border-[#156628] hover:border-[#33FF66] bg-[#050d06] hover:bg-[#0c2410] p-2 transition-colors flex items-center justify-between text-left">
        <div class="flex items-center gap-2"><span class="text-[10px] font-pixel text-[#22aa44]">#${i + 1}</span><div class="text-xs text-[#33FF66] font-bold">@${esc(h.name)}</div></div>
        <div class="text-right text-[10px] text-[#22aa44]"><div class="text-[#33FF66] font-bold">${h.players != null ? `${h.players}/${h.max}` : '?'}</div>${esc(h.ip)}</div></button>`).join('')
        || '<div class="text-[11px] text-[#FFB000] p-2">&gt; NO ROOMS ANSWERED. IS THE HOST ON THE SAME WI-FI?</div>';
      $('#asideFoot1').textContent = 'SCAN: COMPLETE';
      $('#asideFoot2').textContent = 'CLICK A ROW TO JOIN';
    } else {
      $('#asideTitle').textContent = 'CATALOG: //G3/LOGS/ROSTER.TXT';
      $('#asideBadge').textContent = '[0 ENTRIES FOUND]';
      $('#asideHead').innerHTML = '<span class="col-span-1">SLOT</span><span class="col-span-5">PLAYER_HANDLE</span><span class="col-span-3 text-right">PING</span><span class="col-span-3 text-right">STATE</span>';
      rows.innerHTML = '<div class="border border-dashed border-[#156628] p-4 text-[11px] text-[#22aa44] text-center">&gt; NOBODY HERE YET.<br>OPEN A ROOM OR JOIN ONE ON THE LEFT.</div>';
      $('#asideFoot1').textContent = 'LINK: ---';
      $('#asideFoot2').textContent = 'HOST: ---';
    }
    const inp = $('#chatInput');
    inp.disabled = !r;
    inp.placeholder = r ? 'TYPE A MESSAGE, ENTER TO SEND  (T = FOCUS)' : 'CHAT OPENS ONCE YOU ARE IN A ROOM';
  }

  function renderChat() {
    const box = $('#chatLog'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    const r = roomOf();
    box.innerHTML = log.slice(-120).map((e) => e.k === 'sys'
      ? `<div class="text-[#156628]">* ${esc(e.m)}</div>`
      : `<div><span class="text-[#156628]">${clock(e.ts)}</span> <span class="${r && e.id === r.you ? 'text-[#00eefc]' : 'text-[#FFB000]'}">@${esc(e.n)}</span><span class="text-[#33FF66]">&gt;</span> <span class="text-[#33FF66]">${esc(e.m)}</span></div>`).join('')
      || '<div class="text-[#156628]">&gt; (quiet)</div>';
    if (near) box.scrollTop = box.scrollHeight;
  }

  function renderAll() { if (!ready) return; renderTop(); renderPanel(); renderAside(); }

  // ---------------------------------------------------------------- actions
  function go() {
    const base = { transport: ui.mode };
    if (ui.role === 'host') {
      Object.assign(base, { game: gid(), max: ui.max });
      if (ui.mode === 'online') base.code = ui.code;
      if (ui.mode === 'relay') Object.assign(base, { addr: ui.addr, code: ui.rroom });
      if (ui.mode === 'lora') Object.assign(base, { device: ui.device, code: ui.lroom });
      G3.send('host', base);
    } else {
      if (ui.mode === 'lan') base.ip = ui.ip;
      if (ui.mode === 'online') base.code = ui.code;
      if (ui.mode === 'relay') Object.assign(base, { addr: ui.addr, code: ui.rroom });
      if (ui.mode === 'lora') Object.assign(base, { device: ui.device, code: ui.lroom });
      G3.send('join', base);
    }
  }

  function inviteText() {
    const r = roomOf(), s = G3.state.settings, g = gameNow();
    if (!r) return '';
    const head = `Join my G3 room (${g ? g.exe : ''}). You need G3 running on your own computer: `;
    if (r.transport === 'lan') return `${head}open G3, pick Wi-Fi/LAN > JOIN, and use ${G3.state.ips[0] || '?'}:${s.lan_port}`;
    if (r.transport === 'online') return `${head}open G3, pick ROOM_CODE > JOIN, and type ${r.code}`;
    if (r.transport === 'relay') return `${head}open G3, pick RELAY > JOIN, relay ${s.relay}, room ${r.code}`;
    return `${head}radio room ${r.code}`;
  }
  async function copyInvite() {
    const text = inviteText();
    try { await navigator.clipboard.writeText(text); G3.toast('> INVITE COPIED TO THE CLIPBOARD', 'ok'); }
    catch (e) { window.prompt('Copy this invite:', text); }
  }

  function showRules() {
    const g = gameNow(); if (!g) return;
    $('#modalTitle').textContent = `RULEBOOK // ${g.exe}`;
    $('#modalBody').innerHTML = (BLURBS[g.id] || []).map((l, i) => `<div><span class="text-[#FFB000]">${i + 1}.</span> ${esc(l)}</div>`).join('')
      + `<div class="pt-2 border-t border-[#156628]">PLAYERS: ${g.min}-${g.max} // GENRE: ${esc(g.genre)}</div><div class="text-[#FFB000]">&gt; The game module itself isn't installed in this build.</div>`;
    $('#modal').classList.remove('hidden');
  }
  const closeModal = () => $('#modal').classList.add('hidden');

  function act(el) {
    const a = el.dataset.act, v = el.dataset.v;
    switch (a) {
      case 'mode': ui.mode = v; if (v === 'lora' && ui.ports === null) G3.send('ports'); renderPanel(); break;
      case 'role': ui.role = v; renderPanel(); break;
      case 'max':
        ui.max = +v;
        if (roomOf()) G3.send('set_max', { n: +v }); else { G3.send('set_max', { n: +v }); renderPanel(); }
        break;
      case 'newcode': ui.code = G3.newRoomCode(); renderPanel(); break;
      case 'go': go(); break;
      case 'cancel': G3.send('cancel'); break;
      case 'search': G3.send('search'); break;
      case 'joinhost': G3.send('join', { transport: 'lan', ip: el.dataset.ip }); break;
      case 'game': G3.send('select_game', { id: el.dataset.id }); ui.game = el.dataset.id; break;
      case 'ready': { const me = G3.me(); G3.send('ready', { v: !(me && me.ready) }); break; }
      case 'start': G3.send('start'); break;
      case 'stopgame': G3.send('stop_game'); break;
      case 'leave': G3.send('leave'); break;
      case 'kick': G3.send('kick', { id: +el.dataset.id }); break;
      case 'invite': copyInvite(); break;
      case 'rules': showRules(); break;
      case 'pulse': {
        const r = roomOf(); pulseN += 1;
        G3.send('game', { d: { k: 'pulse', n: pulseN } });
        pulses.push({ from: r ? r.you : 0, n: pulseN }); renderPanel(); break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- wiring
  G3.on('init', (m) => {
    const s = m.settings;
    if (!ready) {
      Object.assign(ui, { code: s.room_code || G3.newRoomCode(), addr: s.relay, rroom: s.relay_room, device: s.lora_device,
                          lroom: s.lora_room, max: s.max_players });
      const want = params.get('game');
      if (want && m.catalog.some((g) => g.id === want) && (!m.room || m.room.host)) {
        ui.game = want;
        G3.send('select_game', { id: want });
        history.replaceState(null, '', location.pathname);
      }
      ready = true;
    }
    hadRoom = !!m.room;
    log = [...(m.sys || []).map((e) => ({ k: 'sys', m: e.m, ts: 0 })), ...(m.chat || []).map((e) => ({ k: 'chat', ...e }))];
    renderAll(); renderChat();
  });
  G3.on('room', (r) => {
    if (!hadRoom) { log = []; pulses = []; renderChat(); }
    hadRoom = true;
    renderAll();
  });
  G3.on('status', () => { renderAll(); });
  G3.on('settings', () => { if (ready && !roomOf()) renderAll(); });
  G3.on('closed', (m) => {
    hadRoom = false;
    log.push({ k: 'sys', m: `room closed: ${m.why}`, ts: Date.now() / 1000 });
    if (m.why && !/you left|you closed/.test(m.why)) G3.toast(`> ${m.why}`, 'err');
    renderAll(); renderChat();
  });
  let pingTimer = null;
  function chatPing(m) {                                // the chat box can be below the fold: say so
    const r = roomOf(), box = $('#chatLog'), ping = $('#chatPing');
    if (!ping || (r && m.id === r.you)) return;
    const b = box.getBoundingClientRect();
    if (b.top >= 0 && b.bottom <= window.innerHeight) return;
    ping.textContent = `> @${m.n}: ${m.m}`.slice(0, 120);
    ping.classList.remove('hidden');
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => ping.classList.add('hidden'), 5000);
  }
  G3.on('chat', (m) => { log.push({ k: 'chat', ...m }); renderChat(); chatPing(m); });
  G3.on('sys', (m) => { log.push({ k: 'sys', m: m.m, ts: Date.now() / 1000 }); renderChat(); });
  G3.on('start', () => { pulses = []; [660, 880, 1100].forEach((f, i) => setTimeout(() => G3.beep(f, 0.12, 'square'), i * 90)); });
  G3.on('game', (m) => {
    const r = roomOf();
    if (m.d && m.d.k === 'pulse' && r && m.from !== r.you) { pulses.push({ from: m.from, n: m.d.n }); renderPanel(); }
  });
  G3.on('ports', (m) => { ui.ports = m.ports; if (ready && !roomOf()) renderPanel(); });
  G3.on('conn', (on) => { if (ready) renderTop(); if (on && ready) { /* init follows */ } });

  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#modalClose') || e.target === $('#modal')) return closeModal();
      const el = e.target.closest('[data-act]');
      if (el && !el.disabled) act(el);
    });
    const onField = (e) => { const f = e.target.dataset && e.target.dataset.field; if (f) ui[f] = e.target.value; };
    document.addEventListener('input', onField);
    document.addEventListener('change', onField);
    const chat = $('#chatInput');
    $('#chatPing').addEventListener('click', () => { $('#chatPing').classList.add('hidden'); chat.scrollIntoView({ block: 'center' }); chat.focus(); });
    chat.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && chat.value.trim()) { G3.send('chat', { m: chat.value }); chat.value = ''; }
      if (e.key === 'Escape') chat.blur();
      e.stopPropagation();
    });
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = e.target.matches && e.target.matches('input,textarea,select');
      if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) return closeModal();
      if (e.code === G3.prefs.keys.back && !typing) { if (!roomOf() && !busy()) location.href = 'index.html'; return; }
      if (typing) { if (e.key === 'Enter' && e.target.dataset.field && !roomOf()) { e.preventDefault(); go(); } return; }
      const K = G3.prefs.keys, r = roomOf();
      if (e.code === K.chat || e.key === '/') { if (r) { e.preventDefault(); chat.focus(); } }
      else if (e.code === K.ready && r && !r.host && r.phase !== 'playing') act({ dataset: { act: 'ready' } });
      else if (e.code === K.exec || e.code === 'Space') {
        e.preventDefault();
        if (!r) { if (!busy()) go(); } else if (r.host && r.phase === 'lobby') { const g = gameNow(); if (g && canStart(r, g)[0]) G3.send('start'); }
      }
    });
  });
}());
