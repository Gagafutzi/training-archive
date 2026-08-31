#!/usr/bin/env python3
"""Read an Anki collection's review log into a training-archive source file.

    python3 tools/anki-export.py                       # finds your collection
    python3 tools/anki-export.py --out anki.json       # somewhere specific
    python3 tools/anki-export.py --collection path/to/collection.anki2

Then drop the JSON on the archive page.

WHY THIS IS A SCRIPT AND NOT AN ADAPTER IN THE PAGE
---------------------------------------------------
An Anki collection is a SQLite database. Reading one in a browser means shipping
a WebAssembly build of SQLite, and a `.colpkg` means a zip reader and, on recent
versions, a zstd decoder as well. That is a toolchain, and the archive's one
structural promise is that it still runs in five years without one.

Python 3 has `sqlite3` in its standard library. So the reading happens here, with
no dependencies at all, and the page stays a thing that reads JSON.

This is also the pattern for every other source you did not write: a small script
that emits `{"schema": "training-archive-source/1", ...}`. The page takes that
shape as it stands, so a new source never needs the page to change.

WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT
-------------------------------------------------
Only `revlog` — one row per review, carrying when, how long, and how it went —
plus deck *names*, so a review can say which subject it belonged to.

It never reads `notes`. None of your card content, questions, answers or media
goes into the archive, which matters because an archive is a file you might hand
to someone, and because none of it would tell you anything about your training
anyway.

The collection is copied before it is opened. Anki holds a lock on the live file
and a reader can corrupt a collection that is being written to; a copy cannot.
"""

import argparse
import datetime
import glob
import json
import os
import shutil
import sqlite3
import tempfile

# Anki caps a single review at sixty seconds when it records it, but the cap has
# moved between versions and a corrupt row can carry anything. Clamped here too,
# for the same reason the other sources are: a card left on screen over lunch is
# not an hour of study.
MAX_REVIEW_SECONDS = 60

# revlog.type: 0 learn, 1 review, 2 relearn, 3 filtered. 4 and 5 are manual
# reschedules and set-due-date actions — they are entries in the log but they
# are not reviews, they carry no time, and counting them would inflate every
# count that matters.
REVIEW_TYPES = {0, 1, 2, 3}


def find_collection():
    """The usual places, newest first. Anki keeps one file per profile."""
    roots = [
        os.path.expanduser("~/.local/share/Anki2"),          # Linux
        os.path.expanduser("~/Library/Application Support/Anki2"),  # macOS
        os.path.expandvars(r"%APPDATA%\Anki2"),              # Windows
    ]
    found = []
    for root in roots:
        found.extend(glob.glob(os.path.join(root, "*", "collection.anki2")))
    found.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return found


def deck_names(con):
    """Deck id to name, across both collection layouts.

    Anki 2.1.28 or so moved decks out of a JSON blob in `col` into their own
    table. Both are still in the wild — an old collection that has never been
    upgraded keeps the blob — so both are read, and a collection with neither
    simply gets no deck names rather than failing.
    """
    names = {}
    tables = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}

    if "decks" in tables:
        try:
            for did, name in con.execute("SELECT id, name FROM decks"):
                # Nested decks are stored with \x1f between the parts.
                names[did] = name.replace("\x1f", "::")
            return names
        except sqlite3.Error:
            pass

    try:
        raw = con.execute("SELECT decks FROM col").fetchone()
        if raw and raw[0]:
            for did, deck in json.loads(raw[0]).items():
                names[int(did)] = deck.get("name", "")
    except (sqlite3.Error, ValueError, TypeError):
        pass

    return names


def read_reviews(path):
    """Every review, as archive records."""
    tmp = os.path.join(tempfile.gettempdir(), "training-archive-anki.anki2")
    shutil.copy2(path, tmp)

    try:
        con = sqlite3.connect("file:%s?mode=ro" % tmp, uri=True)
        decks = deck_names(con)

        rows = con.execute("""
            SELECT r.id, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type, c.did
            FROM revlog r LEFT JOIN cards c ON c.id = r.cid
            ORDER BY r.id
        """).fetchall()
        con.close()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    records = []
    minutes = {}

    for rid, ease, ivl, last_ivl, factor, time_ms, rtype, did in rows:
        if rtype not in REVIEW_TYPES:
            continue

        seconds = min((time_ms or 0) / 1000.0, MAX_REVIEW_SECONDS)
        day = datetime.datetime.utcfromtimestamp(rid / 1000.0).strftime("%Y-%m-%d")

        records.append({
            "source": "anki",
            # The review's own millisecond timestamp, which Anki already
            # guarantees unique — so two exports of the same collection fold to
            # one row without any hashing.
            "id": str(rid),
            "at": rid,
            "day": day,
            "kind": "review",
            "seconds": seconds,
            # Ease 1 is "Again", which is the card coming back. Everything above
            # it passed. That is the only outcome Anki records, and it is the
            # one worth keeping.
            "correct": 0 if ease == 1 else 1,
            # No difficulty, on purpose. An interval is a *schedule*, not a
            # measure of how hard the review was, and the archive's rule is that
            # a difficulty has to mean something in its own units. Inventing one
            # here would be the first step towards comparing it with somebody
            # else's.
            "difficulty": None,
            "unit": None,
            "label": decks.get(did, "unknown deck"),
            "raw": {
                "ease": ease,
                "type": rtype,
                "interval": ivl,
                "lastInterval": last_ivl,
                "factor": factor,
            },
        })

        minutes[day] = minutes.get(day, 0.0) + seconds / 60.0

    return records, minutes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--collection", help="path to collection.anki2")
    ap.add_argument("--out", default="anki-source.json", help="where to write the JSON")
    args = ap.parse_args()

    path = args.collection
    if not path:
        found = find_collection()
        if not found:
            raise SystemExit("No Anki collection found. Pass --collection.")
        path = found[0]
        if len(found) > 1:
            print("Several profiles found; using the most recent:")
            for p in found:
                print("   ", p)

    print("Reading %s" % path)
    records, minutes = read_reviews(path)

    if not records:
        raise SystemExit("No reviews in that collection.")

    payload = {
        "schema": "training-archive-source/1",
        "source": "anki",
        "generatedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "records": records,
        "minutes": {d: round(m, 4) for d, m in sorted(minutes.items())},
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)

    days = sorted(minutes)
    print("%d reviews over %d days (%s to %s), %.0f minutes in total"
          % (len(records), len(days), days[0], days[-1], sum(minutes.values())))
    print("Written to %s — drop it on the archive page." % args.out)

    # A stale collection is worth saying out loud: the usual cause is that the
    # real studying happens on another device and this profile is a leftover.
    newest = datetime.datetime.utcfromtimestamp(records[-1]["at"] / 1000.0)
    age = (datetime.datetime.utcnow() - newest).days
    if age > 30:
        print("Note: the most recent review here is %d days old. If you study on "
              "a phone or through AnkiWeb, this profile is not where that lands."
              % age)


if __name__ == "__main__":
    main()
