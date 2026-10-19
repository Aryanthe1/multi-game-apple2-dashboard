# Bobble League

Top-down tactics for 2-8 players, a bit like carrom or table football played with flicked discs. Every team is always
**six bobbles** and there is one ball. You never run around: each round you decide which way and how hard each of your bobbles
will be flicked, **both teams plan at the same time**, and then everything flies at once.

## Rules as built

* **Menu:** every match opens on the game menu. The host picks a gameplay style (guests wait and watch); only **Classic**
  exists so far, to add one add an entry to `MODES` at the top of `game.js` and it appears as a card. Then comes the team
  screen: each team's **captain** (its first player; alone in the room you are both captains) picks a **team name** (up to 12
  characters) and a **mascot** (12 to choose from, drawn on every bobble), then presses READY. The match starts when both
  captains are ready.
* **Fullscreen:** the game always fills the browser window, and asks for real fullscreen on arrival, on the first key press or
  click, and when a style is picked (browsers only allow it after a gesture). Leave fullscreen yourself and it stops asking
  until you press `[ FULLSCREEN ]` or `F`.
* **Teams:** cyan (defends the left goal) and magenta (defends the right). Players take the teams by slot (host cyan, first
  guest magenta, ...). The six bobbles of a team are **shared out evenly** between its players:

  | players | split | each player commands |
  | --- | --- | --- |
  | 2 | 1 v 1 | 6 bobbles |
  | 3 | 2 v 1 | 3 and 3 / 6 |
  | 4 | 2 v 2 | 3 bobbles |
  | 6 | 3 v 3 | 2 bobbles |
  | 8 | 4 v 4 | 2, 2, 1, 1 |
  | solo test | | all 12, for both teams |

  If a player leaves, their bobbles are handed to the rest of their team.
* **A round:** *plan, lock in, play.* During the **plan** phase (30 s) every player sets a flick (direction and power) for as
  many of their own bobbles as they like, then **locks in**. When everybody has locked in, or the time is up, all the flicks
  happen **at the same moment**; bobbles and ball slide, collide and rebound until all of them have stopped, and the next round of
  planning begins. A bobble with no plan just stays put. Your plans are **private**: they never leave your browser except to
  the host, and the host never sends them on.
* **Goals:** the ball must go fully over the goal line between the posts. Bobbles can't enter the nets. After a goal the pitch
  is reset and the next round starts.
* **Winning:** first to 3 goals, or the leader when the 5:00 match clock runs out (it runs while planning too, so don't dither).
  A tie goes to sudden death: the next goal wins. The host can rematch, change mode/teams or go back to the lobby.

## Controls

| | |
| --- | --- |
| plan a flick | press one of your bobbles (glowing gold) and drag **away from where you want it to go**, a slingshot; let go. The arrow stays on it (green to red with power; a full 170 px pull is 100%). Plan as many as you like; a plan can be redone by dragging again |
| clear a plan | click a planned bobble (let go without pulling), or `Esc` while dragging to cancel |
| lock in | the `[ LOCK IN ]` button under the pitch, or `Space` / `Enter`. Click it again to unlock and edit, until the last player locks in |
| fullscreen | `F` |

Gold ring: yours, no plan yet. Green ring and arrow: planned. Dashed team-colour ring: a teammate's bobble.

## Files

* `sim.js`: the physics and rules, pure JS with no DOM. All tuning constants are in `C` at the top.
  `node sim.test.js` runs its tests.
* `game.js`: the menu and team screen, rendering, input and networking (registers with the lobby; see `../README.md`).
* `game.css`: the frame around the canvas, the menu and the team screen.
* `legacy_sideview/`: the first version of the game (real-time side-on slime soccer). Not loaded; kept for reference.

## Netcode

The host's browser runs the simulation at a fixed 60 Hz (from a Web Worker timer, so a covered window doesn't slow
it) and sends a snapshot over the game channel: `{k:'s', tk, ph, t, c, ot, sc, w, lg, rd, sh, lk, rg, ow, tm, b:[x,y,vx,vy],
d:[x0,y0,x1,y1,...12 bobbles], ev:[...]}`, about 500 bytes (`lk` which teams have locked in, `rg` who has, `ow` which player
commands each bobble, `tm` team names and mascots). While things move the snapshot rate depends on the link
(30/s LAN, 20/s relay, up to 15/s online but capped so that guests x rate stays within a publish budget, 4/s radio);
while everyone plans it is a 5/s trickle that keeps the timer honest, with an immediate snapshot on every round start, flick-off,
goal and lock-in. Guests send `{k:'plan', i, ax, ay, _h:true}` (bobble index and the flick as a fraction of full power),
`{k:'ready', v, _h:true}` and, captains only, `{k:'team', side, name?, mascot?, ready?, _h:true}`. The host accepts a plan only from
the player who commands that bobble and only during planning. Menu state travels as `{k:'setup', ...}`, `{k:'begin', ...}` and
`{k:'menu'}` from the host. Guests draw about two snapshot intervals in the past, interpolating between snapshots.
