// node g3/web/games/bobble_league/sim.test.js
const Sim = require('./sim.js');
const { C } = Sim;
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

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
