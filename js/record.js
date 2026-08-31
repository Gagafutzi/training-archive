"use strict";

/* ============================================================
   THE RECORD
   ============================================================

   One row per thing you did, from any trainer. Deliberately thin.

   The tempting mistake here is a rich universal schema — one that knows about
   n-back levels and premise counts and relational complexity, and puts them all
   on one axis so they can be compared. That axis does not exist. Two trainers
   agree on almost nothing except that something happened, when, how long it
   took, and whether it went well; everything past that is each app's own
   vocabulary and belongs in `raw`.

   So `difficulty` always travels with `unit`, and nothing here ever compares two
   records whose units differ. A cross-app claim has to be built out of each
   source's own series moving over time, never out of one number being larger
   than another.
*/

/** The fields every source has to fill, and nothing else. */
function makeRecord(fields) {
  const at = Number(fields.at);
  return {
    source: String(fields.source),
    /* Stable within a source and across exports of it: importing two
       overlapping files must produce one row, not two. Sources with no id of
       their own get a hash of the row — see `hashRow`. */
    id: String(fields.id),
    at,
    /* UTC, which is what both trainers already key their daily minutes by.
       Arguably wrong east or west of Greenwich, and shared deliberately: a
       combined day that split differently from either source's own day would
       disagree with both of them. */
    day: new Date(at).toISOString().slice(0, 10),
    kind: fields.kind || "item",
    seconds: Math.max(0, Number(fields.seconds) || 0),
    /* 1 or 0 for a single item, a fraction for a scored block, null where the
       source does not say. */
    correct: fields.correct == null ? null : Number(fields.correct),
    difficulty: fields.difficulty == null ? null : Number(fields.difficulty),
    /* What `difficulty` is measured in. Never comparable across sources, and
       carried alongside the number so a later reader cannot forget that. */
    unit: fields.unit || null,
    label: fields.label == null ? "" : String(fields.label),
    raw: fields.raw || null,
  };
}

/**
 * A stable id for a source that has none.
 *
 * Third-party exports are usually a table of scores and dates with no key, so
 * the row itself has to be the key. FNV-1a over the row's own text: the same row
 * gives the same id in this run and in one three years from now — which is the
 * whole requirement, since the alternative is duplicate rows every time two
 * exports overlap.
 */
function hashRow(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Fold records into an archive. **Idempotent by construction.**
 *
 * Union on `source + id`, never addition. Importing the same file twice has to
 * change nothing, and importing two overlapping exports has to produce their
 * union rather than their sum — which is the entire point of the project, since
 * the records it exists to hold are the ones a browser reset would otherwise
 * take away.
 *
 * A later import of the same row *replaces* the earlier one rather than being
 * dropped: an export written later saw the same event with more of the app's
 * history behind it, and where the two disagree the later reading is the one to
 * keep. The identity does not change, so this can never duplicate.
 */
function mergeRecords(existing, incoming) {
  const byKey = new Map();
  for (const r of existing) byKey.set(r.source + " " + r.id, r);

  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const key = r.source + " " + r.id;
    if (byKey.has(key)) {
      if (JSON.stringify(byKey.get(key)) !== JSON.stringify(r)) updated++;
    } else {
      added++;
    }
    byKey.set(key, r);
  }

  const records = [...byKey.values()].sort(function (a, b) { return a.at - b.at; });
  return { records: records, added: added, updated: updated, total: records.length };
}

if (typeof module !== "undefined") {
  module.exports = { makeRecord: makeRecord, hashRow: hashRow, mergeRecords: mergeRecords };
}
