"use strict";

/* ============================================================
   WHAT THE RECORD SHOWS
   ============================================================

   Pure functions over a folded archive: a calendar, streaks, a series to plot,
   a per-mode breakdown, and a CSV. Nothing here touches the DOM or storage, so
   every claim the page makes is a function that can be checked.

   **The three states are the reason this module exists.**

   Every other tracker's heatmap has two: trained, or didn't. That works when
   the tracker *is* the trainer and therefore always knows. This one ingests
   exports from apps it does not own, so it has a third state and cannot avoid
   it — a day can be inside a span some export vouched for (so an empty day
   really was a rest day), or outside every span (so nobody knows, and the usual
   cause is that site data was cleared before an export was taken).

   Drawing those two the same colour would assert you rested through exactly the
   stretches where the record was lost, which is the one lie this project exists
   to avoid.
*/

/*
 * `covered` comes from `archive.js`, which the page loads as a plain script and
 * node loads as a module. Resolved once here rather than at every call site, so
 * neither environment needs a special case further down.
 */
var isCovered = (typeof module !== "undefined" && typeof require === "function")
  ? require("./archive.js").covered
  : function (a, s, d) { return covered(a, s, d); };

var UNKNOWN = "unknown";
var RESTED = "rested";
var TRAINED = "trained";

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(day, n) {
  var d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

function daysBetween(from, to) {
  return Math.round(
    (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000);
}

/**
 * One square per day, ending today, with what is known about each.
 *
 * `minutes` is the total across sources; `state` is the distinction above.
 * A day counts as covered if *any* source vouched for it — one trainer's export
 * says nothing about whether another was played, but it does establish that the
 * day itself is inside the observed record.
 */
function calendar(archive, endDay, weeks) {
  var end = endDay || ymd(new Date());
  var span = (weeks || 53) * 7;
  var start = addDays(end, -(span - 1));
  var out = [];

  var sources = Object.keys(archive.minutes || {});

  for (var i = 0; i < span; i++) {
    var day = addDays(start, i);
    var row = { day: day, minutes: 0, bySource: {} };

    for (var s = 0; s < sources.length; s++) {
      var m = (archive.minutes[sources[s]] || {})[day] || 0;
      row.bySource[sources[s]] = m;
      row.minutes += m;
    }

    var anyCovered = false;
    for (var c = 0; c < sources.length; c++) {
      if (isCovered(archive, sources[c], day)) { anyCovered = true; break; }
    }

    row.state = row.minutes > 0 ? TRAINED : (anyCovered ? RESTED : UNKNOWN);
    out.push(row);
  }
  return out;
}

/**
 * Current and longest run of trained days.
 *
 * **A day nobody has evidence about does not break a streak, and does not
 * extend one.** Counting it as a miss would punish you for a cleared cache;
 * counting it as a hit would invent training. It is skipped, and the streak
 * spans it — with `uncertain` saying how many of those the current streak is
 * standing on, so a number resting on guesses says so.
 */
function streaks(archive, endDay) {
  var cal = calendar(archive, endDay, 260);
  var longest = 0, run = 0;
  var current = 0, uncertain = 0, currentDone = false;

  for (var i = 0; i < cal.length; i++) {
    if (cal[i].state === TRAINED) run++;
    else if (cal[i].state === RESTED) { if (run > longest) longest = run; run = 0; }
    // UNKNOWN: neither breaks nor extends.
    if (run > longest) longest = run;
  }

  /*
   * The walk back stops where the record itself starts.
   *
   * Unknown days neither break nor extend a streak, so without a floor the walk
   * runs off the front of the archive and counts every day before you ever
   * played as an unevidenced day inside your current streak — a fixture with
   * two real days reported 1818 of them. Everything before the first day with
   * any evidence is not a gap in the record; it is the absence of a record.
   */
  var floor = 0;
  while (floor < cal.length && cal[floor].state === UNKNOWN) floor++;

  for (var j = cal.length - 1; j >= floor && !currentDone; j--) {
    if (cal[j].state === TRAINED) current++;
    else if (cal[j].state === UNKNOWN) uncertain++;
    else currentDone = true;
  }

  // Unknown days trailing the streak with no trained day beyond them are not
  // inside it.
  if (!current) uncertain = 0;

  return { current: current, longest: longest, uncertain: uncertain };
}

/**
 * A per-day series for one source, for plotting.
 *
 * Accuracy is reported only where the day has enough items to mean anything —
 * a day with three answers is a coin toss wearing a percentage, and drawing it
 * beside a day with two hundred invites reading noise as a trend.
 */
function series(archive, source, minItems) {
  var floor = minItems == null ? 10 : minItems;
  var byDay = {};

  for (var i = 0; i < archive.records.length; i++) {
    var r = archive.records[i];
    if (r.source !== source) continue;
    var d = (byDay[r.day] ??= { day: r.day, n: 0, right: 0, seconds: 0 });
    d.n++;
    if (r.correct) d.right++;
    d.seconds += r.seconds || 0;
  }

  return Object.keys(byDay).sort().map(function (day) {
    var d = byDay[day];
    return {
      day: day,
      n: d.n,
      minutes: d.seconds / 60,
      accuracy: d.n >= floor ? d.right / d.n : null,
    };
  });
}

/** Volume and accuracy per label — per mode, per deck, per whatever it names. */
function byLabel(archive, source) {
  var out = {};
  for (var i = 0; i < archive.records.length; i++) {
    var r = archive.records[i];
    if (r.source !== source) continue;
    var key = r.label || "unlabelled";
    var e = (out[key] ??= { label: key, n: 0, right: 0, seconds: 0 });
    e.n++;
    if (r.correct) e.right++;
    e.seconds += r.seconds || 0;
  }
  return Object.keys(out)
    .map(function (k) {
      var e = out[k];
      e.accuracy = e.n ? e.right / e.n : null;
      e.minutes = e.seconds / 60;
      return e;
    })
    .sort(function (a, b) { return b.n - a.n; });
}

/**
 * The records as CSV, one row each.
 *
 * Deliberately the *records* and not a summary: the point of an archive is that
 * somebody else's tool can read it, and a summary is this tool's opinion.
 */
function toCsv(archive) {
  var head = ["source", "id", "day", "at", "kind", "seconds", "correct",
              "difficulty", "unit", "label"];
  var lines = [head.join(",")];

  function cell(v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  for (var i = 0; i < archive.records.length; i++) {
    var r = archive.records[i];
    lines.push(head.map(function (k) { return cell(r[k]); }).join(","));
  }
  return lines.join("\n");
}

if (typeof module !== "undefined") {
  module.exports = {
    calendar: calendar, streaks: streaks, series: series, byLabel: byLabel,
    toCsv: toCsv, addDays: addDays, daysBetween: daysBetween,
    TRAINED: TRAINED, RESTED: RESTED, UNKNOWN: UNKNOWN,
  };
}
