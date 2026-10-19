"""Login and clearance for the G3 launcher.

An "operator" registers a callsign and passcode (stored salted and hashed in <data dir>/auth.json), logs in, then sits
the Trial of the Rising Sun (g3/lore.py) to earn a clearance level 1-4.  Level 0 means the trial was failed and the
launcher stays locked.  Sessions live in memory, so restarting G3 asks everyone to log in again.

This is a local gate in front of a loopback-only server, not a security boundary against someone with the files; what
it does guarantee is that the trial is graded here, so a page can't just claim a level.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import re
import secrets
import threading
import time
from pathlib import Path

from g3 import lore

NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,16}$")
PASS_MIN, PASS_MAX = 4, 64
KDF_ROUNDS = 200_000
SESSION_TTL = 12 * 3600
TRIAL_TTL = 45 * 60                 # time allowed to finish one trial
RETRY_AFTER_FAIL = 60               # seconds before a failed operator may sit the trial again
LOCK_AFTER, LOCK_FOR = 5, 30        # wrong passcodes in a row, then seconds locked out


class AuthError(Exception):
    def __init__(self, message, status=400, retry_in=0):
        super().__init__(message)
        self.status, self.retry_in = status, retry_in


def _hash(passcode, salt):
    return hashlib.pbkdf2_hmac("sha256", passcode.encode("utf-8"), salt, KDF_ROUNDS).hex()


class Session:
    def __init__(self, user):
        self.user = user                 # the account key (lower-case callsign)
        self.born = time.time()
        self.trial = None                # {"id", "key", "started"}


class Auth:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / "auth.json"
        self.lock = threading.RLock()
        self.sessions = {}
        self.fails = {}                  # account key -> (count, locked until)
        self.accounts = self._load()

    # ------------------------------------------------------------ storage
    def _load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data["users"] if isinstance(data.get("users"), dict) else {}
        except (OSError, ValueError, KeyError, AttributeError):
            return {}

    def _save(self):
        try:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"users": self.accounts}, indent=1), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass

    # ------------------------------------------------------------ accounts
    def register(self, name, passcode):
        name, passcode = str(name or "").strip(), str(passcode or "")
        if not NAME_RE.match(name):
            raise AuthError("Callsign: 3-16 letters, digits, dots, dashes or underscores.")
        if not PASS_MIN <= len(passcode) <= PASS_MAX:
            raise AuthError(f"Passcode: {PASS_MIN}-{PASS_MAX} characters.")
        key = name.lower()
        with self.lock:
            if key in self.accounts:
                raise AuthError("That callsign is already taken.", 409)
            salt = os.urandom(16)
            self.accounts[key] = {"name": name, "salt": salt.hex(), "hash": _hash(passcode, salt), "level": 0, "pct": 0,
                                  "retry_at": 0, "created": int(time.time())}
            self._save()
            return self._open(key)

    def login(self, name, passcode):
        key = str(name or "").strip().lower()
        passcode = str(passcode or "")
        with self.lock:
            count, until = self.fails.get(key, (0, 0))
            if until > time.time():
                raise AuthError("Too many wrong passcodes. Wait a moment.", 429, int(until - time.time()) + 1)
            acct = self.accounts.get(key)
            ok = False
            if acct and len(passcode) <= PASS_MAX:
                ok = hmac.compare_digest(_hash(passcode, bytes.fromhex(acct["salt"])), acct["hash"])
            else:
                _hash(passcode[:PASS_MAX], b"\0" * 16)               # same work either way: don't reveal which callsigns exist
            if not ok:
                count += 1
                self.fails[key] = (0, time.time() + LOCK_FOR) if count >= LOCK_AFTER else (count, 0)
                raise AuthError("Unknown callsign or wrong passcode.", 401)
            self.fails.pop(key, None)
            return self._open(key)

    def _open(self, key):
        token = secrets.token_urlsafe(24)
        self.sessions[token] = Session(key)
        now = time.time()
        for t in [t for t, s in self.sessions.items() if now - s.born > SESSION_TTL]:
            del self.sessions[t]
        return token

    def session(self, token):
        with self.lock:
            s = self.sessions.get(token or "")
            if s is None:
                return None
            if time.time() - s.born > SESSION_TTL or s.user not in self.accounts:
                self.sessions.pop(token, None)
                return None
            return s

    def logout(self, token):
        with self.lock:
            self.sessions.pop(token or "", None)

    # ------------------------------------------------------------ status
    def status(self, token):
        s = self.session(token)
        if s is None:
            return {"authed": False}
        a = self.accounts[s.user]
        return {"authed": True, "name": a["name"], "level": a["level"], "rank": lore.rank_name(a["level"]),
                "pct": a.get("pct", 0), "cleared": a["level"] >= 1,
                "retryIn": max(0, int(a.get("retry_at", 0) - time.time()))}

    def cleared(self, token):
        s = self.session(token)
        return s is not None and self.accounts[s.user]["level"] >= 1

    def name_of(self, token):
        s = self.session(token)
        return self.accounts[s.user]["name"] if s else None

    # ------------------------------------------------------------ the trial
    def start_trial(self, token):
        with self.lock:
            s = self.session(token)
            if s is None:
                raise AuthError("Log in first.", 401)
            wait = int(self.accounts[s.user].get("retry_at", 0) - time.time())
            if wait > 0:
                raise AuthError("The shrine is closed to you for a while after a failed trial.", 429, wait)
            public, key = lore.build(random.SystemRandom())
            s.trial = {"id": secrets.token_hex(6), "key": key, "started": time.time()}
            return {"id": s.trial["id"], "minutes": TRIAL_TTL // 60, "total": len(public),
                    "sections": [{"id": x["id"], "title": x["title"], "sub": x["sub"]} for x in lore.SECTIONS],
                    "questions": public}

    def submit_trial(self, token, trial_id, answers):
        with self.lock:
            s = self.session(token)
            if s is None:
                raise AuthError("Log in first.", 401)
            t = s.trial
            if t is None or t["id"] != trial_id:             # a stray submission must not destroy the trial in progress
                raise AuthError("No trial is in progress. Begin a new one.", 409)
            s.trial = None                                   # one submission per trial, pass or fail
            if time.time() - t["started"] > TRIAL_TTL:
                raise AuthError("The trial ran out of time. Begin a new one.", 410)
            res = lore.grade(t["key"], answers)
            acct = self.accounts[s.user]
            best = max(acct["level"], res["level"])         # a later, worse trial never takes a clearance away
            if res["level"] >= acct["level"]:
                acct["pct"] = res["pct"] if res["level"] > acct["level"] else max(acct.get("pct", 0), res["pct"])
            acct["level"] = best
            if res["level"] == 0:
                acct["retry_at"] = time.time() + RETRY_AFTER_FAIL
            self._save()
            res.update({"best": best, "bestRank": lore.rank_name(best), "passed": res["level"] >= 1,
                        "retryIn": RETRY_AFTER_FAIL if res["level"] == 0 else 0})
            return res
