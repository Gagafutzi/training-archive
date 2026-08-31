"use strict";

/* ============================================================
   THE ARCHIVE
   ============================================================

   **The file is the archive. This site is only the tool that maintains it.**

   That is the whole architecture, and it comes from one fact: nothing a browser
   holds survives "clear site data". Not localStorage, not IndexedDB, not a saved
   file handle — the handle itself lives in IndexedDB and the permission is
   revoked with it. An archive kept in a browser is an archive that disappears on
   the day you debug the app it belongs to, which is exactly how two trainers'
   worth of history came to be six days long.

   So the record lives in a file you keep. This page reads exports, folds them
   in, and writes the file back out. Storage here is a convenience cache and
   nothing more: it is always rebuildable by dropping the archive in again, and
   losing it costs a drag and drop.
*/

/* global mergeRecords */
var REC2 = typeof require === "function" ? require("./record.js") : null;
var _mergeRecords = REC2 ? REC2.mergeRecords : mergeRecords;

var CACHE_KEY = "archive.cache.v1";
var SCHEMA = 1;

function emptyArchive() {
  return {
    schema: SCHEMA,
    updatedAt: null,
    /* What has been folded in, so a re-import is recognisable and so the file
       says where it came from. Never used to decide whether to merge — the
       merge is idempotent, so a file may always be dropped in again. */
    imports: [],
    records: [],
    /* Minutes per source per day, kept apart from the events because both
       trainers count time separately from what they count as an item, and one
       of them counts through a block you abandoned. */
    minutes: {},
  };
}

/**
 * Fold one source's reading into the archive.
 *
 * Minutes take the **larger** of the two rather than the sum, and that is not a
 * detail: minutes accumulate through a day, so a later export of the same day
 * has a figure at least as large, while adding them would double the day every
 * time two overlapping exports were dropped in. Union, never addition, is the
 * same rule the records follow and for the same reason.
 */
function fold(archive, reading, fileName) {
  var merged = _mergeRecords(archive.records, reading.records);
  archive.records = merged.records;

  var bySource = archive.minutes[reading.source] || (archive.minutes[reading.source] = {});
  var addedDays = 0;
  for (var day in reading.minutes) {
    if (!Object.prototype.hasOwnProperty.call(reading.minutes, day)) continue;
    var next = Math.max(bySource[day] || 0, reading.minutes[day]);
    if (bySource[day] == null) addedDays++;
    bySource[day] = next;
  }

  archive.imports.push({
    at: Date.now(),
    file: fileName || "(pasted)",
    source: reading.source,
    added: merged.added,
    updated: merged.updated,
    days: addedDays,
  });
  archive.updatedAt = Date.now();

  return { added: merged.added, updated: merged.updated, days: addedDays, total: merged.total };
}

/* ------------------------------------------------------------------ *
 * What the archive can say                                            *
 * ------------------------------------------------------------------ */

/** Every day any source recorded time, oldest first. */
function days(archive) {
  var set = {};
  for (var source in archive.minutes) {
    for (var day in archive.minutes[source]) set[day] = true;
  }
  return Object.keys(set).sort();
}

/** Minutes per source for one day, and the total. */
function dayRow(archive, day) {
  var row = { day: day, total: 0, bySource: {} };
  for (var source in archive.minutes) {
    var m = archive.minutes[source][day] || 0;
    row.bySource[source] = m;
    row.total += m;
  }
  return row;
}

/**
 * How many days two sources were both trained, and how many weeks that is.
 *
 * **This is the gate on every cross-app claim the project will ever make**, and
 * it is built before any of them. A correlation between two trainers needs
 * overlapping weeks, and with 35 modes on one side and half a dozen measures on
 * the other there are ~200 candidate pairs — at which point the *largest*
 * correlation among pure noise runs about 0.96 on six paired points, 0.78 on
 * twelve, and 0.56 on twenty-six. A screen that reported a number before it had
 * the weeks would be at its most confident when it had least reason to be.
 *
 * So the honest output of this project on the day it is built is a count and a
 * refusal, and the count is the thing worth watching.
 */
var MIN_TRAINED_MINUTES = 1;

function overlap(archive, a, b) {
  var all = days(archive);
  var both = [];
  for (var i = 0; i < all.length; i++) {
    var day = all[i];
    var ma = (archive.minutes[a] || {})[day] || 0;
    var mb = (archive.minutes[b] || {})[day] || 0;
    if (ma >= MIN_TRAINED_MINUTES && mb >= MIN_TRAINED_MINUTES) both.push(day);
  }

  var weeks = {};
  for (var j = 0; j < both.length; j++) weeks[isoWeek(both[j])] = true;

  return { days: both, weeks: Object.keys(weeks).sort() };
}

/** ISO week key, so "how many weeks of overlap" is a countable thing. */
function isoWeek(day) {
  var d = new Date(day + "T00:00:00Z");
  var dayNum = (d.getUTCDay() + 6) % 7;          // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3);      // the Thursday of that week
  var firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  var week = 1 + Math.round(
    ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

/** A source's own summary, in its own units. */
function sourceSummary(archive, source) {
  var records = archive.records.filter(function (r) { return r.source === source; });
  if (!records.length) return null;

  var minutes = archive.minutes[source] || {};
  var totalMinutes = 0;
  var dayCount = 0;
  for (var day in minutes) { totalMinutes += minutes[day]; dayCount++; }

  var scored = records.filter(function (r) { return r.correct != null; });
  var accuracy = scored.length
    ? scored.reduce(function (a, r) { return a + r.correct; }, 0) / scored.length
    : null;

  return {
    source: source,
    records: records.length,
    kind: records[0].kind,
    unit: records[0].unit,
    days: dayCount,
    minutes: totalMinutes,
    accuracy: accuracy,
    first: records[0].day,
    last: records[records.length - 1].day,
  };
}

/* ------------------------------------------------------------------ *
 * The convenience cache                                               *
 * ------------------------------------------------------------------ */

/**
 * Records without `raw`, which is the bulky half.
 *
 * The cache exists so a revisit shows something without a drag and drop. It is
 * not the archive and must never be treated as one — which is why it is stored
 * lossy on purpose: a cache that looked complete would eventually be trusted.
 */
function cacheSave(archive) {
  try {
    var slim = {
      schema: archive.schema,
      updatedAt: archive.updatedAt,
      imports: archive.imports.slice(-20),
      minutes: archive.minutes,
      records: archive.records.map(function (r) {
        var c = {};
        for (var k in r) if (k !== "raw") c[k] = r[k];
        return c;
      }),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(slim));
    return true;
  } catch (e) {
    return false;   // quota, or a browser with storage switched off
  }
}

function cacheLoad() {
  try {
    var raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.records)) return null;
    parsed.imports = parsed.imports || [];
    parsed.minutes = parsed.minutes || {};
    return parsed;
  } catch (e) {
    return null;
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    emptyArchive: emptyArchive, fold: fold, days: days, dayRow: dayRow,
    overlap: overlap, isoWeek: isoWeek, sourceSummary: sourceSummary,
    cacheSave: cacheSave, cacheLoad: cacheLoad, CACHE_KEY: CACHE_KEY,
  };
}
