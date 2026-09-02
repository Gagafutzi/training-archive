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
const { readFile, readSyllogimous, readRnb, readPrepared } = require("../js/adapters.js");
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

const DOWNLOADS = "/home/gagafutzi/Downloads";
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
    assert.ok(out.records.every(r => r.unit === "syllogimous-premises"));
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

const ANKI = "/home/gagafutzi/.local/share/Anki2/Benutzer 1/collection.anki2";
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
