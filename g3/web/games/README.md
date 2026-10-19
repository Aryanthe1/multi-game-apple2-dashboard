# Games

One folder per game, named after its id in `game/hub.py` (`GAMES`):

| folder | game | state |
| --- | --- | --- |
| `bobble_league/` | Bobble League, slime soccer | playable (base game) |
| `sketch_rumble/` | Sketch Rumble, draw and guess | not started |
| `kart_odyssey/` | Kart Odyssey, cosmic racing | not started |
| `letter_league/` | Letter League, co-op word puzzle | not started |
| `liars_bar/` | Liar's Bar, bluffing | not started |
| `whos_away/` | Who's Away From Home, escape room | not started |

A game with no `game.js` shows the lobby's "game module not installed" placeholder (with a live test of the
game channel) when the host presses START.

## How a game plugs in

1. `games/<id>/game.js` calls `G3.registerGame('<id>', { mount })`.
2. `lobby.html` loads the folder's scripts (and stylesheet) before `js/lobby.js`.
3. When the room's phase becomes `playing`, the lobby hides the cover art, puts an empty `div` in the main panel and calls

   ```js
   const inst = mount({
     root,                   // the div to build the game in
     game, seed,             // catalog entry for this game, the room's shared random seed
     room,                   // () => the current room snapshot: { you, host, transport, slots: [{id, n, av, role, ...}], ... }
     send(d, hostOnly),      // send a JSON object over the room's game channel (hostOnly: don't relay it to other guests)
     leave(), backToLobby(), // leave the room / (host) end the game and return everybody to the lobby
   });
   ```
4. `inst` must provide `onMessage(from, d)` (a player's game-channel message; `from` is their slot id, 0 = host),
   `onRoom(room)` (the roster changed) and `destroy()` (called when the phase leaves `playing`, the room closes or
   the player leaves; remove every listener and timer).

The host's browser is the authority for anything shared: guests send inputs (`hostOnly`), the host sends state.
Messages are JSON of at most 16 KB. Chat is a separate channel, so a game never has to handle it, and keys typed in
the chat box never reach `window` listeners.

Browser games should keep their simulation in a DOM-free file so it can be tested with `node` (see
`bobble_league/sim.test.js`).
