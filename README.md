# G³ — multiplayer game launcher

A retro-terminal launcher built from Stitch design exports (kept locally, not in
this repo): a 3D cartridge cube, a room lobby with player slots, ready check and
chat, and a settings console. The multiplayer code underneath is the original
MonsterForge networking, extended from two players to rooms of up to 16.

## Run it

    python -m g3            # opens G3 in its own app window (Edge/Chrome), served from 127.0.0.1:8733

or double-click `PLAY_WINDOWS.bat` (`play_mac_linux.sh` on macOS/Linux).
Closing the G3 window quits it. `--tab` opens a normal browser tab instead.
Python 3.8+ and nothing else: the server is standard library only, and the web
page's Tailwind, Three.js and fonts are bundled in `g3/web/vendor`, so it works
offline (LAN, LoRa). `pip install pyserial` is only needed for LoRa radios.

Try multiplayer alone with `PLAY_SECOND_COPY_WINDOWS.bat`: host in one window
(Wi-Fi/LAN → Host), join from the other with address `127.0.0.1`. The second copy
has its own data folder, so it has its own operator account (add `--no-login` to skip it).

## Login and clearance

Everything sits behind a login. **Register** an operator (callsign + passcode, stored
salted and hashed in `~/.g3/auth.json`; your callsign becomes your player name), then
answer **the Riddle of the Rising Sun**: one riddle describing a gorgeous man. Answer
with his name, **Daivansh** or **Devonut** (any case; a trailing "san" is fine), and the
sun rises: clearance level 1 (DAYBREAK). Any other answer keeps the gate shut for 15 s.

The riddle and the check live on the server (`g3/lore.py`, `g3/auth.py`), so the page
never sees the answer. A later wrong guess never takes a clearance away. Five wrong
passcodes lock a callsign for 30 s. The clearance shows bottom-left on every page (with
log out) and isn't used to gate anything yet beyond getting in.
`python -m g3 --no-login` (or `G3_NOLOGIN=1`) skips all of this for development. To change
the riddle or the accepted names, edit `RIDDLE` and `ANSWERS` in `g3/lore.py`.

## Using it

1. **Launcher** (`/`): spin the cube (drag, `1`-`6`, arrows/WASD), press `[ SELECT ]`.
2. **Lobby** (`/lobby.html`): choose how to connect and whether to host or join:
   Wi-Fi/LAN, room code (works from anywhere, no setup), your own relay, or LoRa
   radio. Hosts pick the capacity; everyone presses ready; the host starts.
3. **Settings** (`/settings.html`): name and avatar, CRT effects and phosphor
   colour, audio, key remapping, network defaults, a link self-test.

Long-distance options are in [LONG_DISTANCE_PLAY.md](LONG_DISTANCE_PLAY.md).

Each game has its own folder in [g3/web/games/](g3/web/games/README.md). **Bobble
League** (top-down tactics, teams of 6 shared between the players, 2-8 players) is playable: see its
[README](g3/web/games/bobble_league/README.md) for the rules and controls (its **Arenas** mode adds four maps,
the stadium, desert, tundra and rainforest, each with its own random event and minigame). The other
five are placeholders: starting one shows a "game module not installed" screen with a
live test of the room's game channel (see below).

## How the multiplayer works

```
browser tabs  <-- WebSocket (loopback only) -->  g3/server.py + g3/app.py
                                                      |
                                       game/hub.py    |  Hub (host) / Guest
                                                      |
                                    game/multiplayer.py  Lobby + Link
                       Wi-Fi/LAN (net.py)   room code (online.py)   relay.py   lora.py
```

* **Star topology.** The host holds one link per guest and relays between
  them; a guest has one link to the host. The host is authoritative for the
  roster, ready flags, selected game and start (`game/hub.py` documents the
  messages).
* **Transports** all expose the same link interface, so the hub doesn't care
  which one carries a player:
  * LAN: TCP listener on 51337 + UDP discovery beacon on 51338 (reports occupancy).
  * Room code: encrypted MQTT through public brokers; the host serves any number of guests.
  * Relay: `python -m game.relay`. Protocol v2 lets one room hold many guests
    (the host keeps a control connection and the relay opens one pipe per guest);
    protocol v1 (two players) still works.
  * LoRa: always exactly two radios.
* **Game channel.** A game plugs in by sending JSON with `{"c":"game","d":{...}}`
  from the page; the host relays it to everyone else as `{"t":"game","from":id,"d":{...}}`.
  `start` gives every player the same random seed.
* **Security.** The bridge binds to 127.0.0.1 only and rejects any request whose
  `Host` or `Origin` isn't loopback, so other machines and other web pages can't
  drive it. Everything players send (names, chat) is HTML-escaped when shown.

## Tests

    python -m game.tests    # multiplayer: framing, rooms, relay, room code, LoRa
    python -m g3.tests      # bridge: security guards, two bridges in one room, login and the riddle
    node g3/web/games/bobble_league/sim.test.js   # Bobble League physics and rules (needs Node)

Settings are stored in `~/.g3/settings.json` (`--data DIR` to change it).
