"""Multiplayer tests: python -m game.tests

Everything runs on loopback (real sockets, the real relay server, a tiny fake
MQTT broker for the online transport, an in-memory pair of radio ports).
"""
from __future__ import annotations

import asyncio
import json
import socket
import struct
import sys
import threading
import time

from game import hub as hubmod
from game.engine import net
from game.multiplayer import Lobby, Link

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


def pump(rooms, cond, timeout=6.0):
    """Tick every room like the app's loop does until cond() is true; returns events seen."""
    seen = []
    end = time.time() + timeout
    while time.time() < end:
        for r in rooms:
            seen.extend(r.step())
        if cond():
            return seen
        time.sleep(0.02)
    for r in rooms:
        seen.extend(r.step())
    return seen if cond() else None


def drive(rooms, secs, until=lambda: False):
    """Tick the rooms for up to `secs` (or until `until()`); returns {room: [events]}."""
    out = {id(r): [] for r in rooms}
    end = time.time() + secs
    while time.time() < end:
        for r in rooms:
            out[id(r)].extend(r.step())
        if until():
            break
        time.sleep(0.02)
    return out


def slot_names(room):
    return [s["n"] for s in room.snapshot()["slots"]]


# ------------------------------------------------------------------ framing
def test_framing():
    print("framing:")
    a, b = socket.socketpair()
    b.settimeout(0.2)
    body = json.dumps({"t": "x", "pad": "y" * 5000}).encode()
    frame = struct.pack(">I", len(body)) + body
    rd = net.FrameReader(b)
    a.sendall(frame[:100])
    try:
        rd.read()
        timed_out = False
    except net.Disconnected as e:
        timed_out = "timeout" in str(e)
    check("a timeout mid-frame keeps the bytes already read", timed_out and len(rd.buf) == 100)
    a.sendall(frame[100:] + struct.pack(">I", 2) + b"{}")
    m1, m2 = rd.read(), rd.read()
    check("the frame completes intact after the timeout", m1["pad"] == "y" * 5000 and m2 == {})
    a.close()
    try:
        rd.read()
        closed = False
    except net.Disconnected as e:
        closed = "peer closed" in str(e)
    check("a closed peer raises Disconnected", closed)
    b.close()
    c, d = socket.socketpair()
    d.sendall(struct.pack(">I", 1 << 22))
    try:
        net.FrameReader(c).read()
        big = False
    except net.Disconnected:
        big = True
    check("an oversized frame is refused", big)
    c.close()
    d.close()


# ------------------------------------------------------------------ LAN rooms with several guests
def lan_room(max_players=4, game="rising_rush"):
    port = free_port()
    hub = hubmod.Hub("HOST", "lan", game=game, max_players=max_players)
    lob = Lobby("HOST", port=port)
    lob.host_lan(hub.add_link, hub.beacon_info)
    assert pump([hub], lambda: lob.state == "hosting", 4) is not None
    hub.transport_up()
    return port, hub, lob


def join_lan(port, name):
    lob = Lobby(name, port=port)
    got = []
    lob.join_lan(f"127.0.0.1:{port}", got.append)
    end = time.time() + 5
    while not got and time.time() < end:
        time.sleep(0.02)
    assert got, f"{name} couldn't connect: {lob.msg}"
    return lob, hubmod.Guest(name, got[0], "lan")


def test_lan_room():
    print("LAN room, three guests:")
    port, hub, lob = lan_room(max_players=4)
    guests = [join_lan(port, n)[1] for n in ("ANA", "BEN", "CAL")]
    rooms = [hub] + guests
    ok = pump(rooms, lambda: len(hub.peers) == 3 and all(g.you for g in guests), 6)
    check("host sees three guests and each guest knows its slot", ok is not None)
    check("slots are numbered 0..3", sorted(s["id"] for s in hub.snapshot()["slots"]) == [0, 1, 2, 3])
    check("guests got the same roster the host has",
          all(slot_names(g) == slot_names(hub) for g in guests))

    guests[0].set_ready(True)
    pump(rooms, lambda: hub.peers[1].ready, 3)
    check("a guest's ready flag reaches the host", hub.peers[1].ready)
    check("start is refused while somebody isn't ready", hub.start()[0] is False)

    guests[1].chat("hello room")
    seen = drive(rooms, 2.0, until=lambda: False)

    def chats(room):
        return [(e["n"], e["m"]) for e in seen[id(room)] if e["t"] == "chat"]
    check("chat reaches the host", ("BEN", "hello room") in chats(hub))
    check("chat is relayed to the other guests and echoed to the sender",
          all(("BEN", "hello room") in chats(g) for g in guests))

    got = {g.name: [] for g in guests}

    def collect():
        for g in guests:
            got[g.name] += [e for e in g.step() if e["t"] == "game"]
        return False
    guests[2].send_game({"x": 1})
    host_ev = []
    end = time.time() + 1.5
    while time.time() < end:
        host_ev += [e for e in hub.step() if e["t"] == "game"]
        collect()
        time.sleep(0.02)
    check("a game message goes to the host and every OTHER guest",
          len(host_ev) == 1 and host_ev[0]["from"] == 3 and got["ANA"] and got["BEN"] and not got["CAL"])

    check("a guest can't pick the game", guests[0].select_game("liars_bar")[0] is False)
    guests[1].set_ready(True)
    guests[2].set_ready(True)
    pump(rooms, lambda: all(p.ready for p in hub.peers.values()), 3)
    check("host can start once everyone is ready", hub.start()[0] is True)
    started = pump(rooms, lambda: all(g.snapshot()["phase"] == "playing" for g in guests), 3)
    check("every guest is told the game started", started is not None)

    lob2, late = join_lan(port, "LATE")
    pump(rooms + [late], lambda: late.closed, 4)
    check("someone joining a running game is refused", late.closed and "running" in late.why)
    check("host can go back to the lobby", hub.stop_game()[0] is True)

    guests[0].close()
    pump(rooms, lambda: len(hub.peers) == 2, 4)
    check("host notices a guest leaving", sorted(hub.peers) == [2, 3])
    check("kick removes a guest", hub.kick(2)[0] is True)
    pump(rooms, lambda: guests[1].closed, 3)
    check("the kicked guest is told", guests[1].closed and "removed" in guests[1].why)

    hub.close()
    pump(rooms, lambda: guests[2].closed, 4)
    check("closing the room ends every guest's session", guests[2].closed)
    lob.stop()


def test_capacity():
    print("room limits:")
    port, hub, lob = lan_room(max_players=2)
    a = join_lan(port, "ONE")[1]
    pump([hub, a], lambda: a.you, 4)
    b = join_lan(port, "TWO")[1]
    pump([hub, a, b], lambda: b.closed, 4)
    check("a third player is turned away from a 2-slot room", b.closed and "full" in b.why)
    check("the host keeps exactly one guest", len(hub.peers) == 1)
    check("max can't drop below the players present", hub.set_max(2)[0] and hub.max == 2)
    hub.select_game("battle_tide")
    check("max is clamped to the game's limit", hub.set_max(16)[0] and hub.max == 4)
    check("a roomier game can be picked again", hub.select_game("bobble_league")[0] is True)
    hub.close()
    a.close()
    lob.stop()


def test_lan_discovery():
    print("LAN discovery:")
    from game.multiplayer import discover
    port, hub, lob = lan_room(max_players=8, game="liars_bar")
    time.sleep(0.3)
    rooms = discover(timeout=1.2, port=port)
    check("a hosting room answers discovery with its occupancy",
          any(r["name"] == "HOST" and r["max"] == 4 and r["game"] == "liars_bar" and r["players"] == 1 for r in rooms))
    hub.close()
    lob.stop()


# ------------------------------------------------------------------ relay (v2) with several guests
class RelayThread:
    def __init__(self):
        from game import relay
        self.port = free_port()
        self.loop = asyncio.new_event_loop()
        started = threading.Event()

        async def run():
            rs = relay.RelayServer()
            self.server = await asyncio.start_server(rs.handle, "127.0.0.1", self.port)
            started.set()
            async with self.server:
                await self.server.serve_forever()

        def go():
            asyncio.set_event_loop(self.loop)
            try:
                self.loop.run_until_complete(run())
            except (Exception, asyncio.CancelledError):
                pass
        threading.Thread(target=go, daemon=True).start()
        started.wait(3)

    def stop(self):
        self.loop.call_soon_threadsafe(self.server.close)


def test_relay():
    print("relay, host + two guests:")
    from game import relay
    rt = RelayThread()
    addr = f"127.0.0.1:{rt.port}"
    hub = hubmod.Hub("HOST", "relay", code="TESTROOM", max_players=4)
    lob = Lobby("HOST")
    lob.host_relay(addr, "testroom", hub.add_link)
    pump([hub], lambda: lob.state == "hosting", 4)
    check("host opens a room on the relay", lob.state == "hosting")
    hub.transport_up()

    guests = []
    for n in ("ANA", "BEN"):
        gl = Lobby(n)
        got = []
        gl.join_relay(addr, "TESTROOM", got.append)
        end = time.time() + 5
        while not got and time.time() < end:
            time.sleep(0.02)
        check(f"{n} reaches the host through the relay", bool(got))
        if got:
            guests.append(hubmod.Guest(n, got[0], "relay"))
    ok = pump([hub] + guests, lambda: len(hub.peers) == 2 and all(g.you for g in guests), 5)
    check("both guests are in the room", ok is not None)
    guests[0].chat("via relay")
    seen = drive([hub] + guests, 2.0)
    check("chat crosses the relay to the host and the other guest",
          all(("ANA", "via relay") in [(e["n"], e["m"]) for e in seen[id(r)] if e["t"] == "chat"]
              for r in (hub, guests[1])))

    bl = Lobby("NOBODY")
    bl.join_relay(addr, "NOSUCHROOM", lambda l: None)
    end = time.time() + 5
    while bl.state == "connecting" and time.time() < end:
        time.sleep(0.05)
    check("joining a room nobody hosts gives a clear error", bl.state == "error" and "nobody is hosting" in bl.msg)

    dup = Lobby("DUP")
    dup.host_relay(addr, "TESTROOM", lambda l: None)
    end = time.time() + 5
    while dup.state == "connecting" and time.time() < end:
        time.sleep(0.05)
    check("a room code can't be hosted twice", dup.state == "error" and "already" in dup.msg)

    hub.close()
    lob.stop()
    pump(guests, lambda: all(g.closed for g in guests), 5)
    check("guests notice the host leaving", all(g.closed for g in guests))

    # the original two-player protocol still works
    res = {}

    def one(role, name):
        res[role] = relay.connect(name, addr, "OLDROOM", wait=5)
    ts = [threading.Thread(target=one, args=(r, n)) for r, n in (("a", "OLD1"), ("b", "OLD2"))]
    ts[0].start()
    time.sleep(0.3)
    ts[1].start()
    for t in ts:
        t.join(6)
    check("relay v1 (two players) still pairs", {"a", "b"} <= set(res) and
          res["a"].is_host and not res["b"].is_host and res["b"].peer_name == "OLD1")
    for s in res.values():
        s.close()
    rt.stop()


# ------------------------------------------------------------------ online room code (fake MQTT broker)
class FakeBroker:
    """Just enough MQTT 3.1.1 for the game's client: CONNECT, SUBSCRIBE, PUBLISH, PINGREQ."""

    def __init__(self):
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(32)
        self.port = self.srv.getsockname()[1]
        self.subs = {}                      # topic -> set of sockets
        self.lock = threading.Lock()
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    @staticmethod
    def _recv(c, n):
        buf = b""
        while len(buf) < n:
            d = c.recv(n - len(buf))
            if not d:
                raise OSError
            buf += d
        return buf

    def _client(self, c):
        try:
            while True:
                first = self._recv(c, 1)[0]
                mult, n = 1, 0
                while True:
                    b = self._recv(c, 1)[0]
                    n += (b & 0x7F) * mult
                    if not b & 0x80:
                        break
                    mult *= 128
                body = self._recv(c, n) if n else b""
                kind = first & 0xF0
                if kind == 0x10:
                    c.sendall(b"\x20\x02\x00\x00")
                elif kind == 0x80:
                    tl = struct.unpack(">H", body[2:4])[0]
                    topic = body[4:4 + tl].decode()
                    with self.lock:
                        self.subs.setdefault(topic, set()).add(c)
                    c.sendall(b"\x90\x03" + body[:2] + b"\x00")
                elif kind == 0x30:
                    tl = struct.unpack(">H", body[:2])[0]
                    topic = body[2:2 + tl].decode()
                    out = bytes([0x30]) + self._len(len(body)) + body
                    with self.lock:
                        targets = list(self.subs.get(topic, ()))
                    for t in targets:
                        try:
                            t.sendall(out)
                        except OSError:
                            pass
                elif kind == 0xC0:
                    c.sendall(b"\xd0\x00")
                elif kind == 0xE0:
                    return
        except OSError:
            pass
        finally:
            with self.lock:
                for s in self.subs.values():
                    s.discard(c)
            c.close()

    @staticmethod
    def _len(n):
        out = bytearray()
        while True:
            b = n % 128
            n //= 128
            out.append(b | (0x80 if n else 0))
            if not n:
                return bytes(out)


def test_online():
    print("online room code (fake broker), host + two guests:")
    import os
    from game import online as ol
    broker = FakeBroker()
    os.environ["MF_BROKERS"] = f"127.0.0.1:{broker.port}"
    try:
        code = "TEST-ROOM-123"
        hub = hubmod.Hub("HOST", "online", code=code, max_players=4)
        hl = Lobby("HOST")
        hl.host_online(code, hub.add_link)
        pump([hub], lambda: hl.state == "hosting", 8)
        check("host connects to a meeting point", hl.state == "hosting")
        hub.transport_up()

        guests, lobs = [], []
        for n in ("ANA", "BEN"):
            gl = Lobby(n)
            got = []
            gl.join_online(code, got.append)
            lobs.append(gl)
            end = time.time() + 12
            while not got and time.time() < end:
                hub.step()
                time.sleep(0.02)
            check(f"{n} finds the room by its code", bool(got))
            if got:
                guests.append(hubmod.Guest(n, got[0], "online", code))
        ok = pump([hub] + guests, lambda: len(hub.peers) == 2 and all(g.you for g in guests), 8)
        check("both guests are in the room", ok is not None)
        check("host and guests agree on the roster", all(slot_names(g) == slot_names(hub) for g in guests))

        guests[1].chat("over mqtt")
        seen = drive([hub] + guests, 3.0)
        check("chat is relayed between guests through the broker",
              all(("BEN", "over mqtt") in [(e["n"], e["m"]) for e in seen[id(r)] if e["t"] == "chat"]
                  for r in (hub, guests[0])))

        wrong = Lobby("EVE")
        gotw = []
        wrong.join_online("OTHER-CODE-999", gotw.append)
        time.sleep(2.5)
        check("a different room code doesn't reach the host", not gotw and len(hub.peers) == 2)
        wrong.stop()

        # two hosts with one code don't pair with each other; legacy pair mode still pairs two equals
        a = ol.OnlineLink("EQ1", "PAIR-TEST-1")
        b = ol.OnlineLink("EQ2", "PAIR-TEST-1")
        end = time.time() + 12
        while not (a.connected and b.connected) and time.time() < end:
            time.sleep(0.1)
        check("original two-player room-code pairing still works", a.connected and b.connected and a.is_host != b.is_host)
        a.send({"t": "chat", "m": "hi"})
        time.sleep(0.5)
        check("and carries messages", b.events.qsize() == 1)
        a.close()
        b.close()

        hub.close()
        hl.stop()
        pump(guests, lambda: all(g.closed for g in guests), 6)
        check("guests learn the host closed the room", all(g.closed for g in guests))
        for l in lobs:
            l.stop()
    finally:
        os.environ.pop("MF_BROKERS", None)


# ------------------------------------------------------------------ LoRa (always exactly two radios)
class FakeRadio:
    def __init__(self):
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.peer = None
        self.closed = False

    @property
    def in_waiting(self):
        return len(self.buf)

    def write(self, data):
        if self.peer is not None:
            with self.peer.lock:
                self.peer.buf += data

    def read(self, n=1):
        with self.lock:
            out = bytes(self.buf[:n])
            del self.buf[:n]
        if not out:
            time.sleep(0.01)
        return out

    def close(self):
        self.closed = True


def test_lora_room():
    print("LoRa (two radios) through the hub:")
    ra, rb = FakeRadio(), FakeRadio()
    ra.peer, rb.peer = rb, ra
    hub = hubmod.Hub("HOST", "lora", code="RADIO", max_players=16, cap=2)
    check("a radio room is capped at two players", hub.max == 2 and hub.snapshot()["gmax"] == 2)
    hl, gl = Lobby("HOST"), Lobby("GUEST")
    hl.host_lora(ra, "RADIO", hub.add_link)
    got = []
    gl.join_lora(rb, "RADIO", got.append)
    ok = pump([hub], lambda: len(hub.peers) == 1 and bool(got), 25)
    check("host's radio pairs with the guest's", ok is not None)
    if got:
        g = hubmod.Guest("GUEST", got[0], "lora", "RADIO")
        ok = pump([hub, g], lambda: g.you == 1, 25)
        check("the guest gets its slot over the radio", ok is not None)
        g.chat("radio check")
        seen = drive([hub, g], 12.0, until=lambda: False)
        check("chat crosses the radio", ("GUEST", "radio check") in
              [(e["n"], e["m"]) for e in seen[id(hub)] if e["t"] == "chat"])
        g.close()
    hub.close()
    hl.stop()
    gl.stop()


# ------------------------------------------------------------------ hub rules with stand-in links
class FakeLink:
    voice_ok = True

    def __init__(self, name):
        import queue
        self.peer_name = name
        self.is_host = True
        self.alive = True
        self.why = ""
        self.events = queue.Queue()
        self.acts = queue.Queue()
        self.sent = []

    def send(self, obj):
        self.sent.append(obj)

    def close(self):
        self.alive = False


def test_hub_rules():
    print("hub rules:")
    hub = hubmod.Hub("HOST", max_players=8)
    a, b = FakeLink("SAM"), FakeLink("SAM")
    hub.add_link(a)
    hub.add_link(b)
    hub.step()
    names = [s["n"] for s in hub.snapshot()["slots"]]
    check("duplicate names are made unique", names[1] == "SAM" and names[2].startswith("SAM#"))

    for i in range(8):
        a.events.put({"t": "chat", "m": f"spam {i}"})
    ev = hub.step()
    check("a chat flood is rate-limited", len([e for e in ev if e["t"] == "chat"]) == 6)

    a.events.put({"t": "chat", "m": "x\x00y\x1b[31mz" + "q" * 400})
    hub.step()
    time.sleep(0.01)
    c = FakeLink("TOOBIG")
    ev = []
    c.events.put({"t": "g", "d": {"blob": "z" * 40000}})
    hub.add_link(c)
    hub.step()
    c.events.put({"t": "g", "d": {"blob": "z" * 40000}})
    ev = hub.step()
    check("an oversized game message is dropped", not [e for e in ev if e["t"] == "game"])

    a.events.put({"t": "ready", "v": True})
    a.events.put({"t": "prof", "av": 999})
    a.events.put({"t": "mystery", "x": 1})
    a.events.put("not even a dict")
    hub.step()
    check("bad avatar / unknown / malformed messages are ignored",
          hub.peers[1].ready and hub.peers[1].av != 999)

    a.alive = False
    a.why = "pulled the plug"
    ev = hub.step()
    check("a dead link is dropped with its reason",
          1 not in hub.peers and any(e["t"] == "sys" and "pulled the plug" in e["m"] for e in ev))

    big = hubmod.Hub("BIG", game="rising_rush", max_players=16)
    for i in range(5):
        big.add_link(FakeLink(f"P{i}"))
    big.step()
    ok, why = big.select_game("battle_tide")
    check("a game that can't hold everyone present is refused", not ok and "at most 4" in why)
    check("start needs the game's minimum player count",
          hubmod.Hub("SOLO", game="bobble_league").start()[0] is False)
    solo = hubmod.Hub("SOLO", "solo", "SOLO", "bobble_league", 2, 2, solo=True)
    snap = solo.snapshot()
    check("a solo test room is up at once and needs only the host", snap["solo"] and snap["link"] == "up" and snap["min"] == 1)
    check("and starts a two-player game alone", solo.start()[0] and solo.phase == "playing")

    t0 = time.time()
    b.events.put({"t": "pon", "ts": t0 - 0.05})
    hub.step()
    check("pong measures round-trip time", 40 <= hub.peers[2].ping <= 400)
    hub.close()
    check("close hangs up on everyone", not b.alive)


def main():
    for fn in (test_framing, test_hub_rules, test_lan_room, test_capacity, test_lan_discovery,
               test_relay, test_online, test_lora_room):
        try:
            fn()
        except Exception as e:                       # a crash is a failure, but keep going
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
