// node g3/web/games/bobble_league/sim.test.js
const Sim = require('./sim.js');
const { C } = Sim;
C.FX_START = 0;                       // most tests want events from round 1; the 'quiet first minute' block below turns it back on
let fails = 0;
function check(label, ok, extra) { console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || extra === undefined ? '' : '  -> ' + extra)); if (!ok) fails++; }
const run = (S, secs) => { for (let i = 0; i < Math.round(secs * 60); i++) Sim.step(S); };
const mk = (sides = [0, 1], opts = {}) => Sim.create(Object.assign({ players: sides.map((side, id) => ({ id, side })) }, opts));
const live = (S) => { run(S, C.COUNT + 0.05); return S; };
const still = (S) => [S.ball].concat(S.discs).every((b) => b.vx === 0 && b.vy === 0);
const settle = (S, max = 40) => { for (let i = 0; i < max * 60 && S.phase === 'roll'; i++) Sim.step(S); };
const park = (S) => S.discs.forEach((q, i) => { q.x = 60 + i * 75; q.y = 40; q.vx = q.vy = 0; });   // everyone out of the ball's way, along the top
const inside = (b, slack = 0) => b.x >= b.r - slack && b.x <= C.W - b.r + slack && b.y >= b.r - 0.01 && b.y <= C.H - b.r + 0.01;
const mine = (S, pid) => S.discs.filter((d) => S.owner[d.i] === pid).map((d) => d.i);
const lockAll = (S) => { for (const id of S.members[0].concat(S.members[1])) Sim.setReady(S, id, true); };

console.log('kickoff');
let S = mk();
check('starts in the countdown with 6 bobbles a side and a ball in the middle',
  S.phase === 'countdown' && S.discs.length === 12 && S.discs.filter((d) => d.side === 0).length === 6 && S.ball.x === C.W / 2 && S.ball.y === C.H / 2);
check('teams start on their own halves, all on the pitch',
  S.discs.every((d) => (d.side === 0 ? d.x < C.W / 2 : d.x > C.W / 2) && inside(d)));
check('and nobody overlaps at kickoff', (() => { const a = S.discs.concat(S.ball); for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y) < a[i].r + a[j].r) return false; return true; })());
run(S, 2.9); check('still counting at 2.9 s', S.phase === 'countdown');
run(S, 0.3); check('planning opens after 3 s', S.phase === 'plan' && S.round === 1 && Math.abs(S.t - C.PLAN_TIME) < 0.5);
const evs = Sim.takeEvents(S).map((e) => e[0]);
check('countdown ticks, go and the new round were announced', evs.includes('c') && evs.includes('go') && evs.includes('plan'), evs.join());

console.log('six bobbles, shared out evenly');
const counts = (sides) => { const T = mk(sides); const per = {}; T.discs.forEach((d) => { per[T.owner[d.i]] = (per[T.owner[d.i]] || 0) + 1; }); return per; };
let per = counts([0, 1]);
check('1 v 1: six bobbles each', per[0] === 6 && per[1] === 6, JSON.stringify(per));
per = counts([0, 1, 0, 1]);
check('2 v 2: three bobbles each', [0, 1, 2, 3].every((id) => per[id] === 3), JSON.stringify(per));
per = counts([0, 1, 0]);
check('2 v 1: the pair get three each, the single player six', per[0] === 3 && per[2] === 3 && per[1] === 6, JSON.stringify(per));
per = counts([0, 1, 0, 1, 0, 1]);
check('3 v 3: two each', [0, 1, 2, 3, 4, 5].every((id) => per[id] === 2), JSON.stringify(per));
per = counts([0, 1, 0, 1, 0, 1, 0, 1]);
check('4 v 4: two of the four get 2, two get 1, none left out', Object.values(per).reduce((a, b) => a + b, 0) === 12 && Object.keys(per).length === 8 && Math.max(...Object.values(per)) === 2 && Math.min(...Object.values(per)) === 1, JSON.stringify(per));
per = counts([0]);
check('solo: the lone player commands all twelve', per[0] === 12, JSON.stringify(per));
S = mk([0, 1, 0, 1]);
check('a player only ever commands bobbles of their own team', S.discs.every((d) => S.members[d.side].includes(S.owner[d.i])));
check('and each team is still exactly 6 bobbles', S.discs.filter((d) => d.side === 0).length === 6 && S.discs.filter((d) => d.side === 1).length === 6);

console.log('planning');
S = live(mk());
check('a plan for someone else\'s bobble is refused', Sim.setPlan(S, 0, 6, 1, 0) === false && S.plans[6] === null);
check('garbage plans are refused', [[0, NaN, 1], [0, 1, Infinity], [99, 1, 0], [-1, 1, 0], [1.5, 1, 0], ['x', 1, 0], [null, 1, 0]].every(([i, ax, ay]) => Sim.setPlan(S, 0, i, ax, ay) === false));
check('an unknown player can\'t plan', Sim.setPlan(S, 9, 0, 1, 0) === false);
check('nothing moved while planning', still(S) && S.phase === 'plan');
check('a proper plan is accepted and stored, not executed', Sim.setPlan(S, 0, 4, 1, 0) === true && S.plans[4] && still(S));
check('power is capped at 1', (Sim.setPlan(S, 0, 4, 5, 0), Math.abs(S.plans[4].ax - 1) < 1e-9));
Sim.setPlan(S, 0, 4, 0.5, 0);
check('half power is stored as half power', Math.abs(S.plans[4].ax - 0.5) < 1e-9);
check('a tiny flick clears the plan', (Sim.setPlan(S, 0, 4, 0.01, 0.01), S.plans[4] === null));
check('every one of my bobbles can be planned, each its own way', [0, 1, 2, 3, 4, 5].every((i) => Sim.setPlan(S, 0, i, Math.cos(i), Math.sin(i))) && S.plans.slice(0, 6).every(Boolean));

console.log('both teams move at once');
S = live(mk()); park(S);
S.ball.x = 500; S.ball.y = 310;
S.discs[4].x = 300; S.discs[4].y = 100; S.discs[10].x = 700; S.discs[10].y = 500;
Sim.setPlan(S, 0, 4, 1, 0); Sim.setPlan(S, 1, 10, -1, 0);
Sim.setReady(S, 0, true);
check('one team locking in does not start the round', S.phase === 'plan' && still(S));
Sim.setReady(S, 1, true);
check('both locked in: the round plays at once', S.phase === 'roll' && S.discs[4].vx > 1400 && S.discs[10].vx < -1400, `${S.phase} ${S.discs[4].vx} ${S.discs[10].vx}`);
check('and announces the flicks', Sim.takeEvents(S).some((e) => e[0] === 'exec' && e[1] === 2));
run(S, 0.1);
check('both bobbles travelling towards each other\'s halves at the same time', S.discs[4].x > 330 && S.discs[10].x < 670);
check('plans are cleared once played', S.plans.every((p) => p === null) && Object.keys(S.ready).length === 0);
check('no flicks during the movement', Sim.setPlan(S, 0, 1, 1, 0) === false);
settle(S);
check('everything slides to a stop and a new round of planning opens', S.phase === 'plan' && still(S) && S.round === 2);
check('the planning time is full again', Math.abs(S.t - C.PLAN_TIME) < 0.5);

console.log('locking in');
S = live(mk());
Sim.setPlan(S, 0, 0, 1, 0);
Sim.setReady(S, 0, true);
check('once locked in you can\'t change your plan', Sim.setPlan(S, 0, 0, 0, 1) === false && S.plans[0].ax > 0.99);
Sim.setReady(S, 0, false);
check('unlock it and you can again', Sim.setPlan(S, 0, 0, 0, 1) === true && Math.abs(S.plans[0].ay - 1) < 1e-9);
check('a spectator can\'t lock in', Sim.setReady(S, 7, true) === false);
S = live(mk([0, 1, 0, 1]));
Sim.setPlan(S, 0, 0, 1, 0);
Sim.setReady(S, 0, true); Sim.setReady(S, 1, true); Sim.setReady(S, 2, true);
check('a team is only locked when every one of its players is', S.phase === 'plan');
Sim.setReady(S, 3, true);
check('...and the round plays when the last player locks in', S.phase === 'roll');
S = live(mk());
run(S, C.PLAN_TIME - 0.3); check('still planning just before the time is up', S.phase === 'plan');
Sim.setPlan(S, 0, 4, 1, 0.2);
run(S, 0.5);
check('when the time runs out whatever is planned plays', S.phase === 'roll' && S.discs[4].vx > 1000 || S.discs[4].x > 330);
S = live(mk());
run(S, C.PLAN_TIME + 0.2);
check('with nothing planned the round is simply replanned', S.phase === 'plan' && S.round === 2 && Sim.takeEvents(S).some((e) => e[0] === 'pass'));
S = live(mk([0, 1, 0, 1]));
Sim.setPlan(S, 0, 0, 1, 0);
Sim.setReady(S, 0, true); Sim.setReady(S, 1, true); Sim.setReady(S, 2, true);
Sim.removePlayer(S, 3);
check('if the last player to lock in leaves, the round goes ahead', S.phase === 'roll', S.phase);
S = live(mk([0, 1, 0, 1]));
Sim.removePlayer(S, 2);
check('when a teammate leaves their bobbles are handed to the rest of the team', mine(S, 0).length === 6 && !S.owner.includes(2));

console.log('solo');
S = live(mk([0]));
check('solo: the lone player may plan for both teams', Sim.setPlan(S, 0, 0, 1, 0) && Sim.setPlan(S, 0, 6, -1, 0));
Sim.setReady(S, 0, true);
check('and one lock-in plays the round', S.phase === 'roll' && S.discs[0].vx > 0 && S.discs[6].vx < 0);

console.log('collisions');
S = live(mk()); park(S);
S.discs[0].x = 300; S.discs[0].y = 310; S.discs[2].x = 380; S.discs[2].y = 310; S.ball.x = 900; S.ball.y = 100;
Sim.setPlan(S, 0, 0, 1, 0); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true);
run(S, 0.12);
check('a hit passes the momentum on (the struck bobble moves, the striker slows)', S.discs[2].vx > 600 && S.discs[0].vx < S.discs[2].vx, `${S.discs[0].vx.toFixed(0)} / ${S.discs[2].vx.toFixed(0)}`);
check('equal bobbles swap speed almost entirely', S.discs[2].vx > 0.8 * C.MAXV * 0.9);
check('and the hit was announced', Sim.takeEvents(S).some((e) => e[0] === 'hit'));
S = live(mk()); park(S);
S.ball.x = 600; S.ball.y = 310; S.discs[0].x = 500; S.discs[0].y = 310;
Sim.setPlan(S, 0, 0, 1, 0); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true);
run(S, 0.1);
check('a bobble hitting the ball sends it flying faster than itself', S.ball.vx > S.discs[0].vx && S.ball.vx > 1000, S.ball.vx.toFixed(0));
check('and a ball hit is announced as a kick', Sim.takeEvents(S).some((e) => e[0] === 'kick'));

console.log('walls and posts');
S = live(mk()); park(S); S.ball.x = 500; S.ball.y = 20; S.ball.vy = -900;
S.discs[0].x = 100; S.discs[0].y = 200;
Sim.setPlan(S, 0, 0, 0, -1); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true);
run(S, 0.15);
check('the ball bounces off the top line', S.ball.y >= S.ball.r && S.ball.vy > 0, `${S.ball.y.toFixed(1)} ${S.ball.vy.toFixed(0)}`);
check('a bobble flicked into the touchline stays on the pitch', (run(S, 1.5), S.discs.every((q) => inside(q))));
S = live(mk()); park(S); S.ball.x = 30; S.ball.y = 100; S.ball.vx = -800;
S.discs[0].x = 300; S.discs[0].y = 500;
Sim.setPlan(S, 0, 0, 0, 1); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true);
run(S, 0.2);
check('the ball bounces off the end line outside the posts', S.ball.x >= S.ball.r && S.ball.vx > 0);
S = live(mk()); park(S); S.ball.x = 60; S.ball.y = C.GY0; S.ball.vx = -400;
S.discs[0].x = 300; S.discs[0].y = 500;
Sim.setPlan(S, 0, 0, 0, 1); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true);
run(S, 0.3);
check('a shot at the post is deflected, not through it', S.ball.x > 0 || S.ball.y < C.GY0 - 2 || S.ball.vx !== -400, `${S.ball.x.toFixed(0)},${S.ball.y.toFixed(0)}`);

console.log('goals');
const shootBall = (S, bx, by, vx, vy) => { park(S); S.ball.x = bx; S.ball.y = by; S.ball.vx = vx; S.ball.vy = vy; Sim.setPlan(S, 0, 0, 1, 0); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true); };
S = live(mk()); shootBall(S, C.W - 120, C.H / 2, 1200, 0);
run(S, 0.5);
check('the ball crossing the right goal line scores for cyan', S.score[0] === 1 && S.score[1] === 0 && S.phase === 'goal' && S.lastGoal === 0, `${S.score} ${S.phase}`);
check('the goal was announced', Sim.takeEvents(S).some((e) => e[0] === 'goal' && e[1] === 0));
run(S, C.GOAL_PAUSE + 0.1);
check('after the celebration the pitch is reset for a new round of planning', S.phase === 'plan' && S.ball.x === C.W / 2 && S.ball.y === C.H / 2 && S.discs[0].x === 70 && S.round === 2);
S = live(mk()); shootBall(S, 150, C.H / 2, -1300, 0);
run(S, 0.5);
check('the left goal scores for magenta', S.score[1] === 1 && S.score[0] === 0);
S = live(mk()); shootBall(S, 150, C.GY1 + 60, -1300, 0);
run(S, 0.8);
check('a ball past the end line outside the posts is not a goal', S.score[0] + S.score[1] === 0);
S = live(mk()); S.score = [2, 0]; shootBall(S, C.W - 120, C.H / 2, 1200, 0);
run(S, 0.5 + C.GOAL_PAUSE + 0.2);
check('the third goal wins the match', S.phase === 'over' && S.winner === 0 && Sim.takeEvents(S).some((e) => e[0] === 'end' && e[1] === 0));

console.log('the clock');
S = live(mk([0, 1], { seconds: 2 }));
S.score = [1, 0];
run(S, 2.2);
check('the clock runs while planning, and when it ends the leader wins', S.phase === 'over' && S.winner === 0, `${S.phase} ${S.winner}`);
S = live(mk([0, 1], { seconds: 2 }));
run(S, 2.2); park(S);
check('a tie goes to sudden death', S.phase === 'plan' && S.ot && Sim.takeEvents(S).some((e) => e[0] === 'ot'));
S.ball.x = C.W - 120; S.ball.y = C.H / 2; S.ball.vx = 1200; S.ball.vy = 0;
Sim.setPlan(S, 0, 0, 1, 0); Sim.setReady(S, 0, true); Sim.setReady(S, 1, true);
run(S, 0.5 + C.GOAL_PAUSE + 0.2);
check('and the next goal wins it', S.phase === 'over' && S.winner === 0);
Sim.restart(S);
check('restart puts it all back', S.phase === 'countdown' && S.score[0] + S.score[1] === 0 && !S.ot && S.winner === -1 && S.clock === 2 && S.discs[0].x === 70 && S.round === 0);

console.log('team names and mascots');
S = mk();
check('teams start as CYAN and MAGENTA with different mascots', S.teams[0].name === 'CYAN' && S.teams[1].name === 'MAGENTA' && S.teams[0].mascot !== S.teams[1].mascot);
Sim.setTeam(S, 0, 'Fire Foxes', 3);
check('a team can be renamed and given a mascot, names are tidied to capitals', S.teams[0].name === 'FIRE FOXES' && S.teams[0].mascot === 3);
Sim.setTeam(S, 1, '  <b>hax</b>\n\u0000   ' + 'x'.repeat(40), 99);
check('odd characters are stripped, the length is capped and a bad mascot is ignored', S.teams[1].name.length <= C.NAME_MAX && !/[<>\n\u0000]/.test(S.teams[1].name) && S.teams[1].mascot === 1, S.teams[1].name);
Sim.setTeam(S, 1, '   ');
check('an empty name falls back to the default', S.teams[1].name === 'MAGENTA');
Sim.setTeam(S, 0, undefined, 5.5); Sim.setTeam(S, 0, undefined, -1); Sim.setTeam(S, 0, undefined, '4');
check('mascots must be whole numbers in range', S.teams[0].mascot === 3);
Sim.restart(S);
check('a restart keeps the names', S.teams[0].name === 'FIRE FOXES');

console.log('snapshots');
S = live(mk([0, 1, 0, 1])); Sim.setTeam(S, 0, 'Foxes', 0);
Sim.setPlan(S, 0, 0, 0.7, 0.2); Sim.setReady(S, 0, true);
const snap = Sim.snapshot(S, [['goal', 0]]);
check('plans never go into a snapshot', !JSON.stringify(snap).includes('0.7') && !('plans' in snap) && !('p' in snap));
const v = Sim.parseSnapshot(JSON.parse(JSON.stringify(snap)));
check('a snapshot survives JSON and keeps the match state', v.ph === 'plan' && v.round === 1 && v.discs.length === 12 && v.score[0] === 0 && v.ev[0][0] === 'goal');
check('and who commands what and who has locked in', v.owners.length === 12 && v.owners[0] === 0 && v.owners[1] === 2 && v.ready.join() === '0');
check('team 0 is not locked (player 2 has not)', !v.locked[0] && v.teams[0].name === 'FOXES' && v.teams[1].name === 'MAGENTA');
Sim.setReady(S, 2, true);
check('the lock flag turns on when the whole team has locked in', Sim.parseSnapshot(Sim.snapshot(S)).locked[0] === 1);
check(`a full snapshot is small (${JSON.stringify(snap).length} bytes)`, JSON.stringify(snap).length < 650);
const a = Sim.parseSnapshot(snap); const b = JSON.parse(JSON.stringify(a)); b.ball.x += 100; b.discs[0].x += 100;
const mid = Sim.lerpView(a, b, 0.5);
check('interpolating between two views lands between them', Math.abs(mid.ball.x - (a.ball.x + 50)) < 1e-6 && Math.abs(mid.discs[0].x - (a.discs[0].x + 50)) < 1e-6);
check('the live view blends the last two steps', (() => { const w = Sim.view(S, 0.5); return Math.abs(w.discs[4].x - (S.discs[4].px + S.discs[4].x) / 2) < 1e-9; })());

console.log('chaos');
S = live(mk([0, 1, 0, 1, 0, 1]));
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let bad = '';
for (let round = 0; round < 80 && S.phase !== 'over' && !bad; round++) {
  if (S.phase === 'plan') {
    for (const d of S.discs) if (rnd() < 0.8) { const ang = rnd() * Math.PI * 2, pw = 0.2 + rnd() * 3; Sim.setPlan(S, S.owner[d.i], d.i, Math.cos(ang) * pw, Math.sin(ang) * pw); }
    lockAll(S);
  }
  for (let i = 0; i < 25 * 60 && (S.phase === 'roll' || S.phase === 'goal') && !bad; i++) {
    Sim.step(S);
    for (const q of S.discs.concat(S.ball)) {
      if (!isFinite(q.x + q.y + q.vx + q.vy)) bad = 'NaN';
      else if (q !== S.ball && !inside(q, 0.5)) bad = `disc ${q.i} off the pitch at ${q.x.toFixed(0)},${q.y.toFixed(0)}`;
      else if (q === S.ball && (q.x < -C.NET - 1 || q.x > C.W + C.NET + 1 || q.y < 0 || q.y > C.H)) bad = `ball out at ${q.x.toFixed(0)},${q.y.toFixed(0)}`;
    }
    if (S.phase === 'roll' && i === 25 * 60 - 1) bad = 'a round never ended';
  }
}
check(`${S.shots} random flicks over ${S.round} rounds, all twelve moving at once: nothing escapes, goes NaN or never stops` + (bad ? ` (${bad})` : ''), !bad && S.shots > 100);

// ====================================================================== arenas
// rate: 1000 makes an event certain whenever it's allowed; rate: 0.0001 keeps the arena's rules on but its random events off.
const arena = (map, sides = [0, 1], opts = {}) => Sim.create(Object.assign({ players: sides.map((side, id) => ({ id, side })), map, seed: 11, rate: 1000 }, opts));
const take = (S, name) => S.ev.filter((e) => e[0] === name);          // events so far (not drained)
const runTo = (S, phase, max = 60) => { for (let i = 0; i < max * 60 && S.phase !== phase; i++) Sim.step(S); return S.phase === phase; };
/** open round 1: the arena events can start in the very first round, so this is where they are */
const skipWarmup = (S) => live(S);
const sideOfPlayer = (S, pid) => (S.members[0].includes(pid) ? 0 : S.members[1].includes(pid) ? 1 : -1);
const flickOne = (S, pid, i, ax, ay) => { Sim.setPlan(S, pid, i, ax, ay); };
const travel = (map, power) => {
  const T = arena(map, [0, 1], { rate: 0 }); live(T); park(T);
  const d = T.discs[0]; d.x = 100; d.y = 310; d.px = d.x; d.py = d.y;
  const x0 = d.x; Sim.setPlan(T, 0, 0, power, 0); lockAll(T); settle(T);
  return d.x - x0;
};

console.log('arenas: the pitch feels different');
{
  const dist = Object.fromEntries(['classic', 'desert', 'rainforest', 'tundra'].map((m) => [m, travel(m, 0.5)]));
  check(`the same flick slides furthest on ice, then wet grass, then grass, least in sand (${Object.entries(dist).map(([k, v]) => k + ' ' + v.toFixed(0)).join(', ')})`,
    dist.tundra > dist.rainforest && dist.rainforest > dist.classic && dist.classic > dist.desert);
  check('an unknown map falls back to classic', arena('mars').map === 'classic');
  check('the stadium plays like the classic pitch', Math.abs(travel('stadium', 0.5) - dist.classic) < 1e-6);
  check('the classic map has no random events at all, however often they are asked for', (() => {
    const T = arena('classic'); skipWarmup(T);
    for (let r = 0; r < 12; r++) { lockAll(T); run(T, C.PLAN_TIME + 0.2); }
    const all = Sim.takeEvents(T).map((e) => e[0]);
    return !all.some((n) => ['heckle', 'storm', 'omen', 'bolt-warn', 'frost'].includes(n)) && !T.mini && !T.bales.length;
  })());
  check('nor does an arena with its events switched off (rate 0)', (() => {
    const T = arena('stadium', [0, 1], { rate: 0 }); skipWarmup(T);
    for (let r = 0; r < 10; r++) run(T, C.PLAN_TIME + 0.2);
    return !T.mini && !Sim.takeEvents(T).some((e) => e[0] === 'heckle');
  })());
}

console.log('arenas: the same seed plays out the same way');
{
  const play = (map, seed) => {
    const T = arena(map, [0, 1, 0, 1], { seed, rate: 1 }); live(T); const log = [];
    for (let n = 0; n < 40 * 60 * 3; n++) {
      if (T.phase === 'plan') { for (const d of T.discs) Sim.setPlan(T, T.owner[d.i], d.i, Math.cos(d.i * 2.1), Math.sin(d.i * 1.3)); lockAll(T); }
      if (T.phase === 'storm' && T.mini) for (const q of T.mini.who) Sim.miniDone(T, q, 2000 + q * 100);
      if (T.mini && !T.mini.race) Sim.miniDone(T, T.mini.pid, 3000);
      Sim.step(T); for (const e of Sim.takeEvents(T)) if (!['kick', 'hit', 'wall', 'post', 'c'].includes(e[0])) log.push(JSON.stringify(e));
    }
    return log.join('|') + '#' + T.discs.map((d) => d.x.toFixed(3)).join();
  };
  for (const m of ['stadium', 'desert', 'tundra', 'rainforest']) {
    check(`${m}: two runs with one seed are identical`, play(m, 5) === play(m, 5));
    check(`${m}: and other seeds give other matches`, new Set([1, 2, 3, 4].map((s) => play(m, s))).size > 1);
  }
}

console.log('stadium: an onlooker pelts a player');
{
  let S = skipWarmup(arena('stadium', [0, 1, 0, 1]));
  const h = take(S, 'heckle');
  check('in the very first round someone gets pelted', S.round === 1 && h.length === 1 && S.mini && S.mini.kind === 'scrub', JSON.stringify(h));
  const pid = S.mini.pid, side = S.mini.side, mate = side === 0 ? (pid === 0 ? 2 : 0) : (pid === 1 ? 3 : 1);
  const theirs = S.discs.filter((d) => S.pelt[d.i]).map((d) => d.i), own = mine(S, mate).filter((i) => !S.pelt[i]);
  check('three bobbles of the pelted player are marked, all on their team', theirs.length === 3 && theirs.every((i) => S.discs[i].side === side), theirs.join());
  check('their teammate takes them over: six bobbles to plan, the pelted player has none', mine(S, mate).length === 6 && mine(S, pid).length === 0 && theirs.every((i) => S.owner[i] === mate));
  check('the pelted player cannot plan them, the teammate can (all six)', theirs.every((i) => !Sim.setPlan(S, pid, i, 1, 0)) && mine(S, mate).every((i) => Sim.setPlan(S, mate, i, 0.4, 0.2)));
  check('the view says whose they are: carried, not stuck', (() => { const f = Sim.view(S, 1).fx; return f.pelt[theirs[0]] === 1 && f.block[theirs[0]] === 0 && f.mini.who[0] === pid && !S.hold.some(Boolean); })());
  check('the snapshot tells the guests which bobbles are carried', (() => { const f = Sim.parseSnapshot(JSON.parse(JSON.stringify(Sim.snapshot(S)))).fx; return f.pelt.filter(Boolean).length === 3 && theirs.every((i) => f.pelt[i] === 1) && f.mini.pid === undefined && f.mini.k === 'scrub'; })());
  check('the team has not locked in until the carrying teammate does', !Sim.parseSnapshot(Sim.snapshot(S)).locked[side]);
  Sim.setReady(S, mate, true);
  check('the pelted player does not hold the team up: the teammate alone locks the team in', Sim.parseSnapshot(Sim.snapshot(S)).locked[side] === 1);
  check('a player who is not pelted cannot free them', Sim.miniDone(S, mate, 5000) === false && !!S.mini);
  const free = Sim.miniDone(S, pid, 300);
  const end = take(S, 'mini-end')[0];
  check('finishing the minigame frees them (a too-fast claim counts as the minimum time)', free && !S.mini && end && end[1] === pid && end[2] === 1);
  check('and their bobbles go back to them', theirs.every((i) => S.owner[i] === pid) && own.every((i) => S.owner[i] === mate) && S.pelt.every((x) => !x));
  check('so the pelted player can plan again, the teammate keeps their own three', (Sim.setReady(S, mate, false), theirs.every((i) => Sim.setPlan(S, pid, i, 0.3, 0.3)) && !Sim.setPlan(S, mate, theirs[0], 1, 0) && Sim.setPlan(S, mate, own[0], 1, 0)));
  check('no second pelting straight after', (() => { const T = skipWarmup(arena('stadium', [0, 1])); Sim.miniDone(T, T.mini.pid, 4000); lockAll(T); return T.round === 2 && !T.mini; })());

  S = skipWarmup(arena('stadium', [0, 1, 0, 1]));
  const lost = S.mini.pid; let carried = S.discs.filter((d) => S.pelt[d.i]).map((d) => d.i);
  run(S, C.HECKLE_T - 0.5); check('still pelted just before the time limit', !!S.mini);
  run(S, 0.7);
  const to = take(S, 'mini-end')[0];
  check('nobody is out for ever: they are let go when the time runs out, bobbles back', !S.mini && to && to[1] === lost && to[2] === 0 && carried.every((i) => S.owner[i] === lost));

  S = skipWarmup(arena('stadium', [0, 1, 0, 1, 0, 1]));
  { const pd = S.mini.pid, before = S.discs.map((d) => d.i); const owners = S.owner.slice(), pelted = S.discs.filter((d) => S.pelt[d.i]).map((d) => d.i);
    const carriers = pelted.map((i) => S.owner[i]);
    check('three a side: the two teammates share the pelted bobbles, one each', pelted.length === 2 && carriers[0] !== carriers[1] && carriers.every((c) => c !== pd && sideOfPlayer(S, c) === S.mini.side));
    Sim.miniDone(S, pd, 3000);
    check('and when they are free again everything is as it was', S.owner.every((o, i) => S.pelt[i] === 0 && (pelted.includes(i) ? o === pd : true)) && S.discs.every((d) => !pelted.includes(d.i) || S.owner[d.i] === pd), String(S.owner)); }

  S = skipWarmup(arena('stadium', [0, 1]));
  const tm = S.mini.side, p1 = S.mini.pid, opp = 1 - p1;
  check('one v one: nobody can carry the pelted player, all six of their bobbles are stuck', mine(S, p1).filter((i) => S.discs[i].side === tm).length === 6 && mine(S, p1).filter((i) => S.discs[i].side === tm).every((i) => S.hold[i] && Sim.view(S, 1).fx.block[i] === 2));
  mine(S, opp).forEach((i) => Sim.setPlan(S, opp, i, 0.3, 0.1)); Sim.setReady(S, opp, true);
  check('and the other team can still play: the round starts without them', S.phase === 'roll');

  S = skipWarmup(arena('stadium', [0, 1, 0]));
  { const side0 = S.mini.side === 0;
    check('two v one: the pair share the carrying when one is pelted, a lone player pelted is stuck', side0 ? S.pelt.some(Boolean) && !S.hold.some(Boolean) : S.hold.filter(Boolean).length === 6); }

  S = skipWarmup(arena('stadium', [0, 1, 0, 1]));
  const gone = S.mini.pid, goneDiscs = S.discs.filter((d) => S.pelt[d.i]).map((d) => d.i); Sim.removePlayer(S, gone);
  check('if the pelted player leaves the room, nothing is left stuck or marked', !S.mini && S.hold.every((x) => !x) && S.pelt.every((x) => !x) && goneDiscs.every((i) => S.owner[i] !== gone && S.owner[i] >= 0));

  S = skipWarmup(arena('stadium', [0]));
  check('solo test: one team is pelted, the other is not', S.mini && S.hold.filter(Boolean).length === 6);

  S = skipWarmup(arena('stadium', [0, 1, 0, 1]));
  { const mate2 = S.owner[S.discs.findIndex((d) => S.pelt[d.i])];
    check('the carrying teammate must lock in again, so they notice the extra bobbles', !S.ready[mate2]); }
}

console.log('desert: the sandstorm race');
{
  let S = skipWarmup(arena('desert', [0, 1, 0, 1]));
  check('the first round opens with a sandstorm instead of planning', S.phase === 'storm' && S.mini.kind === 'dig' && S.mini.race && S.mini.who.length === 4 && take(S, 'storm').length === 1);
  check('nobody can plan during the storm', Sim.setPlan(S, 0, 0, 1, 0) === false && S.phase === 'storm');
  const clock = S.clock; run(S, 1);
  check('and the match clock stands still', S.clock === clock);
  check('a claim from someone who is not in the race is ignored', Sim.miniDone(S, 9, 3000) === false);
  Sim.miniDone(S, 0, 3400); check('the first finisher does not win yet: others get a moment', S.phase === 'storm');
  Sim.miniDone(S, 3, 2600);
  check('a second claim from the same player is ignored', Sim.miniDone(S, 3, 1500) === false && S.mini.reports[3] === 2600);
  run(S, C.MINI_GRACE + 0.1);
  const end = take(S, 'storm-end')[0];
  check('the quickest time wins, not the first message to arrive', end && end[1] === 3 && end[2] === 1, JSON.stringify(end));
  check('then planning opens and the losers (team 0) are locked in place', S.phase === 'plan' && S.frozen === 0 && S.discs.filter((d) => d.side === 0).every((d) => Sim.view(S, 1).fx.block[d.i] === 4));
  check('their plans are refused, the winners\' are fine', mine(S, 0).every((i) => !Sim.setPlan(S, 0, i, 1, 0)) && mine(S, 1).every((i) => Sim.setPlan(S, 1, i, 0.2, 0)));
  Sim.setReady(S, 1, true); Sim.setReady(S, 3, true);
  check('only the winning team has to lock in for the round to start', S.phase === 'roll');
  settle(S);
  check('the next round the lock is gone', S.frozen === -1 && (S.phase === 'plan' || S.phase === 'storm') && S.discs.every((d) => Sim.view(S, 1).fx.block[d.i] === 0 || S.phase === 'storm'));

  S = skipWarmup(arena('desert', [0, 1]));
  Sim.miniDone(S, 0, 1500); Sim.miniDone(S, 1, 800);
  run(S, C.MINI_GRACE + 0.1);
  check('claims under 1.2 s count as 1.2 s: 800 ms still wins against 1500 ms, as 1200', S.phase === 'plan' && S.frozen === 0);
  S = skipWarmup(arena('desert', [0, 1])); Sim.miniDone(S, 1, 900); Sim.miniDone(S, 0, 1100); run(S, 0.1);
  check('a tie at the minimum goes to whoever reported first (claiming 0 buys nothing)', S.frozen === 0);
  S = skipWarmup(arena('desert', [0, 1])); Sim.miniDone(S, 0, 2000); Sim.miniDone(S, 1, 2500);
  check('when everybody has finished it resolves at once, not after the grace', (run(S, 0.05), S.phase !== 'storm') && S.frozen === 1);
  S = skipWarmup(arena('desert', [0, 1]));
  run(S, C.STORM_T + 0.3);
  check('if nobody gets out, the storm ends and nobody is locked', S.phase === 'plan' && S.frozen === -1 && take(S, 'storm-end')[0][1] === -1);
  S = skipWarmup(arena('desert', [0, 1]));
  Sim.removePlayer(S, 1); Sim.miniDone(S, 0, 3000); run(S, 1);
  check('a player leaving mid-storm does not stall it, and a lone player locks nobody out', S.phase === 'plan' && S.frozen === -1);
  S = skipWarmup(arena('desert', [0]));
  Sim.miniDone(S, 0, 2000); run(S, 0.1);
  check('solo test: the race runs but nobody is locked out', S.phase === 'plan' && S.frozen === -1);
  check('a storm is never followed by another on the next round', (() => {
    const T = skipWarmup(arena('desert', [0, 1])); Sim.miniDone(T, 0, 2000); Sim.miniDone(T, 1, 2100); run(T, 0.1);
    lockAll(T);
    return T.round === 2 && T.phase === 'plan';
  })());
  check('the snapshot carries the storm to the guests', (() => { const T = skipWarmup(arena('desert', [0, 1])); const m = Sim.parseSnapshot(JSON.parse(JSON.stringify(Sim.snapshot(T)))); return m.ph === 'storm' && m.fx.map === 'desert' && m.fx.mini.k === 'dig' && m.fx.mini.race && m.fx.mini.who.length === 2 && m.fx.mini.t > 9; })());
}

console.log('desert: hay bales');
{
  const calm = (T) => { if (T.phase === 'storm') run(T, C.STORM_T + 0.3); return T; };
  let S = calm(skipWarmup(arena('desert', [0, 1])));
  check('bales are announced during planning', Array.isArray(S.omen) && S.omen.length >= 1 && S.omen.every((o) => o.x >= 140 && o.x <= 860), JSON.stringify(S.omen));
  const vm = Sim.parseSnapshot(JSON.parse(JSON.stringify(Sim.snapshot(S))));
  check('and the guests are told where from', vm.fx.omen.length === S.omen.length && 'x' in vm.fx.omen[0]);
  const n = S.omen.length;
  Sim.setPlan(S, 0, 0, 0.1, 0); lockAll(S);
  check('when the flicks happen the bales roll in', S.phase === 'roll' && S.bales.length === n && S.omen === null && take(S, 'bales').length === 1);
  let seen = false, bad = '';
  for (let i = 0; i < 30 * 60 && S.phase === 'roll'; i++) {
    Sim.step(S);
    for (const b of S.bales) { if (!isFinite(b.x + b.y)) bad = 'NaN'; if (b.wait <= 0 && b.y > 0 && b.y < C.H) seen = true; }
    for (const q of S.discs) if (!inside(q, 0.5)) bad = 'a bobble left the pitch';
  }
  check('bales cross the pitch, leave it, and the round ends', seen && !bad && S.bales.length === 0 && S.phase !== 'roll', bad);

  S = calm(skipWarmup(arena('desert', [0, 1], { rate: 0.0001 })));      // events effectively off: set one by hand
  live(S); S.omen = [{ x: 500, from: 1, vx: 0, v: 480, d: 0 }];
  park(S); const target = S.discs[5]; target.x = 500; target.y = 330; target.px = 500; target.py = 330;
  const y0 = target.y; Sim.setPlan(S, 0, 0, 0.05, 0); lockAll(S);
  settle(S, 30);
  check('a bale is heavy: a bobble in its way is knocked off', Math.abs(target.y - y0) > 40, `moved ${(target.y - y0).toFixed(1)}`);
  check('a bale never lands in the goal mouth by itself or outlives the round', S.bales.length === 0);
  S = calm(skipWarmup(arena('desert', [0, 1], { rate: 0.0001 }))); live(S);
  S.omen = [{ x: 300, from: 1, vx: 80, v: 400, d: 0.5 }]; park(S); Sim.setPlan(S, 0, 0, 0.1, 0); lockAll(S);
  check('a bale with a delay waits off the pitch first, and keeps the round going', S.bales[0].wait > 0 && (run(S, 0.3), S.phase === 'roll' && S.bales[0].wait > 0));
  check('a goal clears the bales', (() => { const T = calm(skipWarmup(arena('desert', [0, 1]))); live(T); Sim.setPlan(T, 0, 0, 0.1, 0); lockAll(T); T.ball.x = C.W + 30; T.ball.y = 300; run(T, 0.1); return T.phase === 'goal' && T.bales.length === 0; })());
}

console.log('tundra: ice, snowstorms and frostbite');
{
  let S = skipWarmup(arena('tundra', [0, 1]));
  check('the tundra has the same race as the desert, with a different minigame', S.phase === 'storm' && S.mini.kind === 'shake');
  Sim.miniDone(S, 0, 2000); Sim.miniDone(S, 1, 2500); run(S, 0.1);
  check('and the winner\'s team plays alone for the round', S.phase === 'plan' && S.frozen === 1);

  const quiet = () => { const T = Sim.create({ players: [{ id: 0, side: 0 }, { id: 1, side: 1 }], map: 'tundra', seed: 3, rate: 0.0001 }); live(T); return T; };
  S = quiet();
  const round = (T) => { Sim.setPlan(T, 0, 0, 0, -0.1); lockAll(T); settle(T, 40); };       // only bobble 0 ever moves
  round(S); round(S);
  check('two rounds without moving is fine', S.frost.every((f) => f === 0) && S.idle[5] === 2);
  round(S);
  check('the third round of sitting still gives frostbite (but not to the bobble that moved)', S.frost[5] === 1 && S.frost[11] === 1 && S.frost[0] === 0 && take(S, 'frost').length >= 10);
  round(S); check('each further idle round makes it worse', S.frost[5] === 2);
  round(S); check('until it is frozen solid', S.frost[5] === 3);
  check('a frozen bobble can\'t be flicked and the view says so', Sim.setPlan(S, 0, 5, 1, 0) === false && Sim.view(S, 1).fx.block[5] === 3);
  check('the others still can (so the lock-in still works)', Sim.setPlan(S, 0, 0, 0, -0.1) === true);
  check('the snapshot shows who is cold and who is about to be', (() => { const m = Sim.parseSnapshot(JSON.parse(JSON.stringify(Sim.snapshot(S)))); return m.fx.frost[5] === 3 && m.fx.idle[5] >= 5 && m.fx.frost[0] === 0; })());

  const T = quiet();
  const speed = (frost) => { const U = quiet(); park(U); U.discs[3].x = 300; U.discs[3].y = 300; U.frost[3] = frost; Sim.setPlan(U, 0, 3, 0, -1); lockAll(U); return Math.hypot(U.discs[3].vx, U.discs[3].vy); };
  const [s0, s1, s2] = [speed(0), speed(1), speed(2)];
  check(`frostbite weakens the flick (${s0.toFixed(0)} > ${s1.toFixed(0)} > ${s2.toFixed(0)})`, s0 > s1 && s1 > s2 && s2 > 0);
  const run2 = (frost) => { const U = quiet(); park(U); U.discs[3].x = 300; U.discs[3].y = 400; U.frost[3] = frost; Sim.setPlan(U, 0, 3, 0, -0.1); lockAll(U); const y = U.discs[3].y; settle(U, 40); return y - U.discs[3].y; };
  check('and it slides less far, because the cold slows it', run2(0) > run2(1) && run2(1) > run2(2));

  S = quiet();
  for (let r = 0; r < 5; r++) round(S);
  check('(frozen again)', S.frost[6] === 3);
  park(S); const ice = S.discs[6]; ice.x = 600; ice.y = 300; ice.px = ice.x; ice.py = ice.y;
  const hitter = S.discs[0]; hitter.x = 400; hitter.y = 300; hitter.px = hitter.x; hitter.py = hitter.y;
  Sim.setPlan(S, 0, 0, 1, 0); lockAll(S); settle(S, 40);
  check('a hit from another bobble thaws a frozen one a little', S.frost[6] === 2 && S.idle[6] === 0, `frost ${S.frost[6]}`);
  check('and a goal wipes the frostbite out', (() => { const U = quiet(); for (let r = 0; r < 4; r++) round(U); const had = U.frost[5]; Sim.setPlan(U, 0, 0, 0, -0.1); lockAll(U); U.ball.x = C.W + 30; U.ball.y = 300; run(U, 0.1); return had > 0 && U.frost.every((f) => f === 0) && U.idle.every((f) => f === 0); })());
  check('frostbite is a tundra thing: the other arenas never freeze anything', ['classic', 'stadium', 'desert', 'rainforest'].every((m) => { const U = Sim.create({ players: [{ id: 0, side: 0 }, { id: 1, side: 1 }], map: m, seed: 3, rate: 0.0001 }); live(U); for (let r = 0; r < 5; r++) round(U); return U.frost.every((f) => f === 0); }));
}

console.log('rainforest: lightning');
{
  let S = skipWarmup(arena('rainforest', [0, 1, 0, 1]));
  for (let i = 0; i < 600 && !S.bolt; i++) Sim.step(S);
  const warn = take(S, 'bolt-warn')[0];
  check('lightning is announced before it strikes, at the spot it will hit', S.bolt && warn && warn[1] === S.bolt.x && warn[2] === S.bolt.y && S.bolt.t > 0.5);
  check('and the guests can see the warning', (() => { const m = Sim.parseSnapshot(JSON.parse(JSON.stringify(Sim.snapshot(S)))); return m.fx.bolt && m.fx.bolt.x === S.bolt.x; })());
  S.rate = 0.0001;                                                      // one strike only
  const bx = S.bolt.x, by = S.bolt.y;
  const dists = S.discs.map((d) => Math.hypot(d.x - bx, d.y - by)), nearest = dists.indexOf(Math.min(...dists));
  Sim.setPlan(S, S.owner[nearest], nearest, 0.5, 0.5);
  run(S, C.BOLT_WARN + 0.1);
  const hit = take(S, 'bolt')[0];
  check('the strike stuns the closest bobble (and anything right next to it, at most three)', hit && hit[3].includes(nearest) && hit[3].length >= 1 && hit[3].length <= C.STUN_MAX, JSON.stringify(hit));
  check('stunned bobbles are stuck for 10 seconds and lose any plan', hit[3].every((i) => S.stun[i] > C.STUN - 0.3 && S.plans[i] === null && !Sim.setPlan(S, S.owner[i], i, 1, 0)));
  check('and the view counts them down', hit[3].every((i) => { const f = Sim.view(S, 1).fx; return f.block[i] === 1 && f.stun[i] > 9; }));
  const stunned = hit[3][0];
  run(S, 5); check('five seconds later they are still stunned', S.stun[stunned] > 4 && S.stun[stunned] < 5.2, S.stun[stunned].toFixed(2));
  run(S, 5.2);
  check('ten seconds after the strike they can be planned again', S.stun[stunned] === 0 && (S.phase !== 'plan' || Sim.setPlan(S, S.owner[stunned], stunned, 0.3, 0.3) === true));
  check('only one strike was fired', take(S, 'bolt').length === 1);

  S = skipWarmup(arena('rainforest', [0, 1]));
  for (let i = 0; i < 600 && !S.bolt; i++) Sim.step(S);
  S.rate = 0.0001; const rolling = S.discs[7]; rolling.vx = 300; rolling.vy = 100; S.bolt = { x: rolling.x, y: rolling.y, t: 0.01 };
  run(S, 0.05);
  check('a stunned bobble stops dead', S.stun[7] > 0 && S.discs[7].vx === 0 && S.discs[7].vy === 0);
  check('lightning only happens in the rainforest', ['classic', 'stadium', 'desert', 'tundra'].every((m) => { const U = skipWarmup(arena(m, [0, 1])); if (U.phase === 'storm') run(U, 11); run(U, 15); return !U.bolt && U.stun.every((x) => x === 0); }));
  check('lightning comes early: the first strike is announced within about six seconds of play', (() => { const U = Sim.create({ players: [{ id: 0, side: 0 }, { id: 1, side: 1 }], map: 'rainforest', seed: 3 }); live(U); run(U, 6); return Sim.takeEvents(U).some((e) => e[0] === 'bolt-warn'); })());
  check('and keeps coming: at least three strikes in a minute of play, whatever the seed', [1, 2, 3, 4, 5].every((sd) => { const U = Sim.create({ players: [{ id: 0, side: 0 }, { id: 1, side: 1 }], map: 'rainforest', seed: sd }); live(U); let n = 0; for (let i = 0; i < 60 * 60; i++) { if (U.phase === 'plan') { Sim.setPlan(U, 0, 0, 0.1, 0); lockAll(U); } Sim.step(U); n += Sim.takeEvents(U).filter((e) => e[0] === 'bolt-warn').length; } return n >= 3; }));
  S = skipWarmup(arena('rainforest', [0, 1]));
  for (let i = 0; i < 600 && !S.bolt; i++) Sim.step(S);
  S.rate = 0.0001; Sim.setReady(S, 1, true); for (const d of S.discs) if (d.side === 0) { S.bolt.x = d.x; S.bolt.y = d.y; }
  mine(S, 0).forEach((i) => { S.stun[i] = 5; });
  check('a team whose bobbles are all stunned does not hold the round up', Sim.parseSnapshot(Sim.snapshot(S)).locked[0] === 1);
}

console.log('arenas: snapshots and chaos');
{
  check('a classic snapshot is no bigger than before', JSON.stringify(Sim.snapshot(live(mk()))).length < 400 && !('mp' in Sim.snapshot(mk())));
  for (const m of ['stadium', 'desert', 'tundra', 'rainforest']) {
    const T = skipWarmup(arena(m, [0, 1, 0, 1]));
    check(`${m}: an arena snapshot with an event running is still small (${JSON.stringify(Sim.snapshot(T)).length} bytes)`, JSON.stringify(Sim.snapshot(T)).length < 800);
  }
  const a = Sim.parseSnapshot(JSON.parse(JSON.stringify(Sim.snapshot(skipWarmup(arena('desert', [0, 1]))))));
  const b = JSON.parse(JSON.stringify(a)); b.fx.bales = [{ x: 100, y: 100, r: 34 }]; a.fx.bales = [{ x: 0, y: 0, r: 34 }];
  check('bales are interpolated between snapshots', Math.abs(Sim.lerpView(a, b, 0.5).fx.bales[0].x - 50) < 1e-9);
  const c = JSON.parse(JSON.stringify(b)); c.fx.bales = [];
  check('and a different number of bales does not break the blend', Sim.lerpView(b, c, 0.5).fx.bales.length === 0 && Sim.lerpView(c, b, 0.5).fx.bales.length === 1);

  for (const m of ['stadium', 'desert', 'tundra', 'rainforest']) {
    const T = arena(m, [0, 1, 0, 1, 0, 1], { seed: 21, rate: 4 }); live(T);
    let sd = 99; const rn = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    let bad = '', stuck = 0, ticks = 0, events = 0;
    for (let n = 0; n < 60 * 60 * 6 && T.phase !== 'over' && !bad; n++) {
      ticks++;
      if (T.phase === 'plan') {
        for (const d of T.discs) if (rn() < 0.8) { const ang = rn() * 6.28, pw = 0.2 + rn() * 3; Sim.setPlan(T, T.owner[d.i], d.i, Math.cos(ang) * pw, Math.sin(ang) * pw); }
        lockAll(T);
      }
      if (T.mini && rn() < 0.01) for (const q of T.mini.who) if (rn() < 0.7) Sim.miniDone(T, q, 1000 + rn() * 4000);
      if (rn() < 0.0005 && T.members[0].length > 1) { /* nobody leaves in this run */ }
      Sim.step(T);
      events += Sim.takeEvents(T).filter((e) => ['heckle', 'storm', 'bolt', 'bales', 'frost'].includes(e[0])).length;
      for (const q of T.discs.concat(T.ball)) {
        if (!isFinite(q.x + q.y + q.vx + q.vy)) bad = 'NaN';
        else if (q !== T.ball && !inside(q, 0.5)) bad = `disc ${q.i} off the pitch at ${q.x.toFixed(0)},${q.y.toFixed(0)}`;
        else if (q === T.ball && (q.x < -C.NET - 1 || q.x > C.W + C.NET + 1 || q.y < 0 || q.y > C.H)) bad = `ball out at ${q.x.toFixed(0)},${q.y.toFixed(0)}`;
      }
      stuck = T.phase === 'roll' ? stuck + 1 : 0;
      if (stuck > 30 * 60) bad = 'a round never ended';
    }
    check(`${m}: ${T.shots} random flicks, ${events} random events, ${T.round} rounds: nothing escapes, goes NaN, or never ends` + (bad ? ` (${bad})` : ''), !bad && T.shots > 50 && events > 3);
  }
}

// ====================================================================== stadium sizes and formations
console.log('sizes: local 3 v 3, little league 4 v 4, premier league 5 v 5');
{
  const sized = (size, sides = [0, 1], opts = {}) => Sim.create(Object.assign({ players: sides.map((side, id) => ({ id, side })), size }, opts));
  const G = Object.fromEntries(Sim.SIZES.map((z) => [z, Sim.geo(z)]));
  const share = (T) => { const c = {}; T.discs.forEach((d) => { c[T.owner[d.i]] = (c[T.owner[d.i]] || 0) + 1; }); return c; };
  check('the menu offers exactly three sizes, smallest first', Sim.SIZES.join() === 'local,little,premier');
  check('teams of 3, 4 and 5', G.local.n === 3 && G.little.n === 4 && G.premier.n === 5);
  const area = (g) => g.W * g.H;
  check('each stadium is significantly bigger than the last (at least 2x, then 1.7x the area)', area(G.little) > 2 * area(G.local) && area(G.premier) > 1.7 * area(G.little), Sim.SIZES.map((z) => area(G[z])).join());
  check('an unknown size falls back to the standard pitch', sized('mars').size === 'standard' && sized(undefined).n === 6 && sized(undefined).g.W === C.W);
  for (const z of Sim.SIZES) {
    const g = G[z], n = g.n;
    let T = sized(z);
    check(`${z}: ${n} bobbles a side, ball in the middle, goal mouth centred`, T.discs.length === 2 * n && T.discs.filter((d) => d.side === 0).length === n && T.ball.x === g.W / 2 && T.ball.y === g.H / 2 && g.GY0 + g.GY1 === g.H);
    for (const f of Sim.formsFor(n)) {
      T = sized(z); Sim.setFormation(T, 0, f.id); Sim.setFormation(T, 1, f.id); Sim.restart(T);
      const a = T.discs.concat(T.ball);
      let bad = '';
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== T.ball && !(a[i].x >= a[i].r && a[i].x <= g.W - a[i].r && a[i].y >= a[i].r && a[i].y <= g.H - a[i].r)) bad = 'off the pitch';
        if (a[i] !== T.ball && (a[i].side === 0 ? a[i].x >= g.W / 2 : a[i].x <= g.W / 2)) bad = 'on the wrong half';
        for (let j = i + 1; j < a.length; j++) if (Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y) < a[i].r + a[j].r + 4) bad = `overlap ${i}/${j}`;
      }
      check(`${z} / ${f.name} (${f.shape}): everyone fits, on their own half, nobody overlaps`, !bad, bad);
    }
    T = sized(z);
    check(`${z}: the second team is the first team's mirror image`, T.discs.slice(0, n).every((d, k) => T.discs[n + k].x === g.W - d.x && T.discs[n + k].y === d.y));
    const sh = share(T);
    check(`${z}: 1 v 1, each player commands the whole team`, sh[0] === n && sh[1] === n);
    // a full-power flick should be able to cross most of the pitch, whatever its size
    T = sized(z); live(T); park(T);
    const d = T.discs[0]; d.x = 60; d.y = g.H / 2; d.px = d.x; d.py = d.y; T.ball.x = g.W - 40; T.ball.y = 40;
    Sim.setPlan(T, 0, 0, 1, 0); lockAll(T); settle(T);
    check(`${z}: one full-power flick carries a bobble over 55% of the pitch length`, d.x - 60 > 0.55 * g.W, `${(d.x - 60).toFixed(0)} of ${g.W}`);
    // a goal still counts
    T = sized(z); live(T); park(T); T.ball.x = g.W - 120; T.ball.y = g.H / 2; T.ball.vx = 1200;
    Sim.setPlan(T, 0, 0, 1, 0); lockAll(T); run(T, 0.6);
    check(`${z}: a shot into the right goal scores for team 0`, T.score[0] === 1 && T.phase === 'goal', `${T.phase} ${T.score}`);
    T = sized(z); live(T); park(T); T.ball.x = 100; T.ball.y = g.H / 2; T.ball.vx = -1200;
    Sim.setPlan(T, 0, 0, 1, 0); lockAll(T); run(T, 0.6);
    check(`${z}: and into the left goal for team 1`, T.score[1] === 1 && T.phase === 'goal', `${T.phase} ${T.score}`);
    T = sized(z, [0, 1, 0, 1, 0, 1, 0, 1]);
    check(`${z}: with 4 players a side nobody commands more than their share`, Object.values(share(T)).every((v) => v <= Math.ceil(n / 4) + 1));
    const snp = Sim.snapshot(live(sized(z, [0, 1, 0, 1])));
    const pv = Sim.parseSnapshot(JSON.parse(JSON.stringify(snp)));
    check(`${z}: the snapshot names the stadium (${JSON.stringify(snp).length} bytes) and the guests get the same view`, snp.sz === z && pv.size === z && pv.n === n && pv.discs.length === 2 * n && pv.discs.filter((q) => q.side === 0).length === n && pv.owners.length === 2 * n && JSON.stringify(snp).length < 600);
  }

  console.log('formations');
  let T = sized('little');
  check('every size has several formations to pick from, each with a spot for every bobble', [3, 4, 5].every((n) => Sim.formsFor(n).length >= 3 && Sim.formsFor(n).every((f) => f.pts.length === n && f.name && f.id)));
  check('and their ids are unique', [3, 4, 5].every((n) => new Set(Sim.formsFor(n).map((f) => f.id)).size === Sim.formsFor(n).length));
  check('the default formation is the first one', T.form[0] === Sim.formsFor(4)[0].id && T.form[1] === Sim.formsFor(4)[0].id);
  check('a made-up formation is refused', Sim.setFormation(T, 0, 'nonsense') === false && T.form[0] === Sim.formsFor(4)[0].id);
  const pos = (U) => U.discs.map((q) => `${q.x},${q.y}`).join('|');
  const before = pos(T), gl = Sim.geo('little');
  check('picking a formation is accepted', Sim.setFormation(T, 0, 'attack') === true && T.form[0] === 'attack' && T.form[1] === Sim.formsFor(4)[0].id);
  Sim.restart(T);
  check('it moves only that team at the next kick-off', pos(T) !== before && T.discs.slice(4).every((q, k) => q.x === gl.W - Math.round(Sim.formsFor(4)[0].pts[k][0] * gl.W)));
  check('an attacking line stands further up the pitch than a defensive one', (() => { const x = (id) => Math.max(...Sim.formsFor(4).find((f) => f.id === id).pts.map((q) => q[0])); return x('attack') > x('defend'); })());
  T = live(sized('little')); Sim.setFormation(T, 1, 'defend');
  T.ball.x = gl.W - 120; T.ball.y = gl.H / 2; T.ball.vx = 1400; park(T);
  Sim.setPlan(T, 0, 0, 1, 0); lockAll(T); run(T, 0.5 + C.GOAL_PAUSE + 0.2);
  check('after a goal both teams line up in their chosen formation again', T.phase === 'plan' && T.discs[4].x === gl.W - Math.round(Sim.formsFor(4).find((f) => f.id === 'defend').pts[0][0] * gl.W), `${T.phase} ${T.discs[4].x}`);
  T = sized('local'); Sim.setFormation(T, 0, 'attack'); Sim.setSize(T, 'premier');
  check("changing the stadium resets the formations to the new size's default", T.n === 5 && T.discs.length === 10 && T.form[0] === Sim.formsFor(5)[0].id);
  check('and a restart keeps the chosen formation', (Sim.setFormation(T, 1, 'defend'), Sim.restart(T), T.form[1] === 'defend'));

  console.log('events happen early and often');
  for (const map of ['stadium', 'desert', 'tundra', 'rainforest']) {
    let none = 0, late = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const U = Sim.create({ players: [{ id: 0, side: 0 }, { id: 1, side: 1 }], map, seed, size: 'little' });
      let first = -1;
      for (let i = 0; i < 30 * 60 && first < 0; i++) {
        if (U.phase === 'storm' && U.mini) for (const q of U.mini.who) Sim.miniDone(U, q, 2000);
        if (U.mini && !U.mini.race) Sim.miniDone(U, U.mini.pid, 2000);
        if (U.phase === 'plan' && U.t < 20) { Sim.setReady(U, 0, true); Sim.setReady(U, 1, true); }
        Sim.step(U);
        if (Sim.takeEvents(U).some((e) => ['heckle', 'storm', 'omen', 'bolt-warn'].includes(e[0]))) first = i / 60;
      }
      if (first < 0) none++; else if (first > 12) late++;
    }
    check(`${map}: in 60 matches every one had an event within 30 s, almost all within 12 s (none: ${none}, late: ${late})`, none === 0 && late <= 3);
  }

  console.log('sizes: chaos');
  for (const z of Sim.SIZES) {
    for (const m of ['classic', 'desert', 'rainforest']) {
      const g = G[z], T = sized(z, [0, 1, 0, 1, 0, 1], { map: m, seed: 5, rate: 2 }); live(T);
      let sd = 77; const rn = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
      let bad = '', stuck = 0;
      for (let k = 0; k < 60 * 60 * 3 && T.phase !== 'over' && !bad; k++) {
        if (T.phase === 'plan') { for (const d of T.discs) if (rn() < 0.8) { const a = rn() * 6.28, pw = 0.2 + rn() * 3; Sim.setPlan(T, T.owner[d.i], d.i, Math.cos(a) * pw, Math.sin(a) * pw); } lockAll(T); }
        if (T.mini) for (const q of T.mini.who) if (rn() < 0.02) Sim.miniDone(T, q, 1500);
        Sim.step(T); Sim.takeEvents(T);
        for (const q of T.discs.concat(T.ball)) {
          if (!isFinite(q.x + q.y + q.vx + q.vy)) bad = 'NaN';
          else if (q !== T.ball && !(q.x >= q.r - 0.5 && q.x <= g.W - q.r + 0.5 && q.y >= q.r - 0.5 && q.y <= g.H - q.r + 0.5)) bad = `disc ${q.i} off the pitch at ${q.x.toFixed(0)},${q.y.toFixed(0)}`;
          else if (q === T.ball && (q.x < -g.NET - 1 || q.x > g.W + g.NET + 1 || q.y < 0 || q.y > g.H)) bad = `ball out at ${q.x.toFixed(0)},${q.y.toFixed(0)}`;
        }
        stuck = T.phase === 'roll' ? stuck + 1 : 0;
        if (stuck > 30 * 60) bad = 'a round never ended';
      }
      check(`${z} / ${m}: ${T.shots} flicks over ${T.round} rounds: nothing escapes, goes NaN or never stops` + (bad ? ` (${bad})` : ''), !bad && T.shots > 40);
    }
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

console.log('a quiet first minute');
{
  C.FX_START = 60;
  const all = (T) => Sim.takeEvents(T).map((e) => e[0]);
  const fx = ['heckle', 'storm', 'omen', 'bolt-warn'];
  for (const map of ['stadium', 'desert', 'tundra', 'rainforest']) {
    const T = arena(map); live(T);
    let early = [], elapsed = () => T.seconds - T.clock;
    while (elapsed() < C.FX_START - 3 && !T.winner && T.score[0] + T.score[1] === 0) {
      lockAll(T); run(T, C.PLAN_TIME + 0.2); settle(T);
      early = early.concat(all(T));
    }
    check(`${map}: no event in the first minute (${elapsed().toFixed(0)} s played, ${T.round} rounds)`, !early.some((n) => fx.includes(n)) && !T.mini && !T.bales.length && !T.bolt && elapsed() > 30, early.filter((n) => fx.includes(n)).join());
    let late = [];
    for (let r = 0; r < 12 && !late.some((n) => fx.includes(n)); r++) { lockAll(T); run(T, C.PLAN_TIME + 0.2); settle(T); late = late.concat(all(T)); }
    check(`${map}: events start once the minute is up`, late.some((n) => fx.includes(n)), late.join());
  }
  C.FX_START = 0;
}
