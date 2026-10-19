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


def perfect_answers(auth, token):
    """What a scholar would send for the trial in progress (read from the server's own key)."""
    out = []
    for k in auth.sessions[token].trial["key"]:
        if k["kind"] == "one":
            out.append(k["perm"].index(k["answer"]))
        elif k["kind"] == "multi":
            out.append(sorted(k["perm"].index(a) for a in k["answer"]))
        else:
            out.append(k["answer"][0])
    return out


def test_lore_bank():
    from g3 import lore
    print("the trial's question bank:")
    seen, bad = set(), []
    for sec in lore.SECTIONS:
        pool = lore.BANK[sec["id"]]
        if len(pool) < lore.PER_SECTION + 2:
            bad.append(f"{sec['id']} has too few questions")
        for kind, w, text, opts, ans in pool:
            if text in seen:
                bad.append(f"duplicate: {text[:40]}")
            seen.add(text)
            if w not in (1, 2, 3):
                bad.append(f"bad weight: {text[:40]}")
            if kind == "one" and not (len(set(opts)) == len(opts) >= 3 and 0 <= ans < len(opts)):
                bad.append(f"bad single choice: {text[:40]}")
            elif kind == "multi" and not (len(set(opts)) == len(opts) and ans and ans <= set(range(len(opts))) and len(ans) < len(opts)):
                bad.append(f"bad multi choice: {text[:40]}")
            elif kind == "text" and not (opts is None and ans and all(a == lore.norm(a) for a in ans)):
                bad.append(f"bad text question: {text[:40]}")
            elif kind not in ("one", "multi", "text"):
                bad.append(f"unknown kind: {kind}")
    check("every scroll is deep enough and every question is well formed" + (f" ({bad[:2]})" if bad else ""), not bad)
    import random
    pub, key = lore.build(random.Random(1))
    check(f"a trial draws {lore.PER_SECTION} questions from each of the {len(lore.SECTIONS)} scrolls",
          len(pub) == lore.PER_SECTION * len(lore.SECTIONS) and [q["n"] for q in pub] == list(range(len(pub))))
    check("the questions sent to the browser carry no answers", all(set(q) <= {"n", "s", "t", "q", "o"} for q in pub))
    perfect = []
    for k in key:
        perfect.append(k["perm"].index(k["answer"]) if k["kind"] == "one" else
                       sorted(k["perm"].index(a) for a in k["answer"]) if k["kind"] == "multi" else k["answer"][0])
    check("a perfect set of answers scores 100% and is a Shogun", lore.grade(key, perfect)["pct"] == 100 and lore.grade(key, perfect)["rank"] == "SHOGUN")
    check("no answers scores 0% and is a Ronin", lore.grade(key, [])["pct"] == 0 and lore.grade(key, [])["level"] == 0)
    garbage = [True, {}, "x" * 1000, [1, 2, 3], -1, 99, None, [True], [[1]], 1.5, "", [0, 0, 0, 0, 0, 0, 0, 0]] * 4
    check("garbage answers are just wrong; they don't crash the grader", lore.grade(key, garbage)["pct"] <= 5)
    check("typed answers ignore case, punctuation and macrons",
          lore.norm("Amaterasu-Ōmikami") == "amaterasuomikami" and lore.norm("Rōnin!") == "ronin")
    edges = {a: lore.level_for(a)[0] for a in (0, 49, 50, 64, 65, 79, 80, 92, 93, 100)}
    check("the rank thresholds are 50 / 65 / 80 / 93", edges == {0: 0, 49: 0, 50: 1, 64: 1, 65: 2, 79: 2, 80: 3, 92: 3, 93: 4, 100: 4})
    wrong_first = list(perfect)
    wrong_first[0] = "zzz"
    check("one wrong answer costs only its own weight", 90 <= lore.grade(key, wrong_first)["pct"] < 100)


def test_login():
    print("login and the Trial of the Rising Sun:")
    httpd, app, port, data = start("login", login=True)
    base = f"http://127.0.0.1:{port}"
    auth = httpd.RequestHandlerClass.auth
    code, _, hd = http(base, "GET", "/lobby.html")
    check("a page without a clearance redirects to the login", code == 302 and hd["Location"] == "/login.html")
    check("the root and the launcher redirect too", http(base, "GET", "/")[0] == 302 and http(base, "GET", "/index.html")[0] == 302)
    check("the login page and the scripts it needs are public",
          http(base, "GET", "/login.html")[0] == 200 and http(base, "GET", "/js/login.js")[0] == 200 and http(base, "GET", "/css/login.css")[0] == 200)
    check("the answers are not in any file the browser can fetch", b"Amaterasu" not in urllib.request.urlopen(base + "/js/login.js").read())
    check("the bridge refuses a websocket without a clearance", WSClient(port).status == 401)
    st = http(base, "GET", "/api/auth/status")[1]
    check("status says: login enabled, nobody in", st["enabled"] and not st["authed"])

    code, js, _ = http(base, "POST", "/api/auth/register", {"name": "a b", "pass": "secret"})
    check("a callsign with spaces is refused", code == 400 and "Callsign" in js["error"])
    check("a short passcode is refused", http(base, "POST", "/api/auth/register", {"name": "okname", "pass": "abc"})[0] == 400)
    code, js, hd = http(base, "POST", "/api/auth/register", {"name": "Hanzo", "pass": "kitsune!"})
    cookie = (hd["Set-Cookie"] or "").split(";")[0]
    check("registering logs you in", code == 200 and js["authed"] and js["level"] == 0 and not js["cleared"])
    check("the session cookie is HttpOnly and SameSite=Strict", "HttpOnly" in hd["Set-Cookie"] and "SameSite=Strict" in hd["Set-Cookie"])
    check("your callsign becomes your player name", app.settings["name"] == "Hanzo")
    check("a new operator still can't reach the pages or the bridge",
          http(base, "GET", "/lobby.html", cookie=cookie)[0] == 302 and WSClient(port, cookie=cookie).status == 401)
    check("the callsign is taken (case-insensitively)", http(base, "POST", "/api/auth/register", {"name": "HANZO", "pass": "other-pass"})[0] == 409)
    stored = (__import__("pathlib").Path(data) / "auth.json").read_text()
    check("the passcode is stored salted and hashed, never in the clear", "kitsune" not in stored and '"hash"' in stored and '"salt"' in stored)

    code, js, _ = http(base, "POST", "/api/auth/quiz", {})
    check("the trial needs a login", code == 401)
    code, quiz, _ = http(base, "POST", "/api/auth/quiz", {}, cookie)
    check("a trial is 36 questions over 6 scrolls", code == 200 and quiz["total"] == 36 and len(quiz["sections"]) == 6)
    check("and carries no answer key", "answer" not in json.dumps(quiz) and all(set(q) <= {"n", "s", "t", "q", "o"} for q in quiz["questions"]))
    code, res, _ = http(base, "POST", "/api/auth/submit", {"id": "nope", "answers": []}, cookie)
    check("answers for the wrong trial are refused", code == 409)
    tok = cookie.split("=", 1)[1]
    code, res, _ = http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answers": [0] * 36}, cookie)
    check("a failed trial is Ronin: no clearance, a 60 s cooldown", code == 200 and not res["passed"] and res["level"] == 0 and res["retryIn"] == 60)
    check("the same trial can't be submitted twice", http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answers": [0] * 36}, cookie)[0] == 409)
    code, js, _ = http(base, "POST", "/api/auth/quiz", {}, cookie)
    check("the shrine stays closed during the cooldown", code == 429 and 0 < js["retryIn"] <= 60)
    check("status reports the cooldown", 0 < http(base, "GET", "/api/auth/status", cookie=cookie)[1]["retryIn"] <= 60)

    auth.accounts["hanzo"]["retry_at"] = 0
    quiz = http(base, "POST", "/api/auth/quiz", {}, cookie)[1]
    code, res, _ = http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answers": perfect_answers(auth, tok)}, cookie)
    check("a perfect trial earns SHOGUN, level 4", code == 200 and res["passed"] and res["pct"] == 100 and res["rank"] == "SHOGUN" and res["level"] == 4)
    check("with a result for every scroll", len(res["sections"]) == 6 and all(s["pct"] == 100 for s in res["sections"]))
    check("the pages open now", http(base, "GET", "/lobby.html", cookie=cookie)[0] == 200 and http(base, "GET", "/", cookie=cookie)[0] == 200)
    c = WSClient(port, cookie=cookie)
    check("and so does the bridge", c.status == 101 and c.expect(lambda m: m["t"] == "init") is not None)
    c.close()
    st = http(base, "GET", "/api/auth/status", cookie=cookie)[1]
    check("status shows the operator and rank", st["name"] == "Hanzo" and st["rank"] == "SHOGUN" and st["cleared"])

    quiz = http(base, "POST", "/api/auth/quiz", {}, cookie)[1]
    res = http(base, "POST", "/api/auth/submit", {"id": quiz["id"], "answers": []}, cookie)[1]
    st = http(base, "GET", "/api/auth/status", cookie=cookie)[1]
    check("a later bad trial never takes a rank away", res["level"] == 0 and res["best"] == 4 and st["level"] == 4 and st["cleared"])

    check("a cross-site page can't post to the login", http(base, "POST", "/api/auth/login", {"name": "Hanzo", "pass": "kitsune!"}, headers={"Origin": "http://evil.example.com"})[0] == 403)
    check("login only takes JSON", http(base, "POST", "/api/auth/login", raw=b"name=Hanzo", headers={"Content-Type": "text/plain"})[0] == 415)
    check("an oversized body is refused", http(base, "POST", "/api/auth/login", raw=b"{" + b" " * 70000 + b"}")[0] == 413)

    http(base, "POST", "/api/auth/logout", {}, cookie)
    check("logging out ends the session", not http(base, "GET", "/api/auth/status", cookie=cookie)[1]["authed"] and http(base, "GET", "/lobby.html", cookie=cookie)[0] == 302)

    code, js, _ = http(base, "POST", "/api/auth/login", {"name": "hanzo", "pass": "wrong"})
    check("a wrong passcode is refused without saying which part was wrong", code == 401 and js["error"] == http(base, "POST", "/api/auth/login", {"name": "nobody", "pass": "wrong"})[1]["error"])
    codes = [http(base, "POST", "/api/auth/login", {"name": "hanzo", "pass": "wrong"})[0] for _ in range(5)]
    code, js, _ = http(base, "POST", "/api/auth/login", {"name": "hanzo", "pass": "kitsune!"})
    check("five wrong passcodes lock the callsign for a while, even for the right one", code == 429 and js["retryIn"] > 0)
    auth.fails.clear()
    code, js, hd = http(base, "POST", "/api/auth/login", {"name": "HANZO", "pass": "kitsune!"})
    check("the right passcode gets in, and the rank came back from disk-backed state", code == 200 and js["rank"] == "SHOGUN")

    from g3.auth import Auth
    again = Auth(data)
    tok2 = again.login("hanzo", "kitsune!")
    check("accounts survive a restart", again.status(tok2)["level"] == 4)
    httpd.shutdown()
    app.stop()


def main():
    for fn in (test_lore_bank, test_login, test_guards, test_two_servers_one_room, test_host_errors):
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
