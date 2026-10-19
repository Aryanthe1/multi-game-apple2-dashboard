"""Bridge tests: python -m g3.tests

Starts two real G3 servers (separate settings folders) and drives them through
WebSockets exactly like the browser does.
"""
from __future__ import annotations

import base64
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

from g3.server import make_server

FAILS = []


def check(label, ok):
    print(("  ok   " if ok else "  FAIL ") + label)
    if not ok:
        FAILS.append(label)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class WSClient:
    """A tiny browser stand-in."""

    def __init__(self, port, origin=True, host=None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        hdr = (f"GET /ws HTTP/1.1\r\nHost: {host or f'127.0.0.1:{port}'}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n")
        if origin is True:
            hdr += f"Origin: http://127.0.0.1:{port}\r\n"
        elif origin:
            hdr += f"Origin: {origin}\r\n"
        self.sock.sendall((hdr + "\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            c = self.sock.recv(1)
            if not c:
                break
            buf += c
        self.status = int(buf.split(b" ", 2)[1]) if buf else 0
        self.seen = []

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81])
        head += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(data)))

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            c = self.sock.recv(n - len(buf))
            if not c:
                raise EOFError
            buf += c
        return buf

    def recv(self, timeout=0.3):
        self.sock.settimeout(timeout)
        try:
            b0, b1 = self._read(2)
        except (socket.timeout, EOFError):
            return None
        self.sock.settimeout(5)
        n = b1 & 0x7F
        if n == 126:
            (n,) = struct.unpack(">H", self._read(2))
        elif n == 127:
            (n,) = struct.unpack(">Q", self._read(8))
        data = self._read(n)
        if b0 & 0x0F != 1:
            return {"t": "_control", "op": b0 & 0x0F}
        msg = json.loads(data.decode())
        self.seen.append(msg)
        return msg

    def expect(self, pred, timeout=8.0):
        end = time.time() + timeout
        for m in self.seen:                      # something already received may satisfy it
            if pred(m):
                self.seen.remove(m)
                return m
        while time.time() < end:
            m = self.recv(0.2)
            if m is not None and pred(m):
                if m in self.seen:
                    self.seen.remove(m)
                return m
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def start(name):
    data = tempfile.mkdtemp(prefix=f"g3test_{name}_")
    httpd, app, port = make_server(port=free_port(), data=data, scan=False)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, app, port, data


def room_with(n):
    return lambda m: m["t"] == "room" and len(m["slots"]) == n


def test_guards():
    print("bridge security:")
    httpd, app, port, _ = start("guards")
    base = f"http://127.0.0.1:{port}"
    check("health endpoint answers", json.loads(urllib.request.urlopen(base + "/api/health").read())["ok"])

    def status(path, host=None):
        req = urllib.request.Request(base + path, headers={"Host": host} if host else {})
        try:
            return urllib.request.urlopen(req).status
        except urllib.error.HTTPError as e:
            return e.code
    check("path traversal is refused", status("/../app.py") == 404 and status("/%2e%2e/app.py") == 404)
    check("a foreign Host header is refused (DNS rebinding)", status("/api/health", "evil.example.com") == 403)
    c = WSClient(port, origin="http://evil.example.com")
    check("a web page on another origin can't open the bridge", c.status == 403)
    c.close()
    c = WSClient(port, host="evil.example.com")
    check("a websocket with a foreign Host is refused", c.status == 403)
    c.close()
    c = WSClient(port)
    check("the real UI origin is accepted", c.status == 101)
    init = c.expect(lambda m: m["t"] == "init")
    check("a new tab immediately gets the full state",
          init is not None and len(init["catalog"]) == 6 and init["room"] is None and "name" in init["settings"])
    c.send({"c": "../../etc"})
    c.send({"c": "host", "transport": "carrier-pigeon"})
    toast = c.expect(lambda m: m["t"] == "toast")
    check("a bad command is answered with an error toast, not a crash",
          toast is not None and toast["k"] == "err")
    c.send({"c": "settings", "patch": {"name": "  eve\x00\x1b[31m  ", "bogus": 1, "lan_port": 22, "avatar": 99}})
    st = c.expect(lambda m: m["t"] == "settings")
    s = st["settings"]
    check("settings are validated and unknown keys dropped",
          s["name"] == "eve[31m" and "bogus" not in s and s["lan_port"] != 22 and s["avatar"] != 99)
    c.close()
    httpd.shutdown()
    app.stop()


def test_two_servers_one_room():
    print("two bridges, one room:")
    ha, appa, pa, da = start("alice")
    hb, appb, pb, db = start("bob")
    lan = free_port()
    A, B = WSClient(pa), WSClient(pb)
    A.expect(lambda m: m["t"] == "init")
    B.expect(lambda m: m["t"] == "init")
    A.send({"c": "settings", "patch": {"name": "ALICE", "lan_port": lan}})
    B.send({"c": "settings", "patch": {"name": "BOB", "lan_port": lan}})

    A.send({"c": "host", "transport": "lan", "game": "sketch_rumble", "max": 4})
    r = A.expect(lambda m: m["t"] == "room" and m["link"] == "up")
    check("the LAN link comes up with the host alone in the room",
          r is not None and len(r["slots"]) == 1 and r["slots"][0]["n"] == "ALICE"
          and r["game"] == "sketch_rumble" and r["max"] == 4)

    B.send({"c": "join", "transport": "lan", "ip": ""})
    t = B.expect(lambda m: m["t"] == "toast")
    check("joining without an address is refused politely", t is not None and "address" in t["m"])
    B.send({"c": "search"})
    found = B.expect(lambda m: m["t"] == "status" and m["state"] == "results", 10)
    check("searching the LAN finds the open room with its occupancy",
          found is not None and any(h["name"] == "ALICE" and h["players"] == 1 and h["max"] == 4
                                    for h in found["hosts"]))

    B.send({"c": "join", "transport": "lan", "ip": f"127.0.0.1:{lan}"})
    rb = B.expect(lambda m: m["t"] == "room" and m["you"] == 1 and len(m["slots"]) == 2)
    ra = A.expect(room_with(2))
    check("the guest is in the room and knows its slot", rb is not None and rb["host"] is False)
    check("the host sees the guest arrive", ra is not None and ra["slots"][1]["n"] == "BOB")

    tab2 = WSClient(pa)
    init2 = tab2.expect(lambda m: m["t"] == "init")
    check("a second tab on the same bridge joins the live session",
          init2 is not None and init2["room"] is not None and len(init2["room"]["slots"]) == 2)

    B.send({"c": "chat", "m": "hello from bob"})
    ca = A.expect(lambda m: m["t"] == "chat" and m["m"] == "hello from bob")
    cb = B.expect(lambda m: m["t"] == "chat" and m["m"] == "hello from bob")
    c2 = tab2.expect(lambda m: m["t"] == "chat" and m["m"] == "hello from bob")
    check("chat reaches the host, the sender's echo and the host's other tab",
          ca and cb and c2 and ca["n"] == "BOB")

    A.send({"c": "start"})
    t = A.expect(lambda m: m["t"] == "toast")
    check("the host can't start while the guest isn't ready", t is not None and "waiting for BOB" in t["m"])
    B.send({"c": "ready", "v": True})
    A.expect(lambda m: m["t"] == "room" and m["slots"][1]["ready"])
    A.send({"c": "start"})
    sa = A.expect(lambda m: m["t"] == "start")
    sb = B.expect(lambda m: m["t"] == "start")
    check("both sides get the start event with the same seed",
          sa is not None and sb is not None and sa["seed"] == sb["seed"] and sa["game"] == "sketch_rumble")

    B.send({"c": "game", "d": {"pulse": 1}})
    g = A.expect(lambda m: m["t"] == "game")
    check("the game channel carries guest -> host", g is not None and g["from"] == 1 and g["d"] == {"pulse": 1})
    A.send({"c": "game", "d": {"pulse": 2}})
    g = B.expect(lambda m: m["t"] == "game")
    check("and host -> guest", g is not None and g["from"] == 0 and g["d"] == {"pulse": 2})

    B.send({"c": "select_game", "id": "liars_bar"})
    t = B.expect(lambda m: m["t"] == "toast")
    check("a guest can't pick the game", t is not None and "host" in t["m"])
    A.send({"c": "stop_game"})
    B.expect(lambda m: m["t"] == "stop")

    A.send({"c": "kick", "id": 1})
    cl = B.expect(lambda m: m["t"] == "closed")
    check("a kicked guest is told why", cl is not None and "removed" in cl["why"])
    st = B.expect(lambda m: m["t"] == "status" and m["state"] == "idle")
    check("the guest's bridge goes back to idle", st is not None)

    B.send({"c": "join", "transport": "lan", "ip": f"127.0.0.1:{lan}"})
    B.expect(lambda m: m["t"] == "room" and m["you"] == 1 and len(m["slots"]) == 2)
    B.send({"c": "leave"})
    sysm = A.expect(lambda m: m["t"] == "sys" and "left" in m["m"], 6)
    check("the host sees a guest leave", sysm is not None)

    A.send({"c": "leave"})
    A.expect(lambda m: m["t"] == "closed")
    check("the host can close the room", A.expect(lambda m: m["t"] == "status" and m["state"] == "idle") is not None)
    check("settings were saved to disk",
          json.load(open(os.path.join(da, "settings.json")))["name"] == "ALICE")

    for c in (A, B, tab2):
        c.close()
    for h, a in ((ha, appa), (hb, appb)):
        h.shutdown()
        a.stop()


def test_host_errors():
    print("hosting errors:")
    h, app, port, _ = start("errs")
    c = WSClient(port)
    c.expect(lambda m: m["t"] == "init")
    c.send({"c": "host", "transport": "relay", "addr": "", "code": "X"})
    t = c.expect(lambda m: m["t"] == "toast")
    check("relay hosting needs an address", t is not None and "relay" in t["m"])
    c.send({"c": "host", "transport": "lora", "device": "../../etc/passwd"})
    t = c.expect(lambda m: m["t"] == "toast")
    check("a LoRa device path is validated", t is not None and "serial port" in t["m"])
    c.send({"c": "host", "transport": "relay", "addr": "127.0.0.1:1", "code": "NOPE"})
    cl = c.expect(lambda m: m["t"] == "closed", 12)
    check("a transport that can't start closes the room with the reason",
          cl is not None and "Relay" in cl["why"])
    st = c.expect(lambda m: m["t"] == "status" and m["state"] == "error")
    check("and the bridge reports the error state", st is not None)
    c.send({"c": "host", "transport": "lan", "max": 3})
    check("hosting works again afterwards", c.expect(room_with(1)) is not None)
    c.send({"c": "set_max", "n": 16})
    r = c.expect(lambda m: m["t"] == "room" and m["max"] == 8)
    check("capacity is clamped to the selected game", r is not None)
    c.close()
    h.shutdown()
    app.stop()


def main():
    for fn in (test_guards, test_two_servers_one_room, test_host_errors):
        try:
            fn()
        except Exception as e:
            import traceback
            traceback.print_exc()
            check(f"{fn.__name__} ran without crashing ({type(e).__name__}: {e})", False)
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED:")
        for f in FAILS:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
