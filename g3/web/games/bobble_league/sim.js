/* Bobble League: the match simulation (top-down, simultaneous planning).
 *
 * Pure and DOM-free so it runs in the browser (on the HOST only; guests just draw the snapshots the host sends)
 * and under Node for tests.  Pixels and seconds, one tick = 1/60 s (physics runs in 3 sub-steps per tick).
 *
 *   world: the pitch is x 0..W, y 0..H seen from above, y grows downward.  The goals are nets behind the end
 *          lines: x -NET..0 on the left and W..W+NET on the right, open for y GY0..GY1 (the ball only; the
 *          bobbles can't enter).  Team 0 (cyan) defends the LEFT goal and attacks right; team 1 (magenta) the other way.
 *   sizes: the stadium decides the match.  LOCAL is 3 v 3 on a small pitch, LITTLE LEAGUE 4 v 4 on a much bigger one and
 *          PREMIER LEAGUE 5 v 5 on the biggest (SIZES below; setSize() picks one).  'standard' is the original 6 v 6 pitch, kept
 *          as the default for tests; the menu never offers it.  The pitch is S.g (W, H, goal mouth, flick power scale ...).
 *   teams: every team has S.n bobbles (discs 0..n-1 are team 0, n..2n-1 team 1) and there is one ball.  The bobbles of a
 *          team are shared out evenly between its players (3 v 3 with two players: 2 and 1).  Each team picks a formation
 *          (FORMS) that says where its bobbles stand at kick-off.  With a single player in the room (solo test) that player
 *          commands everything.
 *   rounds: both teams plan at the same time.  During the PLAN phase every player sets a flick (direction and power) for
 *          each of their own bobbles, as many as they like, and locks in.  When everybody has locked in (or the planning
 *          time is up) all the flicks happen at once; the bobbles slide, collide and rebound until everything has
 *          stopped, and the next round of planning starts.  Plans are private: the host never sends them to anyone.
 *   rules: goal = the ball fully over the goal line between the posts.  Then, in order: GOAL (the celebration), REPLAY (the
 *          clients play back the roll that scored; the sim just waits), FORM (each team's captain may pick a new formation,
 *          the pitch shows it live; both ready, or FORM_TIME, and the round starts) and the next round of planning.
 *          First to GOAL_LIMIT wins.  There is no match clock: the match is counted in TURNS (rounds in which something was
 *          flicked and has now stopped moving, or ended in a goal).  When the stadium's turn limit is reached the leader wins, and a tie goes to sudden death (next goal wins).
 *   events: the arena events stay off for the first FX_START turns; after that the first one is certain (S.fxSeen) and
 *          lightning runs on a timer (BOLT_FIRST, BOLT_EVERY).
 *   power-ups: a glowing ball sits at each end of the centre line (S.g.pu).  A bobble that touches one holds a boost (S.boost)
 *          until its next flick, which is PU_BOOST times as fast.  A taken power-up comes back PU_COOL rounds later.
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
    TURNS: 14,                    // turn limit of the 'standard' pitch (the sizes in SIZES have their own)
    GOAL_LIMIT: 3,
    COUNT: 3, GOAL_PAUSE: 2.6,
    STEP: 1 / 60, SUB: 3,
    TEAM: 6,                      // bobbles per team on the 'standard' pitch (the sizes in SIZES have their own)
    MASCOTS: 12,                  // how many mascots the client offers (the sim only stores the index)
    NAME_MAX: 12,
    // ---- arena events
    FX_START: 4,                  // turns played before any arena event can start (a quiet start)
    FORM_TIME: 20,                // seconds a captain has to pick a formation after a goal
    REPLAY_MAX: 6, REPLAY_SPEED: 0.75, REPLAY_TAIL: 0.6, REPLAY_AFTER: 0.15,     // longest replay (s of play), its speed, a pause after it, and how long the ball is followed into the net
    PU_R: 20, PU_COOL: 3, PU_BOOST: 1.5,     // power-up ball radius, rounds until a taken one is back, flick speed multiplier
    COOLDOWN: 1,                  // rounds without a minigame after one
    HECKLE_P: 0.75, HECKLE_T: 12, // stadium: chance per round, seconds before a stuck player is let go anyway
    STORM_P: 0.6, STORM_T: 10,    // desert / tundra: chance per round, seconds for the race
    MINI_MIN_MS: 1200,            // a minigame can't be won faster than this (a client claiming less is rounded up)
    MINI_GRACE: 0.7,              // after the first finisher, others still count for this long (the quickest time wins)
    BALES_P: 0.85, BALE_R: 34, BALE_M: 2.6, BALE_V: [380, 540], BALE_MIN_V: 260,
    BOLT_FIRST: 4,                // rainforest: seconds of play until the first strike
    BOLT_EVERY: 9,                // ...and then about this many seconds between strikes (70% to 130% of it)
    BOLT_WARN: 1, STUN: 10, STUN_R: 110, STUN_MAX: 3,
    FROST_AFTER: 2,               // tundra: frostbite starts after this many rounds without moving
    FROST_POW: [1, 0.65, 0.35, 0], FROST_DRAG: [1, 1.5, 2.2, 3.2],
    MOVED_V: 120,                 // a bobble that got faster than this (flicked or knocked) counts as having moved
  };
  const DEFAULT_NAMES = ['CYAN', 'MAGENTA'];

  // The stadiums.  n bobbles a team, the pitch in px, the goal mouth (its height), pv: how much harder a full-power flick is (so
  // the ball can still cross a big pitch), u: how much bigger the bobbles, ball, hay bales and lightning are drawn and simulated (so they
  // stay easy to see on a big pitch), turns: the turn limit, goalLimit: goals to win, extraBales: more hay on a big pitch.
  const SIZES = {
    standard: { name: 'STANDARD', n: C.TEAM, W: C.W, H: C.H, mouth: C.GY1 - C.GY0, pv: 1, u: 1, turns: C.TURNS, goalLimit: C.GOAL_LIMIT, extraBales: 0 },
    local: { name: 'LOCAL', n: 3, W: 760, H: 480, mouth: 170, pv: 0.85, u: 0.75, turns: 12, goalLimit: 3, extraBales: 0 },
    little: { name: 'LITTLE LEAGUE', n: 4, W: 1240, H: 760, mouth: 250, pv: 1.2, u: 0.95, turns: 15, goalLimit: 3, extraBales: 0 },
    premier: { name: 'PREMIER LEAGUE', n: 5, W: 1700, H: 1040, mouth: 330, pv: 1.5, u: 1.1, turns: 18, goalLimit: 3, extraBales: 1 },
  };
  const SIZE_IDS = ['local', 'little', 'premier'];                        // what the menu offers

  /** The geometry of a stadium (an unknown id gives the standard pitch). */
  function geo(id) {
    const z = SIZES[id] || SIZES.standard, GY0 = Math.round((z.H - z.mouth) / 2), NET = Math.round(C.NET * z.mouth / (C.GY1 - C.GY0));
    return {
      id: SIZES[id] ? id : 'standard', name: z.name, n: z.n, W: z.W, H: z.H, NET, GY0, GY1: GY0 + z.mouth, pv: z.pv, u: z.u,
      dr: C.DR * z.u, br: C.BR * z.u, bale: C.BALE_R * z.u, stunR: C.STUN_R * z.u,
      turns: z.turns, goalLimit: z.goalLimit, extraBales: z.extraBales,
      pu: [0, 1].map((k) => ({ x: z.W / 2, y: k ? z.H - C.PU_R * z.u - 6 : C.PU_R * z.u + 6, r: C.PU_R * z.u })),
      posts: [[0, GY0], [0, GY0 + z.mouth], [z.W, GY0], [z.W, GY0 + z.mouth]],
    };
  }

  // Formations: where a team's bobbles stand at kick-off, as fractions of the pitch (team 0's half; team 1 is the mirror image).
  // `counts` is the number of bobbles in each line from the goal outwards, `front` how far up the pitch the last line stands.
  function lineForm(counts, front) {
    const pts = [], L = counts.length;
    counts.forEach((c, l) => {
      const fx = L === 1 ? 0.07 : 0.07 + (front - 0.07) * l / (L - 1), gap = c > 1 ? Math.min(0.28, 0.76 / (c - 1)) : 0;
      for (let j = 0; j < c; j++) pts.push([+fx.toFixed(3), +(0.5 + (j - (c - 1) / 2) * gap).toFixed(3)]);
    });
    return pts;
  }
  const form = (id, name, counts, front) => ({ id, name, shape: counts.join('-'), pts: lineForm(counts, front) });
  const FORMS = {
    3: [form('balanced', 'BALANCED', [1, 2], 0.34), form('attack', 'ATTACKING', [1, 2], 0.42), form('defend', 'DEFENSIVE', [2, 1], 0.28), form('column', 'COLUMN', [1, 1, 1], 0.4)],
    4: [form('diamond', 'DIAMOND', [1, 2, 1], 0.4), form('box', 'BOX', [2, 2], 0.34), form('attack', 'ATTACKING', [1, 3], 0.42), form('defend', 'DEFENSIVE', [3, 1], 0.28)],
    5: [form('balanced', 'BALANCED', [2, 2, 1], 0.4), form('attack', 'ATTACKING', [1, 2, 2], 0.42), form('defend', 'DEFENSIVE', [3, 2], 0.3), form('midfield', 'MIDFIELD', [1, 3, 1], 0.4)],
    // the standard pitch's original kick-off spots (px on 1000 x 620)
    6: [{ id: 'classic', name: 'CLASSIC', shape: '1-2-3', pts: [[70, 310], [200, 185], [200, 435], [335, 105], [320, 310], [335, 515]].map(([x, y]) => [x / 1000, y / 620]) }],
  };
  /** The formations a team of n bobbles can choose from (the first is the default). */
  const formsFor = (n) => FORMS[n] || FORMS[6];

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
  function body(r, m) { return { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r, m }; }

  /** opts: { players: [{id, side}], size, seconds, goalLimit, map, seed, rate } */
  function create(opts) {
    opts = opts || {};
    const S = {
      ball: body(C.BR, C.M_BALL), discs: [], ev: [], tick: 0,
      phase: 'countdown', t: C.COUNT, turn: 0, turnLimit: 0, goalLimit: 0, ot: false, score: [0, 0], lastGoal: -1, winner: -1,
      round: 0, rest: 0, shots: 0, rollT: 0, rl: 0, fy: [false, false], pu: [{ cd: 0 }, { cd: 0 }],
      members: [[], []], ready: {},
      teams: [{ name: DEFAULT_NAMES[0], mascot: 0 }, { name: DEFAULT_NAMES[1], mascot: 1 }],
      // arena state (setMap fills it in)
      map: 'classic', phys: null, events: false, rate: 1, rng: null,
      mini: null, bales: [], omen: null, bolt: null, boltIn: 0, frozen: -1, cool: 0,
    };
    for (const p of opts.players || []) S.members[p.side ? 1 : 0].push(p.id);
    setSize(S, opts.size, opts);
    setMap(S, opts.map, opts.seed, opts);
    placeKickoff(S);
    return S;
  }

  /** Choose the stadium (call before restart()): the pitch, how many bobbles a team has and the match length.  Formations go
   *  back to each size's default.  opts.turns / opts.goalLimit override the size's own (tests do). */
  function setSize(S, id, opts) {
    const g = S.g = geo(id), n = S.n = g.n, N = 2 * n;
    S.size = g.id;
    S.ball.r = g.br;
    S.turnLimit = (opts && opts.turns) || g.turns; S.turn = 0;
    S.goalLimit = (opts && opts.goalLimit) || g.goalLimit;
    S.form = [formsFor(n)[0].id, formsFor(n)[0].id];
    S.discs = [];
    for (let i = 0; i < N; i++) { const d = body(g.dr, C.M_DISC); d.i = i; d.side = i < n ? 0 : 1; S.discs.push(d); }
    S.owner = new Array(N).fill(-1); S.plans = new Array(N).fill(null);
    S.stun = new Array(N).fill(0); S.hold = new Array(N).fill(0); S.pelt = new Array(N).fill(0);
    S.frost = new Array(N).fill(0); S.idle = new Array(N).fill(0); S.moved = new Array(N).fill(0);
    S.boost = new Array(N).fill(0); S.boosted = new Array(N).fill(0);
    S.ready = {};
    assign(S);
    placeKickoff(S);
  }

  /** A team's formation (an id from formsFor(S.n)).  Takes effect at the next kick-off. */
  function setFormation(S, side, id) {
    if (!formsFor(S.n).some((f) => f.id === id)) return false;
    S.form[side ? 1 : 0] = id;
    return true;
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
    S.mini = null; S.bales = []; S.omen = null; S.bolt = null; S.frozen = -1; S.cool = 0; S.fxSeen = false;
    S.boltIn = S.rng ? C.BOLT_FIRST * (0.8 + 0.4 * S.rng()) : C.BOLT_FIRST;
  }

  function placeKickoff(S) {
    const { W, H } = S.g;
    S.discs.forEach((d) => {
      const f = formsFor(S.n).find((q) => q.id === S.form[d.side]) || formsFor(S.n)[0], [fx, fy] = f.pts[d.i % S.n], x = Math.round(fx * W);
      d.x = d.side ? W - x : x; d.y = Math.round(fy * H); d.vx = d.vy = 0; d.px = d.x; d.py = d.y;
    });
    const b = S.ball; b.x = W / 2; b.y = H / 2; b.vx = b.vy = 0; b.px = b.x; b.py = b.y;
  }

  /** Start the match over (same players, teams and team names). */
  function restart(S) {
    S.score = [0, 0]; S.turn = 0; S.ot = false; S.winner = -1; S.lastGoal = -1;
    S.phase = 'countdown'; S.t = C.COUNT; S.rest = 0; S.shots = 0; S.round = 0; S.ev.length = 0;
    S.plans.fill(null); S.ready = {}; S.fy = [false, false]; resetPU(S);
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
      const k = d.i % S.n, list = S.members[d.side].length ? S.members[d.side] : all;
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
  // The first event of a match is certain (when events are on at all), so an arena never starts out quiet.
  /** The arena events have been allowed since FX_START turns were played. */
  const fxOpen = (S) => S.turn >= C.FX_START;
  const chance = (S, p) => S.rng() < Math.min(1, (S.fxSeen ? p : 1) * S.rate);

  function startPlan(S) {
    S.round++; S.rest = 0; S.plans.fill(null); S.ready = {};
    S.frozen = -1; S.omen = null;
    if (S.cool > 0) S.cool--;
    for (const q of S.pu) if (q.cd > 0) q.cd--;
    if (!beginStorm(S)) openPlan(S);
  }

  function openPlan(S) {
    S.phase = 'plan'; S.t = C.PLAN_TIME;
    S.ev.push(['plan', S.round]);
    rollEvents(S);
  }

  /** Desert / tundra: sometimes the round opens with a storm and a race instead of planning. */
  function beginStorm(S) {
    if (!S.events || !fxOpen(S) || S.cool > 0 || (S.map !== 'desert' && S.map !== 'tundra') || !chance(S, C.STORM_P)) return false;
    const who = [];
    for (const o of S.owner) if (o >= 0 && !who.includes(o)) who.push(o);
    if (!who.length) return false;
    const kind = S.map === 'desert' ? 'dig' : 'shake';
    S.phase = 'storm'; S.t = C.STORM_T; S.cool = C.COOLDOWN + 1; S.fxSeen = true;
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
    if (!S.events || !fxOpen(S)) return;
    if (S.map === 'stadium' && !S.mini && S.cool === 0 && chance(S, C.HECKLE_P)) {
      const side = S.rng() < 0.5 ? 0 : 1, pick = S.discs[side * S.n + Math.floor(S.rng() * S.n)], pid = S.owner[pick.i];
      const what = HECKLES[Math.floor(S.rng() * HECKLES.length)], from = +S.rng().toFixed(2);
      if (pid >= 0) {
        S.mini = { kind: 'scrub', race: false, pid, who: [pid], side, t: C.HECKLE_T, what, from };
        for (const d of S.discs) if (d.side === side && S.owner[d.i] === pid) { S.pelt[d.i] = 1; S.plans[d.i] = null; }
        assign(S);                                                        // a teammate takes their bobbles over...
        for (const d of S.discs) if (S.pelt[d.i]) { if (S.owner[d.i] === pid) S.hold[d.i] = 1; else delete S.ready[S.owner[d.i]]; }     // ...or, with nobody to carry them, they are stuck
        S.cool = C.COOLDOWN + 1; S.fxSeen = true;
        S.ev.push(['heckle', pid, side, what, from]);
      }
    } else if (S.map === 'desert' && chance(S, C.BALES_P)) {
      const { W, pv } = S.g, n = 1 + (S.rng() < 0.45 ? 1 : 0) + (S.rng() < 0.15 ? 1 : 0) + S.g.extraBales;
      S.omen = [];
      for (let k = 0; k < n; k++) {
        S.omen.push({ x: Math.round(W * 0.14 + S.rng() * W * 0.72), from: S.rng() < 0.5 ? 0 : 1, vx: Math.round((S.rng() - 0.5) * 360 * pv),
                      v: Math.round((C.BALE_V[0] + S.rng() * (C.BALE_V[1] - C.BALE_V[0])) * pv), d: +(S.rng() * 1.2).toFixed(2) });
      }
      S.fxSeen = true;
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
        const f = C.FROST_POW[S.frost[d.i]] * C.MAXV * S.g.pv * (S.boost[d.i] ? C.PU_BOOST : 1);     // frostbite weakens the flick; a big pitch needs harder flicks; a power-up boosts it
        d.vx = p.ax * f; d.vy = p.ay * f; S.moved[d.i] = 1; n++;
        if (S.boost[d.i]) { S.boost[d.i] = 0; S.boosted[d.i] = 1; }
      }
    }
    S.plans.fill(null); S.ready = {};
    if (!n) { S.ev.push(['pass']); startPlan(S); return; }             // nobody planned anything: plan again
    launchBales(S);
    S.phase = 'roll'; S.rest = 0; S.rollT = 0; S.shots += n;
    S.ev.push(['exec', n]);
  }

  /** The announced hay bales roll in. */
  function launchBales(S) {
    if (!S.omen) return;
    for (const o of S.omen) {
      const b = body(S.g.bale, C.BALE_M);
      b.bale = 1; b.wait = o.d; b.age = 0; b.entered = false;
      b.x = o.x; b.y = o.from ? S.g.H + b.r + 6 : -b.r - 6; b.vx = o.vx; b.vy = o.from ? -o.v : o.v;
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
    const r = b.r, e = S.phys.E_WALL, { W, H, GY0, GY1, NET } = S.g;
    if (b.y < r) { b.y = r; if (b.vy < 0) { b.vy = -b.vy * e; S.wall = Math.max(S.wall, Math.min(1, -b.vy / 900)); } }
    if (b.y > H - r) { b.y = H - r; if (b.vy > 0) { b.vy = -b.vy * e; S.wall = Math.max(S.wall, Math.min(1, b.vy / 900)); } }
    const inMouth = isBall && b.y > GY0 && b.y < GY1;
    if (!isBall || !inMouth) {                                              // the end walls (the ball may pass through the mouth)
      if (b.x < r && !(isBall && b.x < 0)) { b.x = r; if (b.vx < 0) { b.vx = -b.vx * e; S.wall = Math.max(S.wall, Math.min(1, -b.vx / 900)); } }
      if (b.x > W - r && !(isBall && b.x > W)) { b.x = W - r; if (b.vx > 0) { b.vx = -b.vx * e; S.wall = Math.max(S.wall, Math.min(1, b.vx / 900)); } }
    }
    if (isBall) {                                                           // inside a net: walls all round
      if (b.x < 0 || b.x > W) {
        b.y = clamp(b.y, GY0 + r, GY1 - r);
        if (b.y <= GY0 + r || b.y >= GY1 - r) b.vy *= -0.4;
      }
      if (b.x < -NET + r) { b.x = -NET + r; if (b.vx < 0) b.vx *= -0.3; }
      if (b.x > W + NET - r) { b.x = W + NET - r; if (b.vx > 0) b.vx *= -0.3; }
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
    if (b.x > S.g.W - b.r) { b.x = S.g.W - b.r; if (b.vx > 0) b.vx = -b.vx * e; }
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
      for (const [px, py] of S.g.posts) hitPost(b, px, py, S);
      walls(b, isBall, S);
      if (!isBall && Math.hypot(b.vx, b.vy) > C.MOVED_V) S.moved[b.i] = 1;
      const mv = isBall ? slide(b, p.K_BALL, p.D_BALL, h, C.CAP_BALL * S.g.pv) : slide(b, p.K_DISC * C.FROST_DRAG[S.frost[b.i]], p.D_DISC, h, C.CAP_DISC * S.g.pv * (S.boosted[b.i] ? C.PU_BOOST : 1));
      if (mv) moving = true;
    }
    return moving;
  }

  // ------------------------------------------------------------------ arena events, once per tick
  function strike(S) {
    const b = S.bolt;
    S.bolt = null;
    const near = S.discs.map((d) => [Math.hypot(d.x - b.x, d.y - b.y), d.i]).sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    const hit = near.filter((q, k) => k === 0 || q[0] <= S.g.stunR).slice(0, C.STUN_MAX).map((q) => q[1]);     // the closest ones
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
    if (S.map === 'rainforest') {                                         // a strike on a timer (not a lottery), so it never goes quiet for long
      if (S.bolt) { S.bolt.t -= dt; if (S.bolt.t <= 0) strike(S); }
      else if (fxOpen(S)) {
        S.boltIn -= dt * S.rate;
        if (S.boltIn <= 0) {
          const d = S.discs[Math.floor(S.rng() * S.discs.length)];
          S.bolt = { x: r1(clamp(d.x + (S.rng() - 0.5) * 140, 30, S.g.W - 30)), y: r1(clamp(d.y + (S.rng() - 0.5) * 140, 30, S.g.H - 30)), t: C.BOLT_WARN };
          S.boltIn = C.BOLT_EVERY * (0.7 + 0.6 * S.rng());
          S.ev.push(['bolt-warn', S.bolt.x, S.bolt.y]);
        }
      }
    }
    for (let k = S.bales.length - 1; k >= 0; k--) {
      const b = S.bales[k];
      if (b.wait > 0) { b.wait -= dt; if (b.wait <= 0) { b.px = b.x; b.py = b.y; } continue; }
      b.age += dt;
      if (b.y > -b.r * 0.5 && b.y < S.g.H + b.r * 0.5) b.entered = true;
      if (Math.abs(b.vy) < C.BALE_MIN_V * S.g.pv) b.vy = (b.vy < 0 ? -1 : 1) * C.BALE_MIN_V * S.g.pv;      // it keeps rolling until it leaves
      if ((b.entered && (b.y < -b.r * 1.5 || b.y > S.g.H + b.r * 1.5)) || b.age > 12) S.bales.splice(k, 1);
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
      case 'replay': case 'form': {                                       // the clients replay the goal / the captains pick formations; nothing moves
        fxTick(S, dt, false);
        S.t -= dt;
        if (S.t <= 0) { if (S.phase === 'replay') afterReplay(S); else endForm(S); }
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
        if (S.phase === 'roll') {
          S.rollT += dt;
          collectPU(S);
          const g = goalAt(S);
          if (g >= 0) return scored(S, g);
          S.rest = moving ? 0 : S.rest + dt;
          if (S.rest >= C.REST_T) endRound(S);
        } else {                                                          // plan
          S.t -= dt;
          if (S.t <= 0) execute(S);
        }
        return;
      }
      default: return;                                                    // over
    }
  }

  /** 0 / 1 = the team that just scored, -1 = no goal. */
  function goalAt(S) {
    const b = S.ball;
    if (b.y <= S.g.GY0 || b.y >= S.g.GY1) return -1;
    if (b.x + b.r < 0) return 1;
    if (b.x - b.r > S.g.W) return 0;
    return -1;
  }

  function scored(S, side) {
    S.score[side]++; S.lastGoal = side; S.turn++;
    S.phase = 'goal'; S.t = C.GOAL_PAUSE; S.plans.fill(null); S.ready = {};
    S.bales = []; S.omen = null; S.bolt = null;                           // the pitch is reset: hazards, stuns, frostbite and power-ups go with it
    S.stun.fill(0); S.frost.fill(0); S.idle.fill(0); S.moved.fill(0);
    resetPU(S);
    S.ev.push(['goal', side]);
  }

  /** The celebration is over: the replay of the roll that scored (the clients play it from what they recorded; the sim waits). */
  function afterGoal(S) {
    S.rl = +clamp(S.rollT + C.REPLAY_AFTER, 1, C.REPLAY_MAX).toFixed(1);
    S.phase = 'replay'; S.t = S.rl / C.REPLAY_SPEED + C.REPLAY_TAIL;
    S.ev.push(['replay', S.rl]);
  }

  /** Skip the replay (the host's button). */
  function skipReplay(S) { if (S.phase !== 'replay') return false; afterReplay(S); return true; }

  function afterReplay(S) {
    const side = S.lastGoal;
    if (S.ot || S.score[side] >= S.goalLimit) return finish(S, side);
    if (S.turn >= S.turnLimit && judge(S)) return;
    beginForm(S);
  }

  /** After a goal the captains may re-choose their formation; the pitch shows it live. */
  function beginForm(S) {
    S.phase = 'form'; S.t = C.FORM_TIME; S.fy = [false, false];
    placeKickoff(S);
    S.ev.push(['form']);
  }

  /** (FORM phase) a captain picks a formation: the bobbles line up in it at once.  Returns true if it was accepted. */
  function chooseFormation(S, side, id) {
    if (S.phase !== 'form' || !setFormation(S, side, id)) return false;
    S.fy[side ? 1 : 0] = false;
    placeKickoff(S);
    return true;
  }

  /** (FORM phase) a captain is ready (or takes it back).  When both are, the round starts. */
  function formReady(S, side, v) {
    if (S.phase !== 'form') return false;
    S.fy[side ? 1 : 0] = !!v;
    if (S.fy[0] && S.fy[1]) endForm(S);
    return true;
  }

  function endForm(S) {
    S.fy = [false, false];
    S.ev.push(['kick-off']);
    startPlan(S);
  }

  // ------------------------------------------------------------------ power-ups
  function resetPU(S) { for (const q of S.pu) q.cd = 0; S.boost.fill(0); S.boosted.fill(0); }

  /** A bobble touching a power-up ball picks it up: its next flick is boosted. */
  function collectPU(S) {
    for (let k = 0; k < 2; k++) {
      const q = S.pu[k], at = S.g.pu[k];
      if (q.cd > 0) continue;
      for (const d of S.discs) {
        if (Math.hypot(d.x - at.x, d.y - at.y) >= d.r + at.r) continue;
        q.cd = C.PU_COOL; S.boost[d.i] = 1;
        S.ev.push(['pu', d.i, k]);
        break;
      }
    }
  }

  /** The turn limit has been reached: the leader wins, a tie goes to sudden death.  Returns true if the match ended. */
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
    S.boosted.fill(0); S.turn++;
    if (S.turn >= S.turnLimit && !S.ot && judge(S)) return;
    startPlan(S);
  }

  /** Events since the last call: ['c', n] countdown, ['go'], ['plan', round] (a new round of planning), ['exec', n] (n flicks
   *  happen now), ['kick', 0..1] (the ball was struck), ['hit', 0..1] (bobbles met), ['wall', 0..1], ['post', 0..1],
   *  ['goal', side], ['replay', seconds] (the replay of the goal starts), ['form'] (captains pick formations), ['kick-off'],
   *  ['pu', bobble, which] (a power-up was taken), ['pass'] (nobody planned a thing), ['ot'], ['end', winner].
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
      pu: S.pu.map((q) => q.cd), boost: S.boost.slice(),
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
      k: 's', sz: S.size, tk: S.tick, ph: S.phase, t: +S.t.toFixed(2), c: S.turn, tl: S.turnLimit, ot: S.ot ? 1 : 0,
      sc: S.score.slice(), w: S.winner, lg: S.lastGoal, rd: S.round, sh: S.shots,
      lk: [locked(S, 0) && S.phase === 'plan' ? 1 : 0, locked(S, 1) && S.phase === 'plan' ? 1 : 0],
      rg: Object.keys(S.ready).map(Number), ow: S.owner.slice(),
      tm: [[S.teams[0].name, S.teams[0].mascot], [S.teams[1].name, S.teams[1].mascot]],
      b: [r1(S.ball.x), r1(S.ball.y), Math.round(S.ball.vx), Math.round(S.ball.vy)], d,
      ev: events || [],
    };
    const f = fxOf(S, 1);
    if (S.phase === 'replay') o.rl = S.rl;
    if (S.phase === 'form') { o.fo = S.form.slice(); o.fy = S.fy.map(Number); }
    if (f.pu.some(Boolean)) o.pu = f.pu;
    if (f.boost.some(Boolean)) o.bo = f.boost.map((v, i) => v ? i : -1).filter((i) => i >= 0);
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
    const discs = [], n = m.d.length / 4;
    for (let i = 0; i < m.d.length / 2; i++) discs.push({ i, side: i < n ? 0 : 1, x: m.d[2 * i], y: m.d[2 * i + 1] });
    const z = () => new Array(n * 2).fill(0), mn = m.mn;
    return {
      size: SIZES[m.sz] ? m.sz : 'standard', n, tk: m.tk, ph: m.ph, t: m.t, turn: m.c, turnLimit: m.tl || 0, replay: m.rl || 0, forms: m.fo || null, formReady: m.fy || [0, 0], ot: !!m.ot, score: m.sc, winner: m.w, lastGoal: m.lg, round: m.rd, shots: m.sh,
      locked: m.lk, ready: m.rg, owners: m.ow, teams: m.tm.map((q) => ({ name: q[0], mascot: q[1] })),
      ball: { x: m.b[0], y: m.b[1], vx: m.b[2], vy: m.b[3] }, discs, ev: m.ev || [],
      fx: {
        pu: m.pu || [0, 0], boost: (m.bo || []).reduce((a, i) => { a[i] = 1; return a; }, z()),
        map: m.mp || 'classic', frost: m.fr || z(), idle: m.il || z(), stun: m.sn || z(), pelt: (m.pt || []).reduce((a, i) => { a[i] = 1; return a; }, z()), block: m.bk || z(), frozen: m.fz === undefined ? -1 : m.fz,
        mini: mn ? { k: mn[0], race: !!mn[1], who: mn[2], t: mn[3], what: mn[4], from: mn[5], side: mn[6] } : null,
        bales: (m.bl || []).map((q) => ({ x: q[0], y: q[1], r: geo(m.sz).bale })),
        omen: m.om ? m.om.map((q) => ({ x: q[0], from: q[1], vx: q[2] })) : null,
        bolt: m.bt ? { x: m.bt[0], y: m.bt[1], t: m.bt[2] } : null,
      },
    };
  }

  /** The live sim as a view, drawn `alpha` (0..1) of the way from the previous step to the current one. */
  function view(S, alpha) {
    const L = (a, b) => a + (b - a) * alpha;
    return {
      size: S.size, n: S.n, tk: S.tick, ph: S.phase, t: S.t, turn: S.turn, turnLimit: S.turnLimit, replay: S.rl, forms: S.form.slice(), formReady: S.fy.map(Number), ot: S.ot, score: S.score, winner: S.winner, lastGoal: S.lastGoal,
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
      size: b.size, n: b.n, tk: k < 0.5 ? a.tk : b.tk, ph: b.ph, t: L(a.t, b.t), turn: b.turn, turnLimit: b.turnLimit, replay: b.replay, forms: b.forms, formReady: b.formReady, ot: b.ot, score: b.score, winner: b.winner,
      lastGoal: b.lastGoal, round: b.round, shots: b.shots, locked: b.locked, ready: b.ready, owners: b.owners, teams: b.teams,
      ball: { x: L(a.ball.x, b.ball.x), y: L(a.ball.y, b.ball.y), vx: b.ball.vx, vy: b.ball.vy },
      discs: b.discs.map((q, i) => { const p = a.discs[i] || q; return { i: q.i, side: q.side, x: L(p.x, q.x), y: L(p.y, q.y) }; }),
      ev: [], fx: Object.assign({}, b.fx, { bales }),
    };
  }

  return { C, MAPS: MAP_IDS, SIZES: SIZE_IDS, geo, formsFor, create, setSize, setFormation, setMap, restart, step, setPlan, setReady, setTeam, removePlayer, miniDone, chooseFormation, formReady, skipReplay, takeEvents, snapshot, parseSnapshot, view, lerpView };
}));
