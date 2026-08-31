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
const { readFile, readSyllogimous, readRnb } = require("../js/adapters.js");
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

/* ------------------------------------------------------------------ */

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
