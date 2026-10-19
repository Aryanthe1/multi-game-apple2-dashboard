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
  };
  const DEFAULT_NAMES = ['CYAN', 'MAGENTA'];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const POSTS = [[0, C.GY0], [0, C.GY1], [C.W, C.GY0], [C.W, C.GY1]];

  // kickoff spots for team 0 (the left side); team 1 is the mirror image
  const FORMATION = [[70, C.H / 2], [200, C.H / 2 - 125], [200, C.H / 2 + 125], [335, C.H / 2 - 205], [320, C.H / 2], [335, C.H / 2 + 205]];

  function body(r, m) { return { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r, m }; }

  /** opts: { players: [{id, side}], seconds, goalLimit } */
  function create(opts) {
    opts = opts || {};
    const S = {
      ball: body(C.BR, C.M_BALL), discs: [], ev: [], tick: 0,
      phase: 'countdown', t: C.COUNT, clock: opts.seconds || C.MATCH, seconds: opts.seconds || C.MATCH,
      goalLimit: opts.goalLimit || C.GOAL_LIMIT, ot: false, score: [0, 0], lastGoal: -1, winner: -1,
      round: 0, rest: 0, shots: 0,
      members: [[], []], owner: new Array(C.TEAM * 2).fill(-1), plans: new Array(C.TEAM * 2).fill(null), ready: {},
      teams: [{ name: DEFAULT_NAMES[0], mascot: 0 }, { name: DEFAULT_NAMES[1], mascot: 1 }],
    };
    for (let i = 0; i < C.TEAM * 2; i++) { const d = body(C.DR, C.M_DISC); d.i = i; d.side = i < C.TEAM ? 0 : 1; S.discs.push(d); }
    for (const p of opts.players || []) S.members[p.side ? 1 : 0].push(p.id);
    assign(S);
    placeKickoff(S);
    return S;
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
  }

  function ownersOf(S, side) {
    const out = new Set();
    for (const d of S.discs) if (d.side === side && S.owner[d.i] >= 0) out.add(S.owner[d.i]);
    return out;
  }

  /** Has every player of `side` locked in? */
  function locked(S, side) {
    for (const id of ownersOf(S, side)) if (!S.ready[id]) return false;
    return true;
  }

  function removePlayer(S, id) {
    for (const m of S.members) { const i = m.indexOf(id); if (i >= 0) m.splice(i, 1); }
    delete S.ready[id];
    assign(S);
    if (S.phase === 'plan') checkLocks(S);
  }

  // ------------------------------------------------------------------ planning
  function startPlan(S) {
    S.phase = 'plan'; S.round++; S.t = C.PLAN_TIME; S.rest = 0;
    S.plans.fill(null); S.ready = {};
    S.ev.push(['plan', S.round]);
  }

  /** Set (or, with a tiny flick, clear) the planned flick for one of your bobbles.  (ax, ay) is a fraction of full power:
   *  its direction is where the bobble will go, its length (clamped to 1) is the power.  Only during PLAN, only for a bobble
   *  you command, and only while you haven't locked in.  Returns true if it was accepted. */
  function setPlan(S, pid, i, ax, ay) {
    if (S.phase !== 'plan' || S.ready[pid]) return false;
    if (!Number.isInteger(i) || i < 0 || i >= S.discs.length || S.owner[i] !== pid) return false;
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
      if (p) { d.vx = p.ax * C.MAXV; d.vy = p.ay * C.MAXV; n++; }
    }
    S.plans.fill(null); S.ready = {};
    if (!n) { S.ev.push(['pass']); startPlan(S); return; }             // nobody planned anything: plan again
    S.phase = 'roll'; S.rest = 0; S.shots += n;
    S.ev.push(['exec', n]);
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
    const e = a === S.ball || b === S.ball ? C.E_BALL : C.E_DISC;
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
    const r = b.r, e = C.E_WALL;
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

  /** One physics sub-step.  Returns true if anything is still moving. */
  function physics(S, h) {
    let moving = false;
    const all = S.discs.concat(S.ball);
    for (const b of all) { b.x += b.vx * h; b.y += b.vy * h; }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) collide(all[i], all[j], S);
    for (const b of all) {
      const isBall = b === S.ball;
      for (const [px, py] of POSTS) hitPost(b, px, py, S);
      walls(b, isBall, S);
      const mv = isBall ? slide(b, C.K_BALL, C.D_BALL, h, C.CAP_BALL) : slide(b, C.K_DISC, C.D_DISC, h, C.CAP_DISC);
      if (mv) moving = true;
    }
    return moving;
  }

  // ------------------------------------------------------------------ the step
  function step(S) {
    S.tick++;
    const all = S.discs.concat(S.ball);
    for (const b of all) { b.px = b.x; b.py = b.y; }
    const dt = C.STEP;
    switch (S.phase) {
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
    if (S.clock <= 0 && !S.ot && judge(S)) return;
    startPlan(S);
  }

  /** Events since the last call: ['c', n] countdown, ['go'], ['plan', round] (a new round of planning), ['exec', n] (n flicks
   *  happen now), ['kick', 0..1] (the ball was struck), ['hit', 0..1] (bobbles met), ['wall', 0..1], ['post', 0..1],
   *  ['goal', side], ['kick-off'], ['pass'] (nobody planned a thing), ['ot'], ['end', winner]. */
  function takeEvents(S) { const e = S.ev.slice(); S.ev.length = 0; return e; }

  // ------------------------------------------------------------------ snapshots (host -> guests)
  const r1 = (v) => Math.round(v * 10) / 10;

  /** Compact JSON-able snapshot.  `events` are the host's events since the last snapshot.  Plans are NOT in it. */
  function snapshot(S, events) {
    const d = [];
    for (const q of S.discs) d.push(r1(q.x), r1(q.y));
    return {
      k: 's', tk: S.tick, ph: S.phase, t: +S.t.toFixed(2), c: +S.clock.toFixed(1), ot: S.ot ? 1 : 0,
      sc: S.score.slice(), w: S.winner, lg: S.lastGoal, rd: S.round, sh: S.shots,
      lk: [locked(S, 0) && S.phase === 'plan' ? 1 : 0, locked(S, 1) && S.phase === 'plan' ? 1 : 0],
      rg: Object.keys(S.ready).map(Number), ow: S.owner.slice(),
      tm: [[S.teams[0].name, S.teams[0].mascot], [S.teams[1].name, S.teams[1].mascot]],
      b: [r1(S.ball.x), r1(S.ball.y), Math.round(S.ball.vx), Math.round(S.ball.vy)], d,
      ev: events || [],
    };
  }

  /** The renderer's view of a snapshot message (also what view() produces from the live sim). */
  function parseSnapshot(m) {
    const discs = [];
    for (let i = 0; i < m.d.length / 2; i++) discs.push({ i, side: i < C.TEAM ? 0 : 1, x: m.d[2 * i], y: m.d[2 * i + 1] });
    return {
      tk: m.tk, ph: m.ph, t: m.t, clock: m.c, ot: !!m.ot, score: m.sc, winner: m.w, lastGoal: m.lg, round: m.rd, shots: m.sh,
      locked: m.lk, ready: m.rg, owners: m.ow, teams: m.tm.map((q) => ({ name: q[0], mascot: q[1] })),
      ball: { x: m.b[0], y: m.b[1], vx: m.b[2], vy: m.b[3] }, discs, ev: m.ev || [],
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
      ev: [],
    };
  }

  /** Blend two views (k = 0 gives a, 1 gives b).  Discrete things come from b. */
  function lerpView(a, b, k) {
    const L = (x, y) => x + (y - x) * k;
    return {
      tk: k < 0.5 ? a.tk : b.tk, ph: b.ph, t: L(a.t, b.t), clock: L(a.clock, b.clock), ot: b.ot, score: b.score, winner: b.winner,
      lastGoal: b.lastGoal, round: b.round, shots: b.shots, locked: b.locked, ready: b.ready, owners: b.owners, teams: b.teams,
      ball: { x: L(a.ball.x, b.ball.x), y: L(a.ball.y, b.ball.y), vx: b.ball.vx, vy: b.ball.vy },
      discs: b.discs.map((q, i) => { const p = a.discs[i] || q; return { i: q.i, side: q.side, x: L(p.x, q.x), y: L(p.y, q.y) }; }),
      ev: [],
    };
  }

  return { C, create, restart, step, setPlan, setReady, setTeam, removePlayer, takeEvents, snapshot, parseSnapshot, view, lerpView };
}));
