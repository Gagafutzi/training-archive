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
const insight = require("../js/insight.js");
const N = require("../js/notes.js");
const { readFile, readSyllogimous, readRnb, readCct, readEwmt, readPrecision, readRotation, readSynth, readPrepared, readArchiveExport } = require("../js/adapters.js");
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
    firstChild: null, files: [], value: "", hidden: false,
    appendChild(child) { this.innerHTML += child.innerHTML; },
    insertBefore(child) { this.innerHTML += child.textContent; },
    addEventListener() {},
    focus() {},
    classList: { add() {}, remove() {} },
  });
  const nodes = {};
  /*
   * Every id the page defines, read out of the page itself.
   *
   * This used to be a hand-kept list, and a hand-kept list is wrong the moment
   * a control is added to `index.html` — the failure being "Cannot read
   * properties of null", which reads like a bug in the app and is a bug in the
   * fixture. Taking the ids from the markup means the stub is a stub of the
   * real page and stays one.
   */
  const markup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const ids = (markup.match(/\bid="[^"]+"/g) || []).map((m) => m.slice(4, -1));
  assert.ok(ids.length > 10, "no ids found in index.html — the fixture is reading the wrong file");
  for (const id of ids) nodes[id] = el();

  let onReady = null;
  const ctx = {
    console: { log() {} },
    document: {
      getElementById: (id) => nodes[id] || null,
      createElement: () => el(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {}, key: () => null, length: 0 },
    Date, JSON, Math, Number, String, Object, Array, Blob: function () {},
    URL: { createObjectURL: () => "", revokeObjectURL() {} },
    setTimeout: () => 0,
    FileReader: function () {},
    /*
     * The real reason this test passed while the page was dead.
     *
     * `watchSections` returns early when `IntersectionObserver` is missing, and
     * under node it always was — so the observer that threw on every real load
     * was never constructed here. This one is as strict about `rootMargin` as
     * the browser is, and nothing else.
     */
    IntersectionObserver: function (fn, opts) {
      const margin = (opts && opts.rootMargin) || "0px";
      for (const part of String(margin).trim().split(/\s+/)) {
        if (!/^-?\d+(\.\d+)?(px|%)$/.test(part)) {
          throw new SyntaxError(
            "Failed to construct 'IntersectionObserver': rootMargin must be"
            + " specified in pixels or percent.");
        }
      }
      this.observe = function () {};
    },
  };
  ctx.window = {
    addEventListener: (type, fn) => { if (type === "DOMContentLoaded") onReady = fn; },
  };
  vm.createContext(ctx);

  const strip = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")
    // The page loads these as script tags, where `require` does not exist.
    .replace(/typeof require === "function"/g, "false");

  for (const f of ["js/record.js", "js/notes.js", "js/adapters.js", "js/archive.js",
                   "js/insight.js", "js/app.js"]) {
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

  assert.ok(nodes.daysTable.innerHTML.includes("2026-08-25"), "the day table is empty");
  assert.ok(nodes.sourceCards.innerHTML.includes("syllogimous"), "the sources are empty");
  assert.ok(nodes.overlapCards.innerHTML.includes("of 20"), "the overlap gate says nothing");
  assert.strictEqual(nodes.save.disabled, false, "the download button stayed disabled");

  /*
   * Notes through the real render, including a note that is trying to be
   * markup. Everything else this page prints is a source name or a number it
   * computed; notes are the first text on it a person typed, and the first that
   * could close a tag.
   */
  ctx.archive.notes = [
    N.makeNote({ id: "n1", day: "2026-08-25", at: 1, text: "<script>alert(1)</script> felt slow",
      tags: ["sleep"], measure: { name: "RAPM", value: 27, unit: "raw" } }),
    N.tombstone(N.makeNote({ id: "n2", day: "2026-08-24", at: 1, text: "deleted" }), 9),
  ];
  ctx.render();

  assert.ok(nodes.noteList.innerHTML.includes("felt slow"), "the note did not render");
  assert.ok(!nodes.noteList.innerHTML.includes("<script>"),
    "a note closed its own tag — note text reaches innerHTML unescaped");
  assert.ok(nodes.noteList.innerHTML.includes("&lt;script&gt;"), "the text was dropped, not escaped");
  assert.ok(!nodes.noteList.innerHTML.includes("deleted"), "a deleted note is still on the page");
  assert.ok(nodes.measures.innerHTML.includes("RAPM"), "the measure series is empty");
  assert.ok(nodes.daysTable.innerHTML.includes("&#9998;"), "the day with a note carries no marker");
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

/* ------------------------------------------------------------------ *
 * 3D Spatial Rotation                                                 *
 * ------------------------------------------------------------------ */

const rotDump = (history, modes) => ({
  "spatial-rotation.progress.v1": JSON.stringify({
    modes: modes || { blocks: { level: 2, best: 5, sessions: 9, seconds: 900 } },
    history,
  }),
});

const rotSession = extra => Object.assign({
  ts: 1757000000000, mode: "molecules", seconds: 300, score: 18, attempts: 24,
  accuracy: 0.75, peakLevel: 4, endLevel: 3, level: 2,
}, extra || {});

test("rotation: a session records the level it reached, in its own unit", () => {
  const out = readRotation(rotDump([rotSession()]));
  assert.strictEqual(out.source, "rotation");
  const r = out.records[0];
  assert.strictEqual(r.correct, 0.75);
  assert.strictEqual(r.difficulty, 4, "difficulty is the level reached, not the ladder's");
  assert.strictEqual(r.unit, "rotation-level");
  assert.strictEqual(r.seconds, 300);
  assert.strictEqual(r.label, "molecules", "the mode has to survive; three share this source");
  assert.strictEqual(out.minutes[r.day], 5);
  assert.strictEqual(r.raw.ladderLevel, 2, "where the ladder stands is not what was reached");
});

test("rotation: a session too short to count has no accuracy", () => {
  /* The trainer refuses to move its ladder below ten attempts; an accuracy read
     off four answers is no more trustworthy than eWMT's or Precision's was. */
  const out = readRotation(rotDump([
    rotSession({ attempts: 4, score: 4, accuracy: 1, seconds: 9 }),
  ]));
  assert.strictEqual(out.records[0].correct, null,
    "four answers at 100% was recorded as a perfect session");
  assert.strictEqual(out.records[0].raw.rawAccuracy, 1,
    "the app's own number should still be visible in raw");
  assert.strictEqual(out.records[0].seconds, 9, "the time was still spent");
});

test("rotation: the three modes stay apart, and each ladder is carried", () => {
  const out = readRotation(rotDump(
    [rotSession({ mode: "blocks" }), rotSession({ ts: 1757000900000, mode: "rs" })],
    { blocks: { level: 3, best: 6, sessions: 4, seconds: 600 },
      rs: { level: 1, best: 2, sessions: 2, seconds: 300 } }
  ));
  assert.deepStrictEqual(out.records.map(r => r.label).sort(), ["blocks", "rs"]);
  assert.strictEqual(out.state.blocks.level, 3);
  assert.strictEqual(out.state.rs.best, 2);
});

test("rotation: the adapter claims only its own file", () => {
  assert.strictEqual(readRotation({ mp_prog: "{}" }), null);
  assert.strictEqual(readRotation({ "nback-performance": "[]" }), null);
  assert.strictEqual(readRotation({ "spatial-rotation.progress.v1": "{}" }), null);
  assert.strictEqual(readPrecision(rotDump([rotSession()])), null);
  assert.strictEqual(readFile(JSON.stringify(rotDump([rotSession()]))).source, "rotation");
});

/* ------------------------------------------------------------------ *
 * Synth                                                               *
 * ------------------------------------------------------------------ */

const synthSession = (over = {}) => Object.assign({
  d: "2026-09-05", m: "game-symbol-to-char", n: 20, c: 17, rt: 1176,
  xp: 100, t: Date.parse("2026-09-05T09:00:00Z"), secs: 300, spm: 50, unit: 1200,
}, over);

const synthExport = (sessions, store = {}) => ({
  app: "synth", version: "2.5", exported: "2026-09-05T10:00:00.000Z",
  data: Object.assign({ sessions, xp: 1200, dayStreak: 4, symbolStats: {} }, store),
  colors: {},
});

test("synth: a session carries its rate, in its own unit", () => {
  const out = readSynth(synthExport([synthSession()]));
  assert.strictEqual(out.source, "synth");
  assert.strictEqual(out.records.length, 1);
  const r = out.records[0];
  assert.strictEqual(r.unit, "synth-symbols-per-min");
  assert.strictEqual(r.difficulty, 50);
  assert.strictEqual(r.kind, "block");
  assert.strictEqual(r.seconds, 300);
  assert.strictEqual(r.label, "symbol-to-char", "the mode should survive as the label");
  assert.ok(Math.abs(r.correct - 17 / 20) < 1e-9);
  assert.strictEqual(out.minutes["2026-09-05"], 5);
});

test("synth: difficulty rises as the window shrinks", () => {
  /* The staircase pins accuracy and moves speed, so the archive's line has to
     be the rate. Two sessions with identical accuracy must not look identical. */
  const slow = readSynth(synthExport([synthSession({ spm: 30, unit: 2000 })])).records[0];
  const fast = readSynth(synthExport([synthSession({
    t: Date.parse("2026-09-06T09:00:00Z"), spm: 75, unit: 800,
  })])).records[0];
  assert.strictEqual(slow.correct, fast.correct, "accuracy is held flat by design");
  assert.ok(fast.difficulty > slow.difficulty, "the faster session must read as harder");
});

test("synth: a session too short to score has no accuracy", () => {
  const out = readSynth(synthExport([synthSession({ n: 4, c: 4 })]));
  assert.strictEqual(out.records[0].correct, null);
  assert.strictEqual(out.records[0].raw.rawAccuracy, 1, "the raw reading is still kept");
});

test("synth: a row with only a day lands on that day, and says the time was inferred", () => {
  const out = readSynth(synthExport([synthSession({ t: undefined, secs: 0 })]));
  const r = out.records[0];
  assert.strictEqual(r.day, "2026-09-05", "noon UTC must not slide the date");
  assert.strictEqual(r.raw.inferredTime, true);
  assert.strictEqual(r.raw.inferredSeconds, true, "seconds off mean RT must be flagged");
});

test("synth: a storage snapshot reads the same as an export", () => {
  const viaExport = readSynth(synthExport([synthSession()]));
  const viaStorage = readSynth({ synth5_en: JSON.stringify(synthExport([synthSession()]).data) });
  assert.deepStrictEqual(viaStorage.records, viaExport.records,
    "'Read this browser' and the app's own export must agree");
});

test("synth: re-importing an export changes nothing", () => {
  const rows = readSynth(synthExport([synthSession(), synthSession({
    t: Date.parse("2026-09-05T10:00:00Z"), m: "game-search",
  })])).records;
  const first = mergeRecords([], rows);
  const again = mergeRecords(first.records, rows);
  assert.strictEqual(first.total, 2);
  assert.strictEqual(again.total, 2, "a second import of the same file grew the archive");
  assert.strictEqual(again.added, 0);
});

test("synth: the automaticity measures are withheld until they are earned", () => {
  const few = readSynth(synthExport([synthSession()], {
    stroop: { congruent: [700, 720], incongruent: [780, 800] },
    search: { 6: [800, 810, 820], 12: [900, 910, 920] },
  }));
  assert.strictEqual(few.state.stroopInterferenceMs, undefined,
    "four Stroop trials must not produce an interference number");
  assert.strictEqual(few.state.searchSlopeMsPerItem, undefined,
    "six search trials must not produce a slope");

  const many = readSynth(synthExport([synthSession()], {
    stroop: { congruent: Array(20).fill(700), incongruent: Array(20).fill(760) },
    search: { 6: Array(15).fill(800), 12: Array(15).fill(920), 20: Array(15).fill(1040) },
  }));
  assert.strictEqual(many.state.stroopInterferenceMs, 60);
  /* (6,800) (12,920) (20,1040) -> least squares gives 1680/98.67 = 17.027 */
  assert.ok(Math.abs(many.state.searchSlopeMsPerItem - 17.027) < 0.01,
    "slope should be the least-squares fit over set size");
});

test("synth: the adapter claims only its own file", () => {
  assert.strictEqual(readSynth({ app: "synth" }), null, "no sessions is not a reading");
  assert.strictEqual(readSynth({ app: "other", data: { sessions: [] } }), null);
  assert.strictEqual(readSynth(synthExport([])), null);
  assert.strictEqual(readSynth({ "spatial-rotation.progress.v1": "{}" }), null);
  assert.strictEqual(readFile(JSON.stringify(synthExport([synthSession()]))).source, "synth");
});

/* ------------------------------------------------------------------ *
 * What the records carry, and what the page had never read             *
 * ------------------------------------------------------------------ */

/**
 * Every record has carried the exporting program's own account of the item —
 * how it was answered, what modifiers it had on — and the page read six fields
 * and ignored the rest. The one that matters most is the answer mode, because
 * accuracy is not comparable without it: ninety per cent on true or false is
 * barely above guessing, and sixty on a six-slot construction is nowhere near
 * it.
 */
test("a correct answer is worth what it was worth guessing at", function () {
  assert.strictEqual(insight.chanceOf({ answerMode: "boolean" }), 0.5, "true or false is one in two");
  assert.strictEqual(insight.chanceOf({ answerMode: "choice", choices: 4 }), 0.25, "a four-way pick");
  /* Compared with a tolerance: `Math.pow(1/3, 3)` and `1/27` differ in the
     last bit, which is a fact about doubles and not about guessing. */
  assert.ok(
    Math.abs(insight.chanceOf({ answerMode: "construct", slots: 3, options: 3 }) - 1 / 27) < 1e-12,
    "a three-slot construction");
  assert.strictEqual(insight.chanceOf({ answerMode: "map", slots: 2, options: 4 }), 1 / 12,
    "an ordered pick of two from four");
});

test("a record that did not say is not assumed", function () {
  assert.strictEqual(insight.chanceOf(null), null, "a record with no detail was given a chance level");
  assert.strictEqual(insight.chanceOf({}), null, "a record with no answer mode was given one");
  assert.strictEqual(insight.corrected(8, 10, null), null, "an unknown chance level still corrected");
});

test("correcting for chance reorders what looks best", function () {
  /*
   * Seventy per cent on true-or-false against sixty on a one-in-ten pick: 0.40
   * against 0.56, so the lower raw figure is the better answer.
   *
   * Not every such pair reverses, and the first version of this assumed one
   * that does not — eighty against a coin still beats sixty against one in ten,
   * 0.60 to 0.56. The correction is a scale, not a thumb on the balance.
   */
  var easy = insight.corrected(70, 100, 0.5);
  var hard = insight.corrected(60, 100, 0.1);
  assert.ok(hard > easy,
    "sixty per cent against one chance in ten should beat seventy against one"
    + " in two, and read " + hard.toFixed(2) + " against " + easy.toFixed(2));
  assert.strictEqual(insight.corrected(50, 100, 0.5), 0,
    "answering at chance should read nothing");
  assert.strictEqual(insight.corrected(100, 100, 0.5), 1,
    "answering everything should read one");
});

test("never below nothing, however badly it went", function () {
  assert.strictEqual(insight.corrected(10, 100, 0.5), 0,
    "answering below chance read as negative, which is a worse score than never"
    + " pressing and is not a thing");
});

/** One walk-away moves a mean and leaves a median alone. */
test("the middle of the times, not their average", function () {
  assert.strictEqual(insight.median([5, 6, 7]), 6, "an odd count takes the middle one");
  assert.strictEqual(insight.median([4, 6]), 5, "an even count takes the two middle ones");
  assert.strictEqual(insight.median([]), null, "no times should be no answer");
  assert.strictEqual(insight.median([5, 6, 7, 6000]), 6.5,
    "one twenty-minute answer moved the middle");
});

/* ------------------------------------------------------------------ *
 * The page itself                                                     *
 * ------------------------------------------------------------------ *
 *
 * `app.js` is called wiring and has no tests, which is exactly why import
 * broke: a `rootMargin` of "-4rem" threw out of the `IntersectionObserver`
 * constructor, that constructor ran first inside `DOMContentLoaded`, and so no
 * listener on the page was ever attached. Choosing a file did nothing, dropping
 * one did nothing, and nothing appeared in the console the page shows you.
 *
 * These three read the two files as text. They cannot run the page, but they
 * can hold the contracts between the markup and the wiring — which is where
 * both of the faults were.
 */

const PAGE_HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const PAGE_JS = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

test("page: no id is used twice", () => {
  const seen = new Map();
  for (const m of PAGE_HTML.matchAll(/\bid="([^"]+)"/g)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepStrictEqual(dupes, [],
    "getElementById returns the first match, so a container sharing its"
    + " section's id makes the page overwrite the whole section: " + dupes.join(", "));
});

test("page: every element the wiring looks up exists", () => {
  const ids = new Set([...PAGE_HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const missing = [...new Set([...PAGE_JS.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]))]
    .filter(id => !ids.has(id));
  assert.deepStrictEqual(missing, [],
    "app.js reads elements the markup does not define: " + missing.join(", "));
});

test("page: rootMargin is in units rootMargin accepts", () => {
  for (const m of PAGE_JS.matchAll(/rootMargin:\s*"([^"]*)"/g)) {
    for (const part of m[1].trim().split(/\s+/)) {
      assert.ok(/^-?\d+(\.\d+)?(px|%)$/.test(part),
        "`" + part + "` is not px or %, and IntersectionObserver throws on it"
        + " rather than ignoring it — taking every listener in"
        + " DOMContentLoaded down with it");
    }
  }
});

/* ------------------------------------------------------------------ *
 * Notes                                                               *
 * ------------------------------------------------------------------ *
 *
 * The one thing in the archive that no export can rebuild, which raises the
 * stakes on the merge: a bug in the record merge costs a re-import, a bug here
 * costs something that existed in one place.
 */

const aNote = (over) => N.makeNote(Object.assign(
  { id: "n1", day: "2026-03-01", at: 1000, text: "took the RAPM" }, over));

test("notes: folding the same file twice changes nothing", () => {
  const one = [aNote({}), aNote({ id: "n2", day: "2026-03-02", text: "slept badly" })];
  const first = N.mergeNotes([], one);
  const again = N.mergeNotes(first.notes, one);
  assert.strictEqual(again.total, 2, "a re-import doubled the notes");
  assert.strictEqual(again.added, 0);
  assert.strictEqual(again.updated, 0);
});

test("notes: the later writing wins, whichever file arrived first", () => {
  const edited = aNote({ text: "took the RAPM, scored 27", editedAt: 5000 });
  const stale = aNote({ text: "took the RAPM", editedAt: 1000 });

  const forwards = N.mergeNotes([stale], [edited]).notes[0];
  assert.strictEqual(forwards.text, "took the RAPM, scored 27");

  /* The case the record merge gets wrong for notes: an old backup folded in
     after an edit. "Later import wins" would revert the sentence. */
  const backwards = N.mergeNotes([edited], [stale]).notes[0];
  assert.strictEqual(backwards.text, "took the RAPM, scored 27",
    "folding an old archive in silently reverted an edit");
});

test("notes: a deletion survives an old archive being folded back in", () => {
  const live = aNote({ editedAt: 1000 });
  const gone = N.tombstone(live, 5000);

  const after = N.mergeNotes([gone], [live]);
  assert.strictEqual(after.total, 1, "the tombstone was dropped, not kept");
  assert.strictEqual(N.visibleNotes({ notes: after.notes }).length, 0,
    "a deleted note came back when an older archive was imported");
});

test("notes: a tombstone does not keep what it was told to forget", () => {
  const gone = N.tombstone(aNote({ tags: ["iq"], measure: { name: "RAPM", value: 27 } }), 5000);
  assert.strictEqual(gone.text, "", "the text stayed in the file after a delete");
  assert.deepStrictEqual(gone.tags, []);
  assert.strictEqual(gone.measure, null);
  assert.strictEqual(gone.id, "n1", "the identity is what makes the deletion propagate");
});

test("notes: the day is taken as given, not guessed from the clock", () => {
  // One in the morning in Berlin is the day before in UTC. The form hands the
  // local day down, and a note must land on the day the person meant.
  const n = N.makeNote({ id: "x", day: "2026-03-02", at: Date.UTC(2026, 2, 1, 23, 30) });
  assert.strictEqual(n.day, "2026-03-02");
  const guessed = N.makeNote({ id: "y", at: Date.UTC(2026, 2, 1, 23, 30) });
  assert.strictEqual(guessed.day, "2026-03-01", "with no day given, the clock decides");
});

test("notes: a measure needs a number, and carries its unit", () => {
  assert.strictEqual(N.makeNote({ id: "a", measure: { name: "RAPM" } }).measure, null,
    "a name with no value is not a measurement");
  assert.strictEqual(N.makeNote({ id: "a", measure: { name: "RAPM", value: "" } }).measure, null);
  assert.strictEqual(N.makeNote({ id: "a", measure: { name: "RAPM", value: "27" } }).measure.value, 27);
  assert.strictEqual(N.makeNote({ id: "a", measure: { value: 27 } }).measure, null,
    "a number with no name cannot be put beside anything");
});

test("notes: one name in two units is one heading that says so", () => {
  const archive = { notes: [
    aNote({ id: "a", day: "2026-01-01", measure: { name: "RAPM", value: 24, unit: "raw" } }),
    aNote({ id: "b", day: "2026-06-01", measure: { name: "RAPM", value: 88, unit: "percentile" } }),
    aNote({ id: "c", day: "2026-03-01", measure: { name: "digit span", value: 7, unit: "" } }),
  ] };
  const series = N.measureSeries(archive);
  assert.deepStrictEqual(series.map((s) => s.name), ["RAPM", "digit span"]);

  const rapm = series[0];
  assert.deepStrictEqual(rapm.points.map((p) => p.value), [24, 88], "points are out of order");
  assert.ok(rapm.mixed, "raw and percentile were treated as one series");
  assert.ok(!series[1].mixed);
});

test("notes: a deleted note is in no series and no tag count", () => {
  const archive = { notes: [
    N.tombstone(aNote({ id: "a", tags: ["iq"], measure: { name: "RAPM", value: 24 } }), 9000),
    aNote({ id: "b", tags: ["iq", "sleep"] }),
  ] };
  assert.deepStrictEqual(N.measureSeries(archive), []);
  assert.deepStrictEqual(N.tagCounts(archive).map((t) => t.tag), ["iq", "sleep"]);
});

test("notes: two devices offline do not collide", () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(N.noteId(Date.now()));
  assert.strictEqual(ids.size, 2000, "ids collided within a single millisecond run");
});

test("notes: an archive carries its notes out and back", () => {
  const archive = A.emptyArchive();
  A.foldNotes(archive, [aNote({ tags: ["iq"], measure: { name: "RAPM", value: 27, unit: "raw" } })]);
  A.fold(archive, {
    source: "syllogimous",
    records: [makeRecord({ source: "syllogimous", id: "1", at: Date.UTC(2026, 2, 1), seconds: 30, correct: 1 })],
    minutes: { "2026-03-01": 10 },
  }, "a");

  // Out through the download, back in through the adapter, exactly as the page
  // does it — this is the path a restore takes, and notes were dropped on it.
  const roundTrip = readFile(JSON.stringify(archive));
  assert.ok(roundTrip.archive, "our own archive was not recognised");
  assert.strictEqual(roundTrip.notes.length, 1, "the notes did not survive the download");

  const restored = A.emptyArchive();
  for (const r of roundTrip.readings) A.fold(restored, r, "f", roundTrip.writtenOn);
  A.foldNotes(restored, roundTrip.notes);
  assert.strictEqual(N.visibleNotes(restored).length, 1);
  assert.strictEqual(N.visibleNotes(restored)[0].measure.value, 27);
});

test("notes: an archive written before notes existed still opens", () => {
  const old = A.emptyArchive();
  delete old.notes;
  const reading = readFile(JSON.stringify(old.records.length ? old
    : Object.assign(old, { records: [makeRecord({ source: "s", id: "1", at: 1000 })] })));
  assert.ok(reading.archive);
  assert.deepStrictEqual(reading.notes, [], "a missing notes array should read as none");
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

