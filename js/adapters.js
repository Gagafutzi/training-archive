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
      /*
       * The item's own difficulty, on the scale the app actually reasons in.
       *
       * This was the premise count, on the argument that "the level is decided
       * per answer by a model whose state the history does not carry". True
       * when it was written, and the reason it was wrong to leave: a premise
       * count says a seven-premise linear chain and a seven-premise 7D space
       * are the same item, and says nothing at all about the rungs it carried
       * or the clock it was under. Those are most of what makes a Syllogimous
       * item hard.
       *
       * The app now prices each answered item with `levelOf` — the same
       * function its ability model uses — and stores the result. Read, never
       * recomputed: rebuilding it here would be a second copy of a formula that
       * has per-mode weights and per-rung costs, and the two would drift.
       *
       * Older answers have no level and keep the premise count, under a
       * different unit. That is not a gap to paper over: they are different
       * quantities, and the archive's rule is that a difficulty always travels
       * with what it is measured in.
       */
      difficulty: syllogimousDifficulty(q),
      unit: syllogimousUnit(q),
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
/**
 * What one Syllogimous item was worth, and what that number means.
 *
 * Two units, deliberately kept apart. `syllogimous-level` is the app's own
 * difficulty scale, which prices the mode's weight, the premises, the rungs the
 * item carried, the clock it was under and how the premises were shown.
 * `syllogimous-premises` is the premise count, which is all the older records
 * can offer.
 *
 * They are not convertible — a level of 9 is not nine premises — so they are
 * never mixed. Everything downstream carries the unit with the number for
 * exactly this reason.
 */
function syllogimousDifficulty(q) {
  var d = q && q.difficulty;
  if (d && typeof d.level === "number" && isFinite(d.level)) return d.level;
  return Array.isArray(q && q.premises) ? q.premises.length : null;
}

function syllogimousUnit(q) {
  var d = q && q.difficulty;
  if (d && typeof d.level === "number" && isFinite(d.level)) return "syllogimous-level";
  return "syllogimous-premises";
}

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
    /* Nominal length: the trials it actually ran times its interval. RNB does
       not store a measured duration per block, and its `dailyMinutes` does — so
       a day's total comes from there and this is only ever the block's share.
       An abandoned block ran `trials` of the `plannedTrials` it meant to, and
       counting it at full length would credit a block somebody walked out of
       with the time they did not spend on it. */
    var ran = b.trials != null ? Number(b.trials) : Number(cfg.blockLength);
    var seconds = (ran || 0) * (Number(cfg.interval) || 0) / 1000;

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
        /* Whether it was finished. Everything written before RNB started
           recording abandoned blocks was a finished one by definition —
           nothing else was ever stored — so a missing field reads as
           completed rather than as unknown. */
        completed: b.completed !== false,
        trials: b.trials == null ? null : Number(b.trials),
        plannedTrials: b.plannedTrials == null ? null : Number(b.plannedTrials),
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
 * CCT — Cognitive Control Training                                    *
 * ------------------------------------------------------------------ */

/**
 * A flat map of localStorage keys to strings, the same shape the Syllogimous
 * reader takes, because CCT has no history export at all: its Share button
 * writes settings and profiles only. The record therefore reaches the archive
 * as a storage snapshot — see `tools/firefox-storage.py`.
 *
 * **It keeps the last hundred sessions and no more.** Everything before that
 * survives only as running totals (`sessions`, `totalQ`, `totalCorrect`) with
 * no dates on them, so it cannot be put on a calendar and is deliberately not
 * read here — the same call the Syllogimous reader makes about its trial log.
 * Snapshot often enough and the cap never bites; snapshot rarely and the gap is
 * real and silent, which is worth knowing rather than papering over.
 */
function readCct(data) {
  var raw = data && typeof data === "object" ? data.mp_prog : null;
  if (typeof raw !== "string") return null;

  var prog;
  try { prog = JSON.parse(raw); } catch (e) { return null; }
  if (!prog || !Array.isArray(prog.history)) return null;

  var origin = typeof data.__origin === "string" ? data.__origin : null;
  var records = [];
  var minutes = {};

  for (var i = 0; i < prog.history.length; i++) {
    var h = prog.history[i];
    if (!h || !h.ts) continue;

    /* No id on a session, so the event is its own key — the same three-field
       hash the other readers use. */
    var id = _hashRow(h.ts + "|" + h.total + "|" + h.correct);
    var seconds = Math.max(0, Number(h.durationSec) || 0);

    /* Accuracy from the counts rather than the stored `acc`, which is rounded
       to a whole percent for the display. */
    var total = Number(h.total) || 0;
    var correct = total ? Number(h.correct) / total
                : (h.acc == null ? null : Number(h.acc) / 100);

    /* CCT adapts SPEED, and its own number for that is the fastest interval
       reached — where lower means harder. Carried as a rate instead, because
       every other difficulty in the archive rises with difficulty and a single
       inverted axis is exactly the kind of thing a later chart reads the wrong
       way round without anyone noticing. The interval itself stays in `raw`.
       9999 is the app's own "never set" sentinel. */
    var isi = Number(h.lowestISI);
    var rate = (isi > 0 && isi < 9999) ? 60000 / isi : null;

    records.push(_makeRecord({
      source: "cct",
      id: id,
      at: h.ts,
      kind: "block",
      seconds: seconds,
      correct: correct,
      difficulty: rate == null ? null : Math.round(rate * 100) / 100,
      unit: "cct-peak-items-per-min",
      label: "n" + (h.nback == null ? "?" : h.nback) + (h.ict ? " ict" : ""),
      raw: {
        origin: origin,
        acc: h.acc == null ? null : Number(h.acc),
        correct: h.correct == null ? null : Number(h.correct),
        total: total || null,
        lowestISI: isi > 0 && isi < 9999 ? isi : null,
        durationSec: seconds,
        nback: h.nback == null ? null : h.nback,
        ict: !!h.ict,
      },
    }));

    var day = new Date(h.ts).toISOString().slice(0, 10);
    minutes[day] = (minutes[day] || 0) + seconds / 60;
  }

  if (!records.length) return null;

  /* The lifetime counters, which outlive the hundred-session window and are the
     only trace of anything older. Not records — they have no dates — but worth
     keeping so a reader can see that the history is a tail, not the whole. */
  var state = {};
  if (prog.sessions != null) state.lifetimeSessions = Number(prog.sessions);
  if (prog.totalQ != null) state.lifetimeQuestions = Number(prog.totalQ);
  if (prog.totalCorrect != null) state.lifetimeCorrect = Number(prog.totalCorrect);
  if (prog.longestStreak != null) state.longestStreak = Number(prog.longestStreak);

  return {
    source: "cct",
    records: records,
    minutes: minutes,
    state: Object.keys(state).length ? state : null,
  };
}

/* ------------------------------------------------------------------ *
 * eWMT — the Attentional Shield n-back                                *
 * ------------------------------------------------------------------ */

/**
 * Also a storage snapshot: eWMT has no export of any kind, so there is no file
 * format to read and the browser's own store is the only copy there has ever
 * been.
 *
 * Unlike CCT it keeps every session it has ever run, so the whole record is
 * here whenever the snapshot is taken.
 */
function readEwmt(data) {
  var raw = data && typeof data === "object" ? data.attentional_shield_v2 : null;
  if (typeof raw !== "string") return null;

  var store;
  try { store = JSON.parse(raw); } catch (e) { return null; }
  if (!store || !Array.isArray(store.sessions)) return null;

  var origin = typeof data.__origin === "string" ? data.__origin : null;
  var records = [];
  var minutes = {};

  for (var i = 0; i < store.sessions.length; i++) {
    var s = store.sessions[i];
    if (!s || !s.timestamp) continue;

    var id = _hashRow(s.timestamp + "|" + s.trialsCompleted + "|" + s.durationMs);
    var seconds = Math.max(0, Number(s.durationMs) || 0) / 1000;

    var mods = Array.isArray(s.modalityStats) ? s.modalityStats : [];
    var names = mods.map(function (m) { return m && m.type; })
                    .filter(Boolean).sort();

    /* The app's own accuracy, which counts a miss against you as well as a false
       alarm — hits / (hits + false alarms + misses).

       **A session with no targets in it is not a session scored zero.** eWMT
       computes `totalTargets > 0 ? ... : 0`, so a start that was abandoned
       before the first target — which every session in the first real capture
       turned out to be, 49 of them, two to thirty-three seconds long — is
       written as 0% rather than as no reading. Passing that through would have
       held the whole eWMT accuracy line at the floor with nothing behind it.

       Targets are counted from the per-modality breakdown, which is the only
       place they survive. When that is missing there is nothing to count, and
       the app's own number is taken at face value rather than guessed at. */
    var targets = null;
    if (mods.length) {
      targets = 0;
      for (var m = 0; m < mods.length; m++) {
        targets += (Number(mods[m].hits) || 0) + (Number(mods[m].miss) || 0);
      }
    }
    var acc = s.overallAccuracy == null ? null : Number(s.overallAccuracy) / 100;
    if (targets === 0) acc = null;

    records.push(_makeRecord({
      source: "ewmt",
      id: id,
      at: s.timestamp,
      kind: "block",
      seconds: seconds,
      correct: acc,
      /* The highest n the session actually reached, which is the axis it
         adapts along. */
      difficulty: s.bestN == null ? null : Number(s.bestN),
      unit: "ewmt-n",
      label: "n" + (s.bestN == null ? "?" : s.bestN)
             + (names.length ? "/" + names.join("+") : ""),
      raw: {
        origin: origin,
        bestN: s.bestN == null ? null : Number(s.bestN),
        dPrime: s.overallDPrime == null ? null : Number(s.overallDPrime),
        accuracy: s.overallAccuracy == null ? null : Number(s.overallAccuracy),
        trialsCompleted: s.trialsCompleted == null ? null : Number(s.trialsCompleted),
        /* Kept so the null above can be told from a genuinely missing field. */
        targets: targets,
        /* Per-modality hits, false alarms and misses: the breakdown is the only
           place that says WHICH channel the memory ran out on, and no later
           snapshot reconstructs it. */
        modalityStats: mods,
        settings: s.settings || null,
      },
    }));

    var day = new Date(s.timestamp).toISOString().slice(0, 10);
    minutes[day] = (minutes[day] || 0) + seconds / 60;
  }

  if (!records.length) return null;

  var state = {};
  if (store.bestN != null) state.bestN = Number(store.bestN);
  if (store.createdAt != null) state.createdAt = Number(store.createdAt);

  return {
    source: "ewmt",
    records: records,
    minutes: minutes,
    state: Object.keys(state).length ? state : null,
  };
}

/* ------------------------------------------------------------------ *
 * Precision N-back                                                    *
 * ------------------------------------------------------------------ */

/**
 * A storage snapshot again — it keeps its history under `nback-performance`
 * and has no export.
 *
 * The odd one out here in what it adapts. Every other n-back moves n; this one
 * holds n and moves the *threshold* — how far apart two tones, two hues or two
 * shapes have to be before you can tell them apart, tightened per modality
 * after each session. So n alone would miss most of what changed, and the
 * thresholds are carried in `raw` beside it.
 *
 * Difficulty stays n, because it is the one number here that means the same
 * thing it means everywhere else in the archive. A tightening threshold is a
 * real gain and is not on that axis; reading the two together is a job for
 * something that knows this source, which is what `raw` is for.
 */
function readPrecision(data) {
  var raw = data && typeof data === "object" ? data["nback-performance"] : null;
  if (typeof raw !== "string") return null;

  var history;
  try { history = JSON.parse(raw); } catch (e) { return null; }
  if (!Array.isArray(history)) return null;

  var origin = typeof data.__origin === "string" ? data.__origin : null;
  var records = [];
  var minutes = {};

  for (var i = 0; i < history.length; i++) {
    var h = history[i];
    if (!h || !h.date) continue;
    var at = Date.parse(h.date);
    if (isNaN(at)) continue;

    var cfg = h.settings || {};
    var seconds = Math.max(0, Number(h.duration) || 0) / 1000;

    /* Its own accuracy is hits / (matches + false alarms), already a fraction.
       A session that presented no match at all is not a perfect one: the app
       returns 1 for that case, so taken at face value an abandoned session
       reads as flawless. The same trap eWMT set, in the other direction. */
    var matches = Number(h.totalMatches);
    var correct = (h.accuracy != null && matches > 0) ? Number(h.accuracy) : null;

    records.push(_makeRecord({
      source: "precision",
      id: _hashRow(h.date + "|" + cfg.nLevel + "|" + h.duration),
      at: at,
      kind: "block",
      seconds: seconds,
      correct: correct,
      difficulty: cfg.nLevel == null ? null : Number(cfg.nLevel),
      unit: "precision-n",
      label: "n" + (cfg.nLevel == null ? "?" : cfg.nLevel),
      raw: {
        origin: origin,
        /* The thresholds are the thing this trainer actually moves, and they are
           per modality: cents for the tone, degrees of hue, percent of vertex
           displacement for the shape. Lower is harder in all three. */
        audioThreshold: cfg.audioThreshold == null ? null : Number(cfg.audioThreshold),
        colorThreshold: cfg.colorThreshold == null ? null : Number(cfg.colorThreshold),
        shapeThreshold: cfg.shapeThreshold == null ? null : Number(cfg.shapeThreshold),
        grid: cfg.gridRows != null ? [cfg.gridRows, cfg.gridCols] : null,
        score: h.score || null,
        totalMatches: h.totalMatches == null ? null : Number(h.totalMatches),
        totalMatchesByModality: h.totalMatchesByModality || null,
        correctRejections: h.correctRejections == null ? null : Number(h.correctRejections),
        totalNonMatches: h.totalNonMatches == null ? null : Number(h.totalNonMatches),
      },
    }));

    var day = new Date(at).toISOString().slice(0, 10);
    minutes[day] = (minutes[day] || 0) + seconds / 60;
  }

  if (!records.length) return null;
  return { source: "precision", records: records, minutes: minutes, state: null };
}

/* ------------------------------------------------------------------ *
 * 3D Spatial Rotation — the molecule and stereochemistry trainer      *
 * ------------------------------------------------------------------ */

/**
 * A storage snapshot again, and the only source here that had to be taught to
 * keep a record at all: it computed score, accuracy and time for its end screen
 * and then discarded them, so before the trainer gained a progression system
 * there was nothing on disk for any adapter to read.
 *
 * Three modes under one source — `blocks`, `molecules` and `rs` — kept together
 * because they share the app, the session shape and the level scale, and told
 * apart by the label. Each carries its own ladder inside the app.
 */
function readRotation(data) {
  var raw = data && typeof data === "object"
    ? data["spatial-rotation.progress.v1"] : null;
  if (typeof raw !== "string") return null;

  var store;
  try { store = JSON.parse(raw); } catch (e) { return null; }
  if (!store || !Array.isArray(store.history)) return null;

  var origin = typeof data.__origin === "string" ? data.__origin : null;
  var records = [];
  var minutes = {};

  /* The trainer's own threshold for a session meaning anything. Below it the
     app refuses to move its ladder, and an accuracy read off three answers is
     no more trustworthy here than it was in eWMT or Precision. */
  var MIN_ATTEMPTS = 10;

  for (var i = 0; i < store.history.length; i++) {
    var h = store.history[i];
    if (!h || !h.ts) continue;

    var seconds = Math.max(0, Number(h.seconds) || 0);
    var attempts = Number(h.attempts) || 0;
    var correct = (h.accuracy != null && attempts >= MIN_ATTEMPTS)
      ? Number(h.accuracy) : null;

    records.push(_makeRecord({
      source: "rotation",
      id: _hashRow(h.ts + "|" + h.mode + "|" + h.attempts),
      at: h.ts,
      kind: "block",
      seconds: seconds,
      correct: correct,
      /* The highest level actually reached, which is the session's own
         achievement — the level it happened to end on can be a dip. */
      difficulty: h.peakLevel == null ? null : Number(h.peakLevel),
      unit: "rotation-level",
      label: String(h.mode || "?"),
      raw: {
        origin: origin,
        mode: h.mode || null,
        score: h.score == null ? null : Number(h.score),
        attempts: attempts,
        /* Kept so a null accuracy above can be told from one the app never
           had a number for. */
        rawAccuracy: h.accuracy == null ? null : Number(h.accuracy),
        peakLevel: h.peakLevel == null ? null : Number(h.peakLevel),
        endLevel: h.endLevel == null ? null : Number(h.endLevel),
        /* The established level AFTER this session — the ladder's position, as
           distinct from what was reached during the session. */
        ladderLevel: h.level == null ? null : Number(h.level),
      },
    }));

    var day = new Date(h.ts).toISOString().slice(0, 10);
    minutes[day] = (minutes[day] || 0) + seconds / 60;
  }

  if (!records.length) return null;

  /* Where each mode's ladder stands, which no single session states. */
  var state = {};
  if (store.modes && typeof store.modes === "object") {
    for (var m in store.modes) {
      if (!Object.prototype.hasOwnProperty.call(store.modes, m)) continue;
      var e = store.modes[m] || {};
      state[m] = {
        level: e.level == null ? null : Number(e.level),
        best: e.best == null ? null : Number(e.best),
        sessions: e.sessions == null ? null : Number(e.sessions),
        seconds: e.seconds == null ? null : Number(e.seconds),
      };
    }
  }

  return {
    source: "rotation",
    records: records,
    minutes: minutes,
    state: Object.keys(state).length ? state : null,
  };
}

/* ------------------------------------------------------------------ *
 * The archive's own export                                            *
 * ------------------------------------------------------------------ */

/**
 * Reading back a file this app wrote.
 *
 * This was missing, and its absence was the sharpest bug in the project: the
 * archive exists so that clearing site data does not cost the record, it offers
 * a Save button that writes the whole thing, and that file could not be put
 * back. The backup was write-only.
 *
 * It does not fit the one-source adapter shape, and should not be bent into
 * one: an archive spans sources, and its minutes, state and coverage are all
 * keyed per source. So it comes back as one reading PER SOURCE, each exactly
 * the shape that source's own adapter would have produced, and the existing
 * fold merges them one at a time. No new merge logic, and the idempotence the
 * tests already guarantee applies unchanged.
 *
 * `writtenOn` is carried because coverage depends on it: an export written on
 * the 30th is evidence about every day up to the 30th, and restoring it as if
 * it were written today would silently claim the days in between.
 */
function readArchiveExport(file) {
  if (!file || typeof file !== "object") return null;
  /* Our own schema is the number 1. A prepared single-source file says
     "training-archive-source/1" and carries a `source`; this has neither. */
  if (Number(file.schema) !== 1 || file.source) return null;
  if (!Array.isArray(file.records)) return null;

  var minutes = file.minutes && typeof file.minutes === "object" ? file.minutes : {};
  var state = file.state && typeof file.state === "object" ? file.state : {};

  var bySource = {};
  for (var i = 0; i < file.records.length; i++) {
    var r = file.records[i];
    if (!r || !r.source) continue;
    (bySource[r.source] || (bySource[r.source] = [])).push(r);
  }

  /* A source can hold minutes with no records — a day counted by the trainer
     that produced no scored item — so the sources are the union, not just the
     ones with rows. */
  for (var k in minutes) {
    if (Object.prototype.hasOwnProperty.call(minutes, k) && !bySource[k]) bySource[k] = [];
  }

  var names = Object.keys(bySource);
  if (!names.length) return null;

  var readings = [];
  for (var n = 0; n < names.length; n++) {
    var src = names[n];
    /* The newest state this export holds for the source. It is keyed by the day
       it was taken, and only the latest is worth carrying forward. */
    var forSource = state[src], latest = null;
    if (forSource && typeof forSource === "object") {
      var days = Object.keys(forSource).sort();
      if (days.length) latest = forSource[days[days.length - 1]];
    }
    readings.push({
      source: src,
      records: bySource[src],
      minutes: minutes[src] || {},
      state: latest,
    });
  }

  var writtenOn = null;
  if (file.updatedAt) {
    var d = new Date(file.updatedAt);
    if (!isNaN(d.getTime())) writtenOn = d.toISOString().slice(0, 10);
  }

  /* Notes ride alongside the per-source readings rather than inside one of
     them: they belong to no trainer, and splitting them across sources would
     merge every note once per source. */
  var notes = Array.isArray(file.notes) ? file.notes : [];

  return { archive: true, writtenOn: writtenOn, readings: readings, notes: notes };
}

/* ------------------------------------------------------------------ *
 * Synth — the grapheme-colour synesthesia trainer                     *
 * ------------------------------------------------------------------ */

/**
 * Arrives in two shapes, because the app can hand over either one: its own
 * export (`{app:"synth", data:{...}}`, written by Tools -> Data -> Export) or a
 * storage snapshot holding `synth5_en`, which is what "Read this browser"
 * produces. Both carry the same object, so both are unwrapped to it here.
 *
 * Difficulty is **symbols per minute**, and the direction matters. Synth runs a
 * weighted staircase that holds accuracy at a target — 85% by default — and
 * moves the time window until it gets there. So accuracy is flat by
 * construction and says nothing; what improves is how fast the window can get
 * while accuracy stays pinned. The app stores that window as milliseconds per
 * distinct symbol, which *falls* as you improve; inverting it to a rate gives a
 * line that rises with skill, like every other difficulty series here.
 *
 * Its modes stay under one source and are told apart by the label, as the
 * rotation trainer's are: same app, same session shape, same staircase.
 */
function readSynth(data) {
  if (!data || typeof data !== "object") return null;

  var store = null;
  if (data.app === "synth" && data.data && typeof data.data === "object") {
    store = data.data;
  } else if (typeof data["synth5_en"] === "string") {
    try { store = JSON.parse(data["synth5_en"]); } catch (e) { return null; }
  }
  if (!store || !Array.isArray(store.sessions)) return null;

  var origin = typeof data.__origin === "string" ? data.__origin : null;
  var records = [];
  var minutes = {};

  /* Below this a session's accuracy is a coin-flip readout, the same judgement
     eWMT, Precision and rotation already make about their own short blocks. */
  var MIN_ANSWERS = 8;

  for (var i = 0; i < store.sessions.length; i++) {
    var s = store.sessions[i];
    if (!s || typeof s !== "object") continue;

    var answers = Number(s.n) || 0;
    if (!answers) continue;

    /* Sessions written before the app recorded a clock have only a day. Noon
       UTC keeps the derived day equal to the one the app itself wrote, instead
       of letting a midnight timestamp slide either side of the date line. */
    var at = Number(s.t);
    var inferredTime = false;
    if (!at || isNaN(at)) {
      if (typeof s.d !== "string") continue;
      at = Date.parse(s.d + "T12:00:00Z");
      if (isNaN(at)) continue;
      inferredTime = true;
    }

    /* Likewise for duration. Answers x mean response time is time demonstrably
       spent answering — a floor, not the session's real length, and flagged as
       such so nothing later reads it as measured. */
    var seconds = Number(s.secs) || 0;
    var inferredSeconds = false;
    if (!seconds && s.rt) {
      seconds = Math.min(answers * Number(s.rt) / 1000, answers * MAX_ITEM_SECONDS);
      inferredSeconds = true;
    }

    var correct = answers >= MIN_ANSWERS ? Number(s.c) / answers : null;

    records.push(_makeRecord({
      source: "synth",
      id: _hashRow(at + "|" + (s.m || "?") + "|" + answers),
      at: at,
      kind: "block",
      seconds: seconds,
      correct: correct,
      difficulty: s.spm == null ? null : Number(s.spm),
      unit: "synth-symbols-per-min",
      label: String(s.m || "?").replace(/^game-/, ""),
      raw: {
        origin: origin,
        mode: s.m || null,
        answers: answers,
        correctCount: s.c == null ? null : Number(s.c),
        /* Kept so a null accuracy above can be told from a session the app
           never scored. */
        rawAccuracy: answers ? Number(s.c) / answers : null,
        meanRtMs: s.rt == null ? null : Number(s.rt),
        /* The staircase's own state: ms of window per distinct symbol. */
        msPerSymbol: s.unit == null ? null : Number(s.unit),
        xp: s.xp == null ? null : Number(s.xp),
        inferredTime: inferredTime,
        inferredSeconds: inferredSeconds,
      },
    }));

    var day = new Date(at).toISOString().slice(0, 10);
    minutes[day] = (minutes[day] || 0) + seconds / 60;
  }

  if (!records.length) return null;

  /* What no single session states: where the symbols stand, and the two
     automaticity measures the trainer takes on itself. Both are held back until
     they have the trials to mean anything — a Stroop difference off six trials
     is noise wearing a number's clothes. */
  var state = { symbols: {}, xp: Number(store.xp) || 0, dayStreak: Number(store.dayStreak) || 0 };

  var stats = store.symbolStats || {};
  for (var k in stats) {
    if (!Object.prototype.hasOwnProperty.call(stats, k)) continue;
    var t = stats[k] || {};
    var seen = (Number(t.c) || 0) + (Number(t.w) || 0);
    if (!seen) continue;
    state.symbols[k] = {
      seen: seen,
      accuracy: (Number(t.c) || 0) / seen,
      meanRtMs: t.rtN ? (Number(t.rtSum) || 0) / Number(t.rtN) : null,
    };
  }

  var st = store.stroop || {};
  var cg = Array.isArray(st.congruent) ? st.congruent : [];
  var ic = Array.isArray(st.incongruent) ? st.incongruent : [];
  if (cg.length + ic.length >= 30 && cg.length && ic.length) {
    state.stroopInterferenceMs = _median(ic) - _median(cg);
    state.stroopTrials = cg.length + ic.length;
  }

  /* Search slope: ms added per extra item in the field. Near zero means the
     target is found in parallel rather than scanned for. Least squares over the
     set sizes that have trials, and only with at least two of them — one point
     defines no line. */
  var search = store.search || {};
  var pts = [];
  var trials = 0;
  for (var size in search) {
    if (!Object.prototype.hasOwnProperty.call(search, size)) continue;
    var arr = search[size];
    if (!Array.isArray(arr) || arr.length < 3) continue;
    pts.push({ n: Number(size), rt: _median(arr) });
    trials += arr.length;
  }
  if (pts.length >= 2 && trials >= 30) {
    var mx = 0, my = 0;
    for (var a = 0; a < pts.length; a++) { mx += pts[a].n; my += pts[a].rt; }
    mx /= pts.length; my /= pts.length;
    var num = 0, den = 0;
    for (var b = 0; b < pts.length; b++) {
      num += (pts[b].n - mx) * (pts[b].rt - my);
      den += (pts[b].n - mx) * (pts[b].n - mx);
    }
    if (den) {
      state.searchSlopeMsPerItem = num / den;
      state.searchTrials = trials;
    }
  }

  if (!Object.keys(state.symbols).length) delete state.symbols;

  return { source: "synth", records: records, minutes: minutes, state: state };
}

/** Median of a numeric array. Used for both of Synth's reaction-time measures. */
function _median(arr) {
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ------------------------------------------------------------------ *
 * Dispatch                                                            *
 * ------------------------------------------------------------------ */

var ADAPTERS = [
  /* First, because they identify themselves: both say what they are, so nothing
     else needs to be asked whether it recognises them. */
  { name: "archive", read: readArchiveExport },
  { name: "prepared", read: readPrepared },
  { name: "syllogimous", read: readSyllogimous },
  { name: "rnb", read: readRnb },
  { name: "cct", read: readCct },
  { name: "ewmt", read: readEwmt },
  { name: "precision", read: readPrecision },
  { name: "rotation", read: readRotation },
  { name: "synth", read: readSynth },
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
    readCct: readCct,
    readEwmt: readEwmt,
    readPrecision: readPrecision,
    readRotation: readRotation,
    readSynth: readSynth,
    readPrepared: readPrepared,
    readArchiveExport: readArchiveExport,
    MAX_ITEM_SECONDS: MAX_ITEM_SECONDS,
  };
}
