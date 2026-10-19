"""The Riddle of the Rising Sun: the clearance check.

The gate asks one riddle, about a gorgeous man.  Answer it with his name, Daivansh or Devonut, and you pass.  The
riddle lives here, on the server, so the answer never reaches the browser; the guess is checked here too.
"""
from __future__ import annotations

import re
import unicodedata

PASS_LEVEL, PASS_RANK = 1, "DAYBREAK"
LOCKED_RANK = "LOCKED"

TITLE = "THE RIDDLE OF THE RISING SUN"

RIDDLE = [
    "The sun is late to the morning because it stops to stare at me.",
    "Mirrors line up to hold my reflection, and every one of them is thrilled to be second best.",
    "My jaw could carve marble, my hair obeys no wind, and my smile starts every sunrise.",
    "I am a man of two names: one a gentle \"san\", the other sounds like a halo on a snack.",
    "Who am I?",
]

ANSWERS = ("daivansh", "daivansho", "devonut")      # normalised (see norm()); "san" on the end is ignored


def norm(s):
    """Lower-case, no accents, letters and digits only, and a trailing 'san' dropped:
    'Daivansho-San' -> 'daivansho', 'DEVONUT!' -> 'devonut'."""
    s = unicodedata.normalize("NFKD", str(s)).casefold()
    s = re.sub(r"[^a-z0-9]", "", "".join(c for c in s if not unicodedata.combining(c)))
    return s[:-3] if s.endswith("san") and len(s) > 3 else s


def is_right(given):
    """Is the guess correct?  `given` is whatever the browser sent; anything odd is just wrong."""
    return isinstance(given, str) and len(given) <= 80 and norm(given) in ANSWERS


def level_for(passed):
    return (PASS_LEVEL, PASS_RANK) if passed else (0, LOCKED_RANK)


def rank_name(level):
    return PASS_RANK if level >= PASS_LEVEL else LOCKED_RANK
