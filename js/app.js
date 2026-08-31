"use strict";

/* ============================================================
   THE PAGE
   ============================================================

   Drop exports in, read what they come to, take the archive out.

   Nothing here decides anything: every number on the screen is computed in
   `archive.js`, which is the half with tests. This file is wiring.
*/

/* global emptyArchive, fold, days, dayRow, overlap, sourceSummary, cacheSave, cacheLoad, readFile */

var archive = cacheLoad() || emptyArchive();
var $ = function (id) { return document.getElementById(id); };

/** Weeks of overlap before a cross-app comparison is worth computing. */
var WEEKS_NEEDED = 20;

function fmt(n, digits) { return Number(n).toFixed(digits == null ? 0 : digits); }

/* ------------------------------------------------------------------ *
 * Importing                                                           *
 * ------------------------------------------------------------------ */

function importText(text, name) {
  var reading = readFile(text);
  if (reading.error) {
    note(name + ": " + reading.error, true);
    return;
  }

  var out = fold(archive, reading, name);
  var saved = cacheSave(archive);
  note(name + " → " + reading.source + ": "
    + out.added + " new, " + out.updated + " updated, " + out.days + " new days"
    + (saved ? "" : " (cache full — keep the archive file)"));
  render();
}

function note(text, bad) {
  var li = document.createElement("li");
  li.textContent = text;
  if (bad) li.className = "bad";
  $("log").insertBefore(li, $("log").firstChild);
}

function takeFiles(fileList) {
  Array.prototype.forEach.call(fileList, function (file) {
    var reader = new FileReader();
    reader.onload = function () { importText(String(reader.result), file.name); };
    reader.onerror = function () { note(file.name + ": could not be read", true); };
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------------ *
 * Reading the neighbours' storage                                     *
 * ------------------------------------------------------------------ */

/**
 * Both trainers deploy under the same GitHub Pages account, which is one
 * origin — so on the deployed site their localStorage is readable from here
 * without an export at all. Locally they are separate origins and this finds
 * nothing, which is why it is a convenience and never the way data arrives.
 */
function importNeighbours() {
  var found = 0;

  try {
    var syl = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && (key.indexOf("SYL_") === 0 || key.indexOf("syllogimous-") === 0)) {
        syl[key] = localStorage.getItem(key);
      }
    }
    if (syl.SYL_HISTORY) { importText(JSON.stringify(syl), "syllogimous (this browser)"); found++; }
  } catch (e) { /* storage off */ }

  try {
    var profiles = JSON.parse(localStorage.getItem("rnb.profiles.v1") || "null");
    var list = profiles && profiles.list ? profiles.list : [];
    for (var j = 0; j < list.length; j++) {
      var raw = localStorage.getItem("rnb.progress.v2." + list[j].id);
      if (raw) { importText(raw, "rnb: " + list[j].name + " (this browser)"); found++; }
    }
  } catch (e) { /* storage off, or no rnb here */ }

  if (!found) note("Nothing found in this browser's storage — drop the exports in instead.");
}

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */

function render() {
  renderSources();
  renderOverlap();
  renderDays();
  $("save").disabled = archive.records.length === 0;
}

function renderSources() {
  var names = Object.keys(archive.minutes).sort();
  var host = $("sources");
  host.innerHTML = "";

  if (!names.length) {
    host.innerHTML = "<p class='dim'>No sources yet.</p>";
    return;
  }

  names.forEach(function (name) {
    var s = sourceSummary(archive, name);
    var div = document.createElement("div");
    div.className = "card";
    div.innerHTML = "<h3>" + name + "</h3>"
      + "<p><b>" + (s ? s.records : 0) + "</b> " + (s ? s.kind : "record") + "s"
      + " · <b>" + fmt(s ? s.minutes : 0) + "</b> min"
      + " · <b>" + (s ? s.days : 0) + "</b> days</p>"
      + (s && s.accuracy != null
        ? "<p class='dim'>" + fmt(s.accuracy * 100) + "% correct · "
          + s.first + " to " + s.last + "</p>"
        : "")
      + (s && s.unit ? "<p class='dim'>difficulty in <code>" + s.unit + "</code></p>" : "");
    host.appendChild(div);
  });
}

/**
 * The gate, and for now the whole answer.
 *
 * Two trainers with 35 modes on one side and half a dozen measures on the other
 * make roughly 200 candidate pairs. The *strongest* correlation among 200 pairs
 * of pure noise runs about 0.96 on six paired points and 0.56 on twenty-six — so
 * a screen that reported a number today would be at its most impressive when it
 * had least to say. It reports the count instead, until there is enough.
 */
function renderOverlap() {
  var names = Object.keys(archive.minutes).sort();
  var host = $("overlap");
  host.innerHTML = "";

  if (names.length < 2) {
    host.innerHTML = "<p class='dim'>Two sources are needed before anything can be compared.</p>";
    return;
  }

  for (var i = 0; i < names.length; i++) {
    for (var j = i + 1; j < names.length; j++) {
      var pair = overlap(archive, names[i], names[j]);
      var enough = pair.weeks.length >= WEEKS_NEEDED;
      var div = document.createElement("div");
      div.className = "card " + (enough ? "ok" : "waiting");
      div.innerHTML = "<h3>" + names[i] + " ↔ " + names[j] + "</h3>"
        + "<p><b>" + pair.weeks.length + "</b> of " + WEEKS_NEEDED + " weeks"
        + " · " + pair.days.length + " days trained in both</p>"
        + (enough
          ? "<p>Enough overlap to compare. Nothing computed yet — that comes next.</p>"
          : "<p class='dim'>Not enough overlap to compare anything yet. "
            + "With this little data the strongest correlation between two unrelated "
            + "measures would still look convincing.</p>");
      host.appendChild(div);
    }
  }
}

function renderDays() {
  var all = days(archive).slice(-60).reverse();
  var host = $("days");
  var names = Object.keys(archive.minutes).sort();

  if (!all.length) { host.innerHTML = ""; return; }

  var html = "<tr><th>day</th>";
  names.forEach(function (n) { html += "<th>" + n + "</th>"; });
  html += "<th>total</th><th></th></tr>";

  all.forEach(function (day) {
    var row = dayRow(archive, day);
    var trained = names.filter(function (n) { return row.bySource[n] >= 1; });
    html += "<tr><td>" + day + "</td>";
    names.forEach(function (n) {
      var m = row.bySource[n] || 0;
      html += "<td class='" + (m >= 1 ? "" : "dim") + "'>" + (m >= 1 ? fmt(m) + "m" : "—") + "</td>";
    });
    html += "<td><b>" + fmt(row.total) + "m</b></td>";
    html += "<td>" + (trained.length > 1 ? "both" : "") + "</td></tr>";
  });

  host.innerHTML = html;
}

/* ------------------------------------------------------------------ *
 * Taking the archive out                                              *
 * ------------------------------------------------------------------ */

function saveArchive() {
  var blob = new Blob([JSON.stringify(archive, null, 1)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "training-archive-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/**
 * An archive dropped back in is loaded, not folded.
 *
 * It is already the union of everything; folding it would work too, being
 * idempotent, but replacing is what someone restoring after a reset means.
 */
function loadArchive(text) {
  var parsed;
  try { parsed = JSON.parse(text); } catch (e) { return false; }
  if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.records)) return false;
  archive = parsed;
  archive.imports = archive.imports || [];
  archive.minutes = archive.minutes || {};
  cacheSave(archive);
  note("archive restored — " + archive.records.length + " records");
  render();
  return true;
}

/* ------------------------------------------------------------------ *
 * Wiring                                                              *
 * ------------------------------------------------------------------ */

window.addEventListener("DOMContentLoaded", function () {
  $("file").addEventListener("change", function (e) { takeFiles(e.target.files); e.target.value = ""; });
  $("save").addEventListener("click", saveArchive);
  $("neighbours").addEventListener("click", importNeighbours);

  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    // An archive restores; anything else is an export to fold in.
    var files = e.dataTransfer.files;
    Array.prototype.forEach.call(files, function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result);
        if (!loadArchive(text)) importText(text, file.name);
      };
      reader.readAsText(file);
    });
  });

  render();
});
