/* Bobble League: the match simulation (top-down, simultaneous planning).
 *
 * Pure and DOM-free so it runs in the browser (on the HOST only; guests just draw the snapshots the host sends)
 * and under Node for tests.  Pixels and seconds, one tick = 1/60 s (physics runs in 3 sub-steps per tick).
 *
 *   world: the pitch is x 0..W, y 0..H seen from above, y grows downward.  The goals are nets behind the end
 *          lines: x -NET..0 on the left and W..W+NET on the right, open for y GY0..GY1 (the ball only; the
 *          bobbles can't enter).  Team 0 (cyan) defends the LEFT goal and attacks right; team 1 (magenta) the other way.
 *   teams: every team is always 6 bobbles (discs 0..5 are team 0, 6..11 team 1) and there is one ball.  The bobbles of
 *          a team are shared out evenly between its players: 1 v 1 gives 6 each, 2 v 2 gives 3 each, 4 v 4 gives 2,2,1,1.
 *          With a single player in the room (solo test) that player commands all twelve.
 *   rounds: both teams plan at the same time.  During the PLAN phase every player sets a flick (direction and power) for
 *          each of their own bobbles, as many as they like, and locks in.  When everybody has locked in (or the planning
 *          time is up) all the flicks happen at once; the bobbles slide, collide and rebound until everything has
 *          stopped, and the next round of planning starts.  Plans are private: the host never sends them to anyone.
 *   rules: goal = the ball fully over the goal line between the posts; then the pitch is reset.  First to GOAL_LIMIT
 *          wins; when the match clock (which runs during planning and movement) runs out the leader wins, and a tie
 *          goes to sudden death (next goal wins).
 *   maps:  setMap() picks the arena.  'classic' is the plain pitch.  The four arenas change the physics (sand drags, ice
 *          and rain make the pitch slippery) and each has a random event of its own, rolled from a seeded generator so the
 *          same seed plays out the same way:
 *            stadium     an onlooker pelts one player: until they win a wipe-off minigame a teammate takes over their bobbles
 *                        (the team carries on); with nobody to carry them, those bobbles are stuck
 *            desert      hay bales roll across the pitch (announced during planning), and sandstorms put every player in
 *                        a dig-out race; the winner's team gets the turn, the other team's bobbles are locked in place
 *            tundra      the same race in a snowstorm; a bobble that isn't moved for more than 2 rounds gets frostbite
 *                        (weaker flicks and more drag, then frozen solid until another bobble knocks it)
 *            rainforest  slippery, and lightning (announced a moment before) stuns the nearest bobbles for 10 seconds
 *          Minigames run on the players' own screens; the host only hears how long each one took (miniDone).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BobbleSim = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    W: 1000, H: 620, NET: 70,
    GY0: 200, GY1: 420,           // the goal mouth (between the posts)
    DR: 28,                       // bobble radius
    BR: 16,                       // ball radius
    POST: 7,
    M_DISC: 1, M_BALL: 0.45,
    MAXV: 1500,                   // flick speed at full power, px/s
    CAP_DISC: 2000, CAP_BALL: 2400,
    K_DISC: 1.5, D_DISC: 70,      // sliding friction: exponential (per s) and constant (px/s^2)
    K_BALL: 1.0, D_BALL: 35,
    E_DISC: 0.9, E_BALL: 0.88, E_WALL: 0.85,
    REST: 8,                      // below this speed (px/s) a body counts as stopped
    REST_T: 0.35,                 // everything stopped for this long ends the round
    PLAN_TIME: 30,                // seconds to plan a round
    MATCH: 300,                   // match clock, seconds (runs during planning and movement)
    GOAL_LIMIT: 3,
    COUNT: 3, GOAL_PAUSE: 2.6,
    STEP: 1 / 60, SUB: 3,
    TEAM: 6,                      // bobbles per team, always
    MASCOTS: 12,                  // how many mascots the client offers (the sim only stores the index)
    NAME_MAX: 12,
    // ---- arena events
    WARMUP: 1,                    // no random events during the first round
    COOLDOWN: 1,                  // rounds without a minigame after one
    HECKLE_P: 0.4, HECKLE_T: 12,  // stadium: chance per round, seconds before a stuck player is let go anyway
    STORM_P: 0.3, STORM_T: 10,    // desert / tundra: chance per round, seconds for the race
    MINI_MIN_MS: 1200,            // a minigame can't be won faster than this (a client claiming less is rounded up)
    MINI_GRACE: 0.7,              // after the first finisher, others still count for this long (the quickest time wins)
    BALES_P: 0.5, BALE_R: 34, BALE_M: 2.6, BALE_V: [380, 540], BALE_MIN_V: 260,
    BOLT_EVERY: 20,               // rainforest: average seconds of play between lightning strikes
    BOLT_WARN: 1, STUN: 10, STUN_R: 110, STUN_MAX: 3,
    FROST_AFTER: 2,               // tundra: frostbite starts after this many rounds without moving
    FROST_POW: [1, 0.65, 0.35, 0], FROST_DRAG: [1, 1.5, 2.2, 3.2],
    MOVED_V: 120,                 // a bobble that got faster than this (flicked or knocked) counts as having moved
  };
  const DEFAULT_NAMES = ['CYAN', 'MAGENTA'];

  // physics that differ from the base values in C, and whether the arena has its random events
  const MAPS = {
    classic: { events: false, phys: {} },
    stadium: { events: true, phys: {} },
    desert: { events: true, phys: { K_DISC: 2.1, D_DISC: 95, K_BALL: 1.5, D_BALL: 55 } },                      // sand drags
    tundra: { events: true, phys: { K_DISC: 0.8, D_DISC: 30, K_BALL: 0.55, D_BALL: 14, E_DISC: 0.94, E_BALL: 0.92, E_WALL: 0.93 } },   // ice
    rainforest: { events: true, phys: { K_DISC: 1.0, D_DISC: 42, K_BALL: 0.7, D_BALL: 22 } },                  // wet
  };
  const MAP_IDS = Object.keys(MAPS);
  const HECKLES = ['tomato', 'soda', 'banana', 'boo'];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const POSTS = [[0, C.GY0], [0, C.GY1], [C.W, C.GY0], [C.W, C.GY1]];

  // kickoff spots for team 0 (the left side); team 1 is the mirror image
  const FORMATION = [[70, C.H / 2], [200, C.H / 2 - 125], [200, C.H / 2 + 125], [335, C.H / 2 - 205], [320, C.H / 2], [335, C.H / 2 + 205]];

  function body(r, m) { return { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r, m }; }

  /** opts: { players: [{id, side}], seconds, goalLimit, map, seed, rate } */
  function create(opts) {
    opts = opts || {};
    const N = C.TEAM * 2;
    const S = {
      ball: body(C.BR, C.M_BALL), discs: [], ev: [], tick: 0,
      phase: 'countdown', t: C.COUNT, clock: opts.seconds || C.MATCH, seconds: opts.seconds || C.MATCH,
      goalLimit: opts.goalLimit || C.GOAL_LIMIT, ot: false, score: [0, 0], lastGoal: -1, winner: -1,
      round: 0, rest: 0, shots: 0,
      members: [[], []], owner: new Array(N).fill(-1), plans: new Array(N).fill(null), ready: {},
      teams: [{ name: DEFAULT_NAMES[0], mascot: 0 }, { name: DEFAULT_NAMES[1], mascot: 1 }],
      // arena state (setMap fills it in)
      map: 'classic', phys: null, events: false, rate: 1, rng: null,
      stun: new Array(N).fill(0), hold: new Array(N).fill(0), pelt: new Array(N).fill(0), frost: new Array(N).fill(0), idle: new Array(N).fill(0), moved: new Array(N).fill(0),
      mini: null, bales: [], omen: null, bolt: null, frozen: -1, cool: 0,
    };
    for (let i = 0; i < N; i++) { const d = body(C.DR, C.M_DISC); d.i = i; d.side = i < C.TEAM ? 0 : 1; S.discs.push(d); }
    for (const p of opts.players || []) S.members[p.side ? 1 : 0].push(p.id);
    assign(S);
    setMap(S, opts.map, opts.seed, opts);
    placeKickoff(S);
    return S;
  }

  /** Choose the arena (call before restart()).  opts.rate scales how often its random events happen (0 = never; tests use big
   *  numbers to force them). */
  function setMap(S, id, seed, opts) {
    S.map = MAPS[id] ? id : 'classic';
    S.phys = Object.assign({ K_DISC: C.K_DISC, D_DISC: C.D_DISC, K_BALL: C.K_BALL, D_BALL: C.D_BALL, E_DISC: C.E_DISC, E_BALL: C.E_BALL, E_WALL: C.E_WALL }, MAPS[S.map].phys);
    S.rate = opts && typeof opts.rate === 'number' ? opts.rate : 1;
    S.events = MAPS[S.map].events && S.rate > 0;
    S.rng = mulberry(seed === undefined ? 1 : seed);
    resetFx(S);
  }

  /** Forget every event in progress. */
  function resetFx(S) {
    S.stun.fill(0); S.hold.fill(0); S.pelt.fill(0); S.frost.fill(0); S.idle.fill(0); S.moved.fill(0);
    S.mini = null; S.bales = []; S.omen = null; S.bolt = null; S.frozen = -1; S.cool = 0;
  }

  function placeKickoff(S) {
    S.discs.forEach((d) => {
      const [fx, fy] = FORMATION[d.i % C.TEAM];
      d.x = d.side ? C.W - fx : fx; d.y = fy; d.vx = d.vy = 0; d.px = d.x; d.py = d.y;
    });
    const b = S.ball; b.x = C.W / 2; b.y = C.H / 2; b.vx = b.vy = 0; b.px = b.x; b.py = b.y;
  }

  /** Start the match over (same players, teams and team names). */
  function restart(S) {
    S.score = [0, 0]; S.clock = S.seconds; S.ot = false; S.winner = -1; S.lastGoal = -1;
    S.phase = 'countdown'; S.t = C.COUNT; S.rest = 0; S.shots = 0; S.round = 0; S.ev.length = 0;
    S.plans.fill(null); S.ready = {};
    resetFx(S);
    placeKickoff(S);
  }

  /** A team's name and mascot (an index 0..MASCOTS-1).  The name is tidied: capitals, no odd characters, at most NAME_MAX. */
  function setTeam(S, side, name, mascot) {
    const t = S.teams[side ? 1 : 0];
    if (name !== undefined) t.name = String(name).replace(/[^A-Za-z0-9 _.!'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, C.NAME_MAX).toUpperCase() || DEFAULT_NAMES[side ? 1 : 0];
    if (mascot !== undefined && Number.isInteger(mascot) && mascot >= 0 && mascot < C.MASCOTS) t.mascot = mascot;
    return t;
  }

  // ------------------------------------------------------------------ who moves which bobble
  /** Share each team's six bobbles out evenly among its players (k-th bobble -> player k mod n).  A team with nobody
   *  on it (the solo test) is commanded by everyone, in the same way. */
  function assign(S) {
    const all = S.members[0].concat(S.members[1]);
    for (const d of S.discs) {
      const k = d.i % C.TEAM, list = S.members[d.side].length ? S.members[d.side] : all;
      S.owner[d.i] = list.length ? list[k % list.length] : -1;
    }
    const m = S.mini;
    if (m && !m.race) {                                                   // a pelted player: their teammates carry their bobbles meanwhile
      let n = 0;
      for (const d of S.discs) {
        if (!S.pelt[d.i]) continue;
        const list = (S.members[d.side].length ? S.members[d.side] : all).filter((p) => p !== m.pid);
        S.owner[d.i] = list.length ? list[n++ % list.length] : m.pid;
      }
    }
  }

  function ownersOf(S, side) {
    const out = new Set();
    for (const d of S.discs) if (d.side === side && S.owner[d.i] >= 0) out.add(S.owner[d.i]);
    return out;
  }

  /** Why bobble i can't be flicked right now: 0 it can, 1 stunned by lightning, 2 stuck (heckled), 3 frozen solid,
   *  4 its team lost the storm race and is locked in place this round. */
  function blockReason(S, i) {
    if (S.stun[i] > 0) return 1;
    if (S.hold[i]) return 2;
    if (S.frost[i] >= 3) return 3;
    if (S.frozen === S.discs[i].side) return 4;
    return 0;
  }

  /** Does the player have any bobble they could flick? */
  function canAct(S, pid) {
    for (const d of S.discs) if (S.owner[d.i] === pid && blockReason(S, d.i) === 0) return true;
    return false;
  }

  /** Has every player of `side` locked in?  Players with nothing they can flick don't have to. */
  function locked(S, side) {
    for (const id of ownersOf(S, side)) if (!S.ready[id] && canAct(S, id)) return false;
    return true;
  }

  function sideOf(S, pid) { return S.members[0].includes(pid) ? 0 : S.members[1].includes(pid) ? 1 : -1; }

  function removePlayer(S, id) {
    for (const m of S.members) { const i = m.indexOf(id); if (i >= 0) m.splice(i, 1); }
    delete S.ready[id];
    assign(S);
    const m = S.mini;
    if (m) {
      m.who = m.who.filter((q) => q !== id);
      if (m.reports) delete m.reports[id];
      if (!m.race && m.who.length === 0) endHeckle(S, false);
      else if (m.race && m.who.length === 0 && S.phase === 'storm') resolveStorm(S);
    }
    if (S.phase === 'plan') checkLocks(S);
  }

  // ------------------------------------------------------------------ planning
  const chance = (S, p) => S.rng() < Math.min(1, p * S.rate);

  function startPlan(S) {
    S.round++; S.rest = 0; S.plans.fill(null); S.ready = {};
    S.frozen = -1; S.omen = null;
    if (S.cool > 0) S.cool--;
    if (!beginStorm(S)) openPlan(S);
  }

  function openPlan(S) {
    S.phase = 'plan'; S.t = C.PLAN_TIME;
    S.ev.push(['plan', S.round]);
    rollEvents(S);
  }

  /** Desert / tundra: sometimes the round opens with a storm and a race instead of planning. */
  function beginStorm(S) {
    if (!S.events || S.round <= C.WARMUP || S.cool > 0 || (S.map !== 'desert' && S.map !== 'tundra') || !chance(S, C.STORM_P)) return false;
    const who = [];
    for (const o of S.owner) if (o >= 0 && !who.includes(o)) who.push(o);
    if (!who.length) return false;
    const kind = S.map === 'desert' ? 'dig' : 'shake';
    S.phase = 'storm'; S.t = C.STORM_T; S.cool = C.COOLDOWN + 1;
    S.mini = { kind, race: true, who, reports: {}, order: [], grace: -1 };
    S.ev.push(['storm', kind]);
    return true;
  }

  function resolveStorm(S) {
    const m = S.mini;
    let win = -1, best = Infinity;
    for (const k of m.order) if (m.reports[k] !== undefined && m.reports[k] < best) { best = m.reports[k]; win = k; }      // a tie goes to whoever reported first
    const side = win >= 0 ? sideOf(S, win) : -1;
    S.frozen = side >= 0 && S.members[1 - side].length ? 1 - side : -1;     // the losers can't flick this round
    S.ev.push(['storm-end', win, side, m.kind]);
    S.mini = null;
    openPlan(S);
  }

  /** The random events that start with a round of planning. */
  function rollEvents(S) {
    if (!S.events || S.round <= C.WARMUP) return;
    if (S.map === 'stadium' && !S.mini && S.cool === 0 && chance(S, C.HECKLE_P)) {
      const side = S.rng() < 0.5 ? 0 : 1, pick = S.discs[side * C.TEAM + Math.floor(S.rng() * C.TEAM)], pid = S.owner[pick.i];
      const what = HECKLES[Math.floor(S.rng() * HECKLES.length)], from = +S.rng().toFixed(2);
      if (pid >= 0) {
        S.mini = { kind: 'scrub', race: false, pid, who: [pid], side, t: C.HECKLE_T, what, from };
        for (const d of S.discs) if (d.side === side && S.owner[d.i] === pid) { S.pelt[d.i] = 1; S.plans[d.i] = null; }
        assign(S);                                                        // a teammate takes their bobbles over...
        for (const d of S.discs) if (S.pelt[d.i]) { if (S.owner[d.i] === pid) S.hold[d.i] = 1; else delete S.ready[S.owner[d.i]]; }     // ...or, with nobody to carry them, they are stuck
        S.cool = C.COOLDOWN + 1;
        S.ev.push(['heckle', pid, side, what, from]);
      }
    } else if (S.map === 'desert' && chance(S, C.BALES_P)) {
      const n = 1 + (S.rng() < 0.45 ? 1 : 0) + (S.rng() < 0.15 ? 1 : 0);
      S.omen = [];
      for (let k = 0; k < n; k++) {
        S.omen.push({ x: Math.round(140 + S.rng() * 720), from: S.rng() < 0.5 ? 0 : 1, vx: Math.round((S.rng() - 0.5) * 360),
                      v: Math.round(C.BALE_V[0] + S.rng() * (C.BALE_V[1] - C.BALE_V[0])), d: +(S.rng() * 1.2).toFixed(2) });
      }
      S.ev.push(['omen', n]);
    }
  }

  /** A player finished their minigame in `ms` milliseconds (timed on their own screen).  A stuck player is released; in a race
   *  the quickest time among those who finish within a moment of the first wins.  Returns true if it counted. */
  function miniDone(S, pid, ms) {
    const m = S.mini;
    if (!m || !m.who.includes(pid) || typeof ms !== 'number' || !isFinite(ms)) return false;
    ms = Math.max(C.MINI_MIN_MS, ms);
    if (!m.race) { endHeckle(S, true); return true; }
    if (S.phase !== 'storm' || m.reports[pid] !== undefined) return false;
    m.reports[pid] = ms; m.order.push(pid);
    m.grace = m.who.every((q) => m.reports[q] !== undefined) ? 0 : (m.grace < 0 ? C.MINI_GRACE : m.grace);
    return true;
  }

  function endHeckle(S, ok) {
    const m = S.mini;
    if (!m || m.race) return;
    S.hold.fill(0); S.pelt.fill(0); S.mini = null;
    assign(S);                                                            // their bobbles go back to them
    S.ev.push(['mini-end', m.pid, ok ? 1 : 0, m.kind]);
    checkLocks(S);
  }

  /** Set (or, with a tiny flick, clear) the planned flick for one of your bobbles.  (ax, ay) is a fraction of full power:
   *  its direction is where the bobble will go, its length (clamped to 1) is the power.  Only during PLAN, only for a bobble
   *  you command, and only while you haven't locked in.  Returns true if it was accepted. */
  function setPlan(S, pid, i, ax, ay) {
    if (S.phase !== 'plan' || S.ready[pid]) return false;
    if (!Number.isInteger(i) || i < 0 || i >= S.discs.length || S.owner[i] !== pid) return false;
    if (blockReason(S, i)) return false;                                  // stunned, stuck, frozen solid or locked in place
    if (typeof ax !== 'number' || typeof ay !== 'number' || !isFinite(ax) || !isFinite(ay)) return false;
    const mag = Math.hypot(ax, ay);
    if (mag < 0.05) { S.plans[i] = null; return true; }
    const pw = Math.min(1, mag);
    S.plans[i] = { ax: ax / mag * pw, ay: ay / mag * pw };
    return true;
  }

  /** Lock in (or unlock) your plan.  When every player has locked in, the round plays out. */
  function setReady(S, pid, v) {
    if (S.phase !== 'plan' || !(ownersOf(S, 0).has(pid) || ownersOf(S, 1).has(pid))) return false;
    S.ready[pid] = !!v;
    if (!v) delete S.ready[pid];
    checkLocks(S);
    return true;
  }

  function checkLocks(S) { if (S.phase === 'plan' && locked(S, 0) && locked(S, 1)) execute(S); }

  /** All the planned flicks happen now, together. */
  function execute(S) {
    let n = 0;
    for (const d of S.discs) {
      const p = S.plans[d.i];
      if (p && blockReason(S, d.i) === 0) {
        const f = C.FROST_POW[S.frost[d.i]] * C.MAXV;                    // frostbite weakens the flick
        d.vx = p.ax * f; d.vy = p.ay * f; S.moved[d.i] = 1; n++;
      }
    }
    S.plans.fill(null); S.ready = {};
    if (!n) { S.ev.push(['pass']); startPlan(S); return; }             // nobody planned anything: plan again
    launchBales(S);
    S.phase = 'roll'; S.rest = 0; S.shots += n;
    S.ev.push(['exec', n]);
  }

  /** The announced hay bales roll in. */
  function launchBales(S) {
    if (!S.omen) return;
    for (const o of S.omen) {
      const b = body(C.BALE_R, C.BALE_M);
      b.bale = 1; b.wait = o.d; b.age = 0; b.entered = false;
      b.x = o.x; b.y = o.from ? C.H + C.BALE_R + 6 : -C.BALE_R - 6; b.vx = o.vx; b.vy = o.from ? -o.v : o.v;
      b.px = b.x; b.py = b.y;
      S.bales.push(b);
    }
    S.ev.push(['bales', S.omen.length]);
    S.omen = null;
  }

  // ------------------------------------------------------------------ physics
  function collide(a, b, S) {
    let dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
    const min = a.r + b.r;
    if (dist >= min) return;
    if (dist < 1e-6) { dx = 1; dy = 0; dist = 1e-6; }
    const nx = dx / dist, ny = dy / dist, ia = 1 / a.m, ib = 1 / b.m, over = min - dist;
    a.x -= nx * over * ia / (ia + ib); a.y -= ny * over * ia / (ia + ib);
    b.x += nx * over * ib / (ia + ib); b.y += ny * over * ib / (ia + ib);
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn > 0) return;
    const e = a === S.ball || b === S.ball ? S.phys.E_BALL : S.phys.E_DISC;
    const j = -(1 + e) * vn / (ia + ib);
    a.vx -= j * ia * nx; a.vy -= j * ia * ny; b.vx += j * ib * nx; b.vy += j * ib * ny;
    S.hit = Math.max(S.hit, Math.min(1, -vn / 1100));
    if (a === S.ball || b === S.ball) S.kick = Math.max(S.kick, Math.min(1, -vn / 1100));
  }

  function hitPost(b, px, py, S) {
    const dx = b.x - px, dy = b.y - py, dist = Math.hypot(dx, dy), min = b.r + C.POST;
    if (dist >= min) return;
    const nx = dist < 1e-6 ? 1 : dx / dist, ny = dist < 1e-6 ? 0 : dy / dist;
    b.x = px + nx * min; b.y = py + ny * min;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { b.vx -= 1.8 * vn * nx; b.vy -= 1.8 * vn * ny; S.post = Math.max(S.post, Math.min(1, -vn / 900)); }
  }

  function walls(b, isBall, S) {
    const r = b.r, e = S.phys.E_WALL;
    if (b.y < r) { b.y = r; if (b.vy < 0) { b.vy = -b.vy * e; S.wall = Math.max(S.wall, Math.min(1, -b.vy / 900)); } }
    if (b.y > C.H - r) { b.y = C.H - r; if (b.vy > 0) { b.vy = -b.vy * e; S.wall = Math.max(S.wall, Math.min(1, b.vy / 900)); } }
    const inMouth = isBall && b.y > C.GY0 && b.y < C.GY1;
    if (!isBall || !inMouth) {                                              // the end walls (the ball may pass through the mouth)
      if (b.x < r && !(isBall && b.x < 0)) { b.x = r; if (b.vx < 0) { b.vx = -b.vx * e; S.wall = Math.max(S.wall, Math.min(1, -b.vx / 900)); } }
      if (b.x > C.W - r && !(isBall && b.x > C.W)) { b.x = C.W - r; if (b.vx > 0) { b.vx = -b.vx * e; S.wall = Math.max(S.wall, Math.min(1, b.vx / 900)); } }
    }
    if (isBall) {                                                           // inside a net: walls all round
      if (b.x < 0 || b.x > C.W) {
        b.y = clamp(b.y, C.GY0 + r, C.GY1 - r);
        if (b.y <= C.GY0 + r || b.y >= C.GY1 - r) b.vy *= -0.4;
      }
      if (b.x < -C.NET + r) { b.x = -C.NET + r; if (b.vx < 0) b.vx *= -0.3; }
      if (b.x > C.W + C.NET - r) { b.x = C.W + C.NET - r; if (b.vx > 0) b.vx *= -0.3; }
    }
  }

  function slide(b, k, d, h, cap) {
    let s = Math.hypot(b.vx, b.vy);
    if (s === 0) return false;
    if (s > cap) { b.vx *= cap / s; b.vy *= cap / s; s = cap; }
    const s2 = s * Math.exp(-k * h) - d * h;
    if (s2 < C.REST * 0.75) { b.vx = b.vy = 0; return false; }
    b.vx *= s2 / s; b.vy *= s2 / s;
    return s2 > C.REST;
  }

  /** Hay bales roll straight through: they bounce off the side walls but not the top and bottom (they come in and leave there). */
  function baleWalls(b, S) {
    const e = S.phys.E_WALL;
    if (b.x < b.r) { b.x = b.r; if (b.vx < 0) b.vx = -b.vx * e; }
    if (b.x > C.W - b.r) { b.x = C.W - b.r; if (b.vx > 0) b.vx = -b.vx * e; }
  }

  /** One physics sub-step.  Returns true if anything is still moving. */
  function physics(S, h) {
    let moving = S.bales.length > 0;                                      // a bale on its way keeps the round going
    const p = S.phys;
    const all = S.discs.concat(S.ball);
    for (const b of S.bales) if (b.wait <= 0) all.push(b);
    for (const b of all) { b.x += b.vx * h; b.y += b.vy * h; }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) collide(all[i], all[j], S);
    for (const b of all) {
      if (b.bale) { baleWalls(b, S); continue; }
      const isBall = b === S.ball;
      for (const [px, py] of POSTS) hitPost(b, px, py, S);
      walls(b, isBall, S);
      if (!isBall && Math.hypot(b.vx, b.vy) > C.MOVED_V) S.moved[b.i] = 1;
      const mv = isBall ? slide(b, p.K_BALL, p.D_BALL, h, C.CAP_BALL) : slide(b, p.K_DISC * C.FROST_DRAG[S.frost[b.i]], p.D_DISC, h, C.CAP_DISC);
      if (mv) moving = true;
    }
    return moving;
  }

  // ------------------------------------------------------------------ arena events, once per tick
  function strike(S) {
    const b = S.bolt;
    S.bolt = null;
    const near = S.discs.map((d) => [Math.hypot(d.x - b.x, d.y - b.y), d.i]).sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    const hit = near.filter((q, k) => k === 0 || q[0] <= C.STUN_R).slice(0, C.STUN_MAX).map((q) => q[1]);     // the closest ones
    for (const i of hit) { S.stun[i] = C.STUN; S.discs[i].vx = S.discs[i].vy = 0; S.plans[i] = null; }
    S.ev.push(['bolt', r1(b.x), r1(b.y), hit]);
    checkLocks(S);
  }

  /** `playing`: the planning or rolling part of a round (the clocks of most events only run then). */
  function fxTick(S, dt, playing) {
    if (!S.events) return;
    if (S.mini && !S.mini.race) { S.mini.t -= dt; if (S.mini.t <= 0) endHeckle(S, false); }      // let them go eventually
    if (!playing) return;
    for (let i = 0; i < S.stun.length; i++) if (S.stun[i] > 0) S.stun[i] = Math.max(0, S.stun[i] - dt);
    if (S.map === 'rainforest') {
      if (S.bolt) { S.bolt.t -= dt; if (S.bolt.t <= 0) strike(S); }
      else if (S.round > C.WARMUP && S.rng() < Math.min(1, dt * S.rate / C.BOLT_EVERY)) {
        const d = S.discs[Math.floor(S.rng() * S.discs.length)];
        S.bolt = { x: r1(clamp(d.x + (S.rng() - 0.5) * 140, 30, C.W - 30)), y: r1(clamp(d.y + (S.rng() - 0.5) * 140, 30, C.H - 30)), t: C.BOLT_WARN };
        S.ev.push(['bolt-warn', S.bolt.x, S.bolt.y]);
      }
    }
    for (let k = S.bales.length - 1; k >= 0; k--) {
      const b = S.bales[k];
      if (b.wait > 0) { b.wait -= dt; if (b.wait <= 0) { b.px = b.x; b.py = b.y; } continue; }
      b.age += dt;
      if (b.y > -b.r * 0.5 && b.y < C.H + b.r * 0.5) b.entered = true;
      if (Math.abs(b.vy) < C.BALE_MIN_V) b.vy = (b.vy < 0 ? -1 : 1) * C.BALE_MIN_V;               // it keeps rolling until it leaves
      if ((b.entered && (b.y < -b.r * 1.5 || b.y > C.H + b.r * 1.5)) || b.age > 12) S.bales.splice(k, 1);
    }
  }

  /** The round is over: bobbles that didn't move cool down (tundra), the others warm up. */
  function frostTick(S) {
    if (S.map !== 'tundra' || !S.events) return;
    for (const d of S.discs) {
      const i = d.i;
      if (S.moved[i]) {
        S.idle[i] = 0;
        if (S.frost[i] > 0) { S.frost[i]--; S.ev.push(['frost', i, S.frost[i]]); }
      } else {
        S.idle[i]++;
        if (S.idle[i] > C.FROST_AFTER && S.frost[i] < 3) { S.frost[i]++; S.ev.push(['frost', i, S.frost[i]]); }
      }
    }
    S.moved.fill(0);
  }

  // ------------------------------------------------------------------ the step
  function step(S) {
    S.tick++;
    const all = S.discs.concat(S.ball, S.bales);
    for (const b of all) { b.px = b.x; b.py = b.y; }
    const dt = C.STEP;
    switch (S.phase) {
      case 'storm': {                                                     // everybody races a minigame; nothing moves, no clocks run
        const m = S.mini;
        if (!m) { openPlan(S); return; }
        S.t -= dt;
        if (m.grace >= 0) { m.grace -= dt; if (m.grace <= 0) resolveStorm(S); }
        else if (S.t <= 0) resolveStorm(S);
        return;
      }
      case 'countdown': {
        const before = Math.ceil(S.t);
        S.t -= dt;
        if (Math.ceil(S.t) < before && S.t > 0) S.ev.push(['c', Math.ceil(S.t)]);
        if (S.t <= 0) { S.ev.push(['go']); startPlan(S); }
        return;
      }
      case 'plan': case 'roll': case 'goal': {
        S.hit = S.kick = S.wall = S.post = 0;
        let moving = false;
        for (let i = 0; i < C.SUB; i++) if (physics(S, dt / C.SUB)) moving = true;
        if (S.hit > 0.1) S.ev.push([S.kick > 0.1 ? 'kick' : 'hit', +Math.max(S.hit, S.kick).toFixed(2)]);
        if (S.post > 0.15) S.ev.push(['post', +S.post.toFixed(2)]);
        else if (S.wall > 0.2) S.ev.push(['wall', +S.wall.toFixed(2)]);
        fxTick(S, dt, S.phase !== 'goal');
        if (S.phase === 'goal') { S.t -= dt; if (S.t <= 0) afterGoal(S); return; }
        if (!S.ot) S.clock = Math.max(0, S.clock - dt);
        if (S.phase === 'roll') {
          const g = goalAt(S);
          if (g >= 0) return scored(S, g);
          S.rest = moving ? 0 : S.rest + dt;
          if (S.rest >= C.REST_T) endRound(S);
        } else {                                                          // plan
          S.t -= dt;
          if (S.t <= 0) execute(S);
          else if (S.clock <= 0 && !S.ot) judge(S);
        }
        return;
      }
      default: return;                                                    // over
    }
  }

  /** 0 / 1 = the team that just scored, -1 = no goal. */
  function goalAt(S) {
    const b = S.ball;
    if (b.y <= C.GY0 || b.y >= C.GY1) return -1;
    if (b.x + b.r < 0) return 1;
    if (b.x - b.r > C.W) return 0;
    return -1;
  }

  function scored(S, side) {
    S.score[side]++; S.lastGoal = side;
    S.phase = 'goal'; S.t = C.GOAL_PAUSE; S.plans.fill(null); S.ready = {};
    S.bales = []; S.omen = null; S.bolt = null;                           // the pitch is reset: hazards, stuns and frostbite go with it
    S.stun.fill(0); S.frost.fill(0); S.idle.fill(0); S.moved.fill(0);
    S.ev.push(['goal', side]);
  }

  function afterGoal(S) {
    const side = S.lastGoal;
    if (S.ot || S.score[side] >= S.goalLimit) return finish(S, side);
    if (S.clock <= 0 && judge(S)) return;
    placeKickoff(S);
    S.ev.push(['kick-off']);
    startPlan(S);
  }

  /** The clock has run out: the leader wins, a tie goes to sudden death.  Returns true if the match ended. */
  function judge(S) {
    if (S.score[0] !== S.score[1]) { finish(S, S.score[0] > S.score[1] ? 0 : 1); return true; }
    if (!S.ot) { S.ot = true; S.ev.push(['ot']); }
    return false;
  }

  function finish(S, winner) {
    S.phase = 'over'; S.winner = winner;
    S.ev.push(['end', winner]);
  }

  function endRound(S) {
    frostTick(S);
    if (S.clock <= 0 && !S.ot && judge(S)) return;
    startPlan(S);
  }

  /** Events since the last call: ['c', n] countdown, ['go'], ['plan', round] (a new round of planning), ['exec', n] (n flicks
   *  happen now), ['kick', 0..1] (the ball was struck), ['hit', 0..1] (bobbles met), ['wall', 0..1], ['post', 0..1],
   *  ['goal', side], ['kick-off'], ['pass'] (nobody planned a thing), ['ot'], ['end', winner].
   *  Arena events: ['heckle', pid, side, what, from] (stadium: pid is pelted), ['mini-end', pid, ok, kind] (they are free again),
   *  ['storm', kind] / ['storm-end', winnerPid, winnerSide, kind] (the race), ['omen', n] (bales are coming, see fx.omen) and
   *  ['bales', n] (they roll in), ['bolt-warn', x, y] / ['bolt', x, y, [bobbles stunned]], ['frost', bobble, level]. */
  function takeEvents(S) { const e = S.ev.slice(); S.ev.length = 0; return e; }

  // ------------------------------------------------------------------ snapshots (host -> guests)
  const r1 = (v) => Math.round(v * 10) / 10;

  /** Everything the arena adds to a view.  `alpha` blends the bales between the last two steps (1 = now). */
  function fxOf(S, alpha) {
    const L = (a, b) => a + (b - a) * alpha, m = S.mini;
    return {
      map: S.map, frost: S.frost.slice(), idle: S.map === 'tundra' ? S.idle.map((v) => Math.min(v, 9)) : S.idle.map(() => 0),
      stun: S.stun.map((v) => +v.toFixed(1)), pelt: S.pelt.slice(), block: S.discs.map((d) => blockReason(S, d.i)), frozen: S.frozen,
      mini: m ? { k: m.kind, race: m.race, who: m.who.slice(), t: +(m.race ? S.t : m.t).toFixed(1), what: m.what || '', from: m.from || 0, side: m.side === undefined ? -1 : m.side } : null,
      bales: S.bales.filter((b) => b.wait <= 0).map((b) => ({ x: L(b.px, b.x), y: L(b.py, b.y), r: b.r })),
      omen: S.omen ? S.omen.map((o) => ({ x: o.x, from: o.from, vx: o.vx })) : null,
      bolt: S.bolt ? { x: S.bolt.x, y: S.bolt.y, t: +S.bolt.t.toFixed(2) } : null,
    };
  }

  /** Compact JSON-able snapshot.  `events` are the host's events since the last snapshot.  Plans are NOT in it.  The arena
   *  fields are left out when they are at rest, so a classic match's snapshot is as small as ever. */
  function snapshot(S, events) {
    const d = [];
    for (const q of S.discs) d.push(r1(q.x), r1(q.y));
    const o = {
      k: 's', tk: S.tick, ph: S.phase, t: +S.t.toFixed(2), c: +S.clock.toFixed(1), ot: S.ot ? 1 : 0,
      sc: S.score.slice(), w: S.winner, lg: S.lastGoal, rd: S.round, sh: S.shots,
      lk: [locked(S, 0) && S.phase === 'plan' ? 1 : 0, locked(S, 1) && S.phase === 'plan' ? 1 : 0],
      rg: Object.keys(S.ready).map(Number), ow: S.owner.slice(),
      tm: [[S.teams[0].name, S.teams[0].mascot], [S.teams[1].name, S.teams[1].mascot]],
      b: [r1(S.ball.x), r1(S.ball.y), Math.round(S.ball.vx), Math.round(S.ball.vy)], d,
      ev: events || [],
    };
    const f = fxOf(S, 1);
    if (f.map !== 'classic') o.mp = f.map;
    if (f.frost.some(Boolean)) o.fr = f.frost;
    if (f.idle.some(Boolean)) o.il = f.idle;
    if (f.stun.some((v) => v > 0)) o.sn = f.stun.map((v) => Math.ceil(v));
    if (f.block.some(Boolean)) o.bk = f.block;
    if (f.pelt.some(Boolean)) o.pt = f.pelt.map((v, i) => v ? i : -1).filter((i) => i >= 0);
    if (f.frozen >= 0) o.fz = f.frozen;
    if (f.mini) o.mn = [f.mini.k, f.mini.race ? 1 : 0, f.mini.who, f.mini.t, f.mini.what, f.mini.from, f.mini.side];
    if (f.bales.length) o.bl = f.bales.map((b) => [r1(b.x), r1(b.y)]);
    if (f.omen) o.om = f.omen.map((q) => [q.x, q.from, q.vx]);
    if (f.bolt) o.bt = [r1(f.bolt.x), r1(f.bolt.y), f.bolt.t];
    return o;
  }

  /** The renderer's view of a snapshot message (also what view() produces from the live sim). */
  function parseSnapshot(m) {
    const discs = [];
    for (let i = 0; i < m.d.length / 2; i++) discs.push({ i, side: i < C.TEAM ? 0 : 1, x: m.d[2 * i], y: m.d[2 * i + 1] });
    const z = () => new Array(C.TEAM * 2).fill(0), mn = m.mn;
    return {
      tk: m.tk, ph: m.ph, t: m.t, clock: m.c, ot: !!m.ot, score: m.sc, winner: m.w, lastGoal: m.lg, round: m.rd, shots: m.sh,
      locked: m.lk, ready: m.rg, owners: m.ow, teams: m.tm.map((q) => ({ name: q[0], mascot: q[1] })),
      ball: { x: m.b[0], y: m.b[1], vx: m.b[2], vy: m.b[3] }, discs, ev: m.ev || [],
      fx: {
        map: m.mp || 'classic', frost: m.fr || z(), idle: m.il || z(), stun: m.sn || z(), pelt: (m.pt || []).reduce((a, i) => { a[i] = 1; return a; }, z()), block: m.bk || z(), frozen: m.fz === undefined ? -1 : m.fz,
        mini: mn ? { k: mn[0], race: !!mn[1], who: mn[2], t: mn[3], what: mn[4], from: mn[5], side: mn[6] } : null,
        bales: (m.bl || []).map((q) => ({ x: q[0], y: q[1], r: C.BALE_R })),
        omen: m.om ? m.om.map((q) => ({ x: q[0], from: q[1], vx: q[2] })) : null,
        bolt: m.bt ? { x: m.bt[0], y: m.bt[1], t: m.bt[2] } : null,
      },
    };
  }

  /** The live sim as a view, drawn `alpha` (0..1) of the way from the previous step to the current one. */
  function view(S, alpha) {
    const L = (a, b) => a + (b - a) * alpha;
    return {
      tk: S.tick, ph: S.phase, t: S.t, clock: S.clock, ot: S.ot, score: S.score, winner: S.winner, lastGoal: S.lastGoal,
      round: S.round, shots: S.shots, locked: [locked(S, 0) && S.phase === 'plan', locked(S, 1) && S.phase === 'plan'],
      ready: Object.keys(S.ready).map(Number), owners: S.owner, teams: S.teams,
      ball: { x: L(S.ball.px, S.ball.x), y: L(S.ball.py, S.ball.y), vx: S.ball.vx, vy: S.ball.vy },
      discs: S.discs.map((d) => ({ i: d.i, side: d.side, x: L(d.px, d.x), y: L(d.py, d.y) })),
      ev: [], fx: fxOf(S, alpha),
    };
  }

  /** Blend two views (k = 0 gives a, 1 gives b).  Discrete things come from b. */
  function lerpView(a, b, k) {
    const L = (x, y) => x + (y - x) * k;
    const bales = b.fx.bales.length === a.fx.bales.length ? b.fx.bales.map((q, i) => ({ x: L(a.fx.bales[i].x, q.x), y: L(a.fx.bales[i].y, q.y), r: q.r })) : b.fx.bales;
    return {
      tk: k < 0.5 ? a.tk : b.tk, ph: b.ph, t: L(a.t, b.t), clock: L(a.clock, b.clock), ot: b.ot, score: b.score, winner: b.winner,
      lastGoal: b.lastGoal, round: b.round, shots: b.shots, locked: b.locked, ready: b.ready, owners: b.owners, teams: b.teams,
      ball: { x: L(a.ball.x, b.ball.x), y: L(a.ball.y, b.ball.y), vx: b.ball.vx, vy: b.ball.vy },
      discs: b.discs.map((q, i) => { const p = a.discs[i] || q; return { i: q.i, side: q.side, x: L(p.x, q.x), y: L(p.y, q.y) }; }),
      ev: [], fx: Object.assign({}, b.fx, { bales }),
    };
  }

  return { C, MAPS: MAP_IDS, create, setMap, restart, step, setPlan, setReady, setTeam, removePlayer, miniDone, takeEvents, snapshot, parseSnapshot, view, lerpView };
}));
