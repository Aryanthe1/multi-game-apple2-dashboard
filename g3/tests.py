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

    def __init__(self, port, origin=True, host=None, cookie=None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        hdr = (f"GET /ws HTTP/1.1\r\nHost: {host or f'127.0.0.1:{port}'}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n")
        if cookie:
            hdr += f"Cookie: {cookie}\r\n"
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


def start(name, login=False):
    data = tempfile.mkdtemp(prefix=f"g3test_{name}_")
    httpd, app, port = make_server(port=free_port(), data=data, scan=False, login=login)
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

    from pathlib import Path
    tune = Path(__file__).parent / "web" / "assets" / "audio" / "_range_test.mp3"
    tune.write_bytes(bytes(range(100)))
    try:
        def fetch(rng=None):
            req = urllib.request.Request(base + "/assets/audio/_range_test.mp3", headers={"Range": rng} if rng else {})
            try:
                r = urllib.request.urlopen(req)
                return r.status, r.headers, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.headers, b""
        code, hd, body = fetch()
        check("audio is served whole, as audio, with byte ranges on offer", code == 200 and len(body) == 100 and hd["Content-Type"] == "audio/mpeg" and hd["Accept-Ranges"] == "bytes")
        code, hd, body = fetch("bytes=10-19")
        check("a byte range gets a 206 with just those bytes (so the music can seek)", code == 206 and body == bytes(range(10, 20)) and hd["Content-Range"] == "bytes 10-19/100")
        code, hd, body = fetch("bytes=90-")
        check("an open-ended range runs to the end", code == 206 and body == bytes(range(90, 100)))
        check("a range past the end is refused", fetch("bytes=500-")[0] == 416)
    finally:
        tune.unlink()
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

    A.send({"c": "host", "transport": "lan", "game": "rising_rush", "max": 4})
    r = A.expect(lambda m: m["t"] == "room" and m["link"] == "up")
    check("the LAN link comes up with the host alone in the room",
          r is not None and len(r["slots"]) == 1 and r["slots"][0]["n"] == "ALICE"
          and r["game"] == "rising_rush" and r["max"] == 4)

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
          sa is not None and sb is not None and sa["seed"] == sb["seed"] and sa["game"] == "rising_rush")

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


def test_solo():
    print("solo test mode:")
    h, app, port, _ = start("solo")
    c = WSClient(port)
    c.expect(lambda m: m["t"] == "init")
    c.send({"c": "host", "transport": "solo", "game": "bobble_league"})
    r = c.expect(lambda m: m["t"] == "room" and m["phase"] == "playing")
    check("a solo room opens and goes straight into a game that normally needs 2 players",
          r is not None and r["solo"] and r["transport"] == "solo" and len(r["slots"]) == 1 and r["game"] == "bobble_league")
    c.send({"c": "stop_game"})
    r = c.expect(lambda m: m["t"] == "room" and m["phase"] == "lobby")
    check("it can go back to the lobby", r is not None and r["solo"])
    c.send({"c": "start"})
    check("and start again", c.expect(lambda m: m["t"] == "room" and m["phase"] == "playing") is not None)
    c.send({"c": "leave"})
    check("leaving closes the room", c.expect(lambda m: m["t"] == "closed") is not None)
    c.send({"c": "host", "transport": "solo", "game": "nope"})
    r = c.expect(lambda m: m["t"] == "room" and m["phase"] == "playing")
    check("an unknown game falls back to the saved one", r is not None and r["game"] in ("bobble_league", "rising_rush", "battle_tide", "letter_league", "liars_bar", "whos_away"))
    c.close()
    h.shutdown()
    app.stop()


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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def http(base, method, path, body=None, cookie=None, headers=None, raw=None):
    """-> (status, parsed json or None, response headers).  Redirects are reported, not followed."""
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"} if data is not None else {}
    if cookie:
        h["Cookie"] = cookie
    h.update(headers or {})
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        r = _opener.open(req)
        code, text, hd = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        code, text, hd = e.code, e.read(), e.headers
    try:
        js = json.loads(text)
    except ValueError:
        js = None
    return code, js, hd


def test_riddle():
    from g3 import lore
    print("the riddle:")
    check("the riddle is a few lines and never names its answer",
          len(lore.RIDDLE) >= 3 and not any(a in " ".join(lore.RIDDLE).lower() for a in lore.ANSWERS))
    check("Daivansh and Devonut both pass, in any case", all(lore.is_right(g) for g in ("daivansh", "Daivansh", "DEVONUT", "devonut")))
    check("a trailing 'san', spaces and punctuation are forgiven",
          all(lore.is_right(g) for g in ("Daivansho San", "daivansho-san", "Devonut san", "  devonut!  ", "daivanshosan")))
    check("anything else fails", not any(lore.is_right(g) for g in ("", "san", "daivan", "devon", "nobody", "devonuts", "daivansh devonut")))
    garbage = [True, {}, "x" * 1000, [1, 2, 3], -1, 99, None, [True], [["devonut"]], 1.5]
    check("garbage answers are just wrong; they don't crash the check", not any(lore.is_right(g) for g in garbage))
    check("one clearance level, solved or locked", lore.level_for(True)[0] == 1 and lore.level_for(False)[0] == 0
          and lore.rank_name(1) == lore.rank_name(4) == lore.PASS_RANK and lore.rank_name(0) == lore.LOCKED_RANK)


def test_login():
    print("login and the Riddle of the Rising Sun:")
    httpd, app, port, data = start("login", login=True)
    base = f"http://127.0.0.1:{port}"
    auth = httpd.RequestHandlerClass.auth
    code, _, hd = http(base, "GET", "/lobby.html")
    check("a page without a clearance redirects to the login", code == 302 and hd["Location"] == "/login.html")
    check("the root and the launcher redirect too", http(base, "GET", "/")[0] == 302 and http(base, "GET", "/index.html")[0] == 302)
    check("the login page and the scripts it needs are public",
          http(base, "GET", "/login.html")[0] == 200 and http(base, "GET", "/js/login.js")[0] == 200 and http(base, "GET", "/css/login.css")[0] == 200)
    page = urllib.request.urlopen(base + "/js/login.js").read().lower()
    check("the answers are not in any file the browser can fetch", b"daivansh" not in page and b"devonut" not in page)
    check("the bridge refuses a websocket without a clearance", WSClient(port).status == 401)
    st = http(base, "GET", "/api/auth/status")[1]
    check("status says: login enabled, nobody in", st["enabled"] and not st["authed"])

    code, js, _ = http(base, "POST", "/api/auth/register", {"name": "a b", "pass": "secret"})
    check("a callsign with spaces is refused", code == 400 and "Callsign" in js["error"])
    check("a short passcode is refused", http(base, "POST", "/api/auth/register", {"name": "okname", "pass": "abc"})[0] == 400)
    code, js, hd = http(base, "POST", "/api/auth/register", {"name": "Sunny", "pass": "daybreak!"})
    cookie = (hd["Set-Cookie"] or "").split(";")[0]
    check("registering logs you in", code == 200 and js["authed"] and js["level"] == 0 and not js["cleared"])
    check("the session cookie is HttpOnly and SameSite=Strict", "HttpOnly" in hd["Set-Cookie"] and "SameSite=Strict" in hd["Set-Cookie"])
    check("your callsign becomes your player name", app.settings["name"] == "Sunny")
    check("a new operator still can't reach the pages or the bridge",
          http(base, "GET", "/lobby.html", cookie=cookie)[0] == 302 and WSClient(port, cookie=cookie).status == 401)
    check("the callsign is taken (case-insensitively)", http(base, "POST", "/api/auth/register", {"name": "SUNNY", "pass": "other-pass"})[0] == 409)
    stored = (__import__("pathlib").Path(data) / "auth.json").read_text()
    check("the passcode is stored salted and hashed, never in the clear", "daybreak" not in stored and '"hash"' in stored and '"salt"' in stored)

    code, js, _ = http(base, "POST", "/api/auth/quiz", {})
    check("the riddle needs a login", code == 401)
    code, quiz, _ = http(base, "POST", "/api/auth/quiz", {}, cookie)
    check("the riddle is told line by line", code == 200 and isinstance(quiz["riddle"], list) and len(quiz["riddle"]) >= 3)
    check("and carries no answer", "daivansh" not in json.dumps(quiz).lower() and "devonut" not in json.dumps(quiz).lower())
    code, res, _ = http(base, "POST", "/api/auth/submit", {"id": "nope", "answer": "devonut"}, cookie)
    check("an answer for the wrong hearing is refused", code == 409)
    code, res, _ = http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answer": "Sunny"}, cookie)
    check("a wrong name: no clearance, a 15 s cooldown", code == 200 and not res["passed"] and res["level"] == 0 and res["retryIn"] == 15)
    check("the same hearing can't be answered twice", http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answer": "devonut"}, cookie)[0] == 409)
    code, js, _ = http(base, "POST", "/api/auth/quiz", {}, cookie)
    check("the gate stays closed during the cooldown", code == 429 and 0 < js["retryIn"] <= 15)
    check("status reports the cooldown", 0 < http(base, "GET", "/api/auth/status", cookie=cookie)[1]["retryIn"] <= 15)

    auth.accounts["sunny"]["retry_at"] = 0
    quiz = http(base, "POST", "/api/auth/quiz", {}, cookie)[1]
    code, res, _ = http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answer": "Daivansho San"}, cookie)
    check("the right name earns clearance level 1", code == 200 and res["passed"] and res["level"] == 1 and res["rank"] == "DAYBREAK")
    check("the pages open now", http(base, "GET", "/lobby.html", cookie=cookie)[0] == 200 and http(base, "GET", "/", cookie=cookie)[0] == 200)
    c = WSClient(port, cookie=cookie)
    check("and so does the bridge", c.status == 101 and c.expect(lambda m: m["t"] == "init") is not None)
    c.close()
    st = http(base, "GET", "/api/auth/status", cookie=cookie)[1]
    check("status shows the operator and rank", st["name"] == "Sunny" and st["rank"] == "DAYBREAK" and st["cleared"])

    quiz = http(base, "POST", "/api/auth/quiz", {}, cookie)[1]
    res = http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answer": "nobody"}, cookie)[1]
    st = http(base, "GET", "/api/auth/status", cookie=cookie)[1]
    check("a later wrong guess never takes the clearance away", res["level"] == 0 and res["best"] == 1 and st["level"] == 1 and st["cleared"])

    check("a cross-site page can't post to the login", http(base, "POST", "/api/auth/login", {"name": "Sunny", "pass": "daybreak!"}, headers={"Origin": "http://evil.example.com"})[0] == 403)
    check("login only takes JSON", http(base, "POST", "/api/auth/login", raw=b"name=Sunny", headers={"Content-Type": "text/plain"})[0] == 415)
    check("an oversized body is refused", http(base, "POST", "/api/auth/login", raw=b"{" + b" " * 70000 + b"}")[0] == 413)

    http(base, "POST", "/api/auth/logout", {}, cookie)
    check("logging out ends the session", not http(base, "GET", "/api/auth/status", cookie=cookie)[1]["authed"] and http(base, "GET", "/lobby.html", cookie=cookie)[0] == 302)

    code, js, _ = http(base, "POST", "/api/auth/login", {"name": "sunny", "pass": "wrong"})
    check("a wrong passcode is refused without saying which part was wrong", code == 401 and js["error"] == http(base, "POST", "/api/auth/login", {"name": "nobody", "pass": "wrong"})[1]["error"])
    codes = [http(base, "POST", "/api/auth/login", {"name": "sunny", "pass": "wrong"})[0] for _ in range(5)]
    code, js, _ = http(base, "POST", "/api/auth/login", {"name": "sunny", "pass": "daybreak!"})
    check("five wrong passcodes lock the callsign for a while, even for the right one", code == 429 and js["retryIn"] > 0)
    auth.fails.clear()
    code, js, hd = http(base, "POST", "/api/auth/login", {"name": "SUNNY", "pass": "daybreak!"})
    check("the right passcode gets in, and the rank came back from disk-backed state", code == 200 and js["rank"] == "DAYBREAK")

    from g3.auth import Auth
    again = Auth(data)
    tok2 = again.login("sunny", "daybreak!")
    check("accounts survive a restart", again.status(tok2)["level"] == 1)
    httpd.shutdown()
    app.stop()


def main():
    for fn in (test_riddle, test_login, test_guards, test_solo, test_two_servers_one_room, test_host_errors):
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
