"""Pretend LoRa radio pair for trying long-range mode without hardware (Linux/macOS).

    python -m game.lora_sim            # prints two serial port paths
    # window 1: python -m g3                      -> LORA_RADIO, type the 1st path, HOST
    # window 2: python -m g3 --data ~/.g3_player2 -> LORA_RADIO, type the 2nd path, JOIN

It carries bytes between the two ports at radio speed (default 2400 bit/s) and
drops / corrupts / collides packets like a real half-duplex link would.
On Windows use a virtual COM-port pair (e.g. com0com) instead.
"""
from __future__ import annotations

import argparse
import os
import random
import select
import threading
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bitrate", type=int, default=2400)
    ap.add_argument("--loss", type=float, default=0.05, help="packet loss 0..1")
    ap.add_argument("--corrupt", type=float, default=0.01)
    args = ap.parse_args()
    import tty
    ends = []
    for _ in range(2):
        m, s = os.openpty()
        tty.setraw(s)
        ends.append((m, os.ttyname(s), s))
    print("Radio A:", ends[0][1])
    print("Radio B:", ends[1][1])
    print(f"{args.bitrate} bit/s, {args.loss:.0%} loss. Ctrl+C to stop.")
    air_until = [0.0]
    lock = threading.Lock()
    rnd = random.Random()

    def carry(src, dst):
        while True:
            r, _, _ = select.select([src], [], [], 0.5)
            if not r:
                continue
            time.sleep(0.02)                          # gather a whole packet
            try:
                data = os.read(src, 4096)
            except OSError:
                return
            airtime = (len(data) + 10) * 8 / args.bitrate
            with lock:
                now = time.time()
                collided = air_until[0] > now
                air_until[0] = max(air_until[0], now) + airtime
            time.sleep(airtime)
            if collided or rnd.random() < args.loss:
                continue
            if rnd.random() < args.corrupt:
                b = bytearray(data)
                b[rnd.randrange(len(b))] ^= 0x5A
                data = bytes(b)
            os.write(dst, data)
    for a, b in ((0, 1), (1, 0)):
        threading.Thread(target=carry, args=(ends[a][0], ends[b][0]), daemon=True).start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
