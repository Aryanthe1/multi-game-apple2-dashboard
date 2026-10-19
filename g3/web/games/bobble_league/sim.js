/* Bobble League: the match simulation.
 *
 * Pure and DOM-free so it runs in the browser (on the HOST only; guests just draw the snapshots the
 * host sends) and under Node for tests.  Everything is in pixels and seconds on a fixed 1/60 s step.
 *
 *   world: x 0..W is the pitch, y grows downward, the floor is at y = FLOOR.
 *          The goals are nets behind each end wall: x -NET..0 (left) and W..W+NET (right),
 *          open between the floor and the crossbar at y = BAR.
 *   team 0 (cyan) defends the LEFT goal and attacks right; team 1 (magenta) the other way round.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BobbleSim = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    W: 1200, FLOOR: 540, BAR: 330, NET: 90,
    PR: 38,                       // slime radius
    BR: 22,                       // ball radius
    GRAV_P: 2300, GRAV_B: 1300,
    RUN: 360, ACC_G: 3400, ACC_A: 1700, FRIC: 2800,
    JUMP: 880,                    // jump speed: about 170 px high, 4.5 slimes
    SLIDE_V: 640, SLIDE_T: 0.28, SLIDE_CD: 0.85,
    DRAG: 0.12, BALL_MAX: 1500,
    MATCH: 120,                   // seconds of play
    OT: 60,                       // golden-goal overtime, seconds
    COUNT: 3, KICKOFF_COUNT: 2, GOAL_PAUSE: 2.6,
    STEP: 1 / 60,
  };

  // walls the ball bounces off: [ax, ay, bx, by, restitution, nx, ny]  (n = the side the ball lives on)
  const SEGS = [
    [-C.NET, C.FLOOR, C.W + C.NET, C.FLOOR, 0.74, 0, -1],     // floor
    [0, 0, C.W, 0, 0.7, 0, 1],                                // ceiling
    [0, 0, 0, C.BAR, 0.8, 1, 0],                              // end walls above the goals
    [C.W, 0, C.W, C.BAR, 0.8, -1, 0],
    [-C.NET, C.BAR, 0, C.BAR, 0.5, 0, 1],                     // crossbar / net roof
    [C.W, C.BAR, C.W + C.NET, C.BAR, 0.5, 0, 1],
    [-C.NET, C.BAR, -C.NET, C.FLOOR, 0.35, 1, 0],             // back of the nets
    [C.W + C.NET, C.BAR, C.W + C.NET, C.FLOOR, 0.35, -1, 0],
  ];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const approach = (v, to, d) => (v < to ? Math.min(to, v + d) : Math.max(to, v - d));

  function newPlayer(id, team) {
    return { id, team, x: 0, y: C.FLOOR - C.PR, px: 0, py: 0, vx: 0, vy: 0, face: team ? -1 : 1, ground: true,
             slideT: 0, slideCd: 0, prevS: false, inp: { l: 0, r: 0, u: 0, s: 0 } };
  }

  /** players: [{id, team}] */
  function create(opts) {
    opts = opts || {};
    const S = { players: [], ball: { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, hitCd: 0, wallCd: 0 }, ev: [], tick: 0,
                phase: 'countdown', t: C.COUNT, clock: opts.seconds || C.MATCH, seconds: opts.seconds || C.MATCH,
                ot: false, otT: 0, score: [0, 0], lastGoal: -1, winner: -1, lastTouch: -1 };
    for (const p of opts.players || []) S.players.push(newPlayer(p.id, p.team ? 1 : 0));
    placeKickoff(S);
    return S;
  }

  function placeKickoff(S) {
    const idx = [0, 0];
    for (const p of S.players) {
      const j = idx[p.team]++;
      const off = 150 + j * 130;
      p.x = p.team ? C.W / 2 + off : C.W / 2 - off;
      p.y = C.FLOOR - C.PR;
      p.vx = p.vy = 0; p.ground = true; p.slideT = 0; p.slideCd = 0; p.prevS = false;
      p.face = p.team ? -1 : 1;
      p.px = p.x; p.py = p.y;
    }
    const b = S.ball;
    b.x = C.W / 2; b.y = 210; b.vx = b.vy = 0; b.px = b.x; b.py = b.y; b.hitCd = b.wallCd = 0;
  }

  /** Start the match over (same players and teams). */
  function restart(S) {
    S.score = [0, 0]; S.clock = S.seconds; S.ot = false; S.otT = 0; S.winner = -1; S.lastGoal = -1; S.lastTouch = -1;
    S.phase = 'countdown'; S.t = C.COUNT; S.ev.length = 0;
    placeKickoff(S);
  }

  function setInput(S, id, mask) {
    const p = S.players.find((q) => q.id === id);
    if (!p) return;
    p.inp = { l: mask & 1, r: (mask >> 1) & 1, u: (mask >> 2) & 1, s: (mask >> 3) & 1 };
  }

  function removePlayer(S, id) {
    const i = S.players.findIndex((q) => q.id === id);
    if (i >= 0) S.players.splice(i, 1);
  }

  /** Events since the last call: ['c', n] countdown, ['go'], ['goal', team], ['hit', 0..1], ['wall', 0..1],
   *  ['jump'], ['slide'], ['ot'], ['end', winner]. */
  function takeEvents(S) { const e = S.ev.slice(); S.ev.length = 0; return e; }

  // ------------------------------------------------------------------ the step
  function step(S, dt) {
    dt = dt || C.STEP;
    S.tick++;
    for (const p of S.players) { p.px = p.x; p.py = p.y; }
    S.ball.px = S.ball.x; S.ball.py = S.ball.y;

    if (S.phase === 'countdown') {
      const before = Math.ceil(S.t);
      S.t -= dt;
      if (S.t > 0 && Math.ceil(S.t) !== before) S.ev.push(['c', Math.ceil(S.t)]);
      if (S.t <= 0) { S.phase = 'play'; S.t = 0; S.ev.push(['go']); }
    } else if (S.phase === 'play') {
      if (!S.ot) {
        S.clock -= dt;
        if (S.clock <= 0) {
          S.clock = 0;
          if (S.score[0] === S.score[1]) { S.ot = true; S.otT = 0; S.ev.push(['ot']); } else finish(S);
        }
      } else {
        S.otT += dt;
        if (S.otT >= C.OT) finish(S);
      }
    }

    if (S.phase === 'play' || S.phase === 'goal') {
      movePlayers(S, dt);
      stepBall(S, dt);
    }
    if (S.phase === 'play') checkGoal(S);
    else if (S.phase === 'goal') {
      S.t -= dt;
      if (S.t <= 0) {
        if (S.ot) finish(S);
        else { placeKickoff(S); S.phase = 'countdown'; S.t = C.KICKOFF_COUNT; }
      }
    }
  }

  function finish(S) {
    S.phase = 'over';
    S.winner = S.score[0] === S.score[1] ? -1 : S.score[0] > S.score[1] ? 0 : 1;
    S.ev.push(['end', S.winner]);
  }

  function checkGoal(S) {
    const b = S.ball;
    let team = -1;
    if (b.x + C.BR < 0 && b.y > C.BAR) team = 1;                       // into the left net: magenta scores
    else if (b.x - C.BR > C.W && b.y > C.BAR) team = 0;
    if (team < 0) return;
    S.score[team]++;
    S.lastGoal = team;
    S.phase = 'goal'; S.t = C.GOAL_PAUSE;
    S.ev.push(['goal', team]);
  }

  function movePlayers(S, dt) {
    for (const p of S.players) {
      const i = p.inp;
      const dir = (i.r ? 1 : 0) - (i.l ? 1 : 0);
      if (dir) p.face = dir;
      p.slideCd = Math.max(0, p.slideCd - dt);

      if (i.s && !p.prevS && p.ground && p.slideCd <= 0 && p.slideT <= 0) {
        p.slideT = C.SLIDE_T; p.slideCd = C.SLIDE_CD;
        if (dir) p.face = dir;
        p.vx = p.face * C.SLIDE_V;
        S.ev.push(['slide']);
      }
      p.prevS = !!i.s;

      if (p.slideT > 0) {
        p.slideT -= dt;
        p.vx *= 1 - 1.2 * dt;
      } else if (dir) {
        p.vx = approach(p.vx, dir * C.RUN, (p.ground ? C.ACC_G : C.ACC_A) * dt);
      } else {
        p.vx = approach(p.vx, 0, (p.ground ? C.FRIC : C.FRIC * 0.25) * dt);
      }

      if (i.u && p.ground && p.slideT <= 0) { p.vy = -C.JUMP; p.ground = false; S.ev.push(['jump']); }
      const g = C.GRAV_P * (p.vy < 0 && !i.u ? 2.2 : 1);               // let go of jump = short hop
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ground = false;
      bound(p);
    }
    // slimes bump into each other like soft balls and can stand on each other's heads
    for (let a = 0; a < S.players.length; a++) {
      for (let c = a + 1; c < S.players.length; c++) {
        const A = S.players[a], B = S.players[c];
        const dx = B.x - A.x, dy = B.y - A.y, min = C.PR * 2;
        const d = Math.hypot(dx, dy);
        if (d >= min) continue;
        const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0, o = (min - d) / 2;
        A.x -= nx * o; A.y -= ny * o; B.x += nx * o; B.y += ny * o;
        const vn = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
        if (vn < 0) { const j = -1.2 * vn / 2; A.vx -= nx * j; A.vy -= ny * j; B.vx += nx * j; B.vy += ny * j; }
        if (ny < -0.6) B.ground = true; else if (ny > 0.6) A.ground = true;
      }
    }
    for (const p of S.players) bound(p);
  }

  function bound(p) {
    if (p.y >= C.FLOOR - C.PR) { p.y = C.FLOOR - C.PR; if (p.vy > 0) p.vy = 0; p.ground = true; }
    if (p.y < C.PR) { p.y = C.PR; if (p.vy < 0) p.vy = 0; }
    if (p.x < C.PR) { p.x = C.PR; if (p.vx < 0) p.vx = 0; }
    if (p.x > C.W - C.PR) { p.x = C.W - C.PR; if (p.vx > 0) p.vx = 0; }
  }

  function stepBall(S, dt) {
    const b = S.ball, n = 2, h = dt / n;
    b.hitCd = Math.max(0, b.hitCd - dt); b.wallCd = Math.max(0, b.wallCd - dt);
    for (let k = 0; k < n; k++) {
      b.vy += C.GRAV_B * h;
      const dr = Math.max(0, 1 - C.DRAG * h);
      b.vx *= dr; b.vy *= dr;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > C.BALL_MAX) { b.vx *= C.BALL_MAX / sp; b.vy *= C.BALL_MAX / sp; }
      b.x += b.vx * h; b.y += b.vy * h;
      for (const p of S.players) collidePlayer(S, b, p);
      for (const s of SEGS) collideSeg(S, b, s);                        // walls last: a slime can't squeeze the ball out of the world
      containBall(b);
    }
    if (b.y >= C.FLOOR - C.BR - 0.6) b.vx *= 1 - 0.6 * dt;             // rolling friction
    if (!isFinite(b.x) || !isFinite(b.y)) { b.x = C.W / 2; b.y = 200; b.vx = b.vy = 0; }
  }

  /** Last-resort bounds, for the rare frame where a slime pins the ball against a wall. */
  function containBall(b) {
    if (b.y > C.FLOOR - C.BR) { b.y = C.FLOOR - C.BR; if (b.vy > 0) b.vy = 0; }
    if (b.y < C.BR) { b.y = C.BR; if (b.vy < 0) b.vy = 0; }
    if (b.y < C.BAR) {                                                 // above the bar the end walls are solid
      if (b.x < C.BR) { b.x = C.BR; if (b.vx < 0) b.vx = 0; }
      if (b.x > C.W - C.BR) { b.x = C.W - C.BR; if (b.vx > 0) b.vx = 0; }
    }
    if (b.x < -C.NET + C.BR) { b.x = -C.NET + C.BR; if (b.vx < 0) b.vx = 0; }
    if (b.x > C.W + C.NET - C.BR) { b.x = C.W + C.NET - C.BR; if (b.vx > 0) b.vx = 0; }
  }

  function collideSeg(S, b, s) {
    const ax = s[0], ay = s[1], bx = s[2], by = s[3];
    const abx = bx - ax, aby = by - ay;
    const t = clamp(((b.x - ax) * abx + (b.y - ay) * aby) / (abx * abx + aby * aby), 0, 1);
    const cx = ax + abx * t, cy = ay + aby * t;
    let dx = b.x - cx, dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= C.BR) return;
    let nx, ny;
    if (d < 1e-6) { nx = s[5]; ny = s[6]; } else { nx = dx / d; ny = dy / d; }
    b.x += nx * (C.BR - d); b.y += ny * (C.BR - d);
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const e = -vn < 60 ? 0 : s[4];                                   // tiny bounces just settle
      b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
      if (-vn > 260 && b.wallCd <= 0) { S.ev.push(['wall', Math.min(1, -vn / 1000)]); b.wallCd = 0.1; }
    }
  }

  function collidePlayer(S, b, p) {
    let dx = b.x - p.x, dy = b.y - p.y;
    let d = Math.hypot(dx, dy);
    const min = C.PR + C.BR;
    if (d >= min) return;
    if (d < 1e-6) { dx = 0; dy = -1; d = 1; }
    const nx = dx / d, ny = dy / d;
    b.x = p.x + nx * min; b.y = p.y + ny * min;
    const vn = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;                // closing speed (negative = approaching)
    if (vn >= 0) return;
    const j = -(1 + 0.82) * vn + (p.slideT > 0 ? 330 : 0);             // sliding into the ball is a proper kick
    b.vx += nx * j; b.vy += ny * j;
    if (-vn > 110) {                                                   // even a light touch should send it off
      const after = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
      if (after < 200) { b.vx += nx * (200 - after); b.vy += ny * (200 - after); }
    }
    S.lastTouch = p.id;
    if (-vn > 110 && b.hitCd <= 0) { S.ev.push(['hit', Math.min(1, -vn / 900)]); b.hitCd = 0.08; }
  }

  // ------------------------------------------------------------------ snapshots (host -> guests)
  const r1 = (v) => Math.round(v * 10) / 10;

  /** Compact JSON-able snapshot.  `events` are the host's events since the last snapshot. */
  function snapshot(S, events) {
    return {
      k: 's', tk: S.tick, ph: S.phase, t: +S.t.toFixed(2), c: +S.clock.toFixed(1), ot: S.ot ? 1 : 0,
      sc: S.score.slice(), w: S.winner, lg: S.lastGoal,
      b: [r1(S.ball.x), r1(S.ball.y), Math.round(S.ball.vx), Math.round(S.ball.vy)],
      p: S.players.map((p) => [p.id, p.team, r1(p.x), r1(p.y), Math.round(p.vx), Math.round(p.vy),
        (p.ground ? 1 : 0) | (p.slideT > 0 ? 2 : 0) | (p.face > 0 ? 4 : 0)]),
      ev: events || [],
    };
  }

  /** The renderer's view of a snapshot message (also what view() produces from the live sim). */
  function parseSnapshot(m) {
    return {
      tk: m.tk, ph: m.ph, t: m.t, clock: m.c, ot: !!m.ot, score: m.sc, winner: m.w, lastGoal: m.lg,
      ball: { x: m.b[0], y: m.b[1], vx: m.b[2], vy: m.b[3] },
      players: m.p.map((q) => ({ id: q[0], team: q[1], x: q[2], y: q[3], vx: q[4], vy: q[5],
                                 ground: !!(q[6] & 1), slide: !!(q[6] & 2), face: q[6] & 4 ? 1 : -1 })),
      ev: m.ev || [],
    };
  }

  /** The live sim as a view, drawn `alpha` (0..1) of the way from the previous step to the current one. */
  function view(S, alpha) {
    const L = (a, b) => a + (b - a) * alpha;
    return {
      tk: S.tick, ph: S.phase, t: S.t, clock: S.clock, ot: S.ot, score: S.score, winner: S.winner, lastGoal: S.lastGoal,
      ball: { x: L(S.ball.px, S.ball.x), y: L(S.ball.py, S.ball.y), vx: S.ball.vx, vy: S.ball.vy },
      players: S.players.map((p) => ({ id: p.id, team: p.team, x: L(p.px, p.x), y: L(p.py, p.y), vx: p.vx, vy: p.vy,
                                       ground: p.ground, slide: p.slideT > 0, face: p.face })),
      ev: [],
    };
  }

  /** Blend two views (k = 0 gives a, 1 gives b).  Discrete things come from whichever is nearer. */
  function lerpView(a, b, k) {
    const near = k < 0.5 ? a : b;
    const L = (x, y) => x + (y - x) * k;
    const byId = new Map(a.players.map((p) => [p.id, p]));
    return {
      tk: near.tk, ph: b.ph, t: L(a.t, b.t), clock: L(a.clock, b.clock), ot: b.ot, score: b.score, winner: b.winner,
      lastGoal: b.lastGoal,
      ball: { x: L(a.ball.x, b.ball.x), y: L(a.ball.y, b.ball.y), vx: near.ball.vx, vy: near.ball.vy },
      players: b.players.map((q) => {
        const p = byId.get(q.id) || q;
        return { id: q.id, team: q.team, x: L(p.x, q.x), y: L(p.y, q.y), vx: q.vx, vy: q.vy, ground: q.ground, slide: q.slide, face: q.face };
      }),
      ev: [],
    };
  }

  return { C, create, restart, step, setInput, removePlayer, takeEvents, snapshot, parseSnapshot, view, lerpView };
}));
