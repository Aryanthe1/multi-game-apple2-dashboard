/* Bobble League: the client.  Registers with the lobby (G3.registerGame) and is mounted when the host starts the game.
 *
 * A top-down tactics game.  Every team has 3, 4 or 5 bobbles (the stadium picks), shared out evenly between its players.  Each round BOTH teams plan at the same time: drag a bobble back (like a slingshot or a carrom striker) to set
 * which way and how hard it will be flicked, do that for as many of your bobbles as you like, then LOCK IN.  When everybody
 * has locked in (or the time is up) every flick happens at once and the bobbles slide, collide and rebound until all has
 * stopped; then the next round of planning starts.  Your plans are private: nobody else is ever sent them.
 *
 *   host   runs the simulation (sim.js) and streams snapshots through the room's game channel;
 *   guests send their plans to the host ({k:'plan', i, ax, ay, _h:true}, {k:'ready', v, _h:true}) and draw interpolated snapshots.
 *
 * Every match opens on the game menu: the host picks the gameplay style (MODES below), the stadium (STADIUMS: it sets the pitch and
 * the team size) and, for arenas, the arena; then each team's captain picks the team name, mascot and formation; the match starts
 * when both captains are ready.  The game always fills the window and asks for real
 * fullscreen as soon as the browser allows it.
 */
(function () {
  'use strict';
  const Sim = window.BobbleSim, C = Sim.C;

  // The view is the pitch plus a margin for the nets (sides), the scoreboard (top) and the banner (bottom).  The pitch depends on
  // the stadium the host picked (Sim.geo), so these are set again by setGeo() whenever the size changes.
  let G = Sim.geo('little'), TM = 78, BM = 74, MX = 0, VW = 0, VH = 0, HS = 1;
  let MAXPULL = 170, MINPULL = 14;                                // drag length (pitch px) for full power / to count as a plan
  /** Switch to a stadium.  Returns true if that changed anything. */
  function setGeo(id) {
    const g = Sim.geo(id);
    if (g.id === G.id && VW) return false;
    G = g; MX = g.NET + 40; VW = g.W + 2 * MX;
    HS = Math.max(1, VW / 1220);                                  // the scoreboard, banner and labels grow with a big stadium so they stay readable
    TM = Math.round(78 * HS); BM = Math.round(74 * HS); VH = TM + g.H + BM;
    MAXPULL = 170 * g.u; MINPULL = 14 * g.u;
    return true;
  }
  setGeo('little');

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
    { id: 'classic', name: 'CLASSIC', blurb: 'Top-down tactics. Every bobble is shared between the players of its team. Everyone plans a flick for each bobble at the same time, locks in, and they all fly at once. First to 3 wins.' },
    { id: 'arenas', name: 'ARENAS', maps: true, blurb: 'The same game in four arenas. Each one plays differently and throws a random event at you: hecklers, sandstorms, frostbite, lightning.' },
  ];
  // The stadiums, picked right after the mode (the sim knows the pitch and the team size by `id`; this is how they are shown).
  const STADIUMS = [
    { id: 'local', name: 'LOCAL', icon: '🏘️', tag: '3 v 3 // SMALLEST STADIUM', blurb: 'A quick kickabout on a tiny pitch. Three bobbles a side, wall-to-wall action and goals all the time.' },
    { id: 'little', name: 'LITTLE LEAGUE', icon: '🏟️', tag: '4 v 4 // BIG STADIUM', blurb: 'A much bigger ground with four bobbles a side. Room to build moves and pass round the defence.' },
    { id: 'premier', name: 'PREMIER LEAGUE', icon: '🏆', tag: '5 v 5 // THE BIGGEST STADIUM', blurb: 'The big stage. The largest ground of all and five bobbles a side: line up well, and flick hard to cross it.' },
  ];
  // The arenas (the sim knows their physics and events by `id`; this is how they are shown).
  const ARENAS = [
    { id: 'stadium', name: 'THE STADIUM', icon: '🏟️', event: 'HECKLERS', blurb: 'Packed stands. Now and then an onlooker pelts one player: their bobbles are stuck until they win a wipe-off minigame, and their team has to carry on without them.' },
    { id: 'desert', name: 'THE DESERT', icon: '🏜️', event: 'HAY BALES + SANDSTORMS', blurb: 'Sand drags everything. Hay bales roll across the pitch and knock bobbles about. A sandstorm starts a dig-out race: the winner\'s team gets the turn, the other team is locked in place.' },
    { id: 'tundra', name: 'THE TUNDRA', icon: '❄️', event: 'SNOWSTORMS + FROSTBITE', blurb: 'Ice: everything slides. Snowstorms start a shake-it-off race like the desert\'s. Leave a bobble alone for more than 2 rounds and it gets frostbite: weak flicks, then frozen solid until another bobble knocks it.' },
    { id: 'rainforest', name: 'THE RAINFOREST', icon: '🌧️', event: 'LIGHTNING', blurb: 'The pitch is slick with rain. Lightning strikes after a moment\'s warning and stuns the closest bobbles for 10 seconds.' },
  ];
  const ARENA_FX = { stadium: ['🍅', 'HECKLE'], desert: ['🌾', 'HAY'], tundra: ['❄️', 'FROST'], rainforest: ['⚡', 'BOLT'] };
  const BLOCKED = { 1: 'STUNNED', 2: 'STUCK', 3: 'FROZEN SOLID', 4: 'LOCKED IN PLACE' };
  const RATE = { lan: 30, relay: 20, online: 15, lora: 4 };     // snapshots per second while things move, at most
  const IDLE_RATE = 5;                                            // ...and while everyone is planning
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /** A small picture of a stadium (an <svg>): the pitch with the bobbles of each team standing in the formation given for it
   *  (an id from Sim.formsFor; '' leaves that team out).  `width` is in px, 0 fills whatever holds it. */
  function pitchSvg(g, forms, width) {
    const pad = g.NET, sw = Math.max(3, g.W / 170), team = Sim.formsFor(g.n);
    let o = `<svg class="bl-svg" viewBox="${-pad} 0 ${g.W + 2 * pad} ${g.H}" ${width ? `style="width:${width}px"` : ''} xmlns="http://www.w3.org/2000/svg">`;
    o += `<rect x="${-pad}" y="0" width="${g.W + 2 * pad}" height="${g.H}" fill="#06140c"/><rect x="0" y="0" width="${g.W}" height="${g.H}" fill="#168c4a" stroke="#e9fff0" stroke-width="${sw}"/>`;
    o += `<line x1="${g.W / 2}" y1="0" x2="${g.W / 2}" y2="${g.H}" stroke="#e9fff0" stroke-width="${sw}"/><circle cx="${g.W / 2}" cy="${g.H / 2}" r="${g.H * 0.148}" fill="none" stroke="#e9fff0" stroke-width="${sw}"/>`;
    for (const side of [0, 1]) {
      o += `<rect x="${side ? g.W : -pad}" y="${g.GY0}" width="${pad}" height="${g.GY1 - g.GY0}" fill="#020712" stroke="${TEAM[side].main}" stroke-width="${sw}"/>`;
      const f = forms && team.find((q) => q.id === forms[side]);
      if (f) for (const [fx, fy] of f.pts) o += `<circle cx="${side ? g.W - fx * g.W : fx * g.W}" cy="${fy * g.H}" r="${g.dr * 1.6}" fill="${TEAM[side].main}" stroke="#04061e" stroke-width="${sw * 0.8}"/>`;
    }
    return o + `<circle cx="${g.W / 2}" cy="${g.H / 2}" r="${g.br * 1.6}" fill="#fff"/></svg>`;
  }

  // ------------------------------------------------------------------ arena artwork (painted once into the cached background)
  const LINE = { classic: 'rgba(255,255,255,.82)', stadium: 'rgba(255,255,255,.85)', desert: 'rgba(255,250,230,.9)', tundra: 'rgba(22,66,140,.85)', rainforest: 'rgba(235,255,240,.82)' };
  const CROWD = ['#f046d8', '#27d3f2', '#ffd43b', '#ff5c7a', '#ffffff', '#7cf29a', '#9fb0ff', '#ff9f43'];

  // the area around the pitch: x -MX..W+MX, y -TM..H+BM
  function paintSurround(c, map, rnd) {
    const X0 = -MX, Y0 = -TM, X1 = G.W + MX, Y1 = G.H + BM;
    const vgrad = (a, b, d) => { const g = c.createLinearGradient(0, Y0, 0, Y1); g.addColorStop(0, a); g.addColorStop(0.5, b); g.addColorStop(1, d || a); return g; };
    const ringOnly = (fn) => { c.save(); c.beginPath(); c.rect(X0, Y0, VW, VH); c.rect(0, 0, G.W, G.H); c.clip('evenodd'); fn(); c.restore(); };      // draw in the margins only
    // The scenery below was laid out for a 1000 x 620 pitch: stretch its spots over this stadium (and repeat them on a wide one),
    // and scale how many random specks there are with the area.
    const ar = (VW * VH) / (1220 * 772), reps = Math.max(1, Math.round(G.W / 1000));
    const spots = (list) => {
      const out = [];
      for (let r = 0; r < reps; r++) for (const [x, y, s] of list) out.push([X0 + ((x + 110) / 1220 + r) * VW / reps, y < 0 ? y : y >= 620 ? G.H + (y - 620) : y * G.H / 620, s * G.u]);
      return out;
    };
    if (map === 'stadium') {
      c.fillStyle = vgrad('#171a3f', '#0d1030'); c.fillRect(X0, Y0, VW, VH);
      ringOnly(() => {
        for (let y = Y0 + 6; y < Y1; y += 10) for (let x = X0 + 4; x < X1; x += 11) {            // the crowd
          const px = x + (rnd() - 0.5) * 3, py = y + (rnd() - 0.5) * 2, col = CROWD[Math.floor(rnd() * CROWD.length)];
          c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(px - 4, py + 2, 8, 6);
          c.fillStyle = col; c.globalAlpha = 0.55 + rnd() * 0.4; c.beginPath(); c.arc(px, py, 4, 0, 7); c.fill();
          c.fillStyle = col; c.fillRect(px - 4, py + 3, 8, 4); c.globalAlpha = 1;
        }
      });
      const ads = ['BOBBLE LEAGUE', 'G3 ARCADE', 'FLICK IT', 'LOCK IN!'], cols = ['#f046d8', '#27d3f2', '#ffd43b', '#7cf29a'];
      c.font = '8px "Press Start 2P", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
      const nb = Math.max(4, Math.round(G.W / 250)), bw = G.W / nb;
      for (const [y, h] of [[-16, 13], [G.H + 3, 13]]) for (let i = 0; i < nb; i++) {            // advertising boards along the touchlines
        const col = cols[i % 4];
        c.fillStyle = col; c.fillRect(i * bw, y, bw, h); c.fillStyle = 'rgba(4,6,30,.88)'; c.fillRect(i * bw + 3, y + 2, bw - 6, h - 4);
        c.fillStyle = col; c.fillText(ads[i % 4], i * bw + bw / 2, y + h / 2 + 1);
      }
      for (const [x, y] of [[X0 + 10, Y0 + 8], [X1 - 10, Y0 + 8], [X0 + 10, Y1 - 8], [X1 - 10, Y1 - 8]]) {      // floodlights
        const g = c.createRadialGradient(x, y, 2, x, y, 150); g.addColorStop(0, 'rgba(255,248,220,.7)'); g.addColorStop(1, 'rgba(255,248,220,0)');
        c.fillStyle = g; c.fillRect(x - 150, y - 150, 300, 300);
      }
    } else if (map === 'desert') {
      c.fillStyle = vgrad('#8a5a2b', '#b9854a'); c.fillRect(X0, Y0, VW, VH);
      ringOnly(() => {
        for (let n = 0, N = Math.round(40 * ar); n < N; n++) { c.fillStyle = n % 2 ? 'rgba(255,220,150,.12)' : 'rgba(80,40,10,.14)'; const x = X0 + rnd() * VW, y = Y0 + rnd() * VH; c.beginPath(); c.ellipse(x, y, 40 + rnd() * 90, 8 + rnd() * 16, 0, 0, 7); c.fill(); }
        for (let n = 0, N = Math.round(16 * ar); n < N; n++) { const x = X0 + rnd() * VW, y = Y0 + rnd() * VH; c.fillStyle = '#6d5a49'; c.beginPath(); c.ellipse(x, y, 7 + rnd() * 7, 5 + rnd() * 4, 0, 0, 7); c.fill(); c.fillStyle = 'rgba(255,255,255,.12)'; c.beginPath(); c.ellipse(x - 2, y - 2, 4, 2, 0, 0, 7); c.fill(); }
        for (const [x, y, s] of spots([[-70, -40, 1], [160, -48, 0.8], [640, -44, 1.1], [930, -40, 0.9], [-85, 520, 1], [330, 620 + 44, 1.05], [760, 620 + 40, 0.85], [1075, 500, 1], [1070, 110, 0.9], [-80, 120, 0.8]])) {      // cacti
          c.fillStyle = 'rgba(0,0,0,.25)'; c.beginPath(); c.ellipse(x + 6 * s, y + 24 * s, 16 * s, 5 * s, 0, 0, 7); c.fill();
          c.fillStyle = '#2f8f4a'; c.strokeStyle = '#1c5f31'; c.lineWidth = 2;
          const rr = (rx, ry, w, h) => { c.beginPath(); c.roundRect ? c.roundRect(rx, ry, w, h, w / 2) : c.rect(rx, ry, w, h); c.fill(); c.stroke(); };
          rr(x - 6 * s, y - 24 * s, 12 * s, 48 * s); rr(x - 20 * s, y - 12 * s, 9 * s, 24 * s); rr(x + 11 * s, y - 4 * s, 9 * s, 22 * s);
        }
      });
    } else if (map === 'tundra') {
      c.fillStyle = vgrad('#e7f6fd', '#b4d9ee'); c.fillRect(X0, Y0, VW, VH);
      ringOnly(() => {
        for (let n = 0, N = Math.round(34 * ar); n < N; n++) { c.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.4})`; c.beginPath(); c.ellipse(X0 + rnd() * VW, Y0 + rnd() * VH, 30 + rnd() * 80, 6 + rnd() * 12, 0, 0, 7); c.fill(); }
        for (const [x, y, s] of spots([[-85, -30, 1], [-30, -50, 0.8], [190, -46, 0.9], [470, -52, 1.1], [740, -44, 0.85], [980, -48, 1], [1075, 40, 0.9], [-90, 540, 1], [140, 620 + 46, 0.9], [560, 620 + 50, 1.1], [880, 620 + 44, 0.85], [1070, 500, 1]])) {      // pines
          c.fillStyle = 'rgba(0,30,60,.2)'; c.beginPath(); c.ellipse(x + 8 * s, y + 30 * s, 22 * s, 6 * s, 0, 0, 7); c.fill();
          c.fillStyle = '#5a3b22'; c.fillRect(x - 3 * s, y + 18 * s, 6 * s, 14 * s);
          for (let t = 0; t < 3; t++) {
            const ty = y - 22 * s + t * 16 * s, w = (14 + t * 7) * s;
            c.fillStyle = '#1d5a46'; c.beginPath(); c.moveTo(x, ty - 14 * s); c.lineTo(x + w, ty + 12 * s); c.lineTo(x - w, ty + 12 * s); c.closePath(); c.fill();
            c.fillStyle = '#f4fbff'; c.beginPath(); c.moveTo(x, ty - 14 * s); c.lineTo(x + w * 0.55, ty + 1 * s); c.lineTo(x - w * 0.55, ty + 1 * s); c.closePath(); c.fill();
          }
        }
      });
    } else if (map === 'rainforest') {
      c.fillStyle = vgrad('#03130d', '#0a3524'); c.fillRect(X0, Y0, VW, VH);
      ringOnly(() => {
        const greens = ['#0f5a31', '#157a42', '#1b9a52', '#0b4126', '#23b363'];
        for (let n = 0, N = Math.round(150 * ar); n < N; n++) {                                     // leaves
          const x = X0 + rnd() * VW, y = Y0 + rnd() * VH, a = rnd() * 6.3, l = 22 + rnd() * 40;
          c.save(); c.translate(x, y); c.rotate(a); c.fillStyle = greens[Math.floor(rnd() * greens.length)];
          c.beginPath(); c.ellipse(0, 0, l, l * 0.3, 0, 0, 7); c.fill();
          c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(-l, 0); c.lineTo(l, 0); c.stroke(); c.restore();
        }
        for (const [x, y] of [[X0 + 24, Y0 + 20], [X1 - 24, Y0 + 20], [X0 + 24, Y1 - 20], [X1 - 24, Y1 - 20]]) {     // palm fronds from the corners
          for (let f = 0; f < 7; f++) {
            const a = (x < G.W / 2 ? 0 : Math.PI) + (y < G.H / 2 ? 1 : -1) * (0.15 + f * 0.2) * (x < G.W / 2 ? 1 : -1), l = 70 + (f % 2) * 22;
            c.strokeStyle = f % 2 ? '#1b9a52' : '#157a42'; c.lineWidth = 9; c.lineCap = 'round';
            c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(a) * l * 0.5, y + Math.sin(a) * l * 0.5 - 12, x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
          }
          c.lineCap = 'butt';
        }
      });
    } else {
      c.fillStyle = vgrad('#0d0a2e', '#071225'); c.fillRect(X0, Y0, VW, VH);
    }
  }

  // the playing surface
  function paintGround(c, map, rnd) {
    const sw = G.W / 10, pa = (G.W * G.H) / (1000 * 620);            // stripe width; how many more specks a bigger pitch gets
    if (map === 'desert') {
      for (let i = 0; i < 10; i++) { c.fillStyle = i % 2 ? '#d9b36a' : '#d1a85f'; c.fillRect(i * sw, 0, sw, G.H); }
      c.strokeStyle = 'rgba(140,90,30,.2)'; c.lineWidth = 2;
      for (let n = 0, N = Math.round(70 * pa); n < N; n++) { const x = rnd() * G.W, y = rnd() * G.H; c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 30, y - 7, x + 60, y); c.quadraticCurveTo(x + 90, y + 7, x + 120, y); c.stroke(); }
      for (let n = 0, N = Math.round(1200 * pa); n < N; n++) { c.fillStyle = rnd() < 0.5 ? 'rgba(120,70,20,.16)' : 'rgba(255,240,200,.2)'; c.fillRect(rnd() * G.W, rnd() * G.H, 2, 2); }
    } else if (map === 'tundra') {
      const g = c.createLinearGradient(0, 0, G.W, G.H); g.addColorStop(0, '#d6f2fd'); g.addColorStop(0.5, '#bfe6f7'); g.addColorStop(1, '#a6d5ee');
      c.fillStyle = g; c.fillRect(0, 0, G.W, G.H);
      for (let i = 0; i < 10; i++) if (i % 2) { c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(i * sw, 0, sw, G.H); }
      for (let n = 0, N = Math.round(30 * pa); n < N; n++) {                                          // cracks in the ice
        let x = rnd() * G.W, y = rnd() * G.H, a = rnd() * 6.3;
        c.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,.55)' : 'rgba(60,120,180,.22)'; c.lineWidth = 1 + rnd() * 1.5;
        c.beginPath(); c.moveTo(x, y);
        for (let k = 0; k < 6; k++) { a += (rnd() - 0.5) * 1.2; x += Math.cos(a) * (18 + rnd() * 30); y += Math.sin(a) * (18 + rnd() * 30); c.lineTo(x, y); }
        c.stroke();
      }
      c.save(); c.scale(G.W / 1000, G.H / 620);
      c.fillStyle = 'rgba(255,255,255,.2)'; c.beginPath(); c.moveTo(120, 0); c.lineTo(300, 0); c.lineTo(100, 620); c.lineTo(-80, 620); c.closePath(); c.fill();     // the shine
      c.fillStyle = 'rgba(255,255,255,.12)'; c.beginPath(); c.moveTo(560, 0); c.lineTo(620, 0); c.lineTo(420, 620); c.lineTo(360, 620); c.closePath(); c.fill();
      c.restore();
    } else if (map === 'rainforest') {
      for (let i = 0; i < 10; i++) { c.fillStyle = i % 2 ? '#127a45' : '#0e6a3c'; c.fillRect(i * sw, 0, sw, G.H); }
      for (let n = 0, N = Math.round(900 * pa); n < N; n++) { c.fillStyle = `rgba(150,255,170,${0.02 + rnd() * 0.04})`; c.fillRect(rnd() * G.W, rnd() * G.H, 2, 2 + rnd() * 4); }
      for (let n = 0, N = Math.round(16 * pa); n < N; n++) {                                          // puddles
        const x = 40 + rnd() * (G.W - 80), y = 30 + rnd() * (G.H - 60), rx = 30 + rnd() * 60, ry = 12 + rnd() * 22;
        c.fillStyle = 'rgba(110,190,235,.2)'; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); c.fill();
        c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 2; c.beginPath(); c.ellipse(x, y, rx * 0.7, ry * 0.6, 0, 3.6, 5.2); c.stroke();
      }
    } else {
      for (let i = 0; i < 10; i++) { c.fillStyle = i % 2 ? '#1b9d55' : '#168c4a'; c.fillRect(i * sw, 0, sw, G.H); }
      for (let n = 0, N = Math.round(900 * pa); n < N; n++) { c.fillStyle = `rgba(255,255,255,${0.015 + rnd() * 0.02})`; c.fillRect(rnd() * G.W, rnd() * G.H, 2, 2 + rnd() * 3); }
    }
    const lit = c.createRadialGradient(G.W / 2, G.H / 2, 60, G.W / 2, G.H / 2, G.W * 0.65);
    lit.addColorStop(0, map === 'tundra' ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.1)'); lit.addColorStop(1, map === 'tundra' ? 'rgba(10,40,90,.22)' : map === 'rainforest' ? 'rgba(0,10,10,.5)' : 'rgba(0,12,30,.38)');
    c.fillStyle = lit; c.fillRect(0, 0, G.W, G.H);
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
        <div class="bl-pop" id="blPop"></div>
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

    // ------------------------------------------------------------------ the menu: mode, stadium, (arena,) then team names, mascots and formations
    let stage = 'menu', modeId = null, selMode = 0;               // 'menu' -> 'sizes' -> ('maps' ->) 'teams' -> 'play'
    let sizeId = '', selSize = 0;                                 // the stadium: sets the pitch and how many bobbles a team has
    let mapId = 'classic', selMap = 0;                            // the arena ('classic' is the plain pitch)
    const T = { names: [TEAM[0].name, TEAM[1].name], mascots: [0, 1], forms: ['', ''], ready: [false, false] };      // what the team setup screen shows
    const arenaOf = (id) => ARENAS.find((q) => q.id === id);
    const stadiumOf = (id) => STADIUMS.find((q) => q.id === id);
    const modeName = () => {
      const m = MODES.find((q) => q.id === modeId);
      if (!m) return 'MODE SELECT';
      return [m.name, stadiumOf(sizeId) && stadiumOf(sizeId).name, arenaOf(mapId) && arenaOf(mapId).name].filter(Boolean).join(' // ');
    };
    const setModeLabel = () => { const el = wrap.querySelector('#blMode'); if (el) el.textContent = modeName(); };
    const formOf = (s) => Sim.formsFor(G.n).find((f) => f.id === T.forms[s]) || Sim.formsFor(G.n)[0];

    // the captain of a team (its first player) picks its name, mascot and formation; alone in the room you are everybody's captain
    function captainOf(side) {
      const r = ctx.room();
      if (!r) return -1;
      if (r.slots.length < 2) return r.you;
      const list = r.slots.filter((s, i) => i % 2 === side);
      return list.length ? list[0].id : -1;
    }
    const canEdit = (side) => captainOf(side) === you();
    const playersOf = (side) => { const r = ctx.room(); return r ? (r.slots.length < 2 ? r.slots : r.slots.filter((s, i) => i % 2 === side)) : []; };

    function renderStage() { if (stage === 'menu') renderMenu(); else if (stage === 'sizes') renderSizes(); else if (stage === 'maps') renderMaps(); else if (stage === 'teams') renderSetup(false); }

    function renderSizes() {
      menu.classList.remove('hidden', 'teams');
      if (!isHost) {
        menu.innerHTML = `<h2 class="bl-title">${esc(modeName())}</h2>
          <div class="bl-sub">THE HOST IS CHOOSING THE STADIUM<span class="cursor-blink">_</span></div>`;
        return;
      }
      const r = ctx.room(), per = Math.ceil((r ? r.slots.length : 1) / 2);
      menu.innerHTML = `<h2 class="bl-title small">${esc(modeName())}: CHOOSE YOUR STADIUM</h2>
        <div class="bl-modes bl-sizes">${STADIUMS.map((z, i) => {
          const g = Sim.geo(z.id), f = Sim.formsFor(g.n)[0].id;
          return `<button class="bl-mode bl-size ${i === selSize ? 'sel' : ''}" data-bl="size" data-i="${i}"><b>${z.icon} ${z.name}</b><em class="bl-evt">${z.tag}</em>
            <span class="bl-pitch">${pitchSvg(g, [f, f], Math.round(230 * Math.pow(g.W / Sim.geo('premier').W, 0.6)))}</span><span>${z.blurb}</span>
            ${per > g.n ? `<em class="bl-warn">${per} PLAYERS A TEAM: ${per - g.n} OF THEM WOULD ONLY WATCH</em>` : ''}</button>`;
        }).join('')}</div>
        <div class="bl-row"><button data-bl="back">[ &lt; BACK TO MODES ]</button></div>
        <div class="bl-sub">CLICK OR PRESS ENTER TO CONTINUE // ARROWS TO CHOOSE // THE SIZE OF THE STADIUM DECIDES THE TEAM SIZE</div>`;
    }

    function renderMaps() {
      menu.classList.remove('hidden', 'teams');
      if (!isHost) {
        menu.innerHTML = `<h2 class="bl-title">${esc(modeName())}</h2>
          <div class="bl-sub">THE HOST IS CHOOSING THE ARENA<span class="cursor-blink">_</span></div>`;
        return;
      }
      menu.innerHTML = `<h2 class="bl-title small">${esc(modeName())}: CHOOSE YOUR ARENA</h2>
        <div class="bl-modes bl-maps">${ARENAS.map((m, i) => `<button class="bl-mode bl-map m-${m.id} ${i === selMap ? 'sel' : ''}" data-bl="map" data-i="${i}"><b>${m.icon} ${m.name}</b><em class="bl-evt">EVENT: ${m.event}</em><span>${m.blurb}</span></button>`).join('')}</div>
        <div class="bl-row"><button data-bl="back">[ &lt; BACK TO STADIUMS ]</button></div>
        <div class="bl-sub">CLICK OR PRESS ENTER TO CONTINUE // ARROWS TO CHOOSE</div>`;
    }

    function renderMenu() {
      menu.classList.remove('hidden', 'teams');
      if (!isHost) {
        menu.innerHTML = `<h2 class="bl-title">BOBBLE LEAGUE</h2>
          <div class="bl-sub">THE HOST IS CHOOSING THE GAMEPLAY STYLE<span class="cursor-blink">_</span></div>`;
        return;
      }
      menu.innerHTML = `<h2 class="bl-title">BOBBLE LEAGUE</h2>
        <div class="bl-sub">SELECT YOUR GAMEPLAY STYLE</div>
        <div class="bl-modes">${MODES.map((m, i) => `<button class="bl-mode ${i === selMode ? 'sel' : ''}" data-bl="mode" data-i="${i}"><b>${m.name}</b><span>${m.blurb}</span></button>`).join('')}</div>
        <div class="bl-sub">CLICK OR PRESS ENTER TO CONTINUE // THE GAME OPENS FULL SCREEN</div>`;
    }

    const formButtons = (s, can) => Sim.formsFor(G.n).map((f) => `<button data-bl="form" data-side="${s}" data-id="${f.id}" class="${formOf(s).id === f.id ? 'sel' : ''}" ${can ? '' : 'disabled'}>${f.name}<i>${f.shape}</i></button>`).join('');
    function panelHTML(s) {
      const can = canEdit(s), cap = slotOf(captainOf(s));
      const who = playersOf(s).map((p) => '@' + esc(p.n)).join(' ');
      return `<div class="bl-team t${s}">
        <div class="bl-team-head"><span class="bl-team-em" data-em="${s}">${mascotOf(T.mascots[s])}</span><b>TEAM ${s + 1}</b><span class="bl-sub">${who || '-'}</span></div>
        <label class="bl-field">TEAM NAME<input class="bl-name" data-side="${s}" maxlength="${C.NAME_MAX}" spellcheck="false" autocomplete="off" value="${esc(T.names[s])}" ${can ? '' : 'disabled'}></label>
        <div class="bl-field">TEAM MASCOT</div>
        <div class="bl-mascots">${MASCOTS.map((m, i) => `<button data-bl="mascot" data-side="${s}" data-i="${i}" title="${m[1]}" class="${T.mascots[s] === i ? 'sel' : ''}" ${can ? '' : 'disabled'}>${m[0]}</button>`).join('')}</div>
        <div class="bl-field">FORMATION: <b data-shape="${s}">${formOf(s).name} ${formOf(s).shape}</b></div>
        <div class="bl-formrow"><div class="bl-forms" data-forms="${s}">${formButtons(s, can)}</div><div class="bl-formview" data-fv="${s}">${formView(s)}</div></div>
        <button class="bl-ready ${T.ready[s] ? 'on' : ''}" data-bl="teamready" data-side="${s}" ${can ? '' : 'disabled'}>${T.ready[s] ? '[ ✔ READY ]' : '[ READY ]'}</button>
        <div class="bl-sub" data-note="${s}">${can ? 'you are the captain' : `waiting for captain @${esc(cap ? cap.n : '?')}`}</div>
      </div>`;
    }
    // where the team will stand at kick-off (the whole stadium, this team only)
    const formView = (s) => pitchSvg(G, [s === 0 ? formOf(0).id : '', s === 1 ? formOf(1).id : ''], 0);

    function renderSetup(force) {
      if (stage !== 'teams') return;
      menu.classList.remove('hidden'); menu.classList.add('teams');
      const typing = !force && menu.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      if (typing) { patchSetup(); return; }                       // keep the cursor where it is
      menu.innerHTML = `<h2 class="bl-title small">${esc(modeName())}: PICK YOUR TEAMS</h2>
        <div class="bl-teams">${panelHTML(0)}${panelHTML(1)}</div>
        <div class="bl-sub">THE MATCH STARTS WHEN BOTH CAPTAINS ARE READY</div>
        ${isHost ? `<div class="bl-row"><button data-bl="back">[ &lt; BACK TO ${arenaOf(mapId) ? 'ARENAS' : 'STADIUMS'} ]</button></div>` : ''}`;
    }
    function patchSetup() {
      for (const s of [0, 1]) {
        menu.querySelectorAll(`[data-bl="mascot"][data-side="${s}"]`).forEach((b) => b.classList.toggle('sel', +b.dataset.i === T.mascots[s]));
        menu.querySelectorAll(`[data-bl="form"][data-side="${s}"]`).forEach((b) => b.classList.toggle('sel', b.dataset.id === formOf(s).id));
        const sh = menu.querySelector(`[data-shape="${s}"]`); if (sh) sh.textContent = `${formOf(s).name} ${formOf(s).shape}`;
        const fv = menu.querySelector(`[data-fv="${s}"]`); if (fv) fv.innerHTML = formView(s);
        const em = menu.querySelector(`[data-em="${s}"]`); if (em) em.textContent = mascotOf(T.mascots[s]);
        const rb = menu.querySelector(`[data-bl="teamready"][data-side="${s}"]`);
        if (rb) { rb.classList.toggle('on', T.ready[s]); rb.textContent = T.ready[s] ? '[ ✔ READY ]' : '[ READY ]'; }
        const inp = menu.querySelector(`.bl-name[data-side="${s}"]`);
        if (inp && document.activeElement !== inp && inp.value !== T.names[s]) inp.value = T.names[s];
      }
    }

    // host: show one of the menu screens (and tell the guests which)
    function show(st) {
      stage = st; setModeLabel(); broadcastSetup(); renderStage();
      goFullscreen();
      G3.beep(660, 0.1, 'square');
    }
    // host: the mode was picked, now the stadium
    function chooseMode(i) {
      const m = MODES[i];
      if (!isHost || !m || stage !== 'menu') return;
      modeId = m.id; selMode = i; mapId = 'classic'; sizeId = '';
      show('sizes');
    }
    // host: the stadium was picked: it fixes the pitch and the team size.  Then the arena (arenas mode) or the teams.
    function chooseSize(i) {
      const z = STADIUMS[i];
      if (!isHost || !z || stage !== 'sizes') return;
      sizeId = z.id; selSize = i;
      Sim.setSize(sim, sizeId); setGeo(sizeId);
      for (const s of [0, 1]) T.forms[s] = sim.form[s];
      const m = MODES.find((q) => q.id === modeId);
      if (m && m.maps) show('maps'); else toTeams();
    }
    function chooseMap(i) {                                        // host: the arena was picked, now the teams
      const m = ARENAS[i];
      if (!isHost || !m || stage !== 'maps') return;
      mapId = m.id; selMap = i;
      toTeams();
    }
    function toTeams() {
      T.ready = [false, false];
      for (const s of [0, 1]) { T.names[s] = sim.teams[s].name; T.mascots[s] = sim.teams[s].mascot; T.forms[s] = sim.form[s]; }
      stage = 'teams'; setModeLabel(); broadcastSetup(); renderSetup(true);
      goFullscreen();
      G3.beep(660, 0.1, 'square');
    }
    function broadcastSetup() { ctx.send({ k: 'setup', st: stage, mode: modeId, size: sizeId, map: mapId, names: T.names.slice(), mascots: T.mascots.slice(), forms: T.forms.slice(), ready: T.ready.slice() }); }

    // host: a captain changed their team (or pressed READY)
    function applyTeam(from, d) {
      if (!isHost || stage !== 'teams' || !d || typeof d !== 'object') return;
      const s = d.side === 1 ? 1 : 0;
      if (captainOf(s) !== from) return;
      let changed = false;
      if (typeof d.name === 'string' || d.mascot !== undefined) {
        Sim.setTeam(sim, s, typeof d.name === 'string' ? d.name : undefined, d.mascot);
        T.names[s] = sim.teams[s].name; T.mascots[s] = sim.teams[s].mascot;
        changed = true;
      }
      if (typeof d.form === 'string' && Sim.setFormation(sim, s, d.form)) { T.forms[s] = sim.form[s]; changed = true; }
      if (changed) T.ready[s] = false;                            // changing anything un-readies
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
        if (fields.form !== undefined) T.forms[side] = fields.form;
        if (fields.mascot !== undefined || fields.name !== undefined || fields.form !== undefined) T.ready[side] = false;
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
      stage = 'play'; plans = {}; lastRound = -1; clearPops();
      menu.classList.add('hidden'); over.classList.add('hidden'); shownOver = false;
      Sim.setMap(sim, mapId, (Math.random() * 4294967296) >>> 0);            // the seed makes the arena's random events
      setGeo(sizeId);
      Sim.restart(sim); acc = 0; lastTick = performance.now(); sinceSnap = 1e9; forceSnap = true;
      ctx.send({ k: 'begin', mode: modeId, size: sizeId, map: mapId, names: T.names.slice(), mascots: T.mascots.slice(), forms: T.forms.slice() });
      goFullscreen();
      G3.beep(880, 0.12, 'square');
    }

    function goBack() {                                           // host: one step back (teams -> arenas -> stadiums -> modes)
      if (stage === 'teams' && arenaOf(mapId)) { mapId = 'classic'; show('maps'); }
      else if (stage === 'teams' || stage === 'maps') { mapId = 'classic'; show('sizes'); }
      else showMenu();
    }
    function showMenu() {                                         // host: back to the modes (also from a finished match)
      if (!isHost) return;
      stage = 'menu'; modeId = null; sizeId = ''; mapId = 'classic'; drag = null; plans = {};
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
      if (sim && (sim.phase === 'plan' || sim.phase === 'over' || sim.phase === 'storm')) return 1000 / IDLE_RATE;     // nothing moves: a slow trickle keeps the timer honest
      const guests = Math.max(1, (r ? r.slots.length : 2) - 1);
      let rate = RATE[r && r.transport] || 15;
      if (r && r.transport === 'online') rate = clamp(40 / guests, 4, rate);      // every guest is its own publish to every broker
      else if (r && r.transport === 'relay') rate = clamp(80 / guests, 6, rate);
      return 1000 / rate;
    }

    const LOUD = new Set(['exec', 'goal', 'plan', 'end', 'go', 'pass', 'ot', 'kick-off', 'c', 'storm', 'storm-end', 'heckle', 'mini-end', 'omen', 'bales', 'bolt-warn', 'bolt', 'frost']);       // worth a snapshot right now
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
      setGeo(v.size);
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
      let best = null, bd = G.dr * 1.45;
      for (const d of v.discs) {
        if (!mineDisc(v, d) || v.fx.block[d.i]) continue;               // stunned, stuck, frozen or locked bobbles can't be flicked
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
      hoverBlock = -1;
      if (!d && v && stage === 'play' && v.ph === 'plan') for (const q of v.discs) if (mineDisc(v, q) && v.fx.block[q.i] && Math.hypot(q.x - p.x, q.y - p.y) < G.dr * 1.3) hoverBlock = q.i;
      canvas.style.cursor = d ? 'grab' : hoverBlock >= 0 ? 'not-allowed' : 'default';
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
      if (stage === 'sizes') {
        if (!isHost) return;
        const k = e.code;
        if (k === 'Enter' || k === 'Space' || k === 'NumpadEnter') { e.preventDefault(); chooseSize(selSize); }
        else if (k === 'Escape') { e.preventDefault(); showMenu(); }
        else if (['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA'].includes(k)) { e.preventDefault(); selSize = (selSize + STADIUMS.length - 1) % STADIUMS.length; renderSizes(); }
        else if (['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD'].includes(k)) { e.preventDefault(); selSize = (selSize + 1) % STADIUMS.length; renderSizes(); }
        return;
      }
      if (stage === 'maps') {
        if (!isHost) return;
        const k = e.code;
        if (k === 'Enter' || k === 'Space' || k === 'NumpadEnter') { e.preventDefault(); chooseMap(selMap); }
        else if (k === 'Escape') { e.preventDefault(); goBack(); }
        else if (['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA'].includes(k)) { e.preventDefault(); selMap = (selMap + ARENAS.length - 1) % ARENAS.length; renderMaps(); }
        else if (['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD'].includes(k)) { e.preventDefault(); selMap = (selMap + 1) % ARENAS.length; renderMaps(); }
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
      else if (a === 'size') chooseSize(+b.dataset.i);
      else if (a === 'map') chooseMap(+b.dataset.i);
      else if (a === 'form') sendTeam(+b.dataset.side, { form: b.dataset.id });
      else if (a === 'mascot') sendTeam(+b.dataset.side, { mascot: +b.dataset.i });
      else if (a === 'teamready') sendTeam(+b.dataset.side, { ready: !T.ready[+b.dataset.side] });
      else if (a === 'back') goBack();
      else if (a === 'menu') showMenu();
      else if (a === 'ready') toggleReady();
      else if (a === 'lobby') ctx.backToLobby();
      else if (a === 'leave') ctx.leave();
      else if (a === 'rematch' && sim) { clearPops(); Sim.restart(sim); plans = {}; lastRound = -1; acc = 0; lastTick = performance.now(); forceSnap = true; shownOver = false; over.classList.add('hidden'); }
    });

    // ------------------------------------------------------------------ arena minigames (on my own screen; the host hears how long I took)
    const stageEl = wrap.querySelector('.bl-stage');
    let mini = null, miniKey = '', miniDoneKey = '';
    function sendMiniDone(ms) {
      if (isHost) { Sim.miniDone(sim, 0, ms); forceSnap = true; }
      else ctx.send({ k: 'mini', ms: Math.round(ms) }, true);
    }
    function syncMini(v) {
      const m = stage === 'play' && v && v.fx.mini;
      const mine = !!m && m.who.includes(you()) && (!m.race || v.ph === 'storm') && !!window.BobbleMini;
      const key = m ? `${m.k}|${m.race ? v.round : ''}|${m.what}|${m.who.join()}` : '';
      if (mini && (!mine || miniKey !== key)) { mini.stop(); mini = null; }
      if (!m) miniDoneKey = '';
      if (mine && !mini && miniDoneKey !== key) {
        miniKey = key;
        mini = BobbleMini.start(m.k, stageEl, { what: m.what, beep: (f, d, ty) => G3.beep(f, d, ty), onDone: (ms) => { miniDoneKey = key; sendMiniDone(ms); } });
      }
    }

    // ------------------------------------------------------------------ sound and particles
    const beep = (f, d, t) => G3.beep(f, d, t);
    const parts = [];
    let shake = 0, wash = null, goalT = 0, kickT = 0;
    // arena effects: weather, things thrown from the stands, lightning
    const amb = [], thrown = [], splats = [], bolts = [], camFlashes = [];
    let ambMap = '', stormK = 0, flash = 0, hoverBlock = -1;
    function fx(e, v) {
      const ball = v.ball;
      popFor(e);
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
          const x = e[1] === 0 ? G.W : 0;
          for (let i = 0; i < 120; i++) spark(x, G.H / 2, [TEAM[e[1]].main, '#fff', '#ffd43b', TEAM[e[1]].light][i % 4], 650, true);
          break;
        }
        case 'kick-off': kickT = 1; break;
        case 'pass': beep(210, 0.15, 'sawtooth'); break;
        case 'ot': beep(330, 0.4, 'sawtooth'); break;
        case 'end': [392, 330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'triangle'), i * 160)); break;
        case 'storm': [200, 260, 330, 420].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'sawtooth'), i * 120)); shake = Math.max(shake, 6); break;
        case 'storm-end': {
          const mine = v.owners.indexOf(you()), side = mine < 0 ? -1 : (mine < G.n ? 0 : 1);
          if (e[2] < 0) beep(200, 0.3, 'triangle');
          else if (side === e[2]) [523, 659, 784].forEach((f, i) => setTimeout(() => beep(f, 0.14, 'square'), i * 90));
          else [330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'triangle'), i * 120));
          break;
        }
        case 'heckle': {                                              // [pid, side, what, from]: something flies in from the stands
          const lv = lastView, ds = lv ? lv.discs.filter((q) => q.side === e[2] && lv.owners[q.i] === e[1]) : [];
          const tx = ds.length ? ds.reduce((a, q) => a + q.x, 0) / ds.length : (e[2] ? G.W * 0.75 : G.W * 0.25), ty = ds.length ? ds.reduce((a, q) => a + q.y, 0) / ds.length : G.H / 2;
          thrown.push({ what: e[3], x0: clamp(e[4] * G.W, 60, G.W - 60), y0: e[4] < 0.5 ? -TM + 24 : G.H + BM - 24, x1: tx, y1: ty, t: 0, T: 0.75 });
          [300, 220].forEach((f, i) => setTimeout(() => beep(f, 0.12, 'sawtooth'), i * 140));
          break;
        }
        case 'mini-end': if (e[2]) beep(780, 0.12, 'square'); break;
        case 'omen': beep(300, 0.1, 'square'); setTimeout(() => beep(300, 0.1, 'square'), 150); break;
        case 'bales': beep(90, 0.5, 'sawtooth'); break;
        case 'bolt-warn': [400, 600, 800, 1000].forEach((f, i) => setTimeout(() => beep(f, 0.18, 'sawtooth'), i * 220)); break;
        case 'bolt':
          flash = 1; newBolt(e[1], e[2]); shake = Math.max(shake, 16);
          beep(60, 0.5, 'sawtooth'); beep(2200, 0.06, 'square');
          for (let i = 0; i < 40; i++) spark(e[1], e[2], ['#fff27a', '#ffffff', '#9fd8ff'][i % 3], 520);
          break;
        case 'frost': if (v.owners[e[1]] === you()) beep(e[2] > 0 ? 1500 - 250 * e[2] : 900, 0.12, 'triangle'); break;
        default: break;
      }
    }
    function spark(x, y, color, speed, confetti) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: confetti ? 1.4 + Math.random() : 0.3 + Math.random() * 0.25, c: color, s: confetti ? 6 + Math.random() * 5 : 3, rot: Math.random() * 6, f: confetti ? 1.2 : 3.5 });
    }

    // ------------------------------------------------------------------ drawing
    const trail = [];
    let ballRot = 0, bg = null, bgMap = 'classic', bgBuilt = '', k = 1, shownOver = false, prevT = performance.now(), raf = 0, barText = '';

    function resize() {
      const w = canvas.clientWidth || 800, dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(w * dpr);
      const key = bgMap + '|' + G.id;
      wrap.style.setProperty('--bl-ar', (VW / VH).toFixed(4));          // the frame follows the stadium's shape
      if (canvas.width === pw && bgBuilt === key) return;
      bgBuilt = key;
      canvas.width = pw; canvas.height = Math.round(pw * VH / VW);
      k = canvas.width / VW;
      bg = document.createElement('canvas'); bg.width = canvas.width; bg.height = canvas.height;
      const b = bg.getContext('2d'); b.setTransform(k, 0, 0, k, MX * k, TM * k);
      paintBackground(b, bgMap);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function paintBackground(c, map) {
      const rnd = mulberry(99);
      paintSurround(c, map, rnd);                                                  // the stands / dunes / pines / jungle around the pitch
      paintGround(c, map, rnd);                                                    // the playing surface and a soft pool of light
      // the nets
      for (const s of [0, 1]) {
        const x0 = s ? G.W : -G.NET, x1 = s ? G.W + G.NET : 0, t = TEAM[s];
        c.fillStyle = 'rgba(4,8,26,.72)'; c.fillRect(x0, G.GY0, G.NET, G.GY1 - G.GY0);
        c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1.5;
        for (let x = x0; x <= x1; x += 14) { c.beginPath(); c.moveTo(x, G.GY0); c.lineTo(x, G.GY1); c.stroke(); }
        for (let y = G.GY0; y <= G.GY1; y += 14) { c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); }
        c.lineCap = 'round'; c.strokeStyle = t.main; c.shadowColor = t.main; c.shadowBlur = 14; c.lineWidth = 7;
        c.beginPath(); c.moveTo(x1, G.GY0); c.lineTo(s ? x1 : x0, G.GY0); c.lineTo(s ? x1 : x0, G.GY1); c.lineTo(x1, G.GY1); c.stroke();
        c.shadowBlur = 0; c.strokeStyle = '#fff'; c.lineWidth = 2.5;
        c.beginPath(); c.moveTo(x1, G.GY0); c.lineTo(s ? x1 : x0, G.GY0); c.lineTo(s ? x1 : x0, G.GY1); c.lineTo(x1, G.GY1); c.stroke();
        c.lineCap = 'butt';
      }
      // the markings
      c.strokeStyle = LINE[map] || LINE.classic; c.lineWidth = 4;
      c.strokeRect(0, 0, G.W, G.H);
      c.beginPath(); c.moveTo(G.W / 2, 0); c.lineTo(G.W / 2, G.H); c.stroke();
      const m = (G.GY1 - G.GY0) / 220;                                               // the markings follow the size of the goal mouth
      c.beginPath(); c.arc(G.W / 2, G.H / 2, G.H * 0.148, 0, 7); c.stroke();
      c.fillStyle = LINE[map] || LINE.classic; c.beginPath(); c.arc(G.W / 2, G.H / 2, 6, 0, 7); c.fill();
      for (const s of [0, 1]) {
        const x = s ? G.W : 0, d = s ? -1 : 1;
        c.strokeRect(s ? G.W - 160 * m : 0, G.H / 2 - 190 * m, 160 * m, 380 * m);
        c.strokeRect(s ? G.W - 60 * m : 0, G.H / 2 - 120 * m, 60 * m, 240 * m);
        c.beginPath(); c.arc(x + d * 110 * m, G.H / 2, 5, 0, 7); c.fill();
        c.beginPath(); c.arc(x + d * 110 * m, G.H / 2, 82 * m, s ? Math.PI - 0.88 : -0.88, s ? Math.PI + 0.88 : 0.88); c.stroke();
      }
      // the posts
      for (const [px, py, s] of [[0, G.GY0, 0], [0, G.GY1, 0], [G.W, G.GY0, 1], [G.W, G.GY1, 1]]) {
        c.fillStyle = TEAM[s].main; c.beginPath(); c.arc(px, py, C.POST + 3, 0, 7); c.fill();
        c.fillStyle = '#fff'; c.beginPath(); c.arc(px, py, C.POST, 0, 7); c.fill();
      }
    }

    const emoji = (ch, x, y, size) => { g.font = `${size}px ${EMOJI_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, x, y + size * 0.06); };

    function draw(v, dt) {
      setGeo(v.size);
      bgMap = v.fx.map;
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
      for (const d of v.discs) { g.fillStyle = 'rgba(0,0,0,.34)'; g.beginPath(); g.ellipse(d.x + 4, d.y + 7, G.dr, G.dr * 0.92, 0, 0, 7); g.fill(); }
      g.fillStyle = 'rgba(0,0,0,.34)'; g.beginPath(); g.ellipse(v.ball.x + 3, v.ball.y + 5, G.br, G.br * 0.9, 0, 0, 7); g.fill();
      trail.push({ x: v.ball.x, y: v.ball.y });
      if (trail.length > 12) trail.shift();
      const sp = Math.hypot(v.ball.vx, v.ball.vy);
      if (sp > 350) for (let i = 0; i < trail.length - 1; i++) {
        const q = trail[i];
        g.fillStyle = `rgba(255,255,255,${(i / trail.length) * 0.24 * Math.min(1, sp / 1100)})`;
        g.beginPath(); g.arc(q.x, q.y, G.br * (0.4 + 0.6 * i / trail.length), 0, 7); g.fill();
      }
      drawOmens(v, t);
      if (v.ph === 'plan') drawRings(v, t);
      for (const d of v.discs) drawDisc(d, v, t);
      drawBall(v.ball, dt);
      for (const b of v.fx.bales) drawBale(b);
      if (v.ph === 'plan') drawPlans(v);
      if (drag) drawAim(drag);
      if (hoverBlock >= 0 && v.fx.block[hoverBlock]) { const d = v.discs[hoverBlock]; tag(BLOCKED[v.fx.block[hoverBlock]], d.x, d.y - G.dr - 16 * HS, '#ff9f9f'); }
      drawThrown(dt);
      drawParts(dt);
      drawAmbient(v, dt, t);
      drawBolts(dt);
      drawHud(v, t);
      goalT = Math.max(0, goalT - dt); kickT = Math.max(0, kickT - dt);
    }

    // ------------------------------------------------------------------ arena effects
    const flavorOf = (what) => (window.BobbleMini && BobbleMini.FLAVOR[what]) || { emoji: '🍅', colors: ['#d62b1f', '#ff5a3c', '#8f1208'] };
    function tag(txt, x, y, col) {
      g.font = `${9 * HS}px "Press Start 2P", monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const w = g.measureText(txt).width + 10 * HS;
      g.fillStyle = 'rgba(4,6,30,.85)'; g.fillRect(x - w / 2, y - 8 * HS, w, 16 * HS);
      g.fillStyle = col; g.fillText(txt, x, y + 1);
    }

    function initAmb(map) {
      amb.length = 0; ambMap = map;
      const n = map === 'rainforest' ? 150 : map === 'stadium' ? 0 : 110;
      for (let i = 0; i < n; i++) {
        const p = { x: -MX + Math.random() * VW, y: -TM + Math.random() * VH, a: 0.3 + Math.random() * 0.5, z: Math.random() };
        if (map === 'desert') { p.vx = 70 + p.z * 90; p.vy = (p.z - 0.5) * 14; }
        else if (map === 'tundra') { p.vx = (p.z - 0.5) * 30; p.vy = 40 + p.z * 60; }
        else { p.vx = -130; p.vy = 760 + p.z * 200; }
        amb.push(p);
      }
    }

    // weather over the pitch: dust, snow or rain (a storm turns it up), camera flashes in the stadium
    function drawAmbient(v, dt, t) {
      const map = v.fx.map;
      if (map === 'classic') return;
      if (ambMap !== map) initAmb(map);
      stormK += ((v.ph === 'storm' ? 1 : 0) - stormK) * Math.min(1, dt * 3);
      const X0 = -MX, X1 = G.W + MX, Y0 = -TM, Y1 = G.H + BM;
      if (map === 'stadium') {
        if (Math.random() < dt * 9) { const top = Math.random() < 0.5; camFlashes.push({ x: X0 + Math.random() * VW, y: top ? Y0 + Math.random() * (TM - 20) : G.H + 20 + Math.random() * (BM - 30), life: 0.16 }); if (camFlashes.length > 24) camFlashes.shift(); }
        for (let i = camFlashes.length - 1; i >= 0; i--) {
          const f = camFlashes[i]; f.life -= dt;
          if (f.life <= 0) { camFlashes.splice(i, 1); continue; }
          g.fillStyle = `rgba(255,255,240,${f.life / 0.16})`; g.beginPath(); g.arc(f.x, f.y, 2 + f.life * 28, 0, 7); g.fill();
        }
        return;
      }
      const sk = 1 + stormK * (map === 'desert' ? 9 : 5);
      g.lineCap = 'round';
      for (const p of amb) {
        p.x += p.vx * sk * dt; p.y += p.vy * sk * dt;
        if (map === 'tundra') p.x += Math.sin(t * 1.5 + p.z * 30) * 18 * dt;
        if (p.x > X1) p.x = X0; else if (p.x < X0) p.x = X1;
        if (p.y > Y1) p.y = Y0; else if (p.y < Y0) p.y = Y1;
        if (map === 'desert') {
          g.strokeStyle = `rgba(238,205,140,${p.a * (0.35 + 0.55 * stormK)})`; g.lineWidth = 1.5 + p.z * 2;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * sk * 0.045, p.y - p.vy * sk * 0.045); g.stroke();
        } else if (map === 'tundra') {
          g.fillStyle = `rgba(255,255,255,${p.a * (0.6 + 0.4 * stormK)})`;
          if (stormK > 0.3) { g.strokeStyle = g.fillStyle; g.lineWidth = 2 + p.z * 2; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * sk * 0.03, p.y - p.vy * sk * 0.03); g.stroke(); }
          else { g.beginPath(); g.arc(p.x, p.y, 1.5 + p.z * 2.5, 0, 7); g.fill(); }
        } else {
          g.strokeStyle = `rgba(190,225,255,${0.18 + p.a * 0.3})`; g.lineWidth = 1 + p.z;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + p.vx * 0.022, p.y + p.vy * 0.022); g.stroke();
        }
      }
      g.lineCap = 'butt';
      if (stormK > 0.02) {                                                  // the storm hides everything a little
        g.fillStyle = map === 'desert' ? `rgba(214,168,88,${0.4 * stormK})` : `rgba(232,244,255,${0.42 * stormK})`;
        g.fillRect(X0, Y0, VW, VH);
      }
    }

    function drawBale(b) {
      const r = b.r, rot = (b.y + b.x * 0.4) / r;
      g.fillStyle = 'rgba(0,0,0,.3)'; g.beginPath(); g.ellipse(b.x + 5, b.y + 9, r, r * 0.9, 0, 0, 7); g.fill();
      const gr = g.createRadialGradient(b.x - r * 0.3, b.y - r * 0.35, 3, b.x, b.y, r * 1.1);
      gr.addColorStop(0, '#f6dc86'); gr.addColorStop(0.6, '#d8b04a'); gr.addColorStop(1, '#8f6a1c');
      g.fillStyle = gr; g.strokeStyle = '#5d4310'; g.lineWidth = 3; g.beginPath(); g.arc(b.x, b.y, r, 0, 7); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(100,70,15,.7)'; g.lineWidth = 2;
      for (let q = 0; q < 4; q++) { g.beginPath(); g.arc(b.x, b.y, r * (0.25 + q * 0.19), rot + q * 1.3, rot + q * 1.3 + 4.1); g.stroke(); }
      g.strokeStyle = '#8a3b22'; g.lineWidth = 3; g.beginPath();
      g.moveTo(b.x + Math.cos(rot) * r * 0.97, b.y + Math.sin(rot) * r * 0.97); g.lineTo(b.x - Math.cos(rot) * r * 0.97, b.y - Math.sin(rot) * r * 0.97); g.stroke();
    }

    // announced hazards: the path of each hay bale, the spot lightning is about to hit
    function drawOmens(v, t) {
      const fx = v.fx;
      if (fx.omen && v.ph === 'plan') for (const o of fx.omen) {
        const dy = o.from ? -1 : 1, ex = o.x, ey = o.from ? G.H : 0;
        const len = Math.hypot(o.vx, dy * 450), ux = o.vx / len, uy = dy * 450 / len, L = G.H * 0.58, pulse = 0.45 + 0.35 * Math.sin(t * 6);
        g.setLineDash([14, 11]); g.strokeStyle = `rgba(255,214,90,${pulse})`; g.lineWidth = 5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex + ux * L, ey + uy * L); g.stroke(); g.setLineDash([]); g.lineCap = 'butt';
        g.fillStyle = `rgba(255,214,90,${pulse + 0.2})`; g.beginPath();
        g.moveTo(ex + ux * (L + 18), ey + uy * (L + 18)); g.lineTo(ex + ux * L - uy * 12, ey + uy * L + ux * 12); g.lineTo(ex + ux * L + uy * 12, ey + uy * L - ux * 12); g.closePath(); g.fill();
        g.fillStyle = '#fff'; emoji('🌾', ex, ey + dy * 24 * G.u, (34 + 4 * Math.sin(t * 6)) * G.u);
        tag('HAY', ex, ey + dy * 54 * G.u, '#ffd43b');
      }
      if (fx.bolt) {
        const b = fx.bolt, k = clamp(b.t / C.BOLT_WARN, 0, 1), blink = Math.sin(t * 34) > 0;
        g.strokeStyle = `rgba(255,244,140,${0.18 + (1 - k) * 0.4})`; g.lineWidth = 2; g.setLineDash([6, 8]);
        g.beginPath(); g.moveTo(b.x, -TM); g.lineTo(b.x, b.y); g.stroke(); g.setLineDash([]);
        g.strokeStyle = blink ? '#fff27a' : '#ff9f43'; g.lineWidth = 3; g.setLineDash([10, 8]);
        g.beginPath(); g.arc(b.x, b.y, G.stunR, 0, 7); g.stroke(); g.setLineDash([]);
        g.lineWidth = 4; g.beginPath(); g.arc(b.x, b.y, 14 + (G.stunR - 14) * k, 0, 7); g.stroke();
        g.fillStyle = '#fff'; emoji('⚡', b.x, b.y, 34 * G.u);
      }
    }

    // a missile from the stands (stadium), then the splat where it landed
    function drawThrown(dt) {
      for (let i = thrown.length - 1; i >= 0; i--) {
        const q = thrown[i];
        q.t += dt;
        const u = q.t / q.T;
        if (u >= 1) {
          thrown.splice(i, 1);
          const fl = flavorOf(q.what);
          splats.push({ x: q.x1, y: q.y1, life: 1.2, c: fl.colors[0] });
          for (let n = 0; n < 26; n++) spark(q.x1, q.y1, fl.colors[n % 3], 420);
          shake = Math.max(shake, 9); beep(110, 0.18, 'sawtooth'); beep(70, 0.25, 'square');
          continue;
        }
        const x = q.x0 + (q.x1 - q.x0) * u, y = q.y0 + (q.y1 - q.y0) * u - Math.sin(Math.PI * u) * 150;
        g.save(); g.translate(x, y); g.rotate(u * 12); g.fillStyle = '#fff'; emoji(flavorOf(q.what).emoji, 0, 0, 30 + 16 * u); g.restore();
      }
      for (let i = splats.length - 1; i >= 0; i--) {
        const q = splats[i]; q.life -= dt;
        if (q.life <= 0) { splats.splice(i, 1); continue; }
        g.globalAlpha = clamp(q.life, 0, 0.6); g.fillStyle = q.c;
        for (let n = 0; n < 5; n++) { g.beginPath(); g.arc(q.x + Math.cos(n * 1.9) * 26, q.y + Math.sin(n * 2.3) * 22, 14 + n * 3, 0, 7); g.fill(); }
        g.globalAlpha = 1;
      }
    }

    function drawBolts(dt) {
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i]; b.life -= dt;
        if (b.life <= 0) { bolts.splice(i, 1); continue; }
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = `rgba(255,240,120,${b.life / 0.4})`; g.lineWidth = 14; g.beginPath(); b.pts.forEach((p, j) => g[j ? 'lineTo' : 'moveTo'](p[0], p[1])); g.stroke();
        g.strokeStyle = `rgba(255,255,255,${Math.min(1, b.life / 0.25)})`; g.lineWidth = 5; g.beginPath(); b.pts.forEach((p, j) => g[j ? 'lineTo' : 'moveTo'](p[0], p[1])); g.stroke();
        g.lineJoin = 'miter'; g.lineCap = 'butt';
      }
      if (flash > 0.01) { g.fillStyle = `rgba(255,255,235,${0.65 * flash})`; g.fillRect(-MX, -TM, VW, VH); flash *= Math.pow(0.002, dt); }
    }
    function newBolt(x, y) {
      const pts = [[x + (Math.random() - 0.5) * 60, -TM]], n = 8;
      for (let i = 1; i < n; i++) pts.push([x + (Math.random() - 0.5) * 70 * (1 - i / n), -TM + (y + TM) * i / n]);
      pts.push([x, y]);
      bolts.push({ pts, life: 0.4 });
    }

    // ------------------------------------------------------------------ event popups (DOM, above the minigames and the weather)
    // One card per event, with a bar that runs down.  `life` is a fixed number of seconds; `until(view)` keeps it up for as long as the
    // effect itself lasts (the card is never shown for less than 0.8 s, nor longer than `max`); `frac(view)` drives the bar then.
    const popWrap = wrap.querySelector('#blPop');
    const pops = [];
    const nameOf = (pid) => { const s = slotOf(pid); return s ? '@' + s.n : 'A PLAYER'; };
    function pop(id, o) {
      let p = pops.find((q) => q.id === id);
      if (!p) {
        const el = document.createElement('div');
        el.className = 'bl-pop-card';
        el.innerHTML = '<span class="bl-pop-ic"></span><div class="bl-pop-tx"><b></b><span></span></div><i class="bl-pop-bar"></i>';
        popWrap.appendChild(el);
        p = { id, el, ic: el.querySelector('.bl-pop-ic'), ti: el.querySelector('b'), su: el.querySelector('.bl-pop-tx span'), bar: el.querySelector('.bl-pop-bar'), txt: ['', ''] };
        pops.push(p);
        while (pops.length > 3) dropPop(pops[0]);                          // never more than three cards
      }
      p.o = o; p.born = performance.now();
      p.el.style.setProperty('--tone', o.tone || '#ffd43b');
      p.ic.textContent = o.icon || '';
      p.dying = false; p.el.classList.remove('out');
      return p;
    }
    function dropPop(p) {
      const i = pops.indexOf(p);
      if (i >= 0) pops.splice(i, 1);
      p.el.classList.add('out');
      setTimeout(() => p.el.remove(), 280);
    }
    function endPop(id) { const p = pops.find((q) => q.id === id); if (p) dropPop(p); }
    function clearPops() { while (pops.length) dropPop(pops[0]); }
    const str = (f, v) => (typeof f === 'function' ? f(v) : f || '');
    function syncPops(v, now) {
      for (const p of pops.slice()) {
        const o = p.o, age = (now - p.born) / 1000;
        const over = (o.life && age >= o.life) || age >= (o.max || 40) || (o.until && v && age >= 0.8 && !o.until(v));
        if (over) { dropPop(p); continue; }
        const t = str(o.title, v), s = str(o.sub, v);
        if (p.txt[0] !== t) { p.ti.textContent = t; p.txt[0] = t; }
        if (p.txt[1] !== s) { p.su.textContent = s; p.txt[1] = s; }
        const f = o.frac && v ? clamp(o.frac(v), 0, 1) : o.life ? 1 - age / o.life : 1;
        p.bar.style.transform = `scaleX(${f.toFixed(3)})`;
      }
    }
    // what each event says, and how long it lasts
    function popFor(e) {
      switch (e[0]) {
        case 'heckle': {                                                    // [pid, side, what, from]
          const pid = e[1], fl = flavorOf(e[3]), jeer = e[3] === 'boo';
          endPop('heckle-end');
          pop('heckle', {
            icon: fl.emoji, tone: '#ffb36b', max: C.HECKLE_T + 2,
            title: () => `${nameOf(pid)} ${jeer ? 'IS BEING JEERED' : 'GOT PELTED'}!`,
            sub: (v) => {
              const m = v.fx.mini; if (!m) return '';
              const carriers = []; let stuck = false;
              for (let i = 0; i < v.fx.pelt.length; i++) if (v.fx.pelt[i]) { if (v.fx.block[i] === 2) stuck = true; else if (!carriers.includes(v.owners[i])) carriers.push(v.owners[i]); }
              const left = `${Math.ceil(m.t)}s`;
              return stuck ? `THEIR BOBBLES ARE STUCK FOR ${left} UNLESS THEY SCRUB CLEAN`
                : `${carriers.map(nameOf).join(' + ')} CARR${carriers.length > 1 ? 'Y' : 'IES'} THEIR BOBBLES FOR ${left}`;
            },
            until: (v) => !!v.fx.mini && !v.fx.mini.race,
            frac: (v) => (v.fx.mini ? v.fx.mini.t / C.HECKLE_T : 0),
          });
          break;
        }
        case 'mini-end': {                                                  // [pid, ok, kind]
          endPop('heckle');
          pop('heckle-end', { icon: e[2] ? '✅' : '⏱️', tone: e[2] ? '#7cf29a' : '#ffb36b', life: 3,
            title: e[2] ? `${nameOf(e[1])} IS CLEAN!` : `TIME'S UP FOR ${nameOf(e[1])}`, sub: 'THEIR BOBBLES ARE THEIR OWN AGAIN' });
          break;
        }
        case 'storm': {                                                     // [kind]
          const desert = e[1] === 'dig';
          endPop('storm-end');
          pop('storm', {
            icon: desert ? '🏜️' : '🌨️', tone: desert ? '#e0b050' : '#9fd8ff', max: C.STORM_T + 2,
            title: desert ? 'SANDSTORM!' : 'SNOWSTORM!',
            sub: (v) => `RACE: ${desert ? 'DIG OUT' : 'SHAKE IT OFF'}! THE FIRST ONE OUT GETS THE TURN  ${Math.ceil(v.t)}s`,
            until: (v) => v.ph === 'storm', frac: (v) => v.t / C.STORM_T,
          });
          break;
        }
        case 'storm-end': {                                                 // [winnerPid, winnerSide, kind]
          endPop('storm');
          if (e[2] < 0) pop('storm-end', { icon: '🌫️', tone: '#cfd8ff', life: 3.5, title: 'NOBODY GOT OUT', sub: 'THE STORM PASSES: NOBODY IS LOCKED' });
          else pop('storm-end', {
            icon: '🏆', tone: TEAM[e[2]].main, max: C.PLAN_TIME + 2,
            title: (v) => `${v.teams[e[2]].name} WIN THE TURN!`,
            sub: (v) => `${v.teams[1 - e[2]].name} ARE LOCKED IN PLACE FOR THIS ROUND`,
            until: (v) => v.fx.frozen >= 0 && v.ph === 'plan',
          });
          break;
        }
        case 'omen':
          pop('omen', {
            icon: '🌾', tone: '#ffd43b', max: C.PLAN_TIME + 2,
            title: `${e[1]} HAY BALE${e[1] > 1 ? 'S' : ''} INCOMING!`, sub: 'THEY ROLL IN WHEN THE FLICKS START. PLAN AROUND THE DASHED PATHS',
            until: (v) => !!v.fx.omen && v.ph === 'plan', frac: (v) => v.t / C.PLAN_TIME,
          });
          break;
        case 'bales':
          endPop('omen');
          pop('bales', { icon: '🌾', tone: '#ffd43b', max: 15, title: 'WATCH OUT: HAY BALES!', sub: 'THEY KNOCK EVERYTHING IN THEIR WAY', until: (v) => v.fx.bales.length > 0 });
          break;
        case 'bolt-warn':
          pop('bolt', { icon: '⚡', tone: '#fff27a', life: C.BOLT_WARN + 0.4, title: 'LIGHTNING!', sub: 'IT STRIKES THE MARKED SPOT. THE BOBBLES NEAREST IT ARE STUNNED' });
          break;
        case 'bolt': {                                                      // [x, y, [bobbles hit]]
          endPop('bolt');
          const n = e[3].length;
          pop('stun', {
            icon: '😵', tone: '#fff27a', max: C.STUN + 2,
            title: `${n} BOBBLE${n === 1 ? '' : 'S'} STUNNED!`,
            sub: (v) => `THEY CAN'T BE FLICKED FOR ${Math.ceil(Math.max(0, ...v.fx.stun))}s`,
            until: (v) => v.fx.stun.some((x) => x > 0), frac: (v) => Math.max(0, ...v.fx.stun) / C.STUN,
          });
          break;
        }
        case 'frost':                                                       // [bobble, level]
          if (e[2] > 0) pop('frost', {
            icon: '🥶', tone: '#bfe9ff', life: 5,
            title: e[2] >= 3 ? 'FROZEN SOLID!' : 'FROSTBITE!',
            sub: (v) => {
              const cold = v.fx.frost.filter((x) => x > 0 && x < 3).length, ice = v.fx.frost.filter((x) => x >= 3).length;
              return `${cold ? cold + ' COOLING (WEAKER FLICKS)' : ''}${cold && ice ? ', ' : ''}${ice ? ice + ' FROZEN: KNOCK THEM FREE' : ''}. MOVE BOBBLES TO KEEP THEM WARM`;
            },
          });
          break;
        default: break;
      }
    }

    // which bobbles are mine to plan: bright gold when they still need a plan, green once planned; my teammates' are outlined in the team colour
    function drawRings(v, t) {
      const me = you(), ready = iAmReady(v);
      for (const d of v.discs) {
        const owner = v.owners[d.i];
        if (owner === me && v.fx.block[d.i]) {                          // mine, but it can't be flicked right now
          g.strokeStyle = 'rgba(180,190,210,.75)'; g.lineWidth = 2.5; g.setLineDash([4, 5]);
          g.beginPath(); g.arc(d.x, d.y, G.dr + 7, 0, 7); g.stroke(); g.setLineDash([]);
        } else if (owner === me) {
          const planned = !!plans[d.i], hot = d.i === hover || (drag && drag.i === d.i);
          g.strokeStyle = ready ? 'rgba(124,242,154,.9)' : hot ? '#ffffff' : planned ? '#7cf29a' : '#ffd43b';
          g.lineWidth = hot ? 4 : 3;
          g.globalAlpha = hot || ready || planned ? 1 : 0.55 + 0.35 * Math.sin(t * 6 + d.i);
          g.beginPath(); g.arc(d.x, d.y, G.dr + 7 + (hot ? 3 : planned || ready ? 0 : 2 * Math.sin(t * 6 + d.i)), 0, 7); g.stroke();
          g.globalAlpha = 1;
        } else if (owner >= 0 && d.side === (myTeamSide(v))) {
          g.strokeStyle = `rgba(${TEAM[d.side].rgb},.55)`; g.lineWidth = 2.5; g.setLineDash([5, 5]);
          g.beginPath(); g.arc(d.x, d.y, G.dr + 6, 0, 7); g.stroke(); g.setLineDash([]);
        }
      }
    }
    function myTeamSide(v) { const i = v.owners.indexOf(you()); return i < 0 ? -1 : (i < G.n ? 0 : 1); }

    // frostbite, stun, a splat, a padlock: what has happened to a bobble
    function drawStatus(d, v, t) {
      const fx = v.fx, r = G.dr, fr = fx.frost[d.i], st = fx.stun[d.i], bk = fx.block[d.i];
      if (fr > 0) {
        g.fillStyle = `rgba(200,236,255,${[0, 0.28, 0.5, 0.8][fr]})`; g.beginPath(); g.arc(d.x, d.y, r, 0, 7); g.fill();
        g.strokeStyle = `rgba(255,255,255,${0.4 + 0.15 * fr})`; g.lineWidth = 2;
        for (let a = 0; a < 6; a++) {
          const an = a * Math.PI / 3 + fr * 0.2, r0 = r * 0.2, r1 = r * (0.55 + 0.12 * fr);
          g.beginPath(); g.moveTo(d.x + Math.cos(an) * r0, d.y + Math.sin(an) * r0); g.lineTo(d.x + Math.cos(an) * r1, d.y + Math.sin(an) * r1); g.stroke();
        }
        if (fr === 3) { g.strokeStyle = '#e8f8ff'; g.lineWidth = 4; g.beginPath(); g.arc(d.x, d.y, r + 2, 0, 7); g.stroke(); }
        tag(fr === 3 ? 'FROZEN' : '*'.repeat(fr), d.x, d.y - r - 11 * HS, '#bfe9ff');
      } else if (fx.idle[d.i] >= C.FROST_AFTER && v.ph === 'plan') {      // one more round without moving and it gets frostbite
        g.globalAlpha = 0.6 + 0.4 * Math.sin(t * 7);
        tag('COLD!', d.x, d.y - r - 11 * HS, '#ffd43b'); g.globalAlpha = 1;
      }
      if (st > 0) {
        g.fillStyle = 'rgba(20,20,50,.38)'; g.beginPath(); g.arc(d.x, d.y, r, 0, 7); g.fill();
        g.strokeStyle = '#fff27a'; g.lineWidth = 2.5; g.lineJoin = 'round';
        const seed = Math.floor(t * 14);
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          for (let j = 0; j < 7; j++) {
            const an = (j + k * 2.3) * 0.9 + seed * 1.7, rr = r + 3 + (((seed * 7 + j * 13 + k * 5) % 5) - 2) * 3;
            g[j ? 'lineTo' : 'moveTo'](d.x + Math.cos(an) * rr, d.y + Math.sin(an) * rr);
          }
          g.stroke();
        }
        g.lineJoin = 'miter';
        tag(`STUN ${Math.ceil(st)}s`, d.x, d.y - r - 11 * HS, '#fff27a');
      }
      if (fx.pelt[d.i]) {                                                   // the pelted player's bobbles: stuck, or carried by a teammate
        const fl = flavorOf(fx.mini && fx.mini.what);
        g.globalAlpha = 0.72; g.fillStyle = fl.colors[0];
        for (let n = 0; n < 4; n++) { g.beginPath(); g.arc(d.x + Math.cos(n * 1.7) * r * 0.45, d.y + Math.sin(n * 2.1) * r * 0.4, r * (0.42 + 0.1 * (n % 2)), 0, 7); g.fill(); }
        g.globalAlpha = 1; g.fillStyle = '#fff'; emoji(fl.emoji, d.x, d.y, r * 0.8);
        tag(bk === 2 ? 'STUCK' : 'CARRIED', d.x, d.y - r - 11 * HS, '#ffb36b');
      } else if (bk === 4) {
        g.fillStyle = 'rgba(20,24,40,.42)'; g.beginPath(); g.arc(d.x, d.y, r, 0, 7); g.fill();
        g.fillStyle = '#fff'; emoji('🔒', d.x, d.y, r * 0.8);
      }
    }

    function drawDisc(d, v, t) {
      const col = TEAM[d.side], r = G.dr;
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
      drawStatus(d, v, t);
    }

    function drawBall(b, dt) {
      ballRot += Math.hypot(b.vx, b.vy) * dt / G.br * 0.8;
      const r = G.br;
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
      const reach = (60 + power * 280) * G.u, x0 = cx + ux * (G.dr + 5), y0 = cy + uy * (G.dr + 5), ax = cx + ux * reach, ay = cy + uy * reach;
      g.lineCap = 'round'; g.strokeStyle = col; g.lineWidth = solid ? 4 : 5;
      if (!solid) g.setLineDash([14, 11]);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(ax, ay); g.stroke();
      g.setLineDash([]);
      g.fillStyle = col; g.beginPath();
      g.moveTo(ax + ux * 14 * G.u, ay + uy * 14 * G.u); g.lineTo(ax - uy * 11 * G.u, ay + ux * 11 * G.u); g.lineTo(ax + uy * 11 * G.u, ay - ux * 11 * G.u); g.closePath(); g.fill();
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
      const lb = 34 * HS;
      g.font = `${12 * HS}px "Press Start 2P", monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(4,6,30,.8)'; g.fillRect(dr.cx + ux * (shown + lb) - lb, dr.cy + uy * (shown + lb) - 11 * HS, 2 * lb, 22 * HS);
      g.fillStyle = col; g.fillText(`${Math.round(power * 100)}%`, dr.cx + ux * (shown + lb), dr.cy + uy * (shown + lb) + HS);
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
      const mx = G.W / 2, cx = 0, y = 0;                              // the scoreboard and the banner are drawn in their own space, HS times bigger on a big pitch
      const pix = (px) => `${px}px "Press Start 2P", monospace`;
      // scoreboard
      g.save(); g.translate(mx, -TM + 10 * HS); g.scale(HS, HS);
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
      else { const s = Math.ceil(v.clock); g.fillStyle = s <= 15 ? '#ff5c7a' : '#fff'; g.font = pix(18); g.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, cx, y + 26); g.font = pix(7); g.fillStyle = '#9fb0ff'; g.fillText('FIRST TO ' + G.goalLimit, cx, y + 46); }

      // the banner under the pitch
      g.restore(); g.save(); g.translate(mx, G.H + 14 * HS); g.scale(HS, HS);
      const by = 0, bw = 800, planning = canPlan(v), ready = iAmReady(v);
      g.fillStyle = 'rgba(4,6,30,.85)'; g.strokeStyle = planning ? '#ffd43b' : ready ? '#7cf29a' : 'rgba(255,255,255,.4)'; g.lineWidth = planning || ready ? 3 : 2;
      g.beginPath(); g.roundRect ? g.roundRect(cx - bw / 2, by, bw, 46, 12) : g.rect(cx - bw / 2, by, bw, 46); g.fill(); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (v.ph === 'plan') {
        const mineN = v.discs.filter((d) => mineDisc(v, d) && !v.fx.block[d.i]).length, n = Object.keys(plans).length;
        g.fillStyle = ready ? '#7cf29a' : '#ffd43b'; g.font = pix(10);
        g.fillText(mineN === 0 ? `ROUND ${v.round}: ${v.discs.some((d) => mineDisc(v, d)) ? 'NOTHING OF YOURS CAN MOVE' : 'WATCHING'}` : ready ? `ROUND ${v.round}: LOCKED IN` : `ROUND ${v.round}: PLAN YOUR MOVES  ${n}/${mineN}`, cx, by + 14);
        g.fillStyle = '#9fb0ff'; g.font = '14px "Share Tech Mono", monospace';
        const st = (s) => `${mascotOf(v.teams[s].mascot)} ${v.teams[s].name}: ${v.locked[s] ? 'LOCKED IN' : 'planning...'}`;
        g.fillText(`${st(0)}     ${st(1)}`, cx, by + 31);
        const f = clamp(v.t / C.PLAN_TIME, 0, 1);
        g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(cx - bw / 2 + 12, by + 41, bw - 24, 3);
        g.fillStyle = f < 0.2 ? '#ff5c7a' : '#ffd43b'; g.fillRect(cx - bw / 2 + 12, by + 41, (bw - 24) * f, 3);
      } else if (v.ph === 'storm') {
        g.fillStyle = v.fx.map === 'desert' ? '#ffd98a' : '#bfe9ff'; g.font = pix(10); g.fillText(`${v.fx.map === 'desert' ? 'SANDSTORM' : 'SNOWSTORM'}: FIRST ONE OUT GETS THE TURN  ${Math.ceil(v.t)}`, cx, by + 23);
      } else if (v.ph === 'roll') {
        g.fillStyle = '#9fb0ff'; g.font = pix(10); g.fillText('EVERYTHING MOVES AT ONCE...', cx, by + 23);
      } else if (v.ph === 'goal') {
        g.fillStyle = TEAM[v.lastGoal] ? TEAM[v.lastGoal].light : '#fff'; g.font = pix(10); g.fillText(`${v.teams[v.lastGoal] ? v.teams[v.lastGoal].name : ''} SCORES`, cx, by + 23);
      } else if (v.ph === 'countdown') {
        g.fillStyle = '#fff'; g.font = pix(10); g.fillText('GET READY', cx, by + 23);
      }

      g.restore();
      // big centre messages
      g.lineJoin = 'round';
      const big = (txt, size, fill, stroke, yy) => { size *= Math.sqrt(HS); g.font = pix(size); g.lineWidth = size / 4; g.strokeStyle = stroke; g.strokeText(txt, mx, yy); g.fillStyle = fill; g.fillText(txt, mx, yy); };
      if (v.ph === 'countdown' && v.t > 0) {
        const pulse = 1 + 0.25 * (v.t % 1);
        big(String(Math.ceil(v.t)), 90 * pulse, '#ffd43b', '#1b0f4d', G.H / 2 - 60);
      } else if (v.ph === 'goal') {
        const col = TEAM[v.lastGoal] || TEAM[0], bounce = 1 + 0.08 * Math.sin(t * 12);
        big('GOAL!', 80 * bounce, '#fff', col.dark, G.H / 2 - 40);
      } else if (kickT > 0 && v.ph === 'plan') {
        big('PLAN!', 40, '#7cf29a', '#1b0f4d', G.H / 2 - 120);
      }
      g.lineJoin = 'miter';
    }

    // the LOCK IN button under the pitch follows the round
    function syncBar(v) {
      const show = stage === 'play' && !!v && v.ph === 'plan' && v.discs.some((d) => mineDisc(v, d) && !v.fx.block[d.i]);
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
      const mineSide = me < 0 ? -1 : (me < G.n ? 0 : 1);
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
      if (stage !== 'play') { bgMap = mapId; syncMini(null); clearPops(); resize(); if (bg) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); } syncBar(null); return; }
      const v = currentView();
      lastView = v;
      if (!v) {
        bgMap = mapId; resize();
        if (bg) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); g.setTransform(k, 0, 0, k, MX * k, TM * k); g.font = '18px "Press Start 2P", monospace'; g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText('CONNECTING TO THE MATCH...', G.W / 2, G.H / 2); }
        return;
      }
      draw(v, dt);
      syncMini(v);
      syncPops(v, performance.now());
      syncBar(v);
      updateOverlay(latest && !isHost ? latest : v);
    }
    renderMenu();
    raf = requestAnimationFrame(frame);

    // ------------------------------------------------------------------ the lobby's handle on us
    function toPlay(d) {                                           // a guest: the match is on
      if (d.names) { T.names = d.names.slice(); T.mascots = d.mascots.slice(); }
      if (d.forms) T.forms = d.forms.slice();
      if (d.mode) modeId = d.mode;
      if (d.size) { sizeId = d.size; setGeo(d.size); }
      mapId = d.map || mapId;
      stage = 'play'; menu.classList.add('hidden'); setModeLabel();
    }
    return {
      onMessage(from, d) {
        if (!d || typeof d !== 'object') return;
        if (isHost) {
          if (d.k === 'plan' && stage === 'play') Sim.setPlan(sim, from, d.i, d.ax, d.ay);
          else if (d.k === 'ready' && stage === 'play') { Sim.setReady(sim, from, !!d.v); forceSnap = true; }
          else if (d.k === 'mini' && stage === 'play') { Sim.miniDone(sim, from, +d.ms); forceSnap = true; }
          else if (d.k === 'team') applyTeam(from, d);
          return;
        }
        if (from !== 0) return;
        if (d.k === 's') {
          if (stage !== 'play') toPlay(d);                          // missed the 'begin' message: the match itself says it began
          onSnapshot(d);
        } else if (d.k === 'setup') {
          if (stage === 'play') return;
          stage = d.st === 'sizes' ? 'sizes' : d.st === 'maps' ? 'maps' : 'teams'; modeId = d.mode || modeId; mapId = d.map || 'classic';
          sizeId = d.size || ''; if (sizeId) setGeo(sizeId);
          T.names = d.names.slice(); T.mascots = d.mascots.slice(); T.forms = d.forms.slice(); T.ready = d.ready.slice();
          setModeLabel(); renderStage();
        } else if (d.k === 'begin') {
          plans = {}; lastRound = -1;
          toPlay(d);
        } else if (d.k === 'menu') {
          stage = 'menu'; modeId = null; sizeId = ''; mapId = 'classic'; drag = null; plans = {};
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
        if (mini) mini.stop();
        clearPops();
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
