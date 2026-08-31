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


# Where Anki keeps collections, one directory per profile.
#
# The packaged Linux builds are the reason this list is long. Snap and Flatpak
# both confine the app to their own home, so an Anki installed either way keeps
# its collection nowhere near `~/.local/share/Anki2` — and the classic directory
# is often still there from an older install, holding a stale profile that looks
# perfectly plausible. Reading the wrong one is not an error you notice: it
# reports a real collection with real reviews, just not yours.
COLLECTION_ROOTS = [
    "~/.local/share/Anki2",                                   # Linux, classic
    "~/snap/anki-desktop/common",                             # Linux, snap
    "~/.var/app/net.ankiweb.Anki/data/Anki2",                 # Linux, flatpak
    "~/Library/Application Support/Anki2",                    # macOS
    os.path.expandvars(r"%APPDATA%\Anki2"),                   # Windows
]


def find_collections():
    """Every collection on this machine, newest first.

    All of them, not the likeliest one: a person can have a profile per subject
    — one for a language, one for an exam — and their studying is the sum of
    those, not whichever was touched last.
    """
    found = []
    for root in COLLECTION_ROOTS:
        found.extend(glob.glob(os.path.join(os.path.expanduser(root), "*", "collection.anki2")))

    # Deduplicate by real path, since a symlinked or bind-mounted home can
    # otherwise present the same collection twice and double every review.
    seen = set()
    unique = []
    for path in found:
        real = os.path.realpath(path)
        if real in seen:
            continue
        seen.add(real)
        unique.append(path)

    unique.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return unique


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


def minutes_per_day(records):
    """Minutes per day, derived from the reviews rather than tallied per file.

    Summing each collection's own minutes and adding them up looks equivalent
    and is not. A review carries its own millisecond id, so the *same* review
    found in two collections — which is what a profile migration, a restored
    backup or a switch from one Anki packaging to another produces — is one
    record after deduplication and would have been two minutes' worth before it.

    Deriving from the records after they are deduplicated makes that impossible
    rather than unlikely. It is also the rule the trainers themselves follow for
    their own summaries: a running tally is a second source of truth, and it
    drifts.
    """
    minutes = {}
    for r in records:
        minutes[r["day"]] = minutes.get(r["day"], 0.0) + r["seconds"] / 60.0
    return minutes


def profile_name(path):
    """The profile is the directory the collection sits in."""
    return os.path.basename(os.path.dirname(path))


def read_reviews(path, label_profile=False):
    """Every review, as archive records."""
    profile = profile_name(path)
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
            # Profile first when there is more than one, since "Chemie" in an
            # exam profile and "Chemie" in a general one are different study.
            "label": (profile + "::" if label_profile else "") + decks.get(did, "unknown deck"),
            "raw": {
                "ease": ease,
                "type": rtype,
                "interval": ivl,
                "lastInterval": last_ivl,
                "factor": factor,
            },
        })

    return records


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--collection", action="append",
                    help="path to a collection.anki2 (repeatable); default is every one found")
    ap.add_argument("--out", default="anki-source.json", help="where to write the JSON")
    args = ap.parse_args()

    paths = args.collection or find_collections()
    if not paths:
        raise SystemExit("No Anki collection found. Pass --collection.")

    label_profile = len(paths) > 1
    by_id = {}
    empty = []
    shared = 0

    for path in paths:
        print("Reading %s" % path)
        got = read_reviews(path, label_profile)
        if not got:
            empty.append(path)
            continue

        # Keyed on the review's own id, so a collection that was migrated,
        # restored from a backup or copied between Anki packagings contributes
        # its reviews once rather than once per copy.
        fresh = 0
        for r in got:
            if r["id"] in by_id:
                shared += 1
            else:
                fresh += 1
            by_id[r["id"]] = r

        days = sorted({r["day"] for r in got})
        print("   %-24s %5d reviews (%d new), %s to %s"
              % (profile_name(path), len(got), fresh, days[0], days[-1]))

    for path in empty:
        print("   %-24s no reviews" % profile_name(path))

    if not by_id:
        raise SystemExit("No reviews in any collection found.")

    if shared:
        print("   %d review(s) appeared in more than one collection and were counted once."
              % shared)

    records = sorted(by_id.values(), key=lambda r: r["at"])
    minutes = minutes_per_day(records)

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
    print("\n%d reviews over %d days (%s to %s), %.0f minutes in total"
          % (len(records), len(days), days[0], days[-1], sum(minutes.values())))
    print("Written to %s — drop it on the archive page." % args.out)

    # A stale record is worth saying out loud rather than leaving to be noticed:
    # the usual cause is that the studying happens somewhere this cannot see.
    newest = datetime.datetime.utcfromtimestamp(records[-1]["at"] / 1000.0)
    age = (datetime.datetime.utcnow() - newest).days
    if age > 30:
        print("Note: the most recent review found is %d days old. If you study on "
              "a phone or through AnkiWeb, that is not where it lands." % age)


if __name__ == "__main__":
    main()
