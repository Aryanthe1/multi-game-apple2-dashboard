# Bobble League

Top-down tactics for 2-8 players, a bit like carrom or table football played with flicked discs. Every team is always
**six bobbles** and there is one ball. You never run around: each round you decide which way and how hard each of your bobbles
will be flicked, **both teams plan at the same time**, and then everything flies at once.

## Rules as built

* **Menu:** every match opens on the game menu. The host picks a gameplay style (guests wait and watch): **Classic** (the plain
  pitch) or **Arenas** (see below); to add a style add an entry to `MODES` at the top of `game.js` and it appears as a card. Arenas
  opens a map screen first, with one card per arena. Then comes the team
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

## Arenas

The same game in four maps. Each map changes the physics and has one random event of its own. Events never start in round 1, are
rolled from a seed the host picks for the match (so the same seed plays out the same way), and every number below is in `C` at the
top of `sim.js` (`HECKLE_P`, `STORM_P`, `BALES_P`, `BOLT_EVERY`, `STUN`, `FROST_AFTER`, ...).

| arena | pitch | event |
| --- | --- | --- |
| **The Stadium** | normal grass, crowd and flashbulbs | **Hecklers.** An onlooker pelts one player (tomato, soda, banana peel or jeering). Their bobbles are covered in the splat and *a teammate takes them over* (the teammate plans all six, and has to lock in again) while the pelted player rubs their screen clean in the **wipe-off** minigame. Done, or after 12 s, they get their bobbles back. With nobody to carry them (1 v 1, or a lone player on a team) the bobbles are *stuck* until then. Roughly every third round, never twice in a row. |
| **The Desert** | sand: everything slows down fast | **Hay bales.** Announced during planning (a dashed path and a wheat icon at the edge), they roll across the pitch once the flicks start and knock bobbles and ball about, then leave. **Sandstorms.** A round opens with a dig-out race instead of planning: every player mashes `SPACE`/click to dig out; the quickest time wins. The winner's team plays the round, the other team's bobbles are locked in place (padlock) and don't have to lock in. Nobody out in 10 s: no lock. |
| **The Tundra** | ice: everything slides | **Snowstorms**, the same race with a shake-it-off minigame (alternate `←`/`→` or `A`/`D`). **Frostbite:** a bobble that doesn't move for more than 2 rounds starts to freeze (flicks at 65%, then 35% power, and more drag; a warning shows when it is one round from freezing); at the third level it is frozen solid and can't be flicked until another bobble knocks it, which thaws it a level. Moving a bobble (or being hit) keeps it warm; a goal thaws everyone. |
| **The Rainforest** | wet grass: slippery | **Lightning.** About every 20 s of play a strike is announced for a second (a ring on the pitch) and then stuns the closest bobble and any right beside it (at most three) for **10 s**: they can't be flicked and lose their plan. |

Every event announces itself with a **popup** at the top of the screen (above the minigames and the weather, so it can't be hidden).
A popup lasts as long as its effect: the heckle until the player is clean or 12 s are up, a storm for the race and then a "who won the
turn" card for the rest of the planning round, hay bales from the warning until they have rolled off, lightning for its one-second
warning and then a 10 s stun countdown, frostbite for 5 s. A bar on the card runs down with the time left, and when it ends the effect
(splat, padlocks, stun sparks, weather) goes with it. The popups are made by `popFor` in `game.js`.

How the minigames are judged: they run on each player's own screen and the host is only told how long it took (the host clamps it to
at least 1.2 s). In a race everyone who finishes within 0.7 s of the first still counts and the quickest time wins; a tie goes to
whoever reported first. A player who leaves doesn't stall anything. The match clock stops during a storm race.

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
* `game.js`: the menus, rendering (including each arena's artwork and weather), input and networking (registers with the lobby; see
  `../README.md`).
* `minigames.js`: the three arena minigames (wipe-off, dig-out, shake-off); they only report how long they took.
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
`{k:'ready', v, _h:true}`, `{k:'mini', ms}` (I finished my minigame in `ms`) and, captains only, `{k:'team', side, name?, mascot?, ready?, _h:true}`. The host accepts a plan only from
the player who commands that bobble and only during planning. Menu state travels as `{k:'setup', st:'maps'|'teams', map, ...}`, `{k:'begin', map, ...}` and
`{k:'menu'}` from the host. In an arena the snapshot also carries what the arena adds, left out when at rest (so a classic snapshot is no bigger
than before): `mp` map, `fr`/`il` frostbite and idle counts, `sn` stun seconds, `bk` why each bobble can't be flicked, `pt` the pelted
player's bobbles, `fz` the team locked in place, `mn` the running minigame, `bl` hay bales, `om` the announced bales, `bt` the lightning warning. Guests draw about two snapshot intervals in the past, interpolating between snapshots.
