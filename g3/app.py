"""The bridge between the web UI and the multiplayer code.

The server holds the one session (Lobby -> Hub or Guest); browser tabs are just
views.  Every tab gets the full state when it connects, then the stream of
events from the room, and sends commands as JSON: {"c": "<name>", ...}.
"""
from __future__ import annotations

import getpass
import json
import os
import queue
import random
import re
import sys
import threading
import time
import traceback
from collections import deque
from pathlib import Path

from game import hub as hubmod
from game.engine import net
from game.multiplayer import Lobby, local_ips

VERSION = "0.1.0"
CODE_RE = re.compile(r"[^A-Z0-9_-]")
DEVICE_RE = re.compile(r"^(COM\d{1,3}|/dev/[\w./-]+)$")


def clean_code(text, limit=32):
    return CODE_RE.sub("", str(text or "").upper().strip())[:limit]


def default_settings():
    try:
        user = getpass.getuser()
    except Exception:
        user = "player"
    return {
        "name": hubmod.clean_name(user)[:16],
        "avatar": 0,
        "game": hubmod.DEFAULT_GAME,
        "max_players": 8,
        "relay": "",
        "relay_room": "",
        "room_code": "",
        "lora_device": "",
        "lora_room": "FORGE",
        "lan_port": net.DEFAULT_PORT,
        "client_id": "G3-%04X-0x%04X" % (random.getrandbits(16), random.getrandbits(16)),
    }


class Client:
    """One browser tab.  Sends go through a queue so a stuck tab can't stall the room."""

    def __init__(self, ws):
        self.ws = ws
        self.q = queue.Queue(maxsize=1000)
        self.alive = True
        threading.Thread(target=self._pump, daemon=True).start()

    def send(self, obj):
        if not self.alive:
            return False
        try:
            self.q.put_nowait(json.dumps(obj, separators=(",", ":")))
            return True
        except queue.Full:
            self.alive = False
            self.ws.close(1013)
            return False

    def _pump(self):
        while self.alive:
            try:
                data = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self.ws.send(data)
            except OSError:
                self.alive = False

    def stop(self):
        self.alive = False


class App:
    def __init__(self, data_dir="~/.g3"):
        self.data_dir = Path(os.path.expanduser(str(data_dir)))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.data_dir / "settings.json"
        self.settings = self._load_settings()
        self.lock = threading.RLock()
        self.clients = []
        self.lobby = None
        self.room = None
        self.status = {"state": "idle", "msg": "", "hosts": []}
        self.chat = deque(maxlen=100)
        self.syslog = deque(maxlen=60)
        self.started = time.time()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    # ------------------------------------------------------------ settings
    def _load_settings(self):
        s = default_settings()
        try:
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                s.update(self._validate(data, s))
        except (OSError, ValueError):
            pass
        self._write(s)
        return s

    def _write(self, s):
        try:
            tmp = self.settings_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
            tmp.replace(self.settings_path)
        except OSError:
            pass

    @staticmethod
    def _validate(patch, current):
        """Keep only known keys with sane values."""
        out = {}
        for k, v in patch.items():
            if k not in current:
                continue
            if k == "name":
                out[k] = hubmod.clean_name(v)
            elif k in ("avatar",):
                if isinstance(v, int) and 0 <= v < hubmod.N_AVATARS:
                    out[k] = v
            elif k == "game":
                if v in hubmod.GAMES:
                    out[k] = v
            elif k == "max_players":
                if isinstance(v, int) and 2 <= v <= hubmod.MAX_ROOM:
                    out[k] = v
            elif k == "lan_port":
                if isinstance(v, int) and 1024 <= v <= 65530:
                    out[k] = v
            elif k == "relay":
                out[k] = str(v).strip()[:100]
            elif k in ("relay_room", "room_code", "lora_room"):
                out[k] = clean_code(v)
            elif k == "lora_device":
                v = str(v).strip()
                if not v or DEVICE_RE.match(v):
                    out[k] = v
            elif k == "client_id":
                out[k] = str(v)[:32]
        return out

    def public_settings(self):
        return dict(self.settings)

    def set_name(self, name):
        """The logged-in operator's callsign becomes the player name."""
        name = hubmod.clean_name(name or "")[:16]
        with self.lock:
            if name and name != self.settings["name"]:
                self.settings["name"] = name
                self._write(self.settings)
                self._broadcast({"t": "settings", "settings": self.public_settings()})

    # ------------------------------------------------------------ clients
    def add_client(self, client):
        with self.lock:
            self.clients.append(client)
            client.send(self.init_msg())

    def remove_client(self, client):
        with self.lock:
            client.stop()
            if client in self.clients:
                self.clients.remove(client)

    def init_msg(self):
        try:
            from game import lora
            serial_ok = lora.have_serial()
        except Exception:
            serial_ok = False
        return {"t": "init", "version": VERSION, "catalog": hubmod.catalog(),
                "settings": self.public_settings(), "status": self.status,
                "room": self.room.snapshot() if self.room is not None else None,
                "chat": list(self.chat), "sys": list(self.syslog), "ips": local_ips(),
                "serial": serial_ok, "uptime": int(time.time() - self.started),
                "python": sys.version.split()[0]}

    def _broadcast(self, obj):
        for c in list(self.clients):
            if not c.send(obj):
                self.clients.remove(c)

    def _set_status(self, state, msg="", hosts=None):
        new = {"state": state, "msg": msg, "hosts": hosts if hosts is not None else []}
        if new != self.status:
            self.status = new
            self._broadcast({"t": "status", **new})

    # ------------------------------------------------------------ the tick
    def _loop(self):
        while not self._stop.is_set():
            try:
                with self.lock:
                    self._tick()
            except Exception:
                traceback.print_exc()
            time.sleep(0.015)                  # games stream inputs and snapshots through here: keep it snappy

    def _tick(self):
        self._sync_lobby()
        room = self.room
        if room is None:
            return
        for ev in room.step():
            t = ev.get("t")
            if t == "chat":
                self.chat.append(ev)
            elif t == "sys":
                self.syslog.append(ev)
            self._broadcast(ev)
            if t == "closed":
                self._teardown()
                self._set_status("idle", "")
                break

    def _sync_lobby(self):
        lb = self.lobby
        if lb is None:
            return
        room = self.room
        if room is None:                                   # searching, or joining
            if lb.state == "error":
                msg = lb.msg
                self._teardown()
                self._set_status("error", msg)
            elif lb.state == "results":
                hosts = lb.hosts
                self.lobby = None
                self._set_status("results", "", hosts)
            elif lb.state in ("connecting", "searching"):
                self._set_status(lb.state, lb.msg)
            return
        if room.is_host:                                   # opening the room
            if lb.state == "hosting" and room.link_state == "starting":
                room.transport_up()
            if lb.state == "error":
                msg = lb.msg
                self._broadcast({"t": "closed", "why": msg})
                room.close(msg)
                self._teardown()
                self._set_status("error", msg)
            elif lb.msg != self.status.get("msg"):
                self._set_status("room", lb.msg)

    def _teardown(self):
        room, lobby = self.room, self.lobby
        self.room = self.lobby = None
        if room is not None and not room.closed:
            room.close()
        if lobby is not None:
            lobby.stop()
        self.chat.clear()
        self.syslog.clear()

    def stop(self):
        self._stop.set()
        with self.lock:
            self._teardown()

    # ------------------------------------------------------------ commands
    def command(self, client, m):
        name = str(m.get("c", ""))
        fn = getattr(self, "cmd_" + name, None) if re.fullmatch(r"[a-z_]+", name) else None
        if fn is None:
            return
        try:
            with self.lock:
                res = fn(client, m)
        except Exception:
            traceback.print_exc()
            client.send({"t": "toast", "k": "err", "m": "internal error (see the server console)"})
            return
        if isinstance(res, tuple) and not res[0]:
            client.send({"t": "toast", "k": "err", "m": res[1]})

    def _busy(self):
        return self.room is not None or self.lobby is not None

    def _need_room(self):
        return self.room is not None

    def cmd_ping(self, c, m):
        c.send({"t": "pong", "ts": m.get("ts")})

    def cmd_ports(self, c, m):
        def work():
            try:
                from game import lora
                ports = lora.list_ports()
            except Exception:
                ports = []
            c.send({"t": "ports", "ports": ports[:12]})
        threading.Thread(target=work, daemon=True).start()

    def cmd_diag(self, c, m):
        text = ""
        try:
            lines = (self.data_dir / "online_log.txt").read_text(encoding="utf-8").splitlines()
            text = "\n".join(lines[-40:])
        except OSError:
            pass
        c.send({"t": "diag", "log": text, "uptime": int(time.time() - self.started),
                "python": sys.version.split()[0], "ips": local_ips(), "data": str(self.data_dir)})

    def cmd_settings(self, c, m):
        patch = m.get("patch")
        if not isinstance(patch, dict):
            return False, "bad settings"
        clean = self._validate(patch, self.settings)
        if not clean:
            return True, ""
        self.settings.update(clean)
        self._write(self.settings)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        if self.room is not None and ("name" in clean):
            c.send({"t": "toast", "k": "ok", "m": "Name saved; it applies the next time you join a room."})
        return True, ""

    def cmd_reset(self, c, m):
        keep = self.settings["client_id"]
        self.settings = default_settings()
        self.settings["client_id"] = keep
        self._write(self.settings)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        return True, ""

    def cmd_avatar(self, c, m):
        av = m.get("i")
        if not isinstance(av, int) or not 0 <= av < hubmod.N_AVATARS:
            return False, "bad avatar"
        self.settings["avatar"] = av
        self._write(self.settings)
        if self.room is not None:
            self.room.set_avatar(av)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        return True, ""

    # ---- opening / joining
    def cmd_search(self, c, m):
        if self._busy():
            return False, "leave your current room first"
        lobby = Lobby(self.settings["name"], log_dir=self.data_dir, port=self.settings["lan_port"])
        self.lobby = lobby
        lobby.search()
        self._set_status("searching", "")
        return True, ""

    def cmd_host(self, c, m):
        if self._busy():
            return False, "leave your current room first"
        s = self.settings
        tr = m.get("transport")
        code, addr, device = "", "", ""
        if tr == "solo":                                   # testing: a room with nobody else in it, no network at all
            game = m.get("game") if m.get("game") in hubmod.GAMES else s["game"]
            s["game"] = game
            self._write(s)
            hub = hubmod.Hub(s["name"], "solo", "SOLO", game, 2, 2, s["avatar"], solo=True)
            self.room = hub
            self.chat.clear()
            self.syslog.clear()
            hub.start()                                    # straight into the game
            self._set_status("room", "solo test")
            self._broadcast({"t": "settings", "settings": self.public_settings()})
            return True, ""
        if tr == "online":
            from game import online as ol
            code = clean_code(m.get("code")) or ol.new_room_code()
            s["room_code"] = code
        elif tr == "relay":
            addr = str(m.get("addr") or s["relay"]).strip()[:100]
            code = clean_code(m.get("code")) or "G3-%04d" % random.randrange(10000)
            if not addr:
                return False, "type the relay's address first"
            s["relay"], s["relay_room"] = addr, code
        elif tr == "lora":
            device = str(m.get("device") or s["lora_device"]).strip()
            code = clean_code(m.get("code")) or s["lora_room"] or "FORGE"
            if not DEVICE_RE.match(device):
                return False, "pick the radio's serial port first (COM5, /dev/ttyUSB0 ...)"
            s["lora_device"], s["lora_room"] = device, code
        elif tr != "lan":
            return False, "unknown connection type"
        game = m.get("game") if m.get("game") in hubmod.GAMES else s["game"]
        try:
            want = int(m.get("max", s["max_players"]))
        except (TypeError, ValueError):
            want = s["max_players"]
        s["game"], s["max_players"] = game, max(2, min(want, hubmod.MAX_ROOM))
        self._write(s)
        cap = 2 if tr == "lora" else hubmod.MAX_ROOM
        hub = hubmod.Hub(s["name"], tr, code, game, s["max_players"], cap, s["avatar"])
        lobby = Lobby(s["name"], log_dir=self.data_dir, port=s["lan_port"])
        self.lobby, self.room = lobby, hub
        self.chat.clear()
        self.syslog.clear()
        if tr == "lan":
            lobby.host_lan(hub.add_link, hub.beacon_info)
        elif tr == "online":
            lobby.host_online(code, hub.add_link)
        elif tr == "relay":
            lobby.host_relay(addr, code, hub.add_link)
        else:
            lobby.host_lora(device, code, hub.add_link)
        self._set_status("room", lobby.msg)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        return True, ""

    def cmd_join(self, c, m):
        if self._busy():
            return False, "leave your current room first"
        s = self.settings
        tr = m.get("transport")
        lobby = Lobby(s["name"], log_dir=self.data_dir, port=s["lan_port"])
        code = ""

        def on_link(link):
            with self.lock:
                if self.lobby is not lobby or self.room is not None:
                    link.close()                     # cancelled while connecting
                    return
                self.room = hubmod.Guest(s["name"], link, tr, code, s["avatar"])
                self.chat.clear()
                self.syslog.clear()
                self._set_status("room", "")

        if tr == "lan":
            ip = str(m.get("ip", "")).strip()[:100]
            if not ip:
                return False, "type the host's address first"
            self.lobby = lobby
            lobby.join_lan(ip, on_link)
        elif tr == "online":
            code = clean_code(m.get("code"))
            if not code:
                return False, "type the room code first"
            s["room_code"] = code
            self.lobby = lobby
            lobby.join_online(code, on_link)
        elif tr == "relay":
            addr = str(m.get("addr") or s["relay"]).strip()[:100]
            code = clean_code(m.get("code"))
            if not addr or not code:
                return False, "the relay's address and a room code are both needed"
            s["relay"], s["relay_room"] = addr, code
            self.lobby = lobby
            lobby.join_relay(addr, code, on_link)
        elif tr == "lora":
            device = str(m.get("device") or s["lora_device"]).strip()
            code = clean_code(m.get("code")) or s["lora_room"] or "FORGE"
            if not DEVICE_RE.match(device):
                return False, "pick the radio's serial port first (COM5, /dev/ttyUSB0 ...)"
            s["lora_device"], s["lora_room"] = device, code
            self.lobby = lobby
            lobby.join_lora(device, code, on_link)
        else:
            return False, "unknown connection type"
        self._write(s)
        self._set_status("connecting", lobby.msg)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        return True, ""

    def cmd_cancel(self, c, m):
        if self.room is not None:
            return self.cmd_leave(c, m)
        if self.lobby is not None:
            self._teardown()
            self._set_status("idle", "")
        return True, ""

    def cmd_leave(self, c, m):
        room = self.room
        if room is None:
            return True, ""
        room.close()
        self._broadcast({"t": "closed", "why": "you left the room"})
        self._teardown()
        self._set_status("idle", "")
        return True, ""

    # ---- inside a room
    def cmd_ready(self, c, m):
        return self.room.set_ready(bool(m.get("v"))) if self._need_room() else (False, "not in a room")

    def cmd_chat(self, c, m):
        return self.room.chat(m.get("m", "")) if self._need_room() else (False, "not in a room")

    def cmd_select_game(self, c, m):
        gid = m.get("id")
        if gid not in hubmod.GAMES:
            return False, "unknown game"
        if self.room is not None:
            ok, why = self.room.select_game(gid)
            if not ok:
                return False, why
        self.settings["game"] = gid
        self._write(self.settings)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        return True, ""

    def cmd_set_max(self, c, m):
        try:
            n = int(m.get("n"))
        except (TypeError, ValueError):
            return False, "not a number"
        if self.room is not None:
            ok, why = self.room.set_max(n)
            if not ok:
                return False, why
            n = self.room.max if self.room.is_host else n
        self.settings["max_players"] = max(2, min(n, hubmod.MAX_ROOM))
        self._write(self.settings)
        self._broadcast({"t": "settings", "settings": self.public_settings()})
        return True, ""

    def cmd_start(self, c, m):
        return self.room.start() if self._need_room() else (False, "not in a room")

    def cmd_stop_game(self, c, m):
        return self.room.stop_game() if self._need_room() else (False, "not in a room")

    def cmd_kick(self, c, m):
        pid = m.get("id")
        if not self._need_room() or not isinstance(pid, int):
            return False, "not in a room"
        return self.room.kick(pid)

    def cmd_game(self, c, m):
        return self.room.send_game(m.get("d")) if self._need_room() else (False, "not in a room")
