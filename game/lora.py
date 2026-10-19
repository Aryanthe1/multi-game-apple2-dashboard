"""Long-range multiplayer over LoRa.

Works with any LoRa radio that behaves as a *transparent serial link* (bytes
in on one side come out on the other): UART modules such as the Ebyte
E220/E22 series or a Waveshare SX126x HAT in UART mode, connected with a
USB-TTL adapter (laptop) or the Pi's GPIO UART (console).  Configure the
module's channel ONCE with its maker's tool so it transmits inside your
country's licence-free band (India: 865-867 MHz) -- this code never changes
radio settings.

Radio constraints this is built for: ~2-10 kbit/s, packets under 200 bytes,
half-duplex (one side talks at a time), lost packets.  So:
  * frames:  A5 5A | room | kind | seq | frag | len | payload | crc16
  * reliable messages are fragmented, each fragment ACKed and retried with jitter
  * positions are unreliable, throttled to ~1/s, and only the latest matters
  * payloads are compact JSON, zlib-compressed when that is smaller

LoRaLink exposes the same interface as multiplayer.Link, so the game code is
identical over Wi-Fi and radio.
"""
from __future__ import annotations

import json
import queue
import random
import threading
import time
import zlib

SYNC = b"\xA5\x5A"
K_DATA, K_ACK, K_POS, K_BEACON = 1, 2, 3, 4
ZFLAG = 0x80
MAX_PAYLOAD = 180
LINK_TIMEOUT = 60.0
PROTO = "mf-lora-1"


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def room_id(code: str) -> int:
    return zlib.crc32(code.strip().upper().encode()) & 0xFF


def encode(obj) -> bytes:
    raw = json.dumps(obj, separators=(",", ":")).encode()
    z = zlib.compress(raw, 9)
    return (b"\x01" + z) if len(z) < len(raw) else (b"\x00" + raw)


def decode(data: bytes):
    body = zlib.decompress(data[1:]) if data[:1] == b"\x01" else data[1:]
    return json.loads(body.decode())


def frame(room, kind, seq, frag, payload=b""):
    head = bytes([room, kind, seq & 0xFF, frag, len(payload)]) + payload
    c = crc16(head)
    return SYNC + head + bytes([c >> 8, c & 0xFF])


class FrameParser:
    """Pulls valid frames out of a noisy byte stream."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf += data
        out = []
        while True:
            i = self.buf.find(SYNC)
            if i < 0:
                del self.buf[:-1]
                return out
            del self.buf[:i]
            if len(self.buf) < 9:
                return out
            n = self.buf[6]
            total = 2 + 5 + n + 2
            if n > MAX_PAYLOAD + 20:
                del self.buf[:2]
                continue
            if len(self.buf) < total:
                return out
            head = bytes(self.buf[2:7 + n])
            c = self.buf[7 + n] << 8 | self.buf[8 + n]
            if crc16(head) == c:
                out.append((head[0], head[1], head[2], head[3], head[5:]))
                del self.buf[:total]
            else:
                del self.buf[:2]          # corrupted: resync on the next marker


class LoRaLink:
    """Same interface as multiplayer.Link: send/send_pos/events/acts/peer/alive/close."""

    voice_ok = False            # a few kbit/s can't carry speech; text chat still works

    def __init__(self, port, player_name, room_code, host, seed=None, bitrate=2400):
        self.port = port                         # pyserial-like: read(n), write(b), in_waiting
        self.name = player_name
        self.room = room_id(room_code)
        self.is_host = host
        self.seed = seed or random.getrandbits(32)
        self.peer_name = "?"
        self.connected = False
        self.alive = True
        self.why = ""
        self.peer = None
        self.events = queue.Queue()
        self.acts = queue.Queue()
        self._out = queue.Queue()                # reliable messages
        self._pos = None                         # latest position (unreliable)
        self._pos_sent = 0.0
        self._pos_last = None
        self._seq = random.randrange(256)
        self._acks = set()
        self._ack_lock = threading.Lock()
        self._frags = {}
        self._seen = []
        self._last_rx = time.time()
        # retry timeout scales with the radio's speed: full frame airtime + reply + margin
        self.rto = max(0.4, (2 * (MAX_PAYLOAD + 12) * 8) / bitrate + 0.3)
        self._wlock = threading.Lock()
        self._beacons = queue.Queue()
        self._join_msg = None
        self._welcomed = False
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._writer, daemon=True).start()
        threading.Thread(target=self._handshake, daemon=True).start()

    # ------------------------------------------------------------ io
    def _write(self, data):
        with self._wlock:
            try:
                self.port.write(data)
            except Exception as e:
                self._die(f"radio error: {e}")

    def _reader(self):
        parser = FrameParser()
        while self.alive:
            try:
                data = self.port.read(max(1, getattr(self.port, "in_waiting", 0) or 1))
            except Exception as e:
                self._die(f"radio error: {e}")
                return
            if not data:
                if self.connected and time.time() - self._last_rx > LINK_TIMEOUT:
                    self._die("out of radio range")
                continue
            for room, kind, seq, fragb, payload in parser.feed(data):
                if room == self.room:
                    self._on_frame(kind, seq, fragb, payload)

    def _on_frame(self, kind, seq, fragb, payload):
        self._last_rx = time.time()
        if kind == K_ACK:
            with self._ack_lock:
                self._acks.add((seq, fragb))
            return
        if kind == K_BEACON:
            try:
                msg = decode(payload)
            except Exception:
                return
            if not self.connected:
                self._beacons.put(msg)
            return
        if kind == K_POS:
            try:
                self.peer = decode(payload)
            except Exception:
                pass
            return
        if kind == K_DATA:
            self._write(frame(self.room, K_ACK, seq, fragb))
            key = (seq, fragb)
            if key in self._seen:
                return                             # duplicate after a lost ACK
            self._seen = (self._seen + [key])[-64:]
            idx, count = fragb >> 4, fragb & 0x0F
            parts = self._frags.setdefault(seq, {})
            parts[idx] = payload
            if len(parts) == count:
                data = b"".join(parts[i] for i in range(count))
                del self._frags[seq]
                try:
                    msg = decode(data)
                except Exception:
                    return
                self._deliver(msg)

    def _deliver(self, msg):
        t = msg.get("t")
        if t == "join" and self.is_host:
            if not self.connected and msg.get("p") == PROTO:
                self._join_msg = msg
            return
        if t == "welcome" and not self.is_host:
            self.peer_name = msg.get("n", self.peer_name)
            self._welcomed = True
            return
        if t == "act":
            self.acts.put(msg)
        elif t == "pos":
            self.peer = msg
        elif t == "bye":
            self._die("left the session")
        else:
            self.events.put(msg)

    def _writer(self):
        while self.alive:
            try:
                obj = self._out.get(timeout=0.05)
            except queue.Empty:
                self._maybe_pos()
                continue
            data = encode(obj)
            chunks = [data[i:i + MAX_PAYLOAD] for i in range(0, len(data), MAX_PAYLOAD)] or [b""]
            if len(chunks) > 15:
                continue                            # too big for the radio; never happens in play
            self._seq = (self._seq + 1) & 0xFF
            for i, c in enumerate(chunks):
                fragb = i << 4 | len(chunks)
                ok = False
                for attempt in range(8):
                    self._write(frame(self.room, K_DATA, self._seq, fragb, c))
                    end = time.time() + self.rto + random.uniform(0, self.rto * 0.5)
                    while time.time() < end and self.alive:
                        with self._ack_lock:
                            if (self._seq, fragb) in self._acks:
                                self._acks.discard((self._seq, fragb))
                                ok = True
                                break
                        time.sleep(0.01)
                    if ok or not self.alive:
                        break
                if not ok:
                    self._die("radio link lost (no reply)")
                    return

    def _maybe_pos(self):
        p = self._pos
        now = time.time()
        if p is None or not self.connected:
            return
        if (p != self._pos_last and now - self._pos_sent >= 1.0) or now - self._pos_sent >= 8.0:
            self._pos_last, self._pos_sent = p, now
            x, y, f, m, w = p
            self._write(frame(self.room, K_POS, 0, 0, encode({"t": "pos", "x": x, "y": y, "f": f, "m": m, "w": w})))

    def _handshake(self):
        """Host beacons until someone joins; joiner answers the first beacon it hears."""
        if self.is_host:
            while self.alive and not self.connected:
                self._write(frame(self.room, K_BEACON, 0, 0,
                                  encode({"p": PROTO, "n": self.name, "s": self.seed})))
                end = time.time() + 1.5 + random.uniform(0, 0.5)
                while time.time() < end and self.alive:
                    j = self._join_msg
                    if j is not None:
                        self.peer_name = j.get("n", "?")
                        self.send({"t": "welcome", "n": self.name})
                        self.connected = True
                        self._last_rx = time.time()
                        return
                    time.sleep(0.05)
        else:
            while self.alive and not self.connected:
                try:
                    b = self._beacons.get(timeout=0.2)
                except queue.Empty:
                    continue
                if b.get("p") != PROTO:
                    continue
                self.peer_name = b.get("n", "?")
                self.seed = b.get("s", self.seed)
                self.send({"t": "join", "n": self.name, "p": PROTO})
                end = time.time() + 30
                while time.time() < end and self.alive and not self._welcomed:
                    time.sleep(0.05)
                if self._welcomed:
                    self.connected = True
                    self._last_rx = time.time()

    # ------------------------------------------------------------ public (same as Link)
    def _die(self, why):
        if self.alive:
            self.alive = False
            self.why = why

    def send(self, obj):
        if self.alive:
            self._out.put(obj)

    def send_pos(self, x, y, facing, mode, frame_):
        self._pos = (x, y, facing, mode, frame_)

    def close(self):
        if self.alive and self.connected:
            self._write(frame(self.room, K_DATA, (self._seq + 1) & 0xFF, 1, encode({"t": "bye"})))
        self.alive = False
        try:
            self.port.close()
        except Exception:
            pass


def have_serial():
    try:
        import serial  # noqa: F401
        return True
    except ImportError:
        return False


def list_ports():
    try:
        from serial.tools import list_ports as lp
        return [(p.device, p.description or "") for p in lp.comports()]
    except Exception:
        return []


def open_port(device, baud=9600):
    if not have_serial():
        raise RuntimeError("the pyserial package is missing (run: pip install pyserial)")
    import serial
    return serial.Serial(device, baud, timeout=0.05)
