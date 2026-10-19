"""Rooms for more than two players, on top of the per-peer Links.

Star topology: the host holds one Link per guest and relays between them; a
guest holds a single Link to the host.  The host is authoritative for who is in
the room, who is ready, which game is selected and when it starts.  Both sides
expose the same interface (Hub / Guest) so the UI layer treats them alike:

    room.step()  -> list of UI events (call ~20x a second from one thread)
    room.snapshot(), set_ready, chat, select_game, set_max, start, stop_game,
    kick, send_game, set_avatar, close

Messages (JSON objects, "t" = type) carried over any link:
  room   host -> all      {v, you, code, transport, link, game, max, phase, seed, slots:[...]}
  ready  guest -> host    {v: bool}
  prof   guest -> host    {av: int}                      avatar choice
  chat   guest -> host    {m}              host -> all   {id, n, m}
  g      any -> host      {d}              host -> others {from, d}   game channel
         (a guest's d with "_h": true is for the host alone and is not relayed to the other guests)
  png / pon               host -> guest {ts}  /  guest -> host {ts}   round-trip time
  start  host -> all      {game, seed}      stop  host -> all  back to the lobby
  kick / full             host -> guest     leave the room / the room refused you
"""
from __future__ import annotations

import json
import queue
import random
import threading
import time
from collections import deque

# id -> (exe title, long name, genre line, min players to start, max players)
GAMES = {
    "bobble_league": ("BOBBLE_LEAGUE.EXE", "BOBBLE LEAGUE / SLIME SOCCER", "2D SLIME SOCCER", 2, 8),
    "sketch_rumble": ("SKETCH_RUMBLE.EXE", "SKETCH HEADS / SKETCH RUMBLE", "MULTIPLAYER DOODLE PARTY", 1, 16),
    "kart_odyssey": ("KART_ODYSSEY.EXE", "KART ODYSSEY / PIXEL-FREE PUFFERS", "COSMIC INDIE RACING", 1, 4),
    "letter_league": ("LETTER_LEAGUE.EXE", "LETTER LEAGUE / WORD PUZZLE PARTY", "CO-OP WORD PUZZLE", 1, 8),
    "liars_bar": ("LIARS_BAR.EXE", "LIAR'S BAR / BLUFFING PARTY", "DECK BLUFFING & DICE", 2, 4),
    "whos_away": ("WHOS_AWAY_FROM_HOME.EXE", "WHO'S AWAY FROM HOME / ESCAPE ROOM", "MYSTERY ESCAPE ROOM", 1, 4),
}
DEFAULT_GAME = "bobble_league"
MAX_ROOM = 16
N_AVATARS = 12
CHAT_LEN = 200
GAME_MSG_BYTES = 16384
PING_EVERY = 4.0
SLOW_PING_EVERY = 15.0          # radio links: don't spend the airtime
PING_BROADCAST_EVERY = 2.0


def catalog():
    return [{"id": gid, "exe": g[0], "name": g[1], "genre": g[2], "min": g[3], "max": g[4]}
            for gid, g in GAMES.items()]


def clean_text(text, limit=CHAT_LEN):
    return "".join(ch for ch in str(text) if ch.isprintable())[:limit].strip()


def clean_name(name):
    return clean_text(name, 24) or "PLAYER"


class Peer:
    """One guest as the host sees them."""

    def __init__(self, pid, link, name):
        self.pid = pid
        self.link = link
        self.name = name
        self.ready = False
        self.av = pid % N_AVATARS
        self.ping = None
        self.joined = time.time()
        self.last_png = 0.0
        self.chat_times = deque(maxlen=6)


class _Base:
    def __init__(self):
        self.lock = threading.RLock()
        self._events = []
        self.closed = False
        self.why = ""

    def _ev(self, ev):
        self._events.append(ev)

    def _flush(self):
        ev, self._events = self._events, []
        return ev


# ================================================================== host side
class Hub(_Base):
    is_host = True

    def __init__(self, name, transport="lan", code="", game=DEFAULT_GAME, max_players=8,
                 cap=MAX_ROOM, avatar=0):
        super().__init__()
        self.name = clean_name(name)
        self.transport = transport
        self.code = code
        self.cap = max(2, min(cap, MAX_ROOM))
        self.game = game if game in GAMES else DEFAULT_GAME
        self.max = 2
        self.phase = "lobby"
        self.seed = 0
        self.av = avatar % N_AVATARS
        self.link_state = "starting"       # starting | up
        self.peers = {}                    # pid -> Peer
        self.inbox = queue.Queue()
        self.version = 0
        self._dirty = True
        self._ping_dirty = False
        self._last_bcast = 0.0
        self.set_max(max_players)

    # ------------------------------------------------------------ transports call these
    def add_link(self, link):
        """Thread-safe: a new player's link, from any transport's worker thread."""
        self.inbox.put(link)

    def transport_up(self):
        with self.lock:
            self.link_state = "up"
            self._mark()

    # ------------------------------------------------------------ state
    def _mark(self):
        self._dirty = True

    def _next_pid(self):
        pid = 1
        while pid in self.peers:
            pid += 1
        return pid

    def _unique_name(self, name, pid):
        taken = {p.name.lower() for p in self.peers.values()} | {self.name.lower()}
        name = clean_name(name)
        return name if name.lower() not in taken else f"{name[:20]}#{pid}"

    def players(self):
        return 1 + len(self.peers)

    def beacon_info(self):
        return {"p": self.players(), "m": self.max, "g": self.game}

    def _slots(self):
        slots = [{"id": 0, "n": self.name, "av": self.av, "ready": True, "ping": 0,
                  "role": "HOST", "since": 0}]
        now = time.time()
        for pid, p in sorted(self.peers.items()):
            slots.append({"id": pid, "n": p.name, "av": p.av, "ready": p.ready, "ping": p.ping,
                          "role": "GUEST", "since": int(now - p.joined)})
        return slots

    def snapshot(self, you=0):
        with self.lock:
            g = GAMES[self.game]
            return {"t": "room", "v": self.version, "you": you, "host": True, "code": self.code,
                    "transport": self.transport, "link": self.link_state, "game": self.game,
                    "min": g[3], "gmax": min(g[4], self.cap), "max": self.max, "phase": self.phase,
                    "seed": self.seed, "slots": self._slots()}

    def _broadcast_room(self):
        self.version += 1
        self._last_bcast = time.time()
        self._dirty = self._ping_dirty = False
        for pid, p in list(self.peers.items()):
            p.link.send(self.snapshot(pid))
        self._ev(self.snapshot(0))

    def _sys(self, text):
        self._ev({"t": "sys", "m": text})

    # ------------------------------------------------------------ the tick
    def step(self):
        with self.lock:
            if self.closed:
                return self._flush()
            now = time.time()
            while True:
                try:
                    link = self.inbox.get_nowait()
                except queue.Empty:
                    break
                self._admit(link)
            for pid, p in list(self.peers.items()):
                if not p.link.alive:
                    self._drop(pid, p.link.why or "disconnected")
                    continue
                self._drain(p)
                every = PING_EVERY if getattr(p.link, "voice_ok", True) else SLOW_PING_EVERY
                if now - p.last_png >= every:
                    p.last_png = now
                    p.link.send({"t": "png", "ts": now})
            if self._dirty or (self._ping_dirty and now - self._last_bcast >= PING_BROADCAST_EVERY):
                self._broadcast_room()
            return self._flush()

    def _admit(self, link):
        if self.phase != "lobby" or self.players() >= self.max:
            reason = "that room's game is already running" if self.phase != "lobby" else "the room is full"
            link.send({"t": "full", "why": reason})
            link.close()
            self._sys(f"{clean_name(link.peer_name)} was turned away ({reason})")
            return
        pid = self._next_pid()
        p = Peer(pid, link, self._unique_name(link.peer_name, pid))
        self.peers[pid] = p
        self._sys(f"{p.name} joined the room")
        link.send(self.snapshot(pid))
        self._mark()

    def _drop(self, pid, why):
        p = self.peers.pop(pid, None)
        if p is None:
            return
        try:
            p.link.close()
        except Exception:
            pass
        self._sys(f"{p.name} left ({why})")
        if self.phase == "playing" and self.players() < GAMES[self.game][3]:
            self.phase = "lobby"
            self._ev({"t": "stop"})
        self._mark()

    def _drain(self, p):
        while True:
            try:
                ev = p.link.events.get_nowait()
            except queue.Empty:
                break
            if isinstance(ev, dict):
                self._handle(p, ev)
        while True:                              # the old lockstep channel isn't used by rooms
            try:
                p.link.acts.get_nowait()
            except queue.Empty:
                break

    def _handle(self, p, ev):
        t = ev.get("t")
        if t == "ready":
            v = bool(ev.get("v"))
            if self.phase == "lobby" and p.ready != v:
                p.ready = v
                self._mark()
        elif t == "prof":
            av = ev.get("av")
            if isinstance(av, int) and 0 <= av < N_AVATARS and av != p.av:
                p.av = av
                self._mark()
        elif t == "chat":
            now = time.time()
            if len(p.chat_times) == p.chat_times.maxlen and now - p.chat_times[0] < 5.0:
                return                           # more than 6 lines in 5 s: drop the flood
            p.chat_times.append(now)
            text = clean_text(ev.get("m", ""))
            if text:
                self._chat(p.pid, p.name, text)
        elif t == "g":
            self._game_msg(p.pid, ev.get("d"))
        elif t == "pon":
            ts = ev.get("ts")
            if isinstance(ts, (int, float)):
                p.ping = max(0, min(9999, round((time.time() - ts) * 1000)))
                self._ping_dirty = True

    def _chat(self, pid, name, text):
        self._ev({"t": "chat", "id": pid, "n": name, "m": text, "ts": time.time()})
        for q, p in list(self.peers.items()):
            p.link.send({"t": "chat", "id": pid, "n": name, "m": text})

    def _game_msg(self, from_pid, d):
        if d is None:
            return
        try:
            if len(json.dumps(d)) > GAME_MSG_BYTES:
                return
        except (TypeError, ValueError):
            return
        self._ev({"t": "game", "from": from_pid, "d": d})
        if from_pid and isinstance(d, dict) and d.get("_h"):
            return                               # a guest's message for the host alone (inputs): don't fan it out
        for pid, p in list(self.peers.items()):
            if pid != from_pid:
                p.link.send({"t": "g", "from": from_pid, "d": d})

    # ------------------------------------------------------------ actions (any thread)
    def set_ready(self, v):
        return True, ""                          # the host is always ready; they press START

    def set_avatar(self, av):
        with self.lock:
            if isinstance(av, int) and 0 <= av < N_AVATARS and av != self.av:
                self.av = av
                self._mark()
        return True, ""

    def chat(self, text):
        text = clean_text(text)
        if not text:
            return False, "empty"
        with self.lock:
            self._chat(0, self.name, text)
        return True, ""

    def select_game(self, gid):
        with self.lock:
            if gid not in GAMES:
                return False, "unknown game"
            if self.phase != "lobby":
                return False, "a game is running"
            gmax = min(GAMES[gid][4], self.cap)
            if self.players() > gmax:
                return False, f"{GAMES[gid][0]} takes at most {gmax} players; {self.players()} are here"
            self.game = gid
            self.max = max(self.players(), 2, min(self.max, gmax))
            for p in self.peers.values():
                p.ready = False
            self._mark()
        return True, ""

    def set_max(self, n):
        with self.lock:
            try:
                n = int(n)
            except (TypeError, ValueError):
                return False, "not a number"
            gmax = min(GAMES[self.game][4], self.cap)
            n = max(self.players(), 2, min(n, gmax))
            if n != self.max:
                self.max = n
                self._mark()
        return True, ""

    def start(self):
        with self.lock:
            g = GAMES[self.game]
            if self.phase != "lobby":
                return False, "a game is already running"
            if self.players() < g[3]:
                return False, f"{g[0]} needs at least {g[3]} players"
            waiting = [p.name for p in self.peers.values() if not p.ready]
            if waiting:
                return False, "waiting for " + ", ".join(waiting)
            self.phase = "playing"
            self.seed = random.getrandbits(32)
            for p in self.peers.values():
                p.link.send({"t": "start", "game": self.game, "seed": self.seed})
            self._ev({"t": "start", "game": self.game, "seed": self.seed})
            self._mark()
        return True, ""

    def stop_game(self):
        with self.lock:
            if self.phase != "playing":
                return False, "no game is running"
            self.phase = "lobby"
            for p in self.peers.values():
                p.ready = False
                p.link.send({"t": "stop"})
            self._ev({"t": "stop"})
            self._mark()
        return True, ""

    def kick(self, pid):
        with self.lock:
            p = self.peers.get(pid)
            if p is None:
                return False, "no such player"
            p.link.send({"t": "kick"})
            self._drop(pid, "removed by the host")
        return True, ""

    def send_game(self, d):
        with self.lock:
            self._game_msg(0, d)
        return True, ""

    def close(self, why="you closed the room"):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.why = why
            for p in list(self.peers.values()):
                try:
                    p.link.close()
                except Exception:
                    pass
            self.peers.clear()
            while True:                          # anyone who connected in the last moment
                try:
                    self.inbox.get_nowait().close()
                except queue.Empty:
                    break
                except Exception:
                    pass
            self._ev({"t": "closed", "why": why})


# ================================================================== guest side
class Guest(_Base):
    is_host = False

    def __init__(self, name, link, transport="lan", code="", avatar=0):
        super().__init__()
        self.name = clean_name(name)
        self.link = link
        self.transport = transport
        self.code = code
        self.av = avatar % N_AVATARS
        self.room = None
        self.you = None
        link.send({"t": "prof", "av": self.av})

    def snapshot(self, you=None):
        with self.lock:
            if self.room is not None:
                return dict(self.room, host=False, link="up", transport=self.transport, code=self.code or self.room.get("code", ""))
            return {"t": "room", "v": 0, "you": None, "host": False, "code": self.code,
                    "transport": self.transport, "link": "up", "game": DEFAULT_GAME, "min": 1,
                    "gmax": 2, "max": 2, "phase": "joining", "seed": 0, "slots": []}

    def step(self):
        with self.lock:
            if self.closed:
                return self._flush()
            while True:
                try:
                    ev = self.link.events.get_nowait()
                except queue.Empty:
                    break
                if isinstance(ev, dict):
                    self._handle(ev)
                if self.closed:
                    return self._flush()
            while True:
                try:
                    self.link.acts.get_nowait()
                except queue.Empty:
                    break
            if not self.link.alive:
                self._end(self.link.why or "the host left")
            return self._flush()

    def _handle(self, ev):
        t = ev.get("t")
        if t == "room":
            self.room = ev
            self.you = ev.get("you")
            self._ev(self.snapshot())
        elif t == "chat":
            self._ev({"t": "chat", "id": ev.get("id"), "n": clean_name(ev.get("n", "?")),
                      "m": clean_text(ev.get("m", "")), "ts": time.time()})
        elif t == "g":
            self._ev({"t": "game", "from": ev.get("from"), "d": ev.get("d")})
        elif t == "png":
            self.link.send({"t": "pon", "ts": ev.get("ts")})
        elif t == "start":
            self._ev({"t": "start", "game": ev.get("game"), "seed": ev.get("seed")})
        elif t == "stop":
            self._ev({"t": "stop"})
        elif t == "full":
            self._end(clean_text(ev.get("why", "the room is full")))
        elif t == "kick":
            self._end("you were removed by the host")

    def _end(self, why):
        if self.closed:
            return
        self.closed = True
        self.why = why
        try:
            self.link.close()
        except Exception:
            pass
        self._ev({"t": "closed", "why": why})

    # ------------------------------------------------------------ actions
    def set_ready(self, v):
        self.link.send({"t": "ready", "v": bool(v)})
        return True, ""

    def set_avatar(self, av):
        if isinstance(av, int) and 0 <= av < N_AVATARS:
            self.av = av
            self.link.send({"t": "prof", "av": av})
        return True, ""

    def chat(self, text):
        text = clean_text(text)
        if not text:
            return False, "empty"
        self.link.send({"t": "chat", "m": text})
        return True, ""

    def send_game(self, d):
        self.link.send({"t": "g", "d": d})
        return True, ""

    def _host_only(self, *_):
        return False, "only the host can do that"

    select_game = set_max = kick = _host_only

    def start(self):
        return self._host_only()

    def stop_game(self):
        return self._host_only()

    def close(self, why="you left the room"):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.why = why
            try:
                self.link.close()
            except Exception:
                pass
            self._ev({"t": "closed", "why": why})
