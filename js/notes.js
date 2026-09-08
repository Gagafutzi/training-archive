"use strict";

/* ============================================================
   THE NOTES
   ============================================================

   Everything the trainers cannot tell you.

   An export knows what you answered and when. It does not know that you took
   an IQ test in March, that you were ill for two weeks in June, that you
   changed a dose, slept badly for a month, or simply felt slow. Those are the
   facts that make a two-year series readable, and they exist nowhere but in the
   head of the person who trained — which is to say they are lost by default.

   So a note is a dated piece of writing kept in the archive file alongside the
   records. Two things about it are deliberate:

   **It merges by authorship, not by recency of import.** Records use "the later
   import wins", because a record is an *observation* and a later export saw the
   same event with more of the app's history behind it. A note is *authored*:
   there is no better view of it later, only an earlier and a later version of
   what someone wrote. If an old backup were folded in after an edit, "later
   import wins" would silently revert the edit. So notes compare `editedAt` and
   the later text wins regardless of which file arrived first.

   **A deletion is a tombstone, and the tombstone is empty.** Union merge cannot
   express removal: delete a note, fold in last month's archive, and it returns.
   So a deleted note keeps its id and its `editedAt` and loses everything else —
   the text, the tags, the measure. The deletion then propagates by exactly the
   rule an edit does, and the file does not go on holding the contents of
   something you asked it to forget.
*/

/**
 * An optional number attached to a note, because the first thing anyone wants
 * to write down here is a test score — and a score kept as prose ("did the
 * RAPM, got 27") can never be put beside the next one.
 *
 * `unit` travels with `value` for the same reason it does on a record: 27 raw,
 * 27 scaled and the 27th percentile are three different facts, and a series
 * that mixed them would be a line through three unrelated numbers.
 */
function makeMeasure(fields) {
  // `String(undefined)` is the five characters "undefined", which is truthy.
  if (!fields || fields.name == null || !String(fields.name).trim()) return null;

  /*
   * Absent is checked before the number is read, because `Number("")` is 0 and
   * so is `Number(null)`. An empty `<input type="number">` hands over `""`, so
   * without this a measure name typed with the value left blank records a score
   * of zero — silently, and looking exactly like a real result forever after.
   */
  const raw = fields.value;
  if (raw == null || String(raw).trim() === "") return null;
  const value = Number(raw);
  if (!isFinite(value)) return null;
  return {
    name: String(fields.name).trim(),
    value: value,
    unit: fields.unit == null ? "" : String(fields.unit).trim(),
  };
}

function makeNote(fields) {
  const at = Number(fields.at) || Date.now();
  /*
   * The day is taken as given, and only guessed from the clock when it is not.
   *
   * Records key their day in UTC on purpose — a combined day that split
   * differently from either source's own day would disagree with both. A note
   * is not an event a trainer timed, though: it is a person saying which day
   * they mean, so the form hands the local date down and this keeps it. Guessing
   * would put a note written at one in the morning on the day before.
   */
  const given = String(fields.day || "");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(given)
    ? given
    : new Date(at).toISOString().slice(0, 10);

  const tags = (Array.isArray(fields.tags) ? fields.tags : [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t.length)
    .filter((t, i, all) => all.indexOf(t) === i);

  return {
    id: String(fields.id || ""),
    day: day,
    at: at,
    /* What the merge compares. Set to `at` on a new note, bumped on every edit
       and on deletion, and never read for anything else. */
    editedAt: Number(fields.editedAt) || at,
    text: fields.text == null ? "" : String(fields.text),
    tags: tags,
    measure: makeMeasure(fields.measure),
    deleted: !!fields.deleted,
  };
}

/**
 * An id unique across devices without any coordination between them.
 *
 * Two browsers writing notes offline and merging their archives later must not
 * collide, and must not be given consecutive numbers by two separate counters
 * that both started at one. Time plus randomness, which is enough at this scale
 * and stays sortable.
 */
function noteId(now, rand) {
  const t = Number(now) || Date.now();
  const r = typeof rand === "function" ? rand : Math.random;
  return t.toString(36) + "-" + Math.floor(r() * 0x100000000).toString(36);
}

/** Strip a note to a tombstone: identity and time, no content. */
function tombstone(note, when) {
  return makeNote({
    id: note.id,
    day: note.day,
    at: note.at,
    editedAt: Number(when) || Date.now(),
    deleted: true,
  });
}

/**
 * Union on `id`, keeping whichever version was written last.
 *
 * Idempotent, like the record merge: folding the same file twice changes
 * nothing, and a tie goes to what is already here so the result does not depend
 * on the order two equal-aged copies arrived in.
 */
function mergeNotes(existing, incoming) {
  const byId = new Map();
  for (const n of existing || []) byId.set(n.id, n);

  let added = 0;
  let updated = 0;
  for (const raw of incoming || []) {
    const n = makeNote(raw);
    if (!n.id) continue;
    const have = byId.get(n.id);
    if (!have) { byId.set(n.id, n); added++; continue; }
    if (n.editedAt > Number(have.editedAt)) { byId.set(n.id, n); updated++; }
  }

  const notes = [...byId.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at);
  return { notes: notes, added: added, updated: updated, total: notes.length };
}

/** The notes there are to read, newest day first. Tombstones are not notes. */
function visibleNotes(archive) {
  return ((archive && archive.notes) || [])
    .filter((n) => !n.deleted)
    .slice()
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.at - a.at));
}

/** How many notes a given day carries, for a marker beside that day. */
function notesOn(archive, day) {
  return visibleNotes(archive).filter((n) => n.day === day).length;
}

/**
 * Each named measure's points in order.
 *
 * Grouped by name and *not* by unit, so a name recorded two ways shows up as
 * one heading that says its units disagree — rather than as two headings that
 * each look like a clean series. The same discipline the difficulty charts
 * follow: never draw one line across two units, and say when you did not.
 */
function measureSeries(archive) {
  const by = new Map();
  for (const n of visibleNotes(archive)) {
    if (!n.measure || !n.measure.name) continue;
    const key = n.measure.name;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({
      day: n.day, value: n.measure.value, unit: n.measure.unit, id: n.id,
    });
  }

  return [...by.entries()]
    .map(([name, points]) => {
      points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      const units = points.map((p) => p.unit)
        .filter((u, i, all) => all.indexOf(u) === i);
      return { name: name, points: points, units: units, mixed: units.length > 1 };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every tag in use, commonest first, for suggesting rather than prescribing. */
function tagCounts(archive) {
  const counts = new Map();
  for (const n of visibleNotes(archive)) {
    for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, n]) => ({ tag: tag, count: n }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}

if (typeof module !== "undefined") {
  module.exports = {
    makeNote: makeNote, makeMeasure: makeMeasure, noteId: noteId,
    tombstone: tombstone, mergeNotes: mergeNotes, visibleNotes: visibleNotes,
    notesOn: notesOn, measureSeries: measureSeries, tagCounts: tagCounts,
  };
}
