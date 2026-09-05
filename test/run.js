"use strict";

/*
 * Tests, run under node over the very files the browser loads.
 *
 * No build step and no framework: `node test/run.js`. The modules end with a
 * `module.exports` guard so the same file works as a `<script>` tag and as a
 * require, which is what keeps this honest — a test suite running against a
 * transpiled copy is a test suite about a copy.
 *
 * What is tested is the merge, because the merge is the whole promise. If
 * importing the same export twice can double a day, or two overlapping exports
 * can produce two rows for one answer, then the archive is worse than the
 * browser storage it exists to outlive.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { mergeRecords, hashRow, makeRecord } = require("../js/record.js");
const { readFile, readSyllogimous, readRnb, readCct, readEwmt, readPrecision, readPrepared, readArchiveExport } = require("../js/adapters.js");
const { execFileSync } = require("child_process");
const A = require("../js/archive.js");

let passed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

/* ------------------------------------------------------------------ *
 * The merge                                                           *
 * ------------------------------------------------------------------ */

const row = (source, id, at) => makeRecord({ source, id, at, seconds: 10, correct: 1 });

test("importing the same records twice changes nothing", () => {
  const one = [row("a", "1", 1000), row("a", "2", 2000)];
  const first = mergeRecords([], one);
  const again = mergeRecords(first.records, one);

  assert.strictEqual(first.total, 2);
  assert.strictEqual(again.total, 2, "a second import of the same file grew the archive");
  assert.strictEqual(again.added, 0, "a re-import reported new rows");
});

test("two overlapping exports produce their union, not their sum", () => {
  const older = [row("a", "1", 1000), row("a", "2", 2000)];
  const newer = [row("a", "2", 2000), row("a", "3", 3000)];

  const out = mergeRecords(mergeRecords([], older).records, newer);
  assert.strictEqual(out.total, 3, `union of 2 and 2 overlapping by 1 came to ${out.total}`);
  assert.strictEqual(out.added, 1);
});

test("the same id under two sources is two rows", () => {
  const out = mergeRecords([], [row("a", "1", 1000), row("b", "1", 1000)]);
  assert.strictEqual(out.total, 2, "one source's ids collided with another's");
});

test("records come back in time order whatever order they arrived in", () => {
  const out = mergeRecords([], [row("a", "3", 3000), row("a", "1", 1000), row("a", "2", 2000)]);
  assert.deepStrictEqual(out.records.map(r => r.id), ["1", "2", "3"]);
});

test("a row hashes the same way every time", () => {
  assert.strictEqual(hashRow("abc"), hashRow("abc"));
  assert.notStrictEqual(hashRow("abc"), hashRow("abd"));
});

/* ------------------------------------------------------------------ *
 * Minutes                                                             *
 * ------------------------------------------------------------------ */

test("a day's minutes take the larger reading, never the sum", () => {
  const archive = A.emptyArchive();
  A.fold(archive, { source: "x", records: [row("x", "1", 1000)], minutes: { "2026-08-25": 20 } }, "a");
  A.fold(archive, { source: "x", records: [row("x", "1", 1000)], minutes: { "2026-08-25": 20 } }, "a again");

  assert.strictEqual(archive.minutes.x["2026-08-25"], 20,
    "re-importing a file doubled the day");

  A.fold(archive, { source: "x", records: [], minutes: { "2026-08-25": 34 } }, "later");
  assert.strictEqual(archive.minutes.x["2026-08-25"], 34, "a later, larger reading was ignored");

  A.fold(archive, { source: "x", records: [], minutes: { "2026-08-25": 12 } }, "older");
  assert.strictEqual(archive.minutes.x["2026-08-25"], 34,
    "an older export overwrote a day with a smaller figure");
});

test("weeks are counted the way weeks are counted", () => {
  assert.strictEqual(A.isoWeek("2026-08-25"), A.isoWeek("2026-08-29"),
    "two days of one week were counted as two weeks");
  assert.notStrictEqual(A.isoWeek("2026-08-25"), A.isoWeek("2026-09-02"));
});

/* ------------------------------------------------------------------ *
 * The adapters, against real exports                                  *
 * ------------------------------------------------------------------ */

// The machine's own home, not the one this was written on: a hardcoded path
// makes a suite that passes for one person and errors for everybody else.
const DOWNLOADS = require("path").join(require("os").homedir(), "Downloads");
const find = (pattern) => {
  try {
    return fs.readdirSync(DOWNLOADS).filter(f => pattern.test(f))
      .map(f => path.join(DOWNLOADS, f)).sort();
  } catch (e) { return []; }
};

const sylFiles = find(/^syllogimous-export.*\.json$/);
const rnbFiles = find(/^rnb-.*\.json$/);

if (!sylFiles.length || !rnbFiles.length) {
  console.log("(no real exports in ~/Downloads — adapter cases skipped)");
} else {
  test("the syllogimous adapter reads its own export", () => {
    const out = readFile(fs.readFileSync(sylFiles[sylFiles.length - 1], "utf8"));
    assert.strictEqual(out.source, "syllogimous", out.error || "wrong source");
    assert.ok(out.records.length > 100, `only ${out.records.length} records`);
    assert.ok(out.records.every(r => r.at > 0 && r.day.length === 10));
    /*
     * Two units, and only these two. Items answered before the app priced them
     * carry a premise count; everything answered since carries the level the
     * app itself computed. A real export now holds both, which is what a
     * straddling window looks like — and the one thing that must never appear
     * is a third name nobody accounted for.
     */
    const units = new Set(out.records.map(r => r.unit));
    for (const u of units) {
      assert.ok(u === "syllogimous-premises" || u === "syllogimous-level",
        `unexpected difficulty unit ${u}`);
    }
    assert.ok(out.records.every(r => r.difficulty == null || isFinite(r.difficulty)),
      "a record carried a difficulty that is not a number");
    // The clamp: no item may claim more than five minutes of attention.
    assert.ok(out.records.every(r => r.seconds <= 300), "an item claimed over five minutes");
  });

  test("the rnb adapter reads its own export", () => {
    const out = readFile(fs.readFileSync(rnbFiles[rnbFiles.length - 1], "utf8"));
    assert.strictEqual(out.source, "rnb", out.error || "wrong source");
    assert.ok(out.records.length > 50, `only ${out.records.length} records`);
    assert.ok(out.records.every(r => r.kind === "block"));
    assert.ok(out.records.every(r => r.unit === "rnb-load"));
    assert.ok(Object.keys(out.minutes).length > 5);
  });

  test("neither adapter claims the other's file", () => {
    const syl = JSON.parse(fs.readFileSync(sylFiles[sylFiles.length - 1], "utf8"));
    const rnb = JSON.parse(fs.readFileSync(rnbFiles[rnbFiles.length - 1], "utf8"));
    assert.strictEqual(readRnb(syl), null, "the rnb adapter claimed a syllogimous export");
    assert.strictEqual(readSyllogimous(rnb), null, "the syllogimous adapter claimed an rnb export");
  });

  test("every rnb export folds into one archive, oldest to newest", () => {
    /*
     * The case the project exists for. Three exports of the same record, taken
     * on different days and overlapping heavily — dropped in one after another
     * they must come to the union, and dropping them in again must change
     * nothing at all.
     */
    const archive = A.emptyArchive();
    for (const f of rnbFiles) {
      A.fold(archive, readFile(fs.readFileSync(f, "utf8")), path.basename(f));
    }
    const afterAll = archive.records.length;

    for (const f of rnbFiles) {
      A.fold(archive, readFile(fs.readFileSync(f, "utf8")), path.basename(f));
    }
    assert.strictEqual(archive.records.length, afterAll,
      "importing every file a second time changed the archive");

    const newest = readFile(fs.readFileSync(rnbFiles[rnbFiles.length - 1], "utf8"));
    assert.ok(afterAll >= newest.records.length,
      "the archive holds fewer records than its newest single export");
  });

  test("the overlap counter agrees with the two records by hand", () => {
    const archive = A.emptyArchive();
    A.fold(archive, readFile(fs.readFileSync(sylFiles[sylFiles.length - 1], "utf8")), "syl");
    for (const f of rnbFiles) {
      A.fold(archive, readFile(fs.readFileSync(f, "utf8")), path.basename(f));
    }

    const both = A.overlap(archive, "syllogimous", "rnb");
    console.log(`      overlap: ${both.days.length} days, ${both.weeks.length} week(s)`
      + (both.days.length ? ` — ${both.days.join(" ")}` : ""));
    assert.ok(both.days.length >= 1, "no overlapping days found in real exports");
    assert.ok(both.days.every(d => (archive.minutes.syllogimous[d] || 0) >= 1
      && (archive.minutes.rnb[d] || 0) >= 1),
      "a day was counted as overlapping with no time in one of the two");
  });
}

/* ------------------------------------------------------------------ *
 * Prepared sources, and the Anki script that writes one               *
 * ------------------------------------------------------------------ */

test("a prepared file is taken as it stands", () => {
  const out = readPrepared({
    schema: "training-archive-source/1",
    source: "somewhere",
    records: [{ id: "a", at: 1700000000000, kind: "review", seconds: 5, correct: 1 }],
    minutes: { "2023-11-14": 3 },
  });
  assert.strictEqual(out.source, "somewhere");
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].day, "2023-11-14");
});

test("a prepared file with bad rows loses the rows, not the file", () => {
  const out = readPrepared({
    schema: "training-archive-source/1",
    source: "somewhere",
    records: [
      { id: "a", at: 1700000000000, correct: 1 },
      { id: "", at: 1700000000001 },          // no id
      { id: "c" },                             // no timestamp
      { id: "d", at: "nonsense" },
    ],
    minutes: { "2023-11-14": 3, "2023-11-15": -5 },
  });
  assert.strictEqual(out.records.length, 1, "a malformed row reached the archive");
  assert.deepStrictEqual(Object.keys(out.minutes), ["2023-11-14"],
    "a negative day of minutes was accepted");
});

test("a file that says nothing about itself is refused", () => {
  assert.strictEqual(readPrepared({ source: "x", records: [] }), null);
  assert.strictEqual(readPrepared({ schema: "something/else", source: "x", records: [{}] }), null);
});

const ANKI = require("path").join(require("os").homedir(),
  ".local/share/Anki2/Benutzer 1/collection.anki2");
if (!fs.existsSync(ANKI)) {
  console.log("(no anki collection — the exporter case is skipped)");
} else {
  test("the anki exporter reads a real collection into a prepared file", () => {
    const out = path.join(require("os").tmpdir(), "anki-test-source.json");
    execFileSync("python3", [path.join(__dirname, "..", "tools", "anki-export.py"),
      "--collection", ANKI, "--out", out], { stdio: "pipe" });

    const reading = readFile(fs.readFileSync(out, "utf8"));
    assert.strictEqual(reading.source, "anki", reading.error || "wrong source");
    assert.ok(reading.records.length > 0, "no reviews read");
    assert.ok(reading.records.every(r => r.kind === "review"));
    /* No difficulty, on purpose: an interval is a schedule, not a measure of
       how hard the review was, and a made-up one would be the first step
       towards comparing it with another app's. */
    assert.ok(reading.records.every(r => r.difficulty === null && r.unit === null),
      "the anki adapter invented a difficulty");
    assert.ok(reading.records.every(r => r.seconds <= 60), "a review claimed over a minute");

    // And it folds like any other source, twice over.
    const archive = A.emptyArchive();
    A.fold(archive, reading, "anki");
    const once = archive.records.length;
    A.fold(archive, reading, "anki again");
    assert.strictEqual(archive.records.length, once, "re-importing anki grew the archive");

    fs.unlinkSync(out);
  });

  test("a collection found twice contributes its reviews once", () => {
    /*
     * What a profile migration, a restored backup, or a move between Anki
     * packagings produces: the same reviews in two collections, carrying the
     * same ids. The records deduplicate on those ids — but minutes used to be
     * summed per collection, which would have counted the shared days twice
     * while the record count stayed right. Deriving the minutes from the
     * deduplicated reviews is what makes the two agree by construction.
     */
    const out = path.join(require("os").tmpdir(), "anki-double-source.json");
    const script = path.join(__dirname, "..", "tools", "anki-export.py");

    execFileSync("python3", [script, "--collection", ANKI, "--out", out], { stdio: "pipe" });
    const once = readFile(fs.readFileSync(out, "utf8"));

    execFileSync("python3", [script, "--collection", ANKI, "--collection", ANKI,
      "--out", out], { stdio: "pipe" });
    const twice = readFile(fs.readFileSync(out, "utf8"));

    assert.strictEqual(twice.records.length, once.records.length,
      "the same collection read twice doubled the reviews");

    const sum = (m) => Object.keys(m).reduce((a, d) => a + m[d], 0);
    assert.ok(Math.abs(sum(twice.minutes) - sum(once.minutes)) < 0.001,
      `minutes doubled: ${sum(once.minutes)} became ${sum(twice.minutes)}`);

    fs.unlinkSync(out);
  });
}

/* ------------------------------------------------------------------ *
 * The page itself                                                     *
 * ------------------------------------------------------------------ */

/**
 * That `app.js` renders an archive without throwing.
 *
 * It is the only thing standing between a real archive and a blank page, and a
 * blank page is what a `ReferenceError` in a plain script looks like — no build
 * step means no compiler to catch a renamed function, and the browser reports it
 * to a console nobody has open.
 *
 * The DOM here is the smallest one the page's render path actually touches.
 * Faithful enough to catch a missing element or a bad call, and honest about
 * what it is not: it says nothing about how any of it looks.
 */
test("the page renders an archive without throwing", () => {
  const vm = require("vm");

  /* `appendChild` accumulates into innerHTML, because the render path builds
     its cards as elements and the assertions below are about what a reader
     would end up seeing. A stub that swallowed appended children would report
     an empty page for a page that works. */
  const el = () => ({
    innerHTML: "", textContent: "", className: "", disabled: false,
    firstChild: null, files: [],
    appendChild(child) { this.innerHTML += child.innerHTML; },
    insertBefore(child) { this.innerHTML += child.textContent; },
    addEventListener() {},
    classList: { add() {}, remove() {} },
  });
  const nodes = {};
  /*
   * Every id the page defines, so this test renders the real page rather than
   * the half of it that existed when the stub was written. A missing id used to
   * surface as "Cannot read properties of null", which reads like a bug in the
   * app and is a bug in the fixture.
   */
  for (const id of ["log", "save", "sources", "overlap", "days", "file",
                    "neighbours", "drop", "streaks", "heatmap", "charts",
                    "modes", "csv", "filterSource", "filterFrom"]) {
    nodes[id] = el();
  }

  let onReady = null;
  const ctx = {
    console: { log() {} },
    document: {
      getElementById: (id) => nodes[id] || null,
      createElement: () => el(),
    },
    localStorage: { getItem: () => null, setItem() {}, key: () => null, length: 0 },
    Date, JSON, Math, Number, String, Object, Array, Blob: function () {},
    URL: { createObjectURL: () => "", revokeObjectURL() {} },
    setTimeout: () => 0,
    FileReader: function () {},
  };
  ctx.window = {
    addEventListener: (type, fn) => { if (type === "DOMContentLoaded") onReady = fn; },
  };
  vm.createContext(ctx);

  const strip = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")
    // The page loads these as script tags, where `require` does not exist.
    .replace(/typeof require === "function"/g, "false");

  for (const f of ["js/record.js", "js/adapters.js", "js/archive.js", "js/insight.js", "js/app.js"]) {
    vm.runInContext(strip(f), ctx, { filename: f });
  }

  assert.ok(onReady, "app.js never asked to run when the page was ready");
  onReady();                                   // wiring: must not throw

  // A real archive through the real render path.
  const archive = A.emptyArchive();
  A.fold(archive, {
    source: "syllogimous",
    records: [makeRecord({ source: "syllogimous", id: "1", at: Date.UTC(2026, 7, 25),
      seconds: 30, correct: 1, difficulty: 4, unit: "syllogimous-premises", label: "Distinction" })],
    minutes: { "2026-08-25": 40 },
  }, "a");
  A.fold(archive, {
    source: "rnb",
    records: [makeRecord({ source: "rnb", id: "2", at: Date.UTC(2026, 7, 25),
      kind: "block", seconds: 50, correct: 0.8, difficulty: 41, unit: "rnb-load", label: "progression" })],
    minutes: { "2026-08-25": 20 },
  }, "b");

  ctx.archive = archive;
  ctx.render();

  assert.ok(nodes.days.innerHTML.includes("2026-08-25"), "the day table is empty");
  assert.ok(nodes.sources.innerHTML.includes("syllogimous"), "the sources are empty");
  assert.ok(nodes.overlap.innerHTML.includes("of 20"), "the overlap gate says nothing");
  assert.strictEqual(nodes.save.disabled, false, "the download button stayed disabled");
});

/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * What the record shows                                               *
 * ------------------------------------------------------------------ */

const I = require("../js/insight.js");

/**
 * The three states are the whole reason this module exists, so they are the
 * first thing checked. A tracker that owns its trainers has two states and can
 * afford to; this one ingests exports from apps it does not own, so an empty
 * day is either a rest day or a hole in the record, and drawing them alike
 * would claim rest through exactly the stretches that were lost.
 */
test("a day is trained, rested, or unevidenced — and they are told apart", () => {
  const a = A.emptyArchive();
  a.minutes.syl = { "2026-03-02": 40 };
  a.coverage.syl = [["2026-03-01", "2026-03-03"]];

  const cal = I.calendar(a, "2026-03-04", 1);
  const by = {};
  for (const d of cal) by[d.day] = d.state;

  assert.strictEqual(by["2026-03-02"], "trained", "a day with minutes was not called trained");
  assert.strictEqual(by["2026-03-01"], "rested", "an empty day inside a covered span was not a rest day");
  assert.strictEqual(by["2026-03-04"], "unknown", "a day outside every span was claimed as rest");
});

/**
 * An unevidenced day neither breaks a streak nor extends it. Counting it as a
 * miss punishes a cleared cache; counting it as a hit invents training.
 */
test("a hole in the record does not break a streak, and does not fill one", () => {
  const a = A.emptyArchive();
  a.minutes.syl = { "2026-03-01": 30, "2026-03-04": 30 };
  a.coverage.syl = [["2026-03-01", "2026-03-01"], ["2026-03-04", "2026-03-04"]];

  // 03-02 and 03-03 are outside every span: unknown, and skipped.
  const s = I.streaks(a, "2026-03-04");
  assert.strictEqual(s.current, 2, "the streak was broken by days nobody has evidence about");
  assert.strictEqual(s.uncertain, 2,
    "the two unevidenced days inside the streak were not reported as such");

  a.coverage.syl = [["2026-03-01", "2026-03-04"]];
  assert.strictEqual(I.streaks(a, "2026-03-04").current, 1,
    "a known rest day failed to break the streak");
});

/** A percentage from three answers is a coin toss wearing a decimal point. */
test("a day is given an accuracy only once it has enough answers", () => {
  const a = A.emptyArchive();
  a.records = [];
  for (let i = 0; i < 3; i++) {
    a.records.push({ source: "syl", id: "a" + i, day: "2026-03-01", correct: 1, seconds: 10 });
  }
  for (let i = 0; i < 12; i++) {
    a.records.push({ source: "syl", id: "b" + i, day: "2026-03-02", correct: i % 2, seconds: 10 });
  }

  const s = I.series(a, "syl");
  assert.strictEqual(s[0].accuracy, null, "three answers were reported as an accuracy");
  assert.strictEqual(s[1].accuracy, 0.5, "twelve answers were not");
  assert.strictEqual(s[1].n, 12, "the item count is wrong");
});

test("the CSV carries one row per record, with its own commas escaped", () => {
  const a = A.emptyArchive();
  a.records = [{ source: "syl", id: "1", day: "2026-03-01", kind: "item",
                 seconds: 12, correct: 1, label: "Comparison, Numerical" }];
  const csv = I.toCsv(a);
  const lines = csv.split("\n");
  assert.strictEqual(lines.length, 2, "a one-record archive did not make a header and one row");
  assert.ok(lines[1].includes('"Comparison, Numerical"'), "a comma in a label was not quoted");
});


/**
 * The progress line is difficulty, not accuracy.
 *
 * An adaptive trainer holds accuracy at a target and moves the difficulty until
 * it gets there, so accuracy is the controlled variable — flat whether you
 * improved or not. `tools/chart.js` had this written down and the first version
 * of the page drew the other line anyway, so it is a test now.
 */
test("a day carries the difficulty it was played at, in its own unit", () => {
  const a = A.emptyArchive();
  a.records = [
    { source: "syl", id: "1", day: "2026-03-01", correct: 1, seconds: 30,
      difficulty: 4, unit: "premises" },
    { source: "syl", id: "2", day: "2026-03-01", correct: 0, seconds: 30,
      difficulty: 6, unit: "premises" },
    // No difficulty recorded — Anki reviews are like this on purpose.
    { source: "syl", id: "3", day: "2026-03-02", correct: 1, seconds: 30 },
  ];

  const s = I.series(a, "syl");
  assert.strictEqual(s[0].difficulty, 5, "the day's mean difficulty is wrong");
  assert.strictEqual(s[0].unit, "premises", "the unit was dropped");
  assert.strictEqual(s[1].difficulty, null,
    "a day with no recorded difficulty was given one anyway");
});

/* ------------------------------------------------------------------ *
 * CCT and eWMT                                                        *
 * ------------------------------------------------------------------ *
 *
 * Both arrive as a localStorage snapshot rather than an export, because
 * neither app has one. So the thing most worth testing is the sniff: three
 * sources now read a flat key/value map, and each must claim only its own.
 */

const cctDump = (history, extra) => ({
  mp_prog: JSON.stringify(Object.assign({
    sessions: 7, totalQ: 900, totalCorrect: 700, longestStreak: 4, history,
  }, extra || {})),
});

test("CCT: a session becomes one record, with speed carried as a rate", () => {
  const out = readCct(cctDump([
    { ts: 1756800000000, acc: 80, correct: 40, total: 50,
      lowestISI: 2000, durationSec: 300, nback: 2, ict: false },
  ]));
  assert.strictEqual(out.source, "cct");
  assert.strictEqual(out.records.length, 1);
  const r = out.records[0];
  assert.strictEqual(r.correct, 0.8, "accuracy should come from the counts");
  assert.strictEqual(r.difficulty, 30, "2000ms between items is 30 a minute");
  assert.strictEqual(r.unit, "cct-peak-items-per-min");
  assert.strictEqual(r.seconds, 300);
  assert.strictEqual(out.minutes[r.day], 5, "five minutes on that day");
});

test("CCT: the never-set ISI sentinel is not read as a difficulty", () => {
  const out = readCct(cctDump([
    { ts: 1756800000000, acc: 50, correct: 5, total: 10,
      lowestISI: 9999, durationSec: 60, nback: 1 },
  ]));
  assert.strictEqual(out.records[0].difficulty, null,
    "9999 is the app's placeholder, not a speed anybody reached");
});

test("CCT: the lifetime counters survive even though they carry no dates", () => {
  const out = readCct(cctDump([
    { ts: 1756800000000, acc: 80, correct: 4, total: 5, durationSec: 30, nback: 1 },
  ]));
  assert.strictEqual(out.state.lifetimeSessions, 7,
    "the history is a hundred-session tail; the counters are all that says so");
  assert.strictEqual(out.state.lifetimeQuestions, 900);
});

const ewmtDump = sessions => ({
  attentional_shield_v2: JSON.stringify({
    sessions, totalMs: 0, bestN: 3, createdAt: 1756000000000, daily: {},
  }),
});

test("eWMT: a session becomes one record on its own n scale", () => {
  const out = readEwmt(ewmtDump([
    { timestamp: 1756800000000, durationMs: 600000, bestN: 3,
      overallDPrime: 2.1, overallAccuracy: 75, trialsCompleted: 40,
      modalityStats: [{ type: "audio", d: 2, acc: 80, hits: 8, fa: 1, miss: 2 },
                      { type: "position", d: 2.2, acc: 70, hits: 7, fa: 2, miss: 3 }],
      settings: { n: 3 } },
  ]));
  assert.strictEqual(out.source, "ewmt");
  const r = out.records[0];
  assert.strictEqual(r.correct, 0.75);
  assert.strictEqual(r.difficulty, 3);
  assert.strictEqual(r.unit, "ewmt-n");
  assert.strictEqual(r.seconds, 600);
  assert.strictEqual(out.minutes[r.day], 10);
  assert.strictEqual(r.raw.dPrime, 2.1, "d-prime is the better measure; keep it");
  assert.strictEqual(r.raw.modalityStats.length, 2,
    "the per-channel breakdown is the only record of WHICH channel ran out");
});

test("eWMT: a session with no targets has no accuracy, rather than zero", () => {
  /* The app writes 0% when it never presented a target, and the first real
     capture was 49 such sessions — abandoned starts of a few seconds each. */
  const out = readEwmt(ewmtDump([
    { timestamp: 1756800000000, durationMs: 3000, bestN: 2,
      overallDPrime: 0, overallAccuracy: 0, trialsCompleted: 0,
      modalityStats: [{ type: "audio", hits: 0, fa: 0, miss: 0 },
                      { type: "position", hits: 0, fa: 0, miss: 0 }] },
  ]));
  const r = out.records[0];
  assert.strictEqual(r.correct, null,
    "no targets presented is no reading, not a score of zero");
  assert.strictEqual(r.seconds, 3, "the time was still spent and still counts");
  assert.strictEqual(r.raw.targets, 0);
});

test("eWMT: a real zero is still a zero", () => {
  const out = readEwmt(ewmtDump([
    { timestamp: 1756800000000, durationMs: 60000, bestN: 2,
      overallDPrime: 0, overallAccuracy: 0, trialsCompleted: 20,
      modalityStats: [{ type: "audio", hits: 0, fa: 3, miss: 5 }] },
  ]));
  assert.strictEqual(out.records[0].correct, 0,
    "eight targets and none caught is a genuine zero");
});

test("neither new adapter claims a file belonging to another source", () => {
  assert.strictEqual(readCct(ewmtDump([])), null);
  assert.strictEqual(readEwmt(cctDump([])), null);
  assert.strictEqual(readCct({ SYL_HISTORY: "[]" }), null);
  assert.strictEqual(readEwmt({ SYL_HISTORY: "[]" }), null);
  assert.strictEqual(readCct({ mp_prog: "not json" }), null);
  assert.strictEqual(readEwmt({ attentional_shield_v2: "{}" }), null);
});

test("dispatch routes each snapshot to its own adapter", () => {
  const cct = readFile(JSON.stringify(cctDump([
    { ts: 1756800000000, acc: 80, correct: 4, total: 5, durationSec: 30, nback: 1 },
  ])));
  assert.strictEqual(cct.source, "cct", cct.error || "");
  const ewmt = readFile(JSON.stringify(ewmtDump([
    { timestamp: 1756800000000, durationMs: 60000, bestN: 2,
      overallAccuracy: 50, trialsCompleted: 10, modalityStats: [] },
  ])));
  assert.strictEqual(ewmt.source, "ewmt", ewmt.error || "");
});

test("re-importing the same snapshot does not double a day", () => {
  const dump = cctDump([
    { ts: 1756800000000, acc: 80, correct: 4, total: 5, durationSec: 60, nback: 1 },
    { ts: 1756803600000, acc: 60, correct: 3, total: 5, durationSec: 60, nback: 1 },
  ]);
  const first = mergeRecords([], readCct(dump).records);
  const again = mergeRecords(first.records, readCct(dump).records);
  assert.strictEqual(again.records.length, 2, "a re-import duplicated sessions");
});

/* ------------------------------------------------------------------ *
 * Reading back our own export                                         *
 * ------------------------------------------------------------------ *
 *
 * The archive exists so that clearing site data does not cost the record. That
 * promise is only kept if the file it writes can be put back, and for a while
 * it could not be — so these guard the round trip rather than the format.
 */

const exportFile = (records, extra) => Object.assign({
  schema: 1,
  updatedAt: Date.UTC(2026, 8, 3),
  imports: [],
  records,
  minutes: { syl: { "2026-09-01": 12 }, rnb: { "2026-09-02": 30 } },
  state: { rnb: { "2026-09-02": { bestLoad: 41 } } },
  coverage: { syl: [["2026-09-01", "2026-09-03"]] },
}, extra || {});

const expRow = (source, id, day) => ({
  source, id, at: Date.parse(day + "T12:00:00Z"), day,
  kind: "item", seconds: 60, correct: 1, difficulty: null, unit: null,
  label: "", raw: null,
});

test("an archive export comes back as one reading per source", () => {
  const out = readArchiveExport(exportFile([
    expRow("syl", "a", "2026-09-01"),
    expRow("syl", "b", "2026-09-01"),
    expRow("rnb", "c", "2026-09-02"),
  ]));
  assert.ok(out && out.archive, "our own export was not recognised");
  const bySource = {};
  out.readings.forEach(r => { bySource[r.source] = r; });
  assert.deepStrictEqual(Object.keys(bySource).sort(), ["rnb", "syl"]);
  assert.strictEqual(bySource.syl.records.length, 2);
  assert.strictEqual(bySource.rnb.minutes["2026-09-02"], 30,
    "per-source minutes were not carried back");
  assert.deepStrictEqual(bySource.rnb.state, { bestLoad: 41 },
    "the newest state for the source was not carried back");
});

test("a source with minutes but no records is still restored", () => {
  /* A day the trainer counted that produced no scored item. Splitting by
     records alone would drop it and the day would vanish from the record. */
  const out = readArchiveExport(exportFile([expRow("rnb", "c", "2026-09-02")]));
  const syl = out.readings.find(r => r.source === "syl");
  assert.ok(syl, "a source known only from its minutes was dropped");
  assert.strictEqual(syl.records.length, 0);
  assert.strictEqual(syl.minutes["2026-09-01"], 12);
});

test("restoring an export puts every record back, once", () => {
  const file = exportFile([
    expRow("syl", "a", "2026-09-01"),
    expRow("rnb", "c", "2026-09-02"),
  ]);
  const out = readArchiveExport(file);
  const a = A.emptyArchive();
  let added = 0;
  out.readings.forEach(r => { added += A.fold(a, r, "restore", out.writtenOn).added; });
  assert.strictEqual(added, 2);
  assert.strictEqual(a.records.length, 2);

  let again = 0;
  out.readings.forEach(r => { again += A.fold(a, r, "restore", out.writtenOn).added; });
  assert.strictEqual(again, 0, "restoring the same backup twice duplicated records");
  assert.strictEqual(a.records.length, 2);
});

test("a restored export is evidence about the day it was written, not today", () => {
  const out = readArchiveExport(exportFile([expRow("syl", "a", "2026-09-01")]));
  assert.strictEqual(out.writtenOn, "2026-09-03");
  const a = A.emptyArchive();
  A.fold(a, out.readings.find(r => r.source === "syl"), "restore", out.writtenOn);
  assert.deepStrictEqual(a.coverage.syl, [["2026-09-01", "2026-09-03"]],
    "an old backup restored today must not claim the days since");
});

test("the archive reader does not claim files belonging to anything else", () => {
  assert.strictEqual(readArchiveExport(
    { schema: "training-archive-source/1", source: "syl", records: [] }), null,
    "a prepared single-source file is not an archive");
  assert.strictEqual(readArchiveExport({ SYL_HISTORY: "[]" }), null);
  assert.strictEqual(readArchiveExport({ schema: 1 }), null);
  assert.strictEqual(readArchiveExport({ schema: 1, records: [] }), null,
    "an export with nothing in it says nothing");
});

test("dispatch routes our own export to the archive reader", () => {
  const out = readFile(JSON.stringify(exportFile([expRow("syl", "a", "2026-09-01")])));
  assert.ok(out.archive, out.error || "the export was not recognised by readFile");
});

/* ------------------------------------------------------------------ *
 * Difficulty, and the units it is measured in
 * ------------------------------------------------------------------ */

/*
 * Reported: *"how will the archive possibly give a good estimate of syllogimous
 * performance without keeping rungs into account, also premise count in linear
 * compared to space 7d is a completely different game"*.
 *
 * The adapter was reading `q.premises.length`, so every item of every mode was
 * priced by how many sentences it had. The app now stores the level its own
 * ability model computes; this is about reading that, and about never mixing it
 * with the premise counts the older records carry.
 */
const synth = (over) => Object.assign({
  type: "Distinction", premises: ["a", "b", "c", "d"],
  createdAt: 1000, answeredAt: 6000, userAnswer: true, isValid: true,
}, over || {});

const syllExport = (questions) => ({ SYL_HISTORY: JSON.stringify(questions) });

test("an item's stored level is what the archive reads", () => {
  const recs = readSyllogimous(syllExport([
    synth({ difficulty: { level: 12.5, premises: 4, rungs: ["negation"], seconds: 60, carousel: true } }),
  ])).records;
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].difficulty, 12.5, "the archive is still reading the premise count");
  assert.strictEqual(recs[0].unit, "syllogimous-level");
});

test("two modes with the same premise count are no longer the same difficulty", () => {
  const recs = readSyllogimous(syllExport([
    synth({ type: "Linear Arrangement", difficulty: { level: 7.2, premises: 7, rungs: [], seconds: null, carousel: false } }),
    synth({ type: "Direction3D Spatial", answeredAt: 7000, difficulty: { level: 15.9, premises: 7, rungs: [], seconds: null, carousel: false } }),
  ])).records;
  assert.strictEqual(recs.length, 2);
  assert.notStrictEqual(recs[0].difficulty, recs[1].difficulty,
    "seven premises priced identically in two modes — the reported fault");
});

test("an answer from before the level existed keeps its own unit", () => {
  const recs = readSyllogimous(syllExport([synth({})])).records;
  assert.strictEqual(recs[0].difficulty, 4, "the premise-count fallback stopped working");
  assert.strictEqual(recs[0].unit, "syllogimous-premises",
    "an old record was labelled with the new scale");
});

test("a day that straddles the change of scale does not average across it", () => {
  const day = "2026-09-01T12:00:00Z";
  const at = Date.parse(day);
  const rows = [];
  // Four old records at 4 premises, one new record at level 30.
  for (let i = 0; i < 4; i++) {
    rows.push(makeRecord({ source: "syllogimous", id: "old" + i, at: at + i, kind: "item",
      seconds: 5, correct: 1, difficulty: 4, unit: "syllogimous-premises" }));
  }
  rows.push(makeRecord({ source: "syllogimous", id: "new", at: at + 9, kind: "item",
    seconds: 5, correct: 1, difficulty: 30, unit: "syllogimous-level" }));

  const s = I.series({ records: rows }, "syllogimous", 1);
  assert.strictEqual(s.length, 1, "expected one day");
  assert.strictEqual(s[0].unit, "syllogimous-premises",
    "the day should report the unit most of it was measured in");
  assert.strictEqual(s[0].difficulty, 4,
    "the level was folded into the premise counts — that is a mean of two "
    + "different quantities, reported under one of their names");
});

test("once every answer carries a level, the day reports levels", () => {
  const at = Date.parse("2026-09-02T12:00:00Z");
  const rows = [
    makeRecord({ source: "syllogimous", id: "a", at: at, kind: "item", seconds: 5, correct: 1, difficulty: 10, unit: "syllogimous-level" }),
    makeRecord({ source: "syllogimous", id: "b", at: at + 1, kind: "item", seconds: 5, correct: 0, difficulty: 20, unit: "syllogimous-level" }),
  ];
  const s = I.series({ records: rows }, "syllogimous", 1);
  assert.strictEqual(s[0].unit, "syllogimous-level");
  assert.strictEqual(s[0].difficulty, 15);
});

test("a source summary reports the unit most of it is measured in", () => {
  /*
   * The oldest Syllogimous record is a premise count and always will be, so a
   * summary reading the unit off `records[0]` would say "premises" for good —
   * including long after every new answer is a level.
   */
  const at = Date.parse("2026-09-01T12:00:00Z");
  const rows = [];
  rows.push(makeRecord({ source: "syllogimous", id: "old", at: at, kind: "item",
    seconds: 5, correct: 1, difficulty: 4, unit: "syllogimous-premises" }));
  for (let i = 0; i < 5; i++) {
    rows.push(makeRecord({ source: "syllogimous", id: "new" + i, at: at + 1000 + i, kind: "item",
      seconds: 5, correct: 1, difficulty: 11, unit: "syllogimous-level" }));
  }
  const s = A.sourceSummary({ records: rows, minutes: {} }, "syllogimous");
  assert.ok(s, "no summary produced");
  assert.strictEqual(s.unit, "syllogimous-level",
    "the summary is reporting the unit of its oldest record");
  assert.strictEqual(s.records, 6);
});

/* ------------------------------------------------------------------ *
 * Precision N-back                                                    *
 * ------------------------------------------------------------------ */

const precDump = sessions => ({ "nback-performance": JSON.stringify(sessions) });

test("Precision: a session records n, and keeps the thresholds beside it", () => {
  const out = readPrecision(precDump([{
    date: "2026-09-05T10:00:00.000Z", duration: 300000, accuracy: 0.82,
    totalMatches: 20, correctRejections: 30, totalNonMatches: 40,
    settings: { nLevel: 3, audioThreshold: 40, colorThreshold: 12,
                shapeThreshold: 8, gridRows: 3, gridCols: 3 },
    score: { hits: { spatial: 5, audio: 4, color: 5, shape: 4 }, misses: 2,
             audioFalseAlarms: 1, spatialFalseAlarms: 0,
             colorFalseAlarms: 1, shapeFalseAlarms: 0 },
  }]));
  const r = out.records[0];
  assert.strictEqual(out.source, "precision");
  assert.strictEqual(r.difficulty, 3);
  assert.strictEqual(r.unit, "precision-n");
  assert.strictEqual(r.correct, 0.82);
  assert.strictEqual(r.seconds, 300);
  assert.strictEqual(out.minutes[r.day], 5);
  /* The thresholds are what this trainer actually moves; n alone would miss it. */
  assert.strictEqual(r.raw.audioThreshold, 40);
  assert.strictEqual(r.raw.shapeThreshold, 8);
});

test("Precision: a session that presented no match has no accuracy", () => {
  /* The app returns accuracy 1 when nothing was asked, so an abandoned session
     reads as flawless unless that is caught here. */
  const out = readPrecision(precDump([{
    date: "2026-09-05T11:00:00.000Z", duration: 4000, accuracy: 1,
    totalMatches: 0, settings: { nLevel: 2 },
  }]));
  assert.strictEqual(out.records[0].correct, null,
    "an empty session was recorded as a perfect one");
  assert.strictEqual(out.records[0].seconds, 4, "the time was still spent");
});

test("Precision: the adapter claims only its own file", () => {
  assert.strictEqual(readPrecision({ mp_prog: "{}" }), null);
  assert.strictEqual(readPrecision({ SYL_HISTORY: "[]" }), null);
  assert.strictEqual(readPrecision({ "nback-performance": "[]" }), null);
  assert.strictEqual(readPrecision({ "nback-performance": "not json" }), null);
  assert.strictEqual(readCct(precDump([{ date: "x" }])), null);
});

for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.log("  FAIL " + name + "\n       " + e.message);
  }
}
console.log(`\n${passed}/${cases.length} passed`);
process.exit(passed === cases.length ? 0 : 1);
