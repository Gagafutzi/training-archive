"use strict";

/* ============================================================
   ADAPTERS
   ============================================================

   One per source. Each takes a parsed export and returns records and minutes in
   the shape `record.js` describes.

   Three rules they all follow, and the reasons are worth keeping:

   **Keep the original file.** These adapters will be wrong sometimes, and a
   third-party site will change its export without telling anybody. Whatever is
   dropped in stays on disk, so a fixed adapter can re-read it. Nothing here is
   allowed to be the only copy of anything.

   **Slim `raw`.** The whole export is not carried into the archive — a
   Syllogimous question is mostly rendered HTML and an RNB block carries a
   keypress log. What goes in `raw` is the part a later analysis might want; the
   rest is in the file you kept.

   **Difficulty stays in its own units.** Every adapter states a `unit`, and no
   two sources share one. That is what stops the archive quietly implying that
   an RNB load of 41 and a Syllogimous level of 12 are on the same axis.
*/

/* global makeRecord, hashRow */
var REC = typeof require === "function" ? require("./record.js") : null;
var _makeRecord = REC ? REC.makeRecord : makeRecord;
var _hashRow = REC ? REC.hashRow : hashRow;

/** Five minutes, the point past which an item was not being worked on. */
var MAX_ITEM_SECONDS = 300;

/* ------------------------------------------------------------------ *
 * Syllogimous                                                         *
 * ------------------------------------------------------------------ */

/**
 * A flat map of localStorage keys to strings, as its backup writes.
 *
 * The history is the part with timestamps. The trial log alongside it carries
 * the ability model's own numbers but no times at all, so it cannot be placed
 * on a calendar and is left where it is.
 */
function readSyllogimous(data) {
  var raw = data && typeof data === "object" ? data.SYL_HISTORY : null;
  if (typeof raw !== "string") return null;

  /* Which build these came from, when whatever produced the file knows.
     The original v4, a fork, a dev server and the deployed copy all write
     these keys and are not the same app — so the records stay one source,
     because the day counting should not fragment, and carry the origin so an
     analysis that needs them apart can have them apart. */
  var origin = typeof data.__origin === "string" ? data.__origin : null;

  var history;
  try { history = JSON.parse(raw); } catch (e) { return null; }
  if (!Array.isArray(history)) return null;

  var records = [];
  var minutes = {};

  for (var i = 0; i < history.length; i++) {
    var q = history[i];
    // The flag, not the timestamp: `answeredAt` is set when the question is
    // built, so it is truthy from the start.
    if (!q || !q.answeredAt || q.answered === false) continue;

    /* No id on a stored question, so the event is its own key. Three fields
       rather than one: answered-at is ms and effectively unique, and adding
       the other two costs nothing and removes the argument. */
    var id = _hashRow(q.answeredAt + "|" + q.createdAt + "|" + q.type);

    /* Clamped, which is what the app itself now counts. Left un-clamped this
       is the field that told one real account it had trained for 207 minutes
       on a day it trained for 62 — a tab left open goes in whole otherwise. */
    var seconds = 0;
    if (q.createdAt && q.answeredAt > q.createdAt) {
      seconds = Math.min((q.answeredAt - q.createdAt) / 1000, MAX_ITEM_SECONDS);
    }

    records.push(_makeRecord({
      source: "syllogimous",
      id: id,
      at: q.answeredAt,
      kind: "item",
      seconds: seconds,
      correct: scoreSyllogimous(q),
      /* Premises, not the ability level: the level is decided per answer by a
         model whose state the history does not carry. Naming the unit is what
         keeps that honest. */
      difficulty: Array.isArray(q.premises) ? q.premises.length : null,
      unit: "syllogimous-premises",
      label: q.type || "unknown",
      /*
       * **The whole question, kept.**
       *
       * This started as a curated handful of fields on the argument that a
       * stored question is mostly rendered HTML and the archive should not
       * carry a megabyte of `<span class="subject">` to answer a question about
       * accuracy. That argument is fine about *size* and wrong about *archives*:
       * the one thing you cannot do later is recover a field you decided not to
       * keep, and every analysis in this project so far has wanted something
       * nobody thought to save — the rungs an item carried, which conclusion of
       * a series was missed, what the premises actually said.
       *
       * So `item` is the question as it was stored, untouched. The named fields
       * beside it stay because they are what the charts and the merge read, and
       * a query that has to know a field moved from `depth` to `item.depth`
       * between versions is a query that breaks silently.
       */
      raw: {
        origin: origin,
        answerMode: q.answerMode || "boolean",
        negations: q.negations || 0,
        metaRelations: q.metaRelations || 0,
        depth: q.depth || 0,
        widthDelta: q.widthDelta || 0,
        timer: q.timerTypeOnAnswer || "0",
        /* "0" all premises at once, "1"/"2" the carousels. Absent on anything
           answered before the field existed, and null rather than "0" for
           those: not knowing is a different thing from knowing it was the
           default, and an archive that guessed would be inventing the very
           distinction it was asked to make. */
        presentation: q.gameModeOnAnswer == null ? null : String(q.gameModeOnAnswer),
        claims: Array.isArray(q.series) ? q.series.length : 0,
        item: q,
      },
    }));

    var day = new Date(q.answeredAt).toISOString().slice(0, 10);
    minutes[day] = (minutes[day] || 0) + seconds / 60;
  }

  if (!records.length) return null;

  /*
   * Everything in the export that is not the history.
   *
   * The ability estimates, the trial log, the Customise overrides, the
   * progression config, the thresholds. None of it is per-item, so none of it
   * can be a record — and all of it is the *state the items were served under*,
   * which is exactly what a later analysis of those items will want and exactly
   * what no export after this one will still contain.
   *
   * The trial log is the sharpest case. It carries the ability estimate at the
   * moment each item was chosen, which is the only place that number is ever
   * written down; drop it and no amount of history says what the model thought
   * of you at the time.
   */
  var state = {};
  for (var key in data) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (key === "SYL_HISTORY" || key === "__origin") continue;
    state[key] = data[key];
  }

  return {
    source: "syllogimous",
    records: records,
    minutes: minutes,
    state: Object.keys(state).length ? state : null,
  };
}

/**
 * Whether the item was got right, on the app's own rule.
 *
 * An item that asks several conclusions is judged on all of them — two of three
 * is not the item — which is the rule the app scores by, so it is the rule the
 * archive has to record by or the two will disagree about the same evening.
 */
function scoreSyllogimous(q) {
  if (Array.isArray(q.seriesAnswers) && Array.isArray(q.series) && q.series.length > 1) {
    for (var i = 0; i < q.series.length; i++) {
      if (q.seriesAnswers[i] !== true) return 0;
    }
    return 1;
  }
  if (q.userAnswer == null) return 0;   // a timeout is not a right answer
  return q.userAnswer === q.isValid ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Relational N-back                                                   *
 * ------------------------------------------------------------------ */

/**
 * `{ build, profile, exportedAt, data: { blocks, dailyMinutes, … } }`.
 *
 * A block rather than an item, and that difference is kept rather than papered
 * over: `kind` says which, so nothing later averages a twenty-trial block
 * against a single syllogism as though they were the same size of thing.
 */
function readRnb(file) {
  var data = file && file.data ? file.data : file;
  if (!data || !Array.isArray(data.blocks)) return null;

  var origin = file && typeof file.__origin === "string" ? file.__origin : null;

  var records = [];
  for (var i = 0; i < data.blocks.length; i++) {
    var b = data.blocks[i];
    if (!b || !b.ts) continue;

    var cfg = b.cfg || {};
    /* Nominal length: the block's own trials times its interval. RNB does not
       store a measured duration per block, and its `dailyMinutes` does — so a
       day's total comes from there and this is only ever the block's share. */
    var seconds = (Number(cfg.blockLength) || 0) * (Number(cfg.interval) || 0) / 1000;

    records.push(_makeRecord({
      source: "rnb",
      id: String(b.ts),
      at: b.ts,
      kind: "block",
      seconds: seconds,
      correct: b.score == null ? null : Number(b.score),
      difficulty: b.load == null ? null : Number(b.load),
      unit: "rnb-load",
      label: (b.mode || "?") + "/" + Object.keys(cfg.streams || {}).sort().join("+"),
      /* The whole block, for the reason Syllogimous keeps the whole question:
         a keypress log is the only record of *when inside a block* it went
         wrong, and no later export will still have it — RNB sheds `presses`
         from older blocks the moment its own storage runs short. */
      raw: {
        origin: origin,
        build: b.build || null,
        n: b.n, rc: b.rc, rcTier: b.rcTier,
        interrupted: !!b.interrupted,
        lureScore: b.lureScore == null ? null : b.lureScore,
        rtMedian: b.rt ? b.rt.median : null,
        streams: b.streams || null,
        dim: cfg.dim, frame: cfg.frame, interval: cfg.interval,
        blockLength: cfg.blockLength, varN: cfg.varN,
        block: b,
      },
    }));
  }

  if (!records.length) return null;

  /* RNB counts its own minutes as you play and keeps counting through a block
     you abandon, so its daily total is better evidence than the blocks are. */
  var minutes = {};
  var daily = data.dailyMinutes || {};
  for (var day in daily) {
    if (Object.prototype.hasOwnProperty.call(daily, day)) minutes[day] = Number(daily[day]) || 0;
  }

  /* Everything that is not the blocks: the ladder, the staircase posterior, the
     per-tier tunables, the free-play config, the best load. The state the blocks
     were produced under, and per-export rather than per-block, so it cannot be
     a record either. */
  var state = {};
  for (var key in data) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (key === "blocks") continue;
    state[key] = data[key];
  }

  return {
    source: "rnb",
    records: records,
    minutes: minutes,
    state: Object.keys(state).length ? state : null,
  };
}

/* ------------------------------------------------------------------ *
 * Sources prepared outside the browser                                *
 * ------------------------------------------------------------------ */

/**
 * `{ schema: "training-archive-source/1", source, records, minutes }`.
 *
 * The extension point for everything not written here. Anki keeps its reviews
 * in a SQLite database; another site might hand you a CSV, or a page you have
 * to scrape. None of that belongs in a browser that is meant to still run in
 * five years without a toolchain — so a small script does the reading and emits
 * this, and the page takes it as it stands.
 *
 * `tools/anki-export.py` is the worked example, in Python's standard library
 * with no dependencies at all.
 *
 * Checked rather than trusted: the file is somebody's script's output and a
 * malformed row would otherwise land in the archive and stay there.
 */
function readPrepared(file) {
  if (!file || file.schema !== "training-archive-source/1") return null;
  if (!file.source || !Array.isArray(file.records)) return null;

  var records = [];
  for (var i = 0; i < file.records.length; i++) {
    var r = file.records[i];
    if (!r || !r.id || !(Number(r.at) > 0)) continue;
    records.push(_makeRecord({
      source: file.source,
      id: r.id,
      at: r.at,
      kind: r.kind || "item",
      seconds: r.seconds,
      correct: r.correct,
      difficulty: r.difficulty,
      unit: r.unit,
      label: r.label,
      raw: r.raw || null,
    }));
  }
  if (!records.length) return null;

  var minutes = {};
  var given = file.minutes || {};
  for (var day in given) {
    if (!Object.prototype.hasOwnProperty.call(given, day)) continue;
    var m = Number(given[day]);
    if (isFinite(m) && m >= 0) minutes[day] = m;
  }

  return { source: String(file.source), records: records, minutes: minutes };
}

/* ------------------------------------------------------------------ *
 * Dispatch                                                            *
 * ------------------------------------------------------------------ */

var ADAPTERS = [
  /* First, because it identifies itself: a prepared file says what it is, so
     nothing else needs to be asked whether it recognises it. */
  { name: "prepared", read: readPrepared },
  { name: "syllogimous", read: readSyllogimous },
  { name: "rnb", read: readRnb },
];

/**
 * Which source a dropped file came from, decided by what is in it.
 *
 * By shape rather than by filename: a file gets renamed, and a third-party
 * export arrives called `export (3).json`. Each adapter returns null when the
 * file is not its own, so adding a source is adding one function.
 */
function readFile(text) {
  var parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { error: "That file is not valid JSON." };
  }

  for (var i = 0; i < ADAPTERS.length; i++) {
    var out = ADAPTERS[i].read(parsed);
    if (out) return out;
  }

  /* A backup of the right app with nothing in it is a different problem from an
     unrecognised file, and saying so saves the guess. Syllogimous will export
     just a theme, which is a real backup of a real thing and holds no history. */
  if (parsed && typeof parsed === "object") {
    for (var key in parsed) {
      if (key.indexOf("SYL_") === 0 || key.indexOf("syllogimous-") === 0) {
        return { error: "A Syllogimous backup with no history in it — a theme or "
          + "settings export rather than a full one." };
      }
    }
  }

  return { error: "No adapter recognised that file." };
}

if (typeof module !== "undefined") {
  module.exports = {
    readFile: readFile,
    readSyllogimous: readSyllogimous,
    readRnb: readRnb,
    readPrepared: readPrepared,
    MAX_ITEM_SECONDS: MAX_ITEM_SECONDS,
  };
}
