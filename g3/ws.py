"""Just enough WebSocket (RFC 6455) for the UI bridge: text frames, ping/pong,
close, fragmentation.  Standard library only."""
from __future__ import annotations

import base64
import hashlib
import struct
import threading

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 1 << 20


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()


class WebSocket:
    def __init__(self, rfile, sock):
        self.rfile = rfile
        self.sock = sock
        self._send_lock = threading.Lock()
        self.open = True

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                raise EOFError
            buf += chunk
        return buf

    def _send_frame(self, opcode, payload=b""):
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 1 << 16:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        with self._send_lock:
            self.sock.sendall(head + payload)

    def send(self, text: str):
        self._send_frame(0x1, text.encode("utf-8"))

    def recv(self):
        """Next text message, or None when the connection closed."""
        message, opcode0 = b"", None
        try:
            while True:
                b0, b1 = self._read(2)
                fin, opcode = b0 & 0x80, b0 & 0x0F
                masked, n = b1 & 0x80, b1 & 0x7F
                if n == 126:
                    (n,) = struct.unpack(">H", self._read(2))
                elif n == 127:
                    (n,) = struct.unpack(">Q", self._read(8))
                if n > MAX_MESSAGE or not masked:          # clients must mask; refuse huge frames
                    self.close(1009 if n > MAX_MESSAGE else 1002)
                    return None
                mask = self._read(4)
                data = bytearray(self._read(n))
                for i in range(n):
                    data[i] ^= mask[i & 3]
                data = bytes(data)
                if opcode == 0x8:
                    self.close()
                    return None
                if opcode == 0x9:
                    self._send_frame(0xA, data)
                    continue
                if opcode == 0xA:
                    continue
                if opcode in (0x1, 0x2):
                    opcode0, message = opcode, data
                elif opcode == 0x0:
                    message += data
                else:
                    continue
                if len(message) > MAX_MESSAGE:
                    self.close(1009)
                    return None
                if fin:
                    if opcode0 == 0x1:
                        return message.decode("utf-8", "replace")
                    message, opcode0 = b"", None            # binary frames aren't used
        except (EOFError, OSError):
            self.open = False
            return None

    def close(self, code=1000):
        if not self.open:
            return
        self.open = False
        try:
            self._send_frame(0x8, struct.pack(">H", code))
        except OSError:
            pass
