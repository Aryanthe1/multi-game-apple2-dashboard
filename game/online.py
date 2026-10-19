"""Online play from anywhere with just a room code -- no server, no router setup.

Two laptops on home internet can't connect to each other directly (routers and
carrier-grade NAT block incoming connections), so both connect *out* to a
public MQTT message broker and exchange messages through it.  Several free
public brokers are tried in turn.

Privacy: the broker is someone else's server, so every message is encrypted
and authenticated with a key derived from the room code (PBKDF2-SHA256, then
HMAC-SHA256 in counter mode + HMAC tag, encrypt-then-MAC, with sequence
numbers against replays).  The broker only sees random-looking bytes on a topic
that is a hash of the key.  Longer room codes = harder to guess; the game can
generate one.

Robustness: the game connects to ALL the public brokers at once and sends every
message through every one that answered (duplicates are dropped on arrival),
so two players meet as long as their networks share at least one broker, and
a slow or dead broker never delays anything.  Attempts are logged to
<save dir>/online_log.txt.

Rooms: the host opens the room (role="host") and any number of guests join it
(role="guest"); each guest is its own OnlinePeer with its own duplicate filter,
sharing the host's broker connections.  role="pair" is the original symmetric
two-player pairing.

Public brokers are free community services with no uptime guarantee.  If none
can be reached (some college/office networks block them), use Tailscale or
the self-hosted relay instead.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import queue
import random
import socket
import ssl
import struct
import threading
import time

BROKERS = [                      # (host, port, tls)
    ("broker.hivemq.com", 8883, True),
    ("broker.emqx.io", 8883, True),
    ("broker.hivemq.com", 1883, False),
    ("broker.emqx.io", 1883, False),
    ("test.mosquitto.org", 1883, False),
]
LINK_TIMEOUT = 45.0
WORDS = ["ember", "tide", "fern", "gale", "stone", "spark", "dusk", "dawn", "forge", "cinder",
         "brook", "moss", "storm", "flint", "volt", "shade", "glow", "ash", "reef", "thorn",
         "cloud", "slate", "bolt", "gloom", "flare", "wave", "root", "wind", "ore", "zap",
         "night", "sun"]


def new_room_code():
    r = random.SystemRandom()
    return f"{r.choice(WORDS)}-{r.choice(WORDS)}-{r.choice(WORDS)}-{r.randrange(1000):03d}".upper()


def brokers():
    env = os.environ.get("MF_BROKERS")          # e.g. "127.0.0.1:1883" for testing / own broker
    if env:
        out = []
        for item in env.split(","):
            h, _, p = item.strip().partition(":")
            out.append((h, int(p or 1883), False))
        return out
    return BROKERS


# ------------------------------------------------------------------ crypto
class Box:
    def __init__(self, room_code):
        secret = room_code.strip().upper().encode()
        k = hashlib.pbkdf2_hmac("sha256", secret, b"monsterforge-room-v1", 200_000, dklen=64)
        self.enc, self.mac = k[:32], k[32:]
        self.topic = "mforge/v1/" + hashlib.sha256(b"topic" + k).hexdigest()[:24]

    def _stream(self, nonce, n):
        out = bytearray()
        c = 0
        while len(out) < n:
            out += hmac.new(self.enc, nonce + struct.pack(">I", c), hashlib.sha256).digest()
            c += 1
        return bytes(out[:n])

    def seal(self, obj) -> bytes:
        pt = json.dumps(obj, separators=(",", ":")).encode()
        nonce = os.urandom(12)
        ct = bytes(a ^ b for a, b in zip(pt, self._stream(nonce, len(pt))))
        tag = hmac.new(self.mac, nonce + ct, hashlib.sha256).digest()[:16]
        return nonce + ct + tag

    def open(self, data: bytes):
        if len(data) < 28:
            return None
        nonce, ct, tag = data[:12], data[12:-16], data[-16:]
        want = hmac.new(self.mac, nonce + ct, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(tag, want):
            return None                            # wrong room code or tampered
        pt = bytes(a ^ b for a, b in zip(ct, self._stream(nonce, len(ct))))
        try:
            return json.loads(pt.decode())
        except ValueError:
            return None


# ------------------------------------------------------------------ minimal MQTT 3.1.1 client
def _enc_len(n):
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _str(s):
    b = s.encode()
    return struct.pack(">H", len(b)) + b


def _connect_tcp(host, port, timeout):
    """IPv4 first (IPv6 is often half-broken on home and mobile networks), then IPv6."""
    last = None
    for fam in (socket.AF_INET, socket.AF_INET6):
        try:
            infos = socket.getaddrinfo(host, port, fam, socket.SOCK_STREAM)
        except socket.gaierror as e:
            last = last or e              # keep a real connection error over "no IPv6 address"
            continue
        for af, st, proto, _, addr in infos:
            s = socket.socket(af, st, proto)
            s.settimeout(timeout)
            try:
                s.connect(addr)
                return s
            except OSError as e:
                last = e
                s.close()
    raise last or OSError("no address")


class Mqtt:
    def __init__(self, host, port, tls, client_id, timeout=8):
        self.name = f"{host}:{port}"
        raw = _connect_tcp(host, port, timeout)
        if tls:
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        self.sock = raw
        self.lock = threading.Lock()
        self._pid = 0
        var = _str("MQTT") + bytes([4, 0x02]) + struct.pack(">H", 60)   # clean session, keepalive 60s
        self._send(0x10, var + _str(client_id))
        ptype, body = self.read_packet(first_timeout_ok=False)
        if ptype != 0x20 or len(body) < 2 or body[1] != 0:
            raise OSError(f"broker refused the connection ({body[1] if len(body) > 1 else '?'})")

    def _send(self, header, body):
        with self.lock:
            self.sock.sendall(bytes([header]) + _enc_len(len(body)) + body)

    def _exact(self, n, deadline):
        buf = b""
        while len(buf) < n:
            try:
                c = self.sock.recv(n - len(buf))
            except (socket.timeout, ssl.SSLWantReadError):
                if time.time() > deadline:
                    raise OSError("broker stalled mid-message")
                continue                     # part of a packet arrived; keep reading
            if not c:
                raise OSError("broker closed the connection")
            buf += c
        return buf

    def read_packet(self, first_timeout_ok=True):
        """Raises socket.timeout only if NOTHING arrived, so a packet is never split."""
        try:
            first = self.sock.recv(1)
        except (socket.timeout, ssl.SSLWantReadError):
            if first_timeout_ok:
                raise socket.timeout()
            first = self._exact(1, time.time() + 10)
        if not first:
            raise OSError("broker closed the connection")
        deadline = time.time() + 30
        mult, n = 1, 0
        while True:
            b = self._exact(1, deadline)[0]
            n += (b & 0x7F) * mult
            if not b & 0x80:
                break
            mult *= 128
        return first[0] & 0xF0, self._exact(n, deadline) if n else b""

    def subscribe(self, topic):
        self._pid = self._pid % 65535 + 1
        self._send(0x82, struct.pack(">H", self._pid) + _str(topic) + b"\x00")

    def publish(self, topic, payload):
        self._send(0x30, _str(topic) + payload)

    def ping(self):
        self._send(0xC0, b"")

    def close(self):
        try:
            self._send(0xE0, b"")
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ------------------------------------------------------------------ game link
class _Rx:
    """Receive-side state for one remote player: duplicate filtering, the newest
    position, and the inboxes the game thread polls."""

    def __init__(self):
        self.peer = None
        self.events = queue.Queue()
        self.acts = queue.Queue()
        self._seen = set()
        self._max_seen = 0
        self._pos_seq = -1
        self._last_rx = time.time()

    def accept(self, msg):
        """False for a repeat: the same message can arrive once per broker, in any order."""
        s = msg.get("_s", 0)
        if s in self._seen or s < self._max_seen - 2000:
            return False
        self._seen.add(s)
        if len(self._seen) > 4000:
            self._seen = {x for x in self._seen if x > self._max_seen - 2000}
        self._max_seen = max(self._max_seen, s)
        self._last_rx = time.time()
        return True

    def route(self, msg):
        t, s = msg.get("t"), msg.get("_s", 0)
        if t == "pos":
            if s > self._pos_seq:                    # only the newest position matters
                self._pos_seq = s
                self.peer = msg
        elif t == "act":
            self.acts.put(msg)
        elif t == "bye":
            self._die("left the session")
        elif t != "ping":
            self.events.put(msg)


class OnlinePeer(_Rx):
    """One guest as seen by the room host; same interface as multiplayer.Link."""

    voice_ok = True

    def __init__(self, bus, peer_id, name):
        super().__init__()
        self.bus = bus
        self.peer_id = peer_id
        self.peer_name = name
        self.is_host = True                          # this side hosts the room
        self.connected = True
        self.alive = True
        self.why = ""
        self._last_pos = None
        self._last_pos_tx = 0.0

    def _die(self, why):
        if self.alive:
            self.alive = False
            self.why = why
            self.bus._forget(self)

    def send(self, obj):
        if self.alive and self.bus.alive:
            self.bus._pub("/to/" + self.peer_id, obj)

    def send_pos(self, x, y, facing, mode, frame):
        p = (x, y, facing, mode, frame)
        now = time.time()
        if (p != self._last_pos and now - self._last_pos_tx > 0.33) or now - self._last_pos_tx > 2.0:
            self._last_pos, self._last_pos_tx = p, now
            self.send({"t": "pos", "x": x, "y": y, "f": facing, "m": mode, "w": frame})

    def close(self):
        if self.alive:
            self.send({"t": "bye"})
            self._die("closed")


class OnlineLink(_Rx):
    """Same interface as multiplayer.Link / lora.LoRaLink.

    role="pair"  : two equal players; whoever has the larger random id hosts (original behaviour)
    role="host"  : opens the room; every guest arrives as an OnlinePeer through on_peer(peer)
    role="guest" : looks for the room's host; this object is the single link to it
    """

    voice_ok = True

    def __init__(self, player_name, room_code, cancel=None, log_dir=None, role="pair", on_peer=None):
        super().__init__()
        self.name = player_name
        self.box = Box(room_code)
        self.role = role
        self.on_peer = on_peer
        self.peers = {}                  # host role: sender id -> OnlinePeer
        self.rival = None                # host role: name of another host found on this room code
        self.my_id = os.urandom(6).hex()
        self.peer_id = None
        self.peer_name = "?"
        self.is_host = role == "host"
        self.connected = False
        self.alive = True
        self.why = ""
        self._cancel = cancel
        self._seq = 0
        self._lock = threading.Lock()
        self._last_pos = None
        self._last_pos_tx = 0.0
        self._log_path = os.path.join(os.path.expanduser(log_dir), "online_log.txt") if log_dir else None
        self.conns = []
        self._log(f"--- room {self.box.topic[-8:]} ({role}), trying {len(brokers())} meeting points")
        def attempt(i, host, port, tls):
            t = time.time()
            try:
                m = Mqtt(host, port, tls, f"mf-{self.my_id}-{i}", timeout=6)
                m.sock.settimeout(1.0)
                m.subscribe(self.box.topic + "/lobby")
                m.subscribe(self.box.topic + "/to/" + self.my_id)
            except Exception as e:
                self._log(f"FAIL  {host}:{port}{' tls' if tls else ''}: {type(e).__name__}: {e}")
                return
            if not self.alive:
                m.close()
                return
            with self._lock:
                self.conns.append(m)                  # late arrivals join a running link too
            threading.Thread(target=self._reader, args=(m,), daemon=True).start()
            self._log(f"ok    {host}:{port}{' tls' if tls else ''} in {time.time() - t:.1f}s")
        threads = [threading.Thread(target=attempt, args=(i, *b), daemon=True) for i, b in enumerate(brokers())]
        for th in threads:
            th.start()
        start = time.time()
        first = None
        while time.time() - start < 9:
            if all(not th.is_alive() for th in threads):
                break
            if self.conns and first is None:
                first = time.time()
            if first is not None and time.time() - first > 1.5:
                break                                 # don't wait for slow ones; they can join later
            if cancel is not None and cancel.is_set():
                break
            time.sleep(0.05)
        if not self.conns:
            self.alive = False
            raise OSError("couldn't reach any online meeting point (see online_log.txt)")
        threading.Thread(target=self._keeper, daemon=True).start()

    @property
    def broker(self):
        return ", ".join(m.name for m in list(self.conns))

    def _log(self, line):
        if not self._log_path:
            return
        try:
            os.makedirs(os.path.dirname(self._log_path), exist_ok=True)
            with open(self._log_path, "a") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")
        except OSError:
            pass

    # ------------------------------------------------------------ internals
    def _pub(self, where, obj):
        with self._lock:
            self._seq += 1
            seq = self._seq
        data = self.box.seal(dict(obj, _s=seq, _f=self.my_id))
        sent = 0
        for m in list(self.conns):
            try:
                m.publish(self.box.topic + where, data)
                sent += 1
            except OSError as e:
                self._drop(m, e)
        if sent == 0:
            self._die("lost the connection to every meeting point")

    def _drop(self, m, err):
        if m in self.conns:
            self.conns.remove(m)
            self._log(f"lost  {m.name}: {err}")
            m.close()
        if not self.conns:
            self._die("lost the connection to every meeting point")

    def _forget(self, peer):
        self.peers.pop(peer.peer_id, None)
        self._log(f"guest {peer.peer_name} gone: {peer.why}")

    def _reader(self, m):
        while self.alive and m in self.conns:
            try:
                ptype, body = m.read_packet()
            except socket.timeout:
                if self.role != "host" and self.connected and time.time() - self._last_rx > LINK_TIMEOUT:
                    self._die("stopped responding")
                continue
            except (OSError, ssl.SSLError) as e:
                self._drop(m, e)
                return
            if ptype != 0x30:
                continue
            tlen = struct.unpack(">H", body[:2])[0]
            msg = self.box.open(body[2 + tlen:])
            if not msg or msg.get("_f") == self.my_id:
                continue
            with self._lock:
                self._on_msg(msg)

    def _answer_hello(self, sender):
        # answer every hello: if our 'ready' was lost, they keep saying hi until it arrives
        reply = {"t": "ready", "n": self.name}
        if self.role == "host":
            reply["r"] = "h"
        threading.Thread(target=self._pub, args=("/to/" + sender, reply), daemon=True).start()

    def _on_msg(self, msg):
        sender, t = msg.get("_f"), msg.get("t")
        if self.role == "host":
            return self._on_msg_host(sender, t, msg)
        if t == "hi":
            if self.role == "guest":
                return                               # guests never answer hellos
            if self.peer_id is None:
                self.peer_id, self.peer_name = sender, msg.get("n", "?")
                self.is_host = self.my_id > sender
                self._log(f"found {self.peer_name}; I am {'host' if self.is_host else 'guest'}")
            if sender == self.peer_id:
                self._answer_hello(sender)
            return
        if self.peer_id is None and t == "ready":
            if self.role == "guest" and msg.get("r") != "h":
                return                               # only a room host can accept a guest
            self.peer_id, self.peer_name = sender, msg.get("n", "?")
            if self.role == "pair":
                self.is_host = self.my_id > sender
        if sender != self.peer_id:
            return                                   # someone else in the room: ignore
        if not self.accept(msg):
            return
        if t == "ready":
            self.peer_name = msg.get("n", self.peer_name)
            if not self.connected:
                self.connected = True
                self._log(f"paired with {self.peer_name}")
        else:
            self.route(msg)

    def _on_msg_host(self, sender, t, msg):
        if t == "probe":                             # another host is checking this code is free
            threading.Thread(target=self._pub, args=("/to/" + sender, {"t": "taken", "n": self.name}),
                             daemon=True).start()
            return
        if t == "taken":
            self.rival = str(msg.get("n", "?"))[:24]
            return
        peer = self.peers.get(sender)
        if t == "hi":
            if msg.get("r") != "g":
                return                               # only guests knock on a host's door
            if peer is None or not peer.alive:
                peer = OnlinePeer(self, sender, str(msg.get("n", "?"))[:24])
                self.peers[sender] = peer
                self._log(f"guest {peer.peer_name} arrived")
                if self.on_peer is not None:
                    self.on_peer(peer)               # must not block: runs under the receive lock
            self._answer_hello(sender)
            return
        if peer is None or not peer.alive:
            return
        if peer.accept(msg):
            peer.route(msg)

    def _keeper(self):
        last_ping = time.time()
        while self.alive:
            if self.role != "host" and self._cancel is not None and self._cancel.is_set() and not self.connected:
                self.close()
                return
            if self.role != "host" and not self.connected:
                self._pub("/lobby", {"t": "hi", "n": self.name, **({"r": "g"} if self.role == "guest" else {})})
                time.sleep(1.5)
            else:
                time.sleep(0.5)
            now = time.time()
            if self.role == "host":
                for p in list(self.peers.values()):
                    if now - p._last_rx > LINK_TIMEOUT:
                        p._die("stopped responding")
            if now - last_ping > 20:
                for m in list(self.conns):
                    try:
                        m.ping()
                    except OSError as e:
                        self._drop(m, e)
                if self.role == "host" or self.connected:
                    self.send({"t": "ping"})           # keeps the other side's timeout fresh
                last_ping = now

    def _die(self, why):
        if self.alive:
            self.alive = False
            self.why = why
            self._log(f"link ended: {why}")
            for p in list(self.peers.values()):
                p._die(why)

    def probe(self, wait=2.5, cancel=None):
        """Host only: is another host already answering on this room code?  Two hosts on one
        code both answer a guest, and the guest keeps only the first, so the other host sees
        a player "join" who never says or does anything.  Returns that host's name, or None."""
        end = time.time() + wait
        sent = 0.0
        while time.time() < end and self.rival is None and self.alive and not (cancel is not None and cancel.is_set()):
            if time.time() - sent > wait / 2 - 0.05:     # twice: a late meeting point may miss the first
                sent = time.time()
                self._pub("/lobby", {"t": "probe"})
            time.sleep(0.05)
        return self.rival

    # ------------------------------------------------------------ public (same as Link)
    def send(self, obj):
        if not self.alive:
            return
        if self.role == "host":
            for p in list(self.peers.values()):
                p.send(obj)
        elif self.peer_id:
            self._pub("/to/" + self.peer_id, obj)

    def send_pos(self, x, y, facing, mode, frame):
        if self.role == "host":
            return
        p = (x, y, facing, mode, frame)
        now = time.time()
        if (p != self._last_pos and now - self._last_pos_tx > 0.33) or now - self._last_pos_tx > 2.0:
            self._last_pos, self._last_pos_tx = p, now
            self.send({"t": "pos", "x": x, "y": y, "f": facing, "m": mode, "w": frame})

    def close(self):
        if self.alive:
            if self.role == "host":
                for p in list(self.peers.values()):
                    self._pub("/to/" + p.peer_id, {"t": "bye"})
            elif self.peer_id:
                self._pub("/to/" + self.peer_id, {"t": "bye"})
        self.alive = False
        for m in list(self.conns):
            m.close()
