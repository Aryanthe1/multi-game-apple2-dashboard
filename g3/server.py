"""Serves the web UI and the WebSocket bridge on this computer only.

    python -m g3                 # opens http://127.0.0.1:8733
    python -m g3 --port 8800 --data ~/.g3_player2     # a second copy for testing

Only loopback is bound, and every request's Host / Origin must be loopback too,
so other machines -- and other web pages open in your browser -- can't drive the
room, the serial ports or your settings.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import os
import shutil
import socket
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from g3.app import App, Client
from g3.auth import Auth, AuthError
from g3.ws import WebSocket, accept_key

WEB = Path(__file__).resolve().parent / "web"
DEFAULT_PORT = 8733

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("audio/wav", ".wav")
mimetypes.add_type("audio/mp4", ".m4a")


class Handler(BaseHTTPRequestHandler):
    server_version = "G3"
    app: App = None                   # set by make_server()
    auth: Auth = None                 # None: no login (tests, --no-login)
    cookie_name = "g3s"               # includes the port: cookies are shared between ports on 127.0.0.1
    allowed_hosts: set = set()

    def log_message(self, fmt, *args):
        pass

    # ---- login
    def _token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == self.cookie_name:
                return value
        return None

    def _cleared(self):
        return self.auth is None or self.auth.cleared(self._token())

    def _redirect(self, where):
        self.send_response(302)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _json(self, code, obj, cookie=None):
        self._send(code, "application/json", json.dumps(obj).encode(), [("Set-Cookie", cookie)] if cookie else ())

    def _set_cookie(self, token, age=43200):
        return f"{self.cookie_name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}"

    def do_POST(self):
        if not self._loopback_ok() or not self._origin_ok():
            return self._deny()
        path = urlparse(self.path).path
        if self.auth is None or not path.startswith("/api/auth/"):
            return self._deny(404, "not found")
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._deny(415, "json only")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if not 0 <= n <= 65536:
            return self._deny(413, "too large")
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad request"})
        what, tok = path[len("/api/auth/"):], self._token()
        if not isinstance(body, dict):
            body = {}
        try:
            if what in ("login", "register"):
                tok = (self.auth.login if what == "login" else self.auth.register)(body.get("name"), body.get("pass"))
                self.app.set_name(self.auth.name_of(tok))
                return self._json(200, dict(self.auth.status(tok), ok=True), self._set_cookie(tok))
            if what == "logout":
                self.auth.logout(tok)
                return self._json(200, {"ok": True}, self._set_cookie("", 0))
            if what == "quiz":
                return self._json(200, self.auth.start_trial(tok))
            if what == "submit":
                return self._json(200, self.auth.submit_trial(tok, body.get("id"), body.get("answer")))
        except AuthError as e:
            return self._json(e.status, {"error": str(e), "retryIn": e.retry_in})
        self._deny(404, "not found")

    # ---- request guards
    def _loopback_ok(self):
        host = (self.headers.get("Host") or "").lower()
        return host in self.allowed_hosts

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return True                          # not a browser
        o = urlparse(origin)
        return o.scheme == "http" and (o.netloc or "").lower() in self.allowed_hosts

    def _deny(self, code=403, text="forbidden"):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- routes
    def do_GET(self):
        if not self._loopback_ok():
            return self._deny()
        path = urlparse(self.path).path
        if path == "/ws":
            if not self._cleared():
                return self._deny(401, "log in first")
            return self._websocket()
        if path == "/api/health":
            body = json.dumps({"ok": True, "app": "g3"}).encode()
            return self._send(200, "application/json", body)
        if path == "/api/auth/status":
            st = {"enabled": False, "authed": True, "cleared": True} if self.auth is None \
                else dict(self.auth.status(self._token()), enabled=True)
            return self._send(200, "application/json", json.dumps(st).encode(), [("Cache-Control", "no-store")])
        if (path.endswith(".html") or path.endswith("/")) and path != "/login.html" and not self._cleared():
            return self._redirect("/login.html")                 # the pages need a clearance; scripts and styles are public
        self._static(path)

    def do_HEAD(self):
        self._deny(405, "method not allowed")

    def _send(self, code, ctype, body, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        if not any(k == "Cache-Control" for k, _ in extra):
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB)
        except ValueError:
            return self._deny(404, "not found")
        if not target.is_file() or any(part.startswith(".") for part in target.relative_to(WEB).parts):
            return self._deny(404, "not found")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/json", "application/javascript"):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        rng = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "") if ctype.startswith("audio/") else None
        if rng and (rng.group(1) or rng.group(2)):               # audio needs byte ranges to seek (resuming the music on the next page)
            n = len(data)
            a, b = (n - int(rng.group(2)), n - 1) if not rng.group(1) else (int(rng.group(1)), int(rng.group(2) or n - 1))
            b = min(b, n - 1)
            if a > b or a >= n:
                return self._send(416, "text/plain", b"", [("Content-Range", f"bytes */{n}")])
            return self._send(206, ctype, data[a:b + 1], [("Content-Range", f"bytes {a}-{b}/{n}"), ("Accept-Ranges", "bytes")])
        self._send(200, ctype, data, [("Accept-Ranges", "bytes")] if ctype.startswith("audio/") else ())

    def _websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if (self.headers.get("Upgrade", "").lower() != "websocket" or not key
                or self.headers.get("Sec-WebSocket-Version") != "13"):
            return self._deny(400, "websocket upgrade required")
        if not self._origin_ok():
            return self._deny()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept_key(key))
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        ws = WebSocket(self.rfile, self.connection)
        client = Client(ws)
        self.app.add_client(client)
        try:
            while True:
                text = ws.recv()
                if text is None:
                    break
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    self.app.command(client, msg)
        finally:
            self.app.remove_client(client)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def make_server(host="127.0.0.1", port=DEFAULT_PORT, data="~/.g3", scan=True, login=False):
    """Open the app and an HTTP server on the first free port from `port`.  With login=True every page and the
    WebSocket need a clearance earned through the Riddle of the Rising Sun (g3/auth.py)."""
    app = App(data)
    hosts = set()
    handler = type("BoundHandler", (Handler,), {"app": app, "allowed_hosts": hosts,
                                                "auth": Auth(app.data_dir) if login else None})
    last = None
    for p in range(port, port + (20 if scan else 1)):
        try:
            httpd = Server((host, p), handler)
            break
        except OSError as e:
            last = e
    else:
        app.stop()
        raise SystemExit(f"G3: couldn't open a port near {port}: {last}")
    port = httpd.server_address[1]
    hosts.update({f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"})
    handler.cookie_name = f"g3s_{port}"
    return httpd, app, port


def already_running(port):
    """Is a G3 already answering on this port?  (Starting a second one would host the same saved
    room code twice, and a friend joining would talk to only one of them.)"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return json.load(r).get("app") == "g3"
    except (OSError, ValueError):
        return False


def find_browser():
    """A Chromium-based browser (Edge, Chrome, Chromium) that can show the page as a bare app window."""
    env = os.environ
    candidates = [
        os.path.join(env.get("ProgramFiles(x86)", ""), "Microsoft/Edge/Application/msedge.exe"),
        os.path.join(env.get("ProgramFiles", ""), "Microsoft/Edge/Application/msedge.exe"),
        os.path.join(env.get("ProgramFiles", ""), "Google/Chrome/Application/chrome.exe"),
        os.path.join(env.get("ProgramFiles(x86)", ""), "Google/Chrome/Application/chrome.exe"),
        os.path.join(env.get("LOCALAPPDATA", ""), "Google/Chrome/Application/chrome.exe"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_window(url, data):
    """Open `url` in its own app-style window (no tabs or address bar).  Returns the browser process,
    which lives exactly as long as the window, or None if no suitable browser was found."""
    exe = find_browser()
    if exe is None:
        return None
    profile = os.path.join(os.path.expanduser(str(data)), "window")      # its own profile: its own process
    try:
        return subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                                 "--no-default-browser-check", "--window-size=1360,900",
                                 # the host's page runs the match: don't let a covered/minimised window slow it down
                                 "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
                                 "--disable-backgrounding-occluded-windows"])
    except OSError:
        return None


def serve(host="127.0.0.1", port=DEFAULT_PORT, data="~/.g3", open_browser=True, scan=True, window=True, login=True):
    if scan and already_running(port):
        url = f"http://127.0.0.1:{port}/"
        print(f"G3 is already running at {url}; opening that one instead of starting another.")
        if open_browser and not (window and open_window(url, data)):
            webbrowser.open(url)
        return 0
    httpd, app, port = make_server(host, port, data, scan, login)
    url = f"http://127.0.0.1:{port}/"
    print(f"G3 is running at {url}   (close the G3 window or press Ctrl+C to quit)")
    print(f"  your name: {app.settings['name']}    data: {app.data_dir}")

    def show():
        proc = open_window(url, data) if window else None
        if proc is None:
            webbrowser.open(url)                  # no Chromium browser: a normal tab, and the console stays the way to quit
            return
        proc.wait()                               # the window was closed: quit
        httpd.shutdown()
    if open_browser:
        threading.Timer(0.4, lambda: threading.Thread(target=show, daemon=True).start()).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        httpd.server_close()
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="g3", description="G3 multiplayer game launcher")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="UI port (default %(default)s; the next free one is used if busy)")
    ap.add_argument("--data", default=os.environ.get("G3_DATA", "~/.g3"), help="settings folder (use a different one for a second copy)")
    ap.add_argument("--no-browser", action="store_true", help="don't open any window")
    ap.add_argument("--tab", action="store_true", help="open a normal browser tab instead of an app window")
    ap.add_argument("--no-login", action="store_true", help="skip the login and the Riddle of the Rising Sun (development)")
    args = ap.parse_args(argv)
    return serve(port=args.port, data=args.data, open_browser=not args.no_browser, window=not args.tab,
                 login=not (args.no_login or os.environ.get("G3_NOLOGIN")))


if __name__ == "__main__":
    sys.exit(main())
