"""Internet play through a relay (no port forwarding on either player's side).

Run the relay somewhere everybody can reach, e.g. a cheap cloud VM or a PC
whose router forwards one TCP port:

    python -m game.relay --port 47900

Players then choose "Relay" in the link dialog, type the relay's address and a
room code.  The relay only forwards bytes; everything else (handshake, room
hub, chat) is identical to Wi-Fi play.

Protocol v2 (any number of guests per room):
  host  -> b"MFRELAY2 HOST <room>\\n"   relay answers OK (or BUSY); this
                                        connection stays open as a control channel
  guest -> b"MFRELAY2 JOIN <room>\\n"   relay answers NOHOST / FULL / TIMEOUT, or
                                        tells the host "NEW <token>" and waits
  host  -> b"MFRELAY2 ACCEPT <room> <token>\\n" on a fresh connection; the relay
                                        then sends HOST to it and JOIN to the guest
                                        and pipes the two together.
Protocol v1 (exactly two players, kept for older clients):
  client sends b"MFRELAY1 <room>\\n"; relay replies WAIT until a partner arrives,
  then HOST to the first and JOIN to the second.
"""
from __future__ import annotations

import argparse
import asyncio
import re
import secrets
import socket
import threading
import time

from game.engine import net

DEFAULT_RELAY_PORT = 47900
ROOM_RE = re.compile(r"^[A-Z0-9_-]{1,32}$")
MAX_PENDING = 32
ACCEPT_TIMEOUT = 15


# ------------------------------------------------------------------ server
class HostRoom:
    def __init__(self, writer):
        self.control = writer
        self.pending = {}                  # token -> (reader, writer, future)


class RelayServer:
    def __init__(self):
        self.waiting = {}                  # v1: room -> (reader, writer, since)
        self.rooms = {}                    # v2: room -> HostRoom

    async def handle(self, reader, writer):
        peer = writer.get_extra_info("peername")
        try:
            line = await asyncio.wait_for(reader.readline(), 15)
        except (asyncio.TimeoutError, ConnectionError):
            writer.close()
            return
        text = line.decode(errors="replace").strip()
        if text.startswith("MFRELAY2 "):
            await self._v2(reader, writer, peer, text.split(" "))
            return
        parts = text.split(" ", 1)
        if len(parts) != 2 or parts[0] != "MFRELAY1" or not (1 <= len(parts[1]) <= 32):
            writer.close()
            return
        await self._v1(reader, writer, peer, parts[1].upper())

    # ---- v1: exactly two players
    async def _v1(self, reader, writer, peer, room):
        other = self.waiting.pop(room, None)
        if other is not None and other[1].is_closing():
            other = None
        if other is None:
            self.waiting[room] = (reader, writer, time.time())
            writer.write(b"WAIT\n")
            await writer.drain()
            print(f"[relay] {peer} waiting in room {room}")
            return                          # the partner's handler will pipe both ways
        o_reader, o_writer, _ = other
        o_writer.write(b"HOST\n")
        writer.write(b"JOIN\n")
        await o_writer.drain()
        await writer.drain()
        print(f"[relay] room {room}: paired {o_writer.get_extra_info('peername')} <-> {peer}")
        await self._pipe_pair(o_reader, o_writer, reader, writer)
        print(f"[relay] room {room} closed")

    @staticmethod
    async def _pipe_pair(r1, w1, r2, w2):
        async def pipe(src, dst):
            try:
                while True:
                    data = await src.read(65536)
                    if not data:
                        break
                    dst.write(data)
                    await dst.drain()
            except (ConnectionError, asyncio.IncompleteReadError):
                pass
            finally:
                dst.close()
        await asyncio.gather(pipe(r1, w2), pipe(r2, w1))

    # ---- v2: a host and any number of guests
    async def _v2(self, reader, writer, peer, parts):
        verb = parts[1] if len(parts) > 1 else ""
        room = parts[2].upper() if len(parts) > 2 else ""
        if not ROOM_RE.match(room):
            writer.close()
            return
        if verb == "HOST":
            await self._v2_host(reader, writer, peer, room)
        elif verb == "JOIN":
            await self._v2_join(reader, writer, peer, room)
        elif verb == "ACCEPT" and len(parts) > 3:
            await self._v2_accept(reader, writer, peer, room, parts[3])
        else:
            writer.close()

    async def _v2_host(self, reader, writer, peer, room):
        old = self.rooms.get(room)
        if old is not None and not old.control.is_closing():
            writer.write(b"BUSY\n")
            await writer.drain()
            writer.close()
            return
        hr = HostRoom(writer)
        self.rooms[room] = hr
        writer.write(b"OK\n")
        await writer.drain()
        print(f"[relay] {peer} is hosting room {room}")
        try:
            while await reader.read(256):     # the host only sends the odd keep-alive
                pass
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            if self.rooms.get(room) is hr:
                del self.rooms[room]
            for _, w, fut in list(hr.pending.values()):
                if not fut.done():
                    fut.cancel()
                w.close()
            hr.pending.clear()
            writer.close()
            print(f"[relay] room {room} closed (host left)")

    async def _v2_join(self, reader, writer, peer, room):
        hr = self.rooms.get(room)
        if hr is None or hr.control.is_closing():
            writer.write(b"NOHOST\n")
            await writer.drain()
            writer.close()
            return
        if len(hr.pending) >= MAX_PENDING:
            writer.write(b"FULL\n")
            await writer.drain()
            writer.close()
            return
        token = secrets.token_hex(8)
        fut = asyncio.get_running_loop().create_future()
        hr.pending[token] = (reader, writer, fut)
        try:
            hr.control.write(f"NEW {token}\n".encode())
            await hr.control.drain()
            await asyncio.wait_for(asyncio.shield(fut), ACCEPT_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.CancelledError, ConnectionError):
            if hr.pending.pop(token, None) is not None:
                try:
                    writer.write(b"TIMEOUT\n")
                    await writer.drain()
                except ConnectionError:
                    pass
                writer.close()
        # on success the host's ACCEPT handler pipes both ways

    async def _v2_accept(self, reader, writer, peer, room, token):
        hr = self.rooms.get(room)
        entry = hr.pending.pop(token, None) if hr is not None else None
        if entry is None:
            writer.close()
            return
        g_reader, g_writer, fut = entry
        if not fut.done():
            fut.set_result(True)
        writer.write(b"HOST\n")
        g_writer.write(b"JOIN\n")
        try:
            await writer.drain()
            await g_writer.drain()
        except ConnectionError:
            writer.close()
            g_writer.close()
            return
        print(f"[relay] room {room}: guest {g_writer.get_extra_info('peername')} piped to host")
        await self._pipe_pair(reader, writer, g_reader, g_writer)

    async def reaper(self):
        while True:
            await asyncio.sleep(30)
            now = time.time()
            for room, (_, w, since) in list(self.waiting.items()):
                if now - since > 1800 or w.is_closing():
                    self.waiting.pop(room, None)
                    w.close()
            for room, hr in list(self.rooms.items()):
                try:
                    hr.control.write(b"PING\n")          # keeps NATs and dead-host detection honest
                except Exception:
                    pass


async def serve(port):
    rs = RelayServer()
    server = await asyncio.start_server(rs.handle, "0.0.0.0", port)
    print(f"G3 relay listening on TCP port {port}")
    asyncio.create_task(rs.reaper())
    async with server:
        await server.serve_forever()


# ------------------------------------------------------------------ client
def _readline(sock, cancel, deadline):
    buf = b""
    while not buf.endswith(b"\n"):
        if cancel is not None and cancel.is_set():
            raise net.Disconnected("cancelled")
        if time.time() > deadline:
            raise net.Disconnected("nobody else joined the room in time")
        try:
            c = sock.recv(1)
        except socket.timeout:
            continue
        except OSError as e:
            raise net.Disconnected(str(e))
        if not c:
            raise net.Disconnected("relay closed the connection")
        buf += c
    return buf.decode(errors="replace").strip()


def _split_addr(relay_addr):
    host, _, port = relay_addr.strip().partition(":")
    if not host:
        raise ValueError("type the relay's address first")
    return host, int(port) if port else DEFAULT_RELAY_PORT


def _clean_room(room):
    room = room.strip().upper()
    if not ROOM_RE.match(room):
        raise ValueError("room codes use letters, digits and dashes (up to 32)")
    return room


def connect(player_name, relay_addr, room, cancel=None, wait=900):
    """v1: returns a net.Session connected to the other player through the relay."""
    host, port = _split_addr(relay_addr)
    sock = socket.create_connection((host, port), timeout=10)
    sock.settimeout(0.5)
    sock.sendall(f"MFRELAY1 {room.strip().upper()}\n".encode())
    deadline = time.time() + wait
    role = _readline(sock, cancel, deadline)
    while role == "WAIT":
        role = _readline(sock, cancel, deadline)
    sock.settimeout(net.RECV_TIMEOUT)
    if role == "HOST":
        return net.Session.host_handshake(sock, player_name)
    return net.Session.guest_handshake(sock, player_name)


def join(player_name, relay_addr, room, cancel=None, wait=ACCEPT_TIMEOUT + 5):
    """v2 guest: returns a net.Session to the room's host."""
    host, port = _split_addr(relay_addr)
    room = _clean_room(room)
    sock = socket.create_connection((host, port), timeout=10)
    try:
        sock.settimeout(0.5)
        sock.sendall(f"MFRELAY2 JOIN {room}\n".encode())
        answer = _readline(sock, cancel, time.time() + wait)
        if answer == "NOHOST":
            raise net.Disconnected("nobody is hosting that room on this relay (is the host connected?)")
        if answer == "FULL":
            raise net.Disconnected("the relay's waiting list for that room is full")
        if answer != "JOIN":
            raise net.Disconnected("the host didn't answer in time")
        sock.settimeout(net.RECV_TIMEOUT)
        return net.Session.guest_handshake(sock, player_name)
    except Exception:
        sock.close()
        raise


class RelayHost:
    """v2 host: holds the control connection and hands every guest's Session to on_session."""

    def __init__(self, player_name, relay_addr, room, on_session, cancel=None):
        self.name = player_name
        self.on_session = on_session
        self.room = _clean_room(room)
        self.addr = _split_addr(relay_addr)
        self.alive = True
        self.sock = socket.create_connection(self.addr, timeout=10)
        try:
            self.sock.settimeout(0.5)
            self.sock.sendall(f"MFRELAY2 HOST {self.room}\n".encode())
            answer = _readline(self.sock, cancel, time.time() + 10)
        except Exception:
            self.sock.close()
            raise
        if answer != "OK":
            self.sock.close()
            raise net.Disconnected("that room code is already being hosted on this relay")
        threading.Thread(target=self._control, daemon=True).start()

    def _control(self):
        buf = b""
        while self.alive:
            try:
                c = self.sock.recv(256)
            except socket.timeout:
                continue
            except OSError:
                break
            if not c:
                break
            buf += c
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                parts = line.decode(errors="replace").strip().split(" ")
                if len(parts) == 2 and parts[0] == "NEW":
                    threading.Thread(target=self._accept, args=(parts[1],), daemon=True).start()
        self.alive = False

    def _accept(self, token):
        try:
            s = socket.create_connection(self.addr, timeout=10)
        except OSError:
            return
        try:
            s.settimeout(0.5)
            s.sendall(f"MFRELAY2 ACCEPT {self.room} {token}\n".encode())
            if _readline(s, None, time.time() + 10) != "HOST":
                raise net.Disconnected("relay refused the guest")
            s.settimeout(net.RECV_TIMEOUT)
            sess = net.Session.host_handshake(s, self.name)
        except Exception:
            try:
                s.close()
            except OSError:
                pass
            return
        if self.alive:
            self.on_session(sess)
        else:
            sess.close()

    def close(self):
        self.alive = False
        try:
            self.sock.close()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description="G3 internet relay")
    ap.add_argument("--port", type=int, default=DEFAULT_RELAY_PORT)
    args = ap.parse_args()
    try:
        asyncio.run(serve(args.port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
