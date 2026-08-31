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
import glob
import json
import os
import shutil
import sqlite3
import sys
import tempfile

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
    """`https+++gagafutzi.github.io` reads better as what it is."""
    name = os.path.basename(path)
    return name.replace("+++", "://").replace("++++", "://").replace("+", "/")


# ---------------------------------------------------------------- extracting

def syllogimous_from(store):
    """The keys its own backup writes, so its own adapter reads the result."""
    out = {k: v for k, v in store.items()
           if k.startswith("SYL_") or k.startswith("syllogimous-")}
    return out if out.get("SYL_HISTORY") else None


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
