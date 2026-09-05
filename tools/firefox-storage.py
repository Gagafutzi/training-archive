#!/usr/bin/env python3
"""Read the trainers' live localStorage straight out of Firefox.

    python3 tools/firefox-storage.py --outdir /tmp/live

Writes one JSON per origin per app, in each app's own export format, so the
existing adapters read them without knowing where they came from.

WHY THIS EXISTS
---------------
The archive's whole reason for being is that clearing site data takes your
history with it. Exports are the defence, and they only work if you remember to
make one — which is exactly what nobody does before clicking "clear" in the
middle of debugging.

Firefox keeps each origin's localStorage in its own SQLite database on disk. So
the record can be snapshotted from a machine you already have, without an export
and without the browser being involved at all. Run this before a reset, or on a
schedule, and the reset costs nothing.

It also answers a smaller thing: the page's own "Read this browser" button can
only ever see the origin it is *served from*. Opened as a `file://` page it has
its own isolated storage and finds nothing, which is not a permission problem and
cannot be fixed by granting anything.

WHAT IT READS
-------------
Only `ls/data.sqlite` under `storage/default/<origin>/`, and only for origins
that look like one of the trainers. Read-only, on a copy, so a running Firefox
is never touched.

THE COMPRESSION
---------------
Firefox stores larger values Snappy-compressed (`compression_type = 1`). Python
has no Snappy in its standard library, so the raw format is implemented below —
it is small, and vendoring a dependency into a project whose one promise is that
it still runs in five years would be the worse trade.
"""

import argparse
import datetime
import glob
import json
import os
import shutil
import sqlite3
import sys
import tempfile

# Five minutes, the point past which an item was not being worked on — the same
# line every other source in this project draws.
MAX_ITEM_SECONDS = 300

# ---------------------------------------------------------------- snappy

def _varint(data, pos):
    result = 0
    shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def snappy_decompress(data):
    """Raw Snappy, as Firefox writes it.

    A varint of the uncompressed length, then a stream of elements. Each begins
    with a tag byte whose low two bits give its kind: a literal run, or a copy
    from earlier in the output at a one-, two- or four-byte offset.

    Copies are allowed to overlap their own destination — that is how the format
    expresses a repeated run — so they are emitted byte at a time rather than
    sliced, which is the one place a faster-looking implementation is wrong.
    """
    expected, pos = _varint(data, 0)
    out = bytearray()

    while pos < len(data):
        tag = data[pos]
        pos += 1
        kind = tag & 0x03

        if kind == 0:                                  # literal
            length = tag >> 2
            if length >= 60:
                extra = length - 59
                length = int.from_bytes(data[pos:pos + extra], "little")
                pos += extra
            length += 1
            out += data[pos:pos + length]
            pos += length
            continue

        if kind == 1:                                  # copy, 1-byte offset
            length = 4 + ((tag >> 2) & 0x07)
            offset = ((tag >> 5) << 8) | data[pos]
            pos += 1
        elif kind == 2:                                # copy, 2-byte offset
            length = 1 + (tag >> 2)
            offset = int.from_bytes(data[pos:pos + 2], "little")
            pos += 2
        else:                                          # copy, 4-byte offset
            length = 1 + (tag >> 2)
            offset = int.from_bytes(data[pos:pos + 4], "little")
            pos += 4

        if offset == 0 or offset > len(out):
            raise ValueError("bad snappy copy offset")

        start = len(out) - offset
        for i in range(length):
            out.append(out[start + i])

    if len(out) != expected:
        raise ValueError("snappy length mismatch: %d, expected %d" % (len(out), expected))
    return bytes(out)


# ---------------------------------------------------------------- firefox

FIREFOX_ROOTS = [
    "~/.mozilla/firefox",
    "~/snap/firefox/common/.mozilla/firefox",
    "~/.var/app/org.mozilla.firefox/.mozilla/firefox",
    "~/Library/Application Support/Firefox/Profiles",
    os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles"),
]


def storage_dirs():
    """Every `storage/default` Firefox has on this machine."""
    out = []
    for root in FIREFOX_ROOTS:
        out.extend(glob.glob(os.path.join(os.path.expanduser(root), "*", "storage", "default")))
    return out


def read_origin(path):
    """One origin's localStorage as a plain dict, or None."""
    db = os.path.join(path, "ls", "data.sqlite")
    if not os.path.exists(db):
        return None

    tmp = os.path.join(tempfile.gettempdir(), "training-archive-ls.sqlite")
    shutil.copy2(db, tmp)
    try:
        con = sqlite3.connect("file:%s?mode=ro" % tmp, uri=True)
        rows = con.execute(
            "SELECT key, value, compression_type, conversion_type FROM data").fetchall()
        con.close()
    except sqlite3.Error:
        return None
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    store = {}
    for key, value, compression, conversion in rows:
        if isinstance(value, str):
            store[key] = value
            continue
        raw = bytes(value)
        if compression == 1:
            try:
                raw = snappy_decompress(raw)
            except (ValueError, IndexError):
                continue                      # a value we cannot read is skipped
        # conversion_type 0 means the value was stored as UTF-16.
        try:
            store[key] = raw.decode("utf-16-le" if conversion == 0 else "utf-8")
        except UnicodeDecodeError:
            try:
                store[key] = raw.decode("utf-8", "replace")
            except Exception:
                continue

    return store or None


def origin_label(path):
    """`https+++example.github.io` reads better as what it is."""
    name = os.path.basename(path)
    return name.replace("+++", "://").replace("++++", "://").replace("+", "/")


# ---------------------------------------------------------------- extracting

def syllogimous_from(store):
    """The keys its own backup writes, so its own adapter reads the result."""
    out = {k: v for k, v in store.items()
           if k.startswith("SYL_") or k.startswith("syllogimous-")}
    return out if out.get("SYL_HISTORY") else None


def syllogimous_v3_from(store):
    """Syllogimous **v3**, which is a different app under a different key.

    A separate source rather than more of `syllogimous`, for the reason units
    are kept apart everywhere else: v3's modes are its own — `space-time`,
    `anchor-space`, `Analogy: Vertical` — and its premise counts sit on their own
    scale. Folding them together would put two vocabularies in one column and
    invite a comparison that means nothing.

    **The duration is derived, not recorded.** v3 stores when a question
    *started* and nothing about when it ended: `timeOffset` is null or zero on
    every one of them, and `tlen` is the limit rather than the time taken. So an
    item's length is taken as the gap to the next question, clamped at five
    minutes like everywhere else — which is a real measure of time on task and
    is honestly a better one than a self-reported duration, right up until
    somebody walks away mid-session, which is what the clamp is for.
    """
    raw = store.get("sllgms-v3-app-state")
    if not raw:
        return None
    try:
        questions = json.loads(raw).get("questions") or []
    except ValueError:
        return None

    questions = sorted((q for q in questions if q.get("startedAt")),
                       key=lambda q: q["startedAt"])
    if not questions:
        return None

    gaps = []
    for i in range(len(questions) - 1):
        gap = (questions[i + 1]["startedAt"] - questions[i]["startedAt"]) / 1000.0
        gaps.append(gap if 0 < gap <= MAX_ITEM_SECONDS else None)
    known = sorted(g for g in gaps if g is not None)
    typical = known[len(known) // 2] if known else 30.0
    gaps.append(None)                       # the last question has no successor

    records = []
    for q, gap in zip(questions, gaps):
        started = q["startedAt"]
        records.append({
            "source": "syllogimous-v3",
            "id": str(started),
            "at": started,
            "day": datetime.datetime.utcfromtimestamp(started / 1000.0).strftime("%Y-%m-%d"),
            "kind": "item",
            "seconds": gap if gap is not None else typical,
            # "missed" is the clock running out, which is not a right answer.
            "correct": 1 if q.get("correctness") == "right" else 0,
            "difficulty": q.get("plen"),
            "unit": "syllogimous-v3-premises",
            "label": q.get("category") or q.get("type") or "unknown",
            "raw": {
                "type": q.get("type"),
                "modifiers": q.get("modifiers"),
                "tags": q.get("tags"),
                "timeLimit": q.get("tlen"),
                "correctness": q.get("correctness"),
            },
        })

    minutes = {}
    for r in records:
        minutes[r["day"]] = minutes.get(r["day"], 0.0) + r["seconds"] / 60.0

    return {"records": records, "minutes": minutes}


def cct_from(store):
    """The one key its progress lives under, handed over as its adapter reads it.

    CCT has no history export — its Share button writes settings and profiles
    only — so this snapshot is the sole route its record has into the archive.
    It also keeps just the last hundred sessions, so how often this runs decides
    how much of the history survives at all.
    """
    raw = store.get("mp_prog")
    if not raw:
        return None
    try:
        prog = json.loads(raw)
    except ValueError:
        return None
    if not prog.get("history"):
        return None
    return {"mp_prog": raw}


def ewmt_from(store):
    """Likewise the one key, and likewise the only copy: eWMT exports nothing."""
    raw = store.get("attentional_shield_v2")
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not data.get("sessions"):
        return None
    return {"attentional_shield_v2": raw}


def precision_from(store):
    """Its history under one key, and no export to ask for instead."""
    raw = store.get("nback-performance")
    if not raw:
        return None
    try:
        hist = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(hist, list) or not hist:
        return None
    return {"nback-performance": raw}


def rotation_from(store):
    """The molecule and stereochemistry trainer's ladder and session list.

    It kept nothing at all until it was given a progression system; this key is
    what that added, and it is the only copy — the app has no export.
    """
    raw = store.get("spatial-rotation.progress.v1")
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not data.get("history"):
        return None
    return {"spatial-rotation.progress.v1": raw}


def rnb_from(store):
    """One payload per profile: RNB keeps a whole record under each."""
    out = []
    try:
        profiles = json.loads(store.get("rnb.profiles.v1", "null")) or {}
    except ValueError:
        profiles = {}

    for entry in profiles.get("list", []):
        raw = store.get("rnb.progress.v2." + entry.get("id", ""))
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if data.get("blocks"):
            out.append((entry.get("name", "profile"), data))

    # A record written before profiles existed still sits under the bare key.
    legacy = store.get("rnb.progress.v2")
    if legacy:
        try:
            data = json.loads(legacy)
            if data.get("blocks"):
                out.append(("legacy", data))
        except ValueError:
            pass

    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--outdir", default="live-storage", help="where to write the JSON")
    args = ap.parse_args()

    roots = storage_dirs()
    if not roots:
        raise SystemExit("No Firefox profile found.")

    os.makedirs(args.outdir, exist_ok=True)
    written = []

    for root in roots:
        for origin in sorted(glob.glob(os.path.join(root, "*"))):
            if not os.path.isdir(origin):
                continue

            store = read_origin(origin)
            if not store:
                continue

            label = origin_label(origin)
            safe = "".join(c if c.isalnum() else "-" for c in label)[:60]

            syl = syllogimous_from(store)
            if syl:
                # Which build this came from. The original v4, a fork, a dev server and
                # the deployed copy are all "Syllogimous" and are not the same app —
                # same modes by name, different generators and different scales. Kept
                # as one source so the day counting is not fragmented, and tagged so
                # any analysis that needs them apart can have them apart.
                syl["__origin"] = label
                path = os.path.join(args.outdir, "syllogimous-%s.json" % safe)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(syl, fh)
                items = len(json.loads(syl["SYL_HISTORY"]))
                print("  syllogimous  %-52s %5d items" % (label, items))
                written.append(path)

            v3 = syllogimous_v3_from(store)
            if v3:
                # Which deployment, the same as the other readers record it:
                # v3 is mirrored under several domains and they are one app.
                for r in v3["records"]:
                    r["raw"]["origin"] = label
                path = os.path.join(args.outdir, "syllogimous-v3-%s.json" % safe)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump({
                        "schema": "training-archive-source/1",
                        "source": "syllogimous-v3",
                        "records": v3["records"],
                        "minutes": v3["minutes"],
                    }, fh)
                print("  syllogimous-v3 %-50s %5d items" % (label, len(v3["records"])))
                written.append(path)

            cct = cct_from(store)
            if cct:
                cct["__origin"] = label
                path = os.path.join(args.outdir, "cct-%s.json" % safe)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(cct, fh)
                n = len(json.loads(cct["mp_prog"])["history"])
                print("  cct          %-52s %5d sessions%s"
                      % (label, n, " (at the 100 cap)" if n >= 100 else ""))
                written.append(path)

            ewmt = ewmt_from(store)
            if ewmt:
                ewmt["__origin"] = label
                path = os.path.join(args.outdir, "ewmt-%s.json" % safe)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(ewmt, fh)
                n = len(json.loads(ewmt["attentional_shield_v2"])["sessions"])
                print("  ewmt         %-52s %5d sessions" % (label, n))
                written.append(path)

            prec = precision_from(store)
            if prec:
                prec["__origin"] = label
                path = os.path.join(args.outdir, "precision-%s.json" % safe)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(prec, fh)
                print("  precision    %-52s %5d sessions"
                      % (label, len(json.loads(prec["nback-performance"]))))
                written.append(path)

            rot = rotation_from(store)
            if rot:
                rot["__origin"] = label
                path = os.path.join(args.outdir, "rotation-%s.json" % safe)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(rot, fh)
                hist = json.loads(rot["spatial-rotation.progress.v1"])["history"]
                print("  rotation     %-52s %5d sessions" % (label, len(hist)))
                written.append(path)

            for name, data in rnb_from(store):
                path = os.path.join(args.outdir, "rnb-%s-%s.json" % (safe, name))
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump({"data": data, "__origin": label + " (" + name + ")"}, fh)
                print("  rnb          %-52s %5d blocks (%s)"
                      % (label, len(data["blocks"]), name))
                written.append(path)

    if not written:
        print("Nothing found. Either nothing has been played in Firefox, or it "
              "was played in another browser.")
        return 1

    print("\n%d file(s) in %s" % (len(written), args.outdir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
