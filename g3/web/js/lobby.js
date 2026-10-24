/* Lobby: link setup (host / join over LAN, room code, relay, LoRa), the room itself,
   the roster and chat tape, and the stand-in screen while a game "runs". */
(function () {
  'use strict';
  const { $, $$, esc } = G3;

  const BLURBS = {
    bobble_league: ['Top-down tactics: two teams of 3, 4 or 5 bobbles (you pick the stadium), shared out between the players, and one glowing ball.', 'Both teams plan a flick for each bobble in secret, lock in, and every flick happens at once.', 'First to 3 goals wins, or the leader when the clock runs out.'],
    rising_rush: ['Boss rush: a band of ninjas against towering bosses.', 'Team up, time your strikes and bring each boss down.'],
    battle_tide: ['Naval tactics for up to 4 captains.', 'Position battleships, destroyers and subs, trade broadsides, sink the enemy fleet.'],
    letter_league: ['A co-op word puzzle on one shared board.', 'Longer words and combos score for the whole team.'],
    liars_bar: ['Deck bluffing and dice for 2-4 players.', 'Play cards face-down, call a bluff, outlast the table.'],
    whos_away: ['A co-op mystery escape room in an empty mansion.', 'Search rooms, combine clues and crack the lock together.'],
  };

  // Which cartridges can be played yet is decided in classified.js (F1 open, F2 classified, F3 and up work in progress).
  const { accessOf, built } = G3;
  const locked = (id) => accessOf(id) !== 'open';

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
    const phase = !r ? ({ classified: 'CLASSIFIED', wip: 'WORK_IN_PROGRESS' }[accessOf(g.id)] || 'IDLE') : r.link !== 'up' ? 'LINKING' : r.phase === 'playing' ? 'RUNNING' : 'IN_LOBBY';
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
    // how many friends can join (1 to 7): the room holds that many plus you, so the room size sent to the server is friends + 1
    const gmax = r ? r.gmax : g.max;
    const cur = r ? r.max : ui.max;
    const host = isHost();
    const chips = [1, 2, 3, 4, 5, 6, 7].filter((n) => n + 1 <= gmax).map((n) => {
      const lab = `${n}`;
      return host ? chip(`[ ${lab} ]`, n + 1 === cur, `data-act="max" data-v="${n + 1}"`) : chip(`[ ${lab} ]`, n + 1 === cur, 'disabled');
    }).join(' ');
    const s = G3.summary();
    const where = r ? (r.code ? `#${r.code}` : `${G3.state.ips[0] || '?'}:${G3.state.settings.lan_port}`) : '---';
    return `<div class="border border-[#156628] bg-[#071208] p-2.5 text-[11px] md:text-xs leading-relaxed space-y-1">
      <div class="flex flex-wrap items-center justify-between"><span class="text-[#33FF66] font-bold">GAME: ${esc(g.name.split('/')[0].trim())}</span><span class="text-[#22aa44]">GENRE: ${esc(g.genre)}</span></div>
      <div class="text-[#22aa44] flex flex-wrap items-center gap-1.5 pt-1"><span>FRIENDS WHO CAN JOIN:</span>${chips}</div>
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
    const need = r.solo ? 1 : g.min;
    if (r.slots.length < need) return [false, `${g.exe} NEEDS ${need}+ PLAYERS`];
    const wait = r.slots.filter((s) => s.role !== 'HOST' && !s.ready).map((s) => '@' + s.n);
    if (wait.length) return [false, 'WAITING FOR: ' + wait.join(', ')];
    return [true, 'ALL PLAYERS READY'];
  }

  const bigBtn = (attrs, label, sub = '', dis = false) => `<button ${attrs} ${dis ? 'disabled' : ''} class="w-full border-2 border-[#33FF66] bg-[#050d06] hover:bg-[#33FF66] hover:text-[#050d06] font-pixel text-sm md:text-base py-3.5 px-4 text-center tracking-wider transition-all duration-150 box-glow-green active:scale-[0.99] flex items-center justify-center gap-2">
      <span class="text-base">▶</span><span class="tracking-widest font-bold">${label}</span></button>${sub ? `<div class="text-center text-[12px] text-[#FFB000]">${sub}</div>` : ''}`;
  const small = (attrs, label, col = '#33FF66') => `<button ${attrs} class="border border-[#156628] hover:border-[${col}] hover:bg-[${col}] hover:text-[#050d06] bg-[#071208] text-[${col}] py-2 px-2 text-center transition-colors font-mono">${label}</button>`;

  function joinInfo(r) {
    const st = G3.state.settings;
    if (r.transport === 'lan') return ['ROOM CODE', (G3.state.ips[0] || '?') + ':' + st.lan_port];      // only reachable from older settings: the lobby no longer offers it
    if (r.transport === 'relay') return ['ROOM CODE', `${r.code}  @  ${st.relay}`];
    return ['ROOM CODE', r.code];
  }

  function lobbyHTML(r, g) {
    const me = G3.me(), [ok, why] = canStart(r, g);
    const [invLabel, invValue] = joinInfo(r);
    const invite = r.host && !r.solo && r.slots.length < r.max ? `<div class="border border-[#FFB000] bg-[#071208] p-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div class="min-w-0"><div class="text-[10px] text-[#FFB000] font-bold">&gt; ${invLabel}</div>
          <div class="text-xl md:text-3xl tracking-widest text-[#00eefc] font-bold break-all selectable">${esc(invValue)}</div></div>
        ${small('data-act="invite"', '[ COPY INVITE ]', '#FFB000')}</div>` : '';
    const host = r.host;
    const primary = host
      ? bigBtn('data-act="start"', '[ PRESS TO ENTER GAME ]', `> ${why}`, !ok)
      : bigBtn('data-act="ready"', me && me.ready ? '[ ✔ READY - PRESS TO UNREADY ]' : '[ PRESS WHEN READY ]', me && me.ready ? '> WAITING FOR THE HOST TO START' : '> THE HOST STARTS WHEN EVERYONE IS READY');
    return `${r.link !== 'up' ? `<div class="border border-[#FFB000] text-[#FFB000] bg-[#071208] p-2 text-[11px]">&gt; LINK OPENING: ${esc(G3.state.status.msg || 'please wait')}</div>` : ''}
      ${r.solo ? '<div class="border border-[#FFB000] text-[#FFB000] bg-[#071208] p-2 text-[11px]">&gt; SOLO TEST ROOM: just you, no network, nobody can join. Close the room to leave.</div>' : ''}
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

  // The stand-ins for cartridges that can't be played: F2 is classified, F3 and up are work in progress.
  function lockedHTML(g) {
    const name = esc(g.name.split('/')[0].trim());
    const back = '<a href="index.html" class="block border border-[#156628] hover:border-[#FFB000] hover:bg-[#FFB000] hover:text-[#050d06] bg-[#071208] text-[#FFB000] py-2 px-2 text-center transition-colors text-[10px] md:text-xs">[ &lt; BACK TO CUBE ROTATOR ]</a>';
    if (accessOf(g.id) === 'classified') {
      return `<div class="border-2 border-[#FF3366] bg-[#0d0508] p-4 md:p-5 text-center space-y-3 relative overflow-hidden">
          <div class="g3-stripes g3-stripes-red absolute inset-x-0 top-0 h-2"></div>
          <div class="text-[#FF3366] text-[10px] font-pixel pt-2 tracking-widest">TOP SECRET // EYES ONLY</div>
          <div class="font-pixel text-lg md:text-2xl text-[#FF3366] tracking-widest g3-stamp">CLASSIFIED ACCESS</div>
          <div class="text-[#FF3366] text-xs md:text-sm font-bold">&gt; ACCESS DENIED<span class="cursor-blink">_</span></div>
          <div class="border border-[#FF3366]/50 bg-[#050203] p-3 text-left text-[11px] md:text-xs space-y-1 text-[#e8a0b0]">
            <div>FILE: <span class="text-[#FFB000]">${esc(g.exe)}</span></div>
            <div>CLEARANCE REQUIRED: <span class="text-[#FF3366] font-bold">LEVEL 5</span> // YOURS: <span class="text-[#FF3366] font-bold">NONE</span></div>
            <div>CONTENTS: <span class="g3-redact">████████████</span> <span class="g3-redact">██████</span> <span class="g3-redact">█████████</span></div>
            <div>STATUS: <span class="g3-redact">███████████</span> // ETA: <span class="g3-redact">████</span></div>
          </div>
          <div class="text-[11px] text-[#e8a0b0]">&gt; THIS CARTRIDGE ${name} IS SEALED. HOSTING AND JOINING ARE DISABLED.</div>
          <div class="g3-stripes g3-stripes-red absolute inset-x-0 bottom-0 h-2"></div>
        </div>${back}`;
    }
    const pct = built(g.id), f = Math.round(pct / 5);
    return `<div class="border-2 border-[#FFB000] bg-[#0d0a02] p-4 md:p-5 text-center space-y-3 relative overflow-hidden">
        <div class="g3-stripes g3-stripes-amber absolute inset-x-0 top-0 h-2"></div>
        <div class="text-[#FFB000] text-[10px] font-pixel pt-2 tracking-widest">&#9888; UNDER CONSTRUCTION &#9888;</div>
        <div class="font-pixel text-lg md:text-2xl text-[#FFB000] glow-amber tracking-widest">WORK IN PROGRESS</div>
        <div class="text-[#33FF66] text-xs md:text-sm">&gt; ${name} IS NOT PLAYABLE YET<span class="cursor-blink">_</span></div>
        <div class="border border-[#FFB000]/50 bg-[#050401] p-3 text-left text-[11px] md:text-xs space-y-1 text-[#22aa44]">
          <div>FILE: <span class="text-[#FFB000]">${esc(g.exe)}</span></div>
          <div>BUILD: <span class="text-[#FFB000] font-pixel text-[9px]">[${'█'.repeat(f)}${'░'.repeat(20 - f)}] ${pct}%</span></div>
          <div>STATUS: <span class="text-[#33FF66]">${pct ? 'DEVS ARE COOKING. CHECK BACK SOON.' : 'NOT STARTED. NO CODE WRITTEN YET.'}</span></div>
        </div>
        <div class="text-[11px] text-[#22aa44]">&gt; HOSTING AND JOINING ARE DISABLED FOR THIS CARTRIDGE. TRY F1 FOR A GAME YOU CAN PLAY.</div>
        <div class="g3-stripes g3-stripes-amber absolute inset-x-0 bottom-0 h-2"></div>
      </div>${back}`;
  }

  function setupHTML(g) {
    if (locked(g.id)) return lockedHTML(g);
    const st = G3.state.status, host = ui.role === 'host';
    if (busy()) {
      return `${readoutHTML(null, g)}
        <div class="border border-[#33FF66] bg-[#071208] p-4 text-center space-y-3">
          <div class="font-pixel text-[11px] text-[#33FF66] glow-green">${st.state === 'searching' ? 'SCANNING THE NETWORK' : 'ESTABLISHING LINK'}<span class="cursor-blink">_</span></div>
          <div class="text-[11px] text-[#22aa44]">${esc(st.msg || 'working...')}</div>
          ${small('data-act="cancel"', '[ ■ CANCEL ]', '#FF3366')}</div>`;
    }
    // the only way into a room is its room code: one big box to type (or, for the host, generate) it
    const roleChips = [['host', 'HOST A ROOM'], ['join', 'JOIN A ROOM']].map(([k, label]) => chip(`[ ${label} ]`, ui.role === k, `data-act="role" data-v="${k}"`)).join(' ');
    const codeBox = `<input class="t-input w-full text-center text-xl md:text-3xl tracking-widest py-4 md:py-5" data-field="code" value="${esc(ui.code)}" placeholder="ROOM CODE" aria-label="Room code" autocomplete="off" spellcheck="false">`;
    const fields = host ? `<div class="flex gap-2 items-stretch"><div class="flex-1">${codeBox}</div>${small('data-act="newcode"', '[ NEW CODE ]', '#00eefc')}</div>` : codeBox;
    return `${readoutHTML(null, g)}
      <div class="space-y-2">
        <div class="text-[10px] text-[#22aa44] flex flex-wrap items-center gap-1.5"><span>ROLE:</span>${roleChips}</div>
        ${st.state === 'error' ? `<div class="border border-[#FF3366] text-[#FF3366] bg-[#071208] p-2 text-[11px]">&gt; ERROR: ${esc(st.msg)}</div>` : ''}
        ${fields}
      </div>
      <div class="pt-1 space-y-2.5">
        ${bigBtn('data-act="go"', host ? '[ OPEN ROOM ]' : '[ JOIN ROOM ]', host ? '> YOU HOST; FRIENDS CONNECT TO YOU' : '> CONNECT TO A FRIEND\'S ROOM')}
        ${small('data-act="solo"', '[ ► SOLO TEST: PLAY ALONE, NO NETWORK ]', '#FFB000')}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] md:text-xs">
          ${small('data-act="rules"', '[ ? VIEW RULES ]', '#00eefc')}
          <a href="index.html" class="border border-[#156628] hover:border-[#FFB000] hover:bg-[#FFB000] hover:text-[#050d06] bg-[#071208] text-[#FFB000] py-2 px-2 text-center transition-colors">[ &lt; BACK TO CUBE ROTATOR ]</a>
        </div></div>`;
  }

  // ---------------------------------------------------------------- a game running in the panel (web/games/<id>/game.js)
  let gameInst = null, gameKey = '', gameQueue = [];

  function stopGame() {
    if (gameInst) { try { gameInst.destroy(); } catch (e) { console.error(e); } }
    gameInst = null; gameKey = ''; gameQueue = [];
    $('#heroSection').classList.remove('hidden');
  }

  function mountGame(r, g) {
    const key = `${r.game}:${r.seed}`;
    if (gameInst && gameKey === key) { if (gameInst.onRoom) gameInst.onRoom(r); return; }
    stopGame();
    const panel = $('#panel');
    panel.innerHTML = '<div id="gameRoot"></div>';
    $('#heroSection').classList.add('hidden');                // the game wants the room
    const send = (d, hostOnly) => G3.send('game', { d: hostOnly ? Object.assign({ _h: true }, d) : d });
    gameKey = key;
    try {
      gameInst = G3.games[r.game].mount({
        root: $('#gameRoot'), game: g, seed: r.seed, room: roomOf, send,
        leave: () => G3.send('leave'), backToLobby: () => G3.send('stop_game'),
      });
    } catch (e) {
      console.error(e);
      gameInst = null; gameKey = '';
      panel.innerHTML = playingHTML(r, g);
      return;
    }
    const queued = gameQueue; gameQueue = [];
    queued.forEach((m) => gameInst.onMessage && gameInst.onMessage(m.from, m.d));
  }

  function renderPanel() {
    const r = roomOf(), g = gameNow();
    if (!g) return;
    if (r && r.phase === 'playing' && G3.games[r.game]) { mountGame(r, g); return; }
    stopGame();
    if (!r) G3.lockedScreen(g, () => { location.href = 'index.html'; });
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
    if (locked(gid())) return;
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
    const r = roomOf(), g = gameNow();
    if (!r) return '';
    return `Join my G3 room (${g ? g.exe : ''}): room code ${r.code}`;
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
      case 'role': ui.role = v; ui.code = v === 'join' ? '' : (ui.code || G3.newRoomCode()); renderPanel(); break;                // joining starts with an empty box; hosting always has a code
      case 'max':
        ui.max = +v;
        if (roomOf()) G3.send('set_max', { n: +v }); else { G3.send('set_max', { n: +v }); renderPanel(); }
        break;
      case 'newcode': ui.code = G3.newRoomCode(); renderPanel(); break;
      case 'go': go(); break;
      case 'solo': if (locked(gid())) break; G3.send('host', { transport: 'solo', game: gid() }); break;
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
        if (params.get('solo') && !m.room && !locked(want)) G3.send('host', { transport: 'solo', game: want });     // the launcher's SOLO TEST button
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
    if (gameInst) { if (gameInst.onMessage) gameInst.onMessage(m.from, m.d); return; }
    if (G3.games[gid()] && gameQueue.length < 100) { gameQueue.push(m); return; }   // arrived before the game mounted
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
