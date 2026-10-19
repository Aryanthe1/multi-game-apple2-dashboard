"""Wire basics shared by every TCP transport (Wi-Fi/LAN, Tailscale, relay).

Framing is a 4-byte big-endian length followed by a UTF-8 JSON object.  A
Session is one connected pair (host side or guest side) after the hello
exchange; a Listener lets one host accept any number of guests.
"""
from __future__ import annotations

import json
import socket
import struct
import threading
import time

PROTO = 2                    # bumped when the app-level messages changed (room hub)
DEFAULT_PORT = 51337
RECV_TIMEOUT = 15.0


class Disconnected(Exception):
    pass


# ------------------------------------------------------------------ framing
def send_msg(sock, obj):
    try:
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        sock.sendall(struct.pack(">I", len(body)) + body)
    except (OSError, BrokenPipeError) as e:
        raise Disconnected(str(e))


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
        except socket.timeout:
            raise Disconnected("timeout")
        except OSError as e:
            raise Disconnected(str(e))
        if not chunk:
            raise Disconnected("peer closed")
        buf += chunk
    return buf


def recv_msg(sock):
    """Blocking read of one frame; for handshakes.  Use FrameReader in a poll loop."""
    (n,) = struct.unpack(">I", _recv_exact(sock, 4))
    if n > 1 << 20:
        raise Disconnected("oversized frame")
    try:
        return json.loads(_recv_exact(sock, n).decode("utf-8"))
    except ValueError:
        raise Disconnected("bad frame")


class FrameReader:
    """Reads frames from a socket that has a short timeout, for a polling reader thread.

    A timeout in the middle of a frame must not lose the bytes already read
    (recv_msg would, and the next read would then start mid-frame).  Here the
    partial data stays buffered; Disconnected("timeout") means only "no complete
    frame yet, try again".
    """

    def __init__(self, sock):
        self.sock = sock
        self.buf = bytearray()

    def _take(self):
        if len(self.buf) < 4:
            return None
        (n,) = struct.unpack(">I", self.buf[:4])
        if n > 1 << 20:
            raise Disconnected("oversized frame")
        if len(self.buf) < 4 + n:
            return None
        body = bytes(self.buf[4:4 + n])
        del self.buf[:4 + n]
        try:
            return json.loads(body.decode("utf-8"))
        except ValueError:
            raise Disconnected("bad frame")

    def read(self):
        while True:
            msg = self._take()
            if msg is not None:
                return msg
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                raise Disconnected("timeout")
            except OSError as e:
                raise Disconnected(str(e))
            if not chunk:
                raise Disconnected("peer closed")
            self.buf += chunk


# ------------------------------------------------------------------ sessions
def new_seed():
    return int(time.time() * 1000) & 0xFFFFFFFF


class Session:
    def __init__(self, sock, is_host: bool, player_name: str):
        self.sock = sock
        self.sock.settimeout(RECV_TIMEOUT)
        self.is_host = is_host
        self.name = player_name
        self.peer_name = "?"
        self.seed = 0
        self.alive = True

    # the hello exchange, the same on a LAN socket and through a relay
    @classmethod
    def host_handshake(cls, conn, player_name, seed=None):
        s = cls(conn, True, player_name)
        s.seed = seed if seed is not None else new_seed()
        send_msg(conn, {"t": "hello", "proto": PROTO, "name": player_name, "seed": s.seed})
        reply = recv_msg(conn)
        if reply.get("proto") != PROTO:
            raise Disconnected("the other player has a different game version")
        s.peer_name = str(reply.get("name", "?"))[:24]
        return s

    @classmethod
    def guest_handshake(cls, sock, player_name):
        s = cls(sock, False, player_name)
        hello = recv_msg(sock)
        if hello.get("proto") != PROTO:
            raise Disconnected("the other player has a different game version")
        s.seed = hello.get("seed", 0)
        s.peer_name = str(hello.get("name", "?"))[:24]
        send_msg(sock, {"t": "hello", "proto": PROTO, "name": player_name})
        return s

    @classmethod
    def host(cls, player_name, port=DEFAULT_PORT, seed=None, timeout=120, cancel=None):
        """Wait for ONE player to connect (two-player use).  `cancel` aborts the wait."""
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", port))
        srv.listen(1)
        srv.settimeout(0.5 if cancel is not None else timeout)
        deadline = time.time() + timeout
        while True:
            try:
                conn, _ = srv.accept()
                break
            except socket.timeout:
                if cancel is None or cancel.is_set() or time.time() >= deadline:
                    srv.close()
                    raise Disconnected("no one connected")
        srv.close()
        return cls.host_handshake(conn, player_name, seed)

    @classmethod
    def join(cls, player_name, host, port=DEFAULT_PORT):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        try:
            sock.connect((host, port))
        except OSError as e:
            sock.close()
            raise Disconnected(str(e))
        try:
            return cls.guest_handshake(sock, player_name)
        except Exception:
            sock.close()
            raise

    def close(self):
        self.alive = False
        try:
            send_msg(self.sock, {"t": "bye"})
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class Listener:
    """Accepts any number of guests on a TCP port; each connected, handshaken
    Session is passed to on_session(session) from a worker thread."""

    def __init__(self, player_name, on_session, port=DEFAULT_PORT):
        self.name = player_name
        self.on_session = on_session
        self.port = port
        self._stop = threading.Event()
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.srv.bind(("0.0.0.0", port))
        except OSError:
            self.srv.close()
            raise
        self.srv.listen(16)
        self.srv.settimeout(0.5)
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handshake, args=(conn,), daemon=True).start()
        try:
            self.srv.close()
        except OSError:
            pass

    def _handshake(self, conn):
        try:
            conn.settimeout(10)
            s = Session.host_handshake(conn, self.name)
        except Exception:
            try:
                conn.close()
            except OSError:
                pass
            return
        if self._stop.is_set():
            s.close()
            return
        self.on_session(s)

    def close(self):
        self._stop.set()


# ------------------------------------------------------------------ LAN discovery
class DiscoveryBeacon(threading.Thread):
    """Answers UDP "MF-DISCOVER" broadcasts with "MF-HERE <json>" while a room is open.

    `info` is a callable returning a small dict (name, players, max, game) so
    the searching side can list rooms with their occupancy."""

    def __init__(self, name, port=DEFAULT_PORT, info=None):
        super().__init__(daemon=True)
        self.name = name
        self.port = port + 1
        self.info = info
        self._stop_evt = threading.Event()

    def _payload(self):
        d = {"n": self.name}
        if self.info is not None:
            try:
                d.update(self.info())
            except Exception:
                pass
        return b"MF-HERE " + json.dumps(d, separators=(",", ":")).encode("utf-8")

    def run(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("", self.port))
        except OSError:
            return
        s.settimeout(0.5)
        while not self._stop_evt.is_set():
            try:
                data, addr = s.recvfrom(256)
                if data.startswith(b"MF-DISCOVER"):
                    s.sendto(self._payload(), addr)
            except socket.timeout:
                continue
            except OSError:
                break
        s.close()

    def stop(self):
        self._stop_evt.set()
