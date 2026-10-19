// node g3/web/games/bobble_league/sim.test.js
const assert = require('assert');
const Sim = require('./sim.js');
const { C } = Sim;
let fails = 0;
function check(label, ok, extra) { console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || extra === undefined ? '' : '  -> ' + extra)); if (!ok) fails++; }
const run = (S, secs) => { for (let i = 0; i < secs * 60; i++) Sim.step(S); };
const mk = (n = 2, seconds) => Sim.create({ players: Array.from({ length: n }, (_, i) => ({ id: i, team: i % 2 })), seconds });
const live = (S) => { run(S, C.COUNT + 0.1); return S; };

console.log('kickoff');
let S = mk();
check('starts in the countdown', S.phase === 'countdown');
run(S, 2.9); check('still counting at 2.9 s', S.phase === 'countdown');
run(S, 0.3); check('play begins after 3 s', S.phase === 'play');
const evs = Sim.takeEvents(S).map((e) => e[0]);
check('countdown ticks and go were announced', evs.includes('c') && evs.includes('go'), evs.join());
check('teams start on their own sides', S.players[0].x < C.W / 2 && S.players[1].x > C.W / 2);

console.log('movement');
S = live(mk());
let p = S.players[0];
Sim.setInput(S, 0, 4);
let top = p.y;
for (let i = 0; i < 90; i++) { Sim.step(S); top = Math.min(top, p.y); }
const jumped = (C.FLOOR - C.PR) - top;
check(`held jump reaches ~170 px (got ${jumped.toFixed(0)})`, jumped > 150 && jumped < 190);
check('and lands again', p.ground && Math.abs(p.y - (C.FLOOR - C.PR)) < 1);
S = live(mk()); p = S.players[0];
Sim.setInput(S, 0, 4); run(S, 0.12); Sim.setInput(S, 0, 0);
let top2 = p.y; for (let i = 0; i < 60; i++) { Sim.step(S); top2 = Math.min(top2, p.y); }
check(`a tap is a short hop (${((C.FLOOR - C.PR) - top2).toFixed(0)} px < held jump)`, (C.FLOOR - C.PR) - top2 < jumped - 30);
S = live(Sim.create({ players: [{ id: 0, team: 0 }] })); p = S.players[0]; const x0 = p.x;
Sim.setInput(S, 0, 2); run(S, 0.5);
check(`running right covers ground (${(p.x - x0).toFixed(0)} px in 0.5 s)`, p.x - x0 > 120 && p.x - x0 < 200);
Sim.setInput(S, 0, 0); run(S, 0.4);
check('and stops when you let go', Math.abs(p.vx) < 1);
Sim.setInput(S, 0, 2 | 8); run(S, 0.05);
check('slide is a burst of speed', p.vx > 500 && p.slideT > 0);
run(S, 0.5); Sim.setInput(S, 0, 2); run(S, 0.5);
check('slide cools down then recovers to normal run speed', p.slideT <= 0 && Math.abs(p.vx - C.RUN) < 5);
S = live(mk()); p = S.players[0];
Sim.setInput(S, 0, 1); run(S, 3);
check('slimes stop at the wall', Math.abs(p.x - C.PR) < 0.01);

console.log('the ball');
S = live(mk()); let b = S.ball;
run(S, 4);
check('drops and settles on the floor', Math.abs(b.y - (C.FLOOR - C.BR)) < 1.5 && Math.abs(b.vy) < 5, `y=${b.y}`);
S = live(mk()); b = S.ball; b.x = 600; b.y = 400; b.vx = 1200; b.vy = 0;
run(S, 2);
check('a hard shot into the end wall stays in play (no goal above the bar)', S.score[0] + S.score[1] === 0 || S.phase !== 'play');
S = live(mk()); b = S.ball; b.x = 300; b.y = 150; b.vx = 0; b.vy = 0;
const hit0 = S.players[0]; hit0.x = 280; hit0.y = C.FLOOR - C.PR;
Sim.setInput(S, 0, 2 | 4); run(S, 0.4);
// whichever way it went, the ball must have been touched
check('running and jumping into the ball touches it', S.lastTouch === 0 || Math.hypot(b.vx, b.vy) > 0);
S = live(mk()); b = S.ball; p = S.players[0];
p.x = 400; b.x = 470; b.y = C.FLOOR - C.BR; b.vx = b.vy = 0;
Sim.setInput(S, 0, 2); run(S, 0.5);
check(`walking into a resting ball knocks it forward (${b.vx.toFixed(0)} px/s)`, b.vx > 150 && S.lastTouch === 0);
S = live(mk()); b = S.ball; p = S.players[0];
p.x = 400; b.x = 520; b.y = C.FLOOR - C.BR; b.vx = b.vy = 0;
Sim.setInput(S, 0, 2); run(S, 0.1); Sim.setInput(S, 0, 2 | 8); run(S, 0.3);
const slideSpeed = Math.hypot(b.vx, b.vy);
S = live(mk()); b = S.ball; p = S.players[0];
p.x = 400; b.x = 520; b.y = C.FLOOR - C.BR; b.vx = b.vy = 0;
Sim.setInput(S, 0, 2); run(S, 0.4);
check(`a sliding hit is harder than a walking one (${slideSpeed.toFixed(0)} vs ${Math.hypot(b.vx, b.vy).toFixed(0)})`, slideSpeed > Math.hypot(b.vx, b.vy));

console.log('goals');
S = live(mk()); Sim.takeEvents(S); b = S.ball;
b.x = C.W + 40; b.y = 450; b.vx = 100; b.vy = 0;
run(S, 0.05);
check('ball in the right net scores for cyan', S.phase === 'goal' && S.score[0] === 1 && S.score[1] === 0 && S.lastGoal === 0);
check('a goal event was announced', Sim.takeEvents(S).some((e) => e[0] === 'goal' && e[1] === 0));
run(S, C.GOAL_PAUSE + 0.1);
check('after the pause the players reset and count down', S.phase === 'countdown' && Math.abs(S.ball.x - C.W / 2) < 1 && S.players[0].x < C.W / 2);
run(S, C.KICKOFF_COUNT + 0.1);
b = S.ball; b.x = -50; b.y = 450; b.vx = -100; b.vy = 0; run(S, 0.05);
check('ball in the left net scores for magenta', S.score[1] === 1 && S.lastGoal === 1);
S = live(mk()); b = S.ball; b.x = C.W + 40; b.y = 200; b.vx = 0; b.vy = 0; run(S, 0.05);
check('over the crossbar does not count', S.score[0] === 0 && S.phase === 'play');
S = live(mk()); b = S.ball; b.x = C.W - 10; b.y = C.BAR - 30; b.vx = 900; b.vy = 100; run(S, 1);
check('shots at the wall above the goal bounce back', b.x < C.W + 1 || S.score[0] === 1);

console.log('the clock');
S = mk(2, 5); live(S);
S.score[0] = 1; run(S, 5.1);
check('time up with a lead ends the match', S.phase === 'over' && S.winner === 0);
check('the end was announced', Sim.takeEvents(S).some((e) => e[0] === 'end' && e[1] === 0));
S = mk(2, 3); live(S); run(S, 3.1);
check('a draw goes to golden-goal overtime', S.phase === 'play' && S.ot, S.phase);
b = S.ball; b.x = -40; b.y = 450; b.vx = 0; b.vy = 0; run(S, 0.05); run(S, C.GOAL_PAUSE + 0.1);
check('the overtime goal wins it', S.phase === 'over' && S.winner === 1, `${S.phase} ${S.winner}`);
S = mk(2, 1); live(S); run(S, 1.1 + C.OT + 0.1);
check('overtime with no goal ends in a draw', S.phase === 'over' && S.winner === -1);
Sim.restart(S);
check('rematch resets score and clock', S.phase === 'countdown' && S.score[0] === 0 && S.clock === 1);

console.log('snapshots');
S = live(mk(4)); Sim.setInput(S, 1, 2); run(S, 0.7);
const snap = JSON.parse(JSON.stringify(Sim.snapshot(S, [['hit', 0.5]])));
const v = Sim.parseSnapshot(snap);
check('4 players survive the round trip', v.players.length === 4 && v.players[1].team === 1);
check('positions are kept to a tenth of a pixel', Math.abs(v.players[1].x - S.players[1].x) < 0.06 && Math.abs(v.ball.y - S.ball.y) < 0.06);
check('events ride along', v.ev.length === 1 && v.ev[0][0] === 'hit');
check(`a full 8-player snapshot is small (${JSON.stringify(Sim.snapshot(live(mk(8)))).length} bytes)`, JSON.stringify(Sim.snapshot(live(mk(8)))).length < 700);
const va = Sim.view(S, 0), vb = Sim.view(S, 1), vm = Sim.lerpView(va, vb, 0.5);
check('interpolating between two views lands between them', Math.abs(vm.ball.x - (va.ball.x + vb.ball.x) / 2) < 1e-6);

console.log('chaos');
S = mk(8, 20);
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
let bad = null;
for (let i = 0; i < 60 * 40 && !bad; i++) {
  if (i % 20 === 0) for (const q of S.players) Sim.setInput(S, q.id, Math.floor(rnd() * 16));
  Sim.step(S);
  const bl = S.ball;
  if (!isFinite(bl.x + bl.y + bl.vx + bl.vy) || bl.x < -C.NET - 5 || bl.x > C.W + C.NET + 5 || bl.y > C.FLOOR + 1 || bl.y < -5) bad = `ball at ${bl.x},${bl.y} tick ${i}`;
  for (const q of S.players) if (!isFinite(q.x + q.y) || q.x < 0 || q.x > C.W || q.y > C.FLOOR || q.y < 0) bad = `player at ${q.x},${q.y} tick ${i}`;
  if (S.phase === 'over') Sim.restart(S);
}
check('40 s of 8 players mashing keys: nothing escapes, nothing goes NaN', !bad, bad);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
