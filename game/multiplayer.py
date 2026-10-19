"""Connecting players: discovery, the per-peer Link, and the Lobby that sets
transports up.

A host opens a room over one transport (Wi-Fi/LAN, online room code, relay or
LoRa radio) and every player who connects arrives as a *Link*.  A guest has a
single Link to the host.  After connecting, one background reader thread per
Link receives everything and sorts it into queues, so the game thread only
sends and polls and never blocks.

Every transport's link has the same interface (send, send_pos, peer, events,
acts, alive, why, peer_name, is_host, close), so game/hub.py doesn't care which
one it is.  Messages are length-prefixed JSON (see game/engine/net.py); what
they mean is defined in game/hub.py.
"""
from __future__ import annotations

import json
import queue
import socket
import threading
import time

from game.engine import net

LINK_TIMEOUT = 25.0       # no message at all for this long = connection lost


def local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    ips = sorted(ip for ip in ips if not ip.startswith("127."))
    return ips or ["127.0.0.1"]


def discover(timeout=2.0, port=net.DEFAULT_PORT):
    """Find rooms open on the local network: [{ip, name, players, max, game}]."""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.3)
    try:
        for dest in ("255.255.255.255", "127.0.0.1"):
            try:
                s.sendto(b"MF-DISCOVER", (dest, port + 1))
            except OSError:
                pass
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, addr = s.recvfrom(512)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data.startswith(b"MF-HERE"):
                continue
            raw = data[8:].decode("utf-8", "replace")
            try:
                info = json.loads(raw)
                if not isinstance(info, dict):
                    raise ValueError
            except ValueError:
                info = {"n": raw}
            name = str(info.get("n", "?"))[:24]
            room = {"ip": addr[0], "name": name, "players": info.get("p"),
                    "max": info.get("m"), "game": info.get("g")}
            if name not in found or found[name]["ip"].startswith("127."):
                found[name] = room
    finally:
        s.close()
    return list(found.values())


class Link:
    """One TCP connection to one other player (host side: one per guest)."""

    voice_ok = True

    def __init__(self, session):
        self.s = session
        self.is_host = session.is_host
        self.peer_name = session.peer_name
        self.alive = True
        self.why = ""
        self.peer = None                 # latest pos message
        self.events = queue.Queue()      # everything that isn't pos/act
        self.acts = queue.Queue()
        self._send_lock = threading.Lock()
        self._last_rx = time.time()
        self._last_pos = None
        self._last_tx = 0.0
        session.sock.settimeout(1.0)
        self._frames = net.FrameReader(session.sock)
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while self.alive:
            try:
                msg = self._frames.read()
            except net.Disconnected as e:
                if "timeout" in str(e):
                    if time.time() - self._last_rx > LINK_TIMEOUT:
                        self._die("connection timed out")
                        return
                    continue
                self._die(str(e))
                return
            except Exception as e:
                self._die(repr(e))
                return
            self._last_rx = time.time()
            if not isinstance(msg, dict):
                continue
            t = msg.get("t")
            if t == "pos":
                self.peer = msg
            elif t == "act":
                self.acts.put(msg)
            elif t == "bye":
                self._die("left the session")
                return
            elif t != "ping":
                self.events.put(msg)

    def _die(self, why):
        if self.alive:
            self.alive = False
            self.why = why

    def send(self, obj):
        if not self.alive:
            return
        try:
            with self._send_lock:
                net.send_msg(self.s.sock, obj)
            self._last_tx = time.time()
        except net.Disconnected as e:
            self._die(str(e))

    def send_pos(self, x, y, facing, mode, frame):
        p = (x, y, facing, mode, frame)
        now = time.time()
        if p != self._last_pos or now - self._last_tx > 2.0:
            self._last_pos = p
            self.send({"t": "pos", "x": x, "y": y, "f": facing, "m": mode, "w": frame})

    def close(self):
        if self.alive:
            self.send({"t": "bye"})
        self.alive = False
        try:
            self.s.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.s.sock.close()
        except OSError:
            pass


class Lobby:
    """Transport setup; every flow runs on a worker thread and reports through
    `state` / `msg`.

    state: menu | connecting | hosting | searching | results | ready | error
    Hosts: on_link(link) is called (from a worker thread) for each player who connects.
    Guests: on_link(link) is called once, when the single link to the host is up.
    """

    def __init__(self, player_name, log_dir=None, port=net.DEFAULT_PORT):
        self.name = player_name
        self.port = port
        self.log_dir = log_dir
        self.state = "menu"
        self.msg = ""
        self.hosts = []
        self.ips = local_ips()
        self.cancel = threading.Event()
        self._closers = []

    # ------------------------------------------------------------ plumbing
    def _run(self, fn):
        self.cancel = threading.Event()
        threading.Thread(target=fn, args=(self.cancel,), daemon=True).start()

    def _fail(self, msg):
        self.msg, self.state = msg, "error"

    def _hosting(self, msg=""):
        self.state, self.msg = "hosting", msg

    def stop(self):
        """Abort whatever is in progress and close anything this lobby opened."""
        self.cancel.set()
        closers, self._closers = self._closers, []
        for fn in closers:
            try:
                fn()
            except Exception:
                pass
        self.state, self.msg = "menu", ""

    back = stop

    @staticmethod
    def _split_ip(ip, default_port):
        host, _, p = ip.strip().partition(":")
        return host, int(p) if p.isdigit() else default_port

    # ------------------------------------------------------------ Wi-Fi / LAN / Tailscale
    def host_lan(self, on_link, info=None):
        self.state, self.msg = "connecting", "Opening the room..."

        def work(cancel):
            try:
                lst = net.Listener(self.name, lambda s: on_link(Link(s)), self.port)
            except OSError as e:
                self._fail(f"Couldn't host ({e.strerror or e}). Is another room already open on this PC?")
                return
            beacon = net.DiscoveryBeacon(self.name, self.port, info)
            beacon.start()
            self._closers += [lst.close, beacon.stop]
            self._hosting()
        self._run(work)

    def search(self):
        self.state, self.msg, self.hosts = "searching", "", []

        def work(cancel):
            hosts = discover(port=self.port)
            if not cancel.is_set():
                self.hosts, self.state = hosts[:8], "results"
        self._run(work)

    def join_lan(self, ip, on_link):
        host, port = self._split_ip(ip, self.port)
        self.state, self.msg = "connecting", f"Connecting to {host}..."

        def work(cancel):
            try:
                s = net.Session.join(self.name, host, port)
            except (net.Disconnected, OSError) as e:
                if not cancel.is_set():
                    self._fail(f"Couldn't connect to {host} ({e}).")
                return
            if cancel.is_set():
                s.close()
                return
            self.state, self.msg = "ready", ""
            on_link(Link(s))
        self._run(work)

    # ------------------------------------------------------------ online room code (public MQTT brokers)
    def host_online(self, code, on_link):
        self.state, self.msg = "connecting", "Reaching the online meeting point..."

        def work(cancel):
            from game import online as ol
            try:
                link = ol.OnlineLink(self.name, code, cancel=cancel, log_dir=self.log_dir,
                                     role="host", on_peer=on_link)
            except OSError as e:
                if not cancel.is_set():
                    self._fail(f"Online: {e}. Your network may block these servers; try a phone hotspot, "
                               f"Tailscale, or a relay (see LONG_DISTANCE_PLAY.md).")
                return
            self.msg = "Checking that nobody else is hosting this room code..."
            rival = link.probe(cancel=cancel)
            if cancel.is_set():
                link.close()
                return
            if rival:
                link.close()
                self._fail(f"Room code {code} is already being hosted by @{rival}. If that's another G3 window "
                           f"of yours (maybe an old one), close it, or press NEW CODE here.")
                return
            self._closers.append(link.close)
            n = len(link.conns)
            self._hosting(f"Connected to {n} meeting point{'s' if n != 1 else ''}.")
        self._run(work)

    def join_online(self, code, on_link):
        self.state, self.msg = "connecting", "Reaching the online meeting point..."

        def work(cancel):
            from game import online as ol
            try:
                link = ol.OnlineLink(self.name, code, cancel=cancel, log_dir=self.log_dir, role="guest")
            except OSError as e:
                if not cancel.is_set():
                    self._fail(f"Online: {e}. Your network may block these servers; try a phone hotspot, "
                               f"Tailscale, or a relay (see LONG_DISTANCE_PLAY.md).")
                return
            n = len(link.conns)
            self.msg = f"Connected to {n} meeting point{'s' if n != 1 else ''}. Looking for room {code.upper()}..."
            end = time.time() + 120
            while not link.connected and link.alive and not cancel.is_set() and time.time() < end:
                time.sleep(0.1)
            if not link.connected:
                link.close()
                if not cancel.is_set():
                    self._fail("Nobody is hosting that room code. Same code? Has the host opened the room yet?")
                return
            self.state, self.msg = "ready", ""
            self._closers.append(link.close)
            on_link(link)
        self._run(work)

    # ------------------------------------------------------------ relay
    def host_relay(self, addr, room, on_link):
        self.state, self.msg = "connecting", f"Connecting to relay {addr}..."

        def work(cancel):
            from game import relay as rl
            try:
                host = rl.RelayHost(self.name, addr, room, lambda s: on_link(Link(s)), cancel=cancel)
            except (net.Disconnected, OSError, ValueError) as e:
                if not cancel.is_set():
                    self._fail(f"Relay: {e}")
                return
            if cancel.is_set():
                host.close()
                return
            self._closers.append(host.close)
            self._hosting(f"Room {room.upper()} is open on the relay.")
        self._run(work)

    def join_relay(self, addr, room, on_link):
        self.state, self.msg = "connecting", f"Connecting to relay {addr}..."

        def work(cancel):
            from game import relay as rl
            try:
                s = rl.join(self.name, addr, room, cancel=cancel)
            except (net.Disconnected, OSError, ValueError) as e:
                if not cancel.is_set():
                    self._fail(f"Relay: {e}")
                return
            if cancel.is_set():
                s.close()
                return
            self.state, self.msg = "ready", ""
            on_link(Link(s))
        self._run(work)

    # ------------------------------------------------------------ LoRa radio (always exactly two radios)
    def refresh_ports(self):
        from game import lora as lr
        return lr.list_ports()[:8]

    def _lora(self, device, room, host, on_link, waiting_msg, patience):
        self.state, self.msg = "connecting", waiting_msg

        def work(cancel):
            from game import lora as lr
            try:
                port = lr.open_port(device) if isinstance(device, str) else device
            except Exception as e:
                self._fail(f"Couldn't open {device}: {e}")
                return
            link = lr.LoRaLink(port, self.name, room, host)
            self._closers.append(link.close)
            if host:
                self._hosting(waiting_msg)
            end = time.time() + patience
            while not link.connected and link.alive and not cancel.is_set() and time.time() < end:
                time.sleep(0.1)
            if cancel.is_set() or not link.connected:
                link.close()
                if not cancel.is_set():
                    self._fail("No one answered on the radio. Same room code? Same channel? In range?"
                               if link.alive else f"Radio: {link.why}")
                return
            if not host:
                self.state, self.msg = "ready", ""
            on_link(link)
        self._run(work)

    def host_lora(self, device, room, on_link):
        self._lora(device, room, True, on_link,
                   f"Radio room {room.upper()} open; waiting for a friend's radio...", 900)

    def join_lora(self, device, room, on_link):
        self._lora(device, room, False, on_link,
                   f"Listening for a host on radio room {room.upper()}...", 300)
