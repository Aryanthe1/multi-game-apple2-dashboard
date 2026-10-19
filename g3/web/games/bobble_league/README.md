# Bobble League

Slime soccer for 2-8 players: two teams of bouncy blobs, one ball, a goal at each end. Most goals when the clock
runs out wins; a draw goes to golden-goal overtime.

## Rules as built

* Teams alternate by slot (host cyan, first guest magenta, ...). Cyan defends the left goal and attacks right.
* 3 s countdown, 120 s match, after a goal 2.6 s of celebration then a 2 s kickoff countdown.
* Tied at 0:00: golden goal, 60 s; no goal in that time is a draw. The host can rematch or go back to the lobby.
* The ball only counts when it is fully inside the net, under the crossbar.

## Controls

| | |
| --- | --- |
| move | `A` / `D` or arrow keys |
| jump | `W`, up arrow or space; hold for a high jump, tap for a short hop |
| slide | `S`, down arrow or shift: a burst of speed on the ground; a sliding hit is a much harder kick (1 s cooldown) |
| fullscreen | `F` |

## Files

* `sim.js`: the physics and rules, pure JS with no DOM. All tuning constants are in `C` at the top.
  `node sim.test.js` runs its tests.
* `game.js`: rendering, input and networking (registers with the lobby; see `../README.md`).
* `game.css`: the frame around the canvas.

## Netcode

The host's browser runs the simulation at a fixed 60 Hz (from a Web Worker timer, so a covered window doesn't slow
it) and sends a snapshot over the game channel: `{k:'s', tk, ph, t, c, ot, sc, w, lg, b:[x,y,vx,vy],
p:[[id,team,x,y,vx,vy,flags]...], ev:[...]}`, about 270 bytes for 8 players. The snapshot rate depends on the link
(30/s LAN, 20/s relay, up to 15/s online but capped so that guests x rate stays within a publish budget, 4/s
radio). Guests send `{k:'in', m:bitmask, _h:true}` when their keys change and as a heartbeat; the host ignores a
guest that has been silent for 1.5 s. Guests draw about two snapshot intervals in the past, interpolating between
snapshots, so remote play is smooth but a guest's own slime reacts after one round trip. Client-side prediction for
the guest's own slime is the obvious next step.
