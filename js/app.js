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
 * Whether the file is behind the page                                 *
 * ------------------------------------------------------------------ *
 *
 * The header promises that the file is the archive and this page only
 * maintains it. That promise is only kept if the page says when the two have
 * drifted apart — an import that never reached a download is a record that
 * exists in exactly one place, and that place is the one the header warns you
 * about. So the count survives a reload, and leaving with imports outstanding
 * asks first.
 */

var UNSAVED_KEY = "archive.unsaved.v1";
var SAVED_AT_KEY = "archive.savedAt.v1";
var unsavedImports = 0;
var savedAt = "";

function loadSaveState() {
  try {
    unsavedImports = Number(localStorage.getItem(UNSAVED_KEY)) || 0;
    savedAt = localStorage.getItem(SAVED_AT_KEY) || "";
  } catch (e) { /* storage off; the warning simply starts from zero */ }
}

function storeSaveState() {
  try {
    localStorage.setItem(UNSAVED_KEY, String(unsavedImports));
    if (savedAt) localStorage.setItem(SAVED_AT_KEY, savedAt);
  } catch (e) { /* storage off */ }
}

function markUnsaved() { unsavedImports++; storeSaveState(); renderSaveState(); }

function markSaved() {
  unsavedImports = 0;
  savedAt = new Date().toISOString();
  storeSaveState();
  renderSaveState();
}

function renderSaveState() {
  renderUnsavedPill();

  var host = $("savestate");
  if (!host) return;

  if (!archive.records.length) { host.textContent = ""; host.className = "savestate"; return; }

  if (unsavedImports > 0) {
    host.className = "savestate warn";
    host.innerHTML = "<b>" + unsavedImports + "</b> import"
      + (unsavedImports === 1 ? " is" : "s are") + " not in any file yet"
      + (savedAt ? " — last download " + savedAt.slice(0, 10) : "")
      + ". Download the archive to keep " + (unsavedImports === 1 ? "it" : "them") + ".";
    return;
  }

  host.className = "savestate";
  host.textContent = savedAt
    ? "Downloaded " + savedAt.slice(0, 10) + " — the file is up to date."
    : "Never downloaded from this browser. Nothing here survives clearing site data.";
}

/*
 * The same fact as `savestate`, in the one place that is always on screen.
 *
 * Hidden at zero rather than shown as "0": a badge that is always there is a
 * badge nobody reads, and the sentence in the drop zone already covers the
 * settled case.
 */
function renderUnsavedPill() {
  var pill = $("unsaved");
  if (!pill) return;
  pill.hidden = unsavedImports === 0;
  pill.textContent = String(unsavedImports);
}

/* ------------------------------------------------------------------ *
 * Where you are                                                       *
 * ------------------------------------------------------------------ *
 *
 * The bar says which section you can jump to; this says which one you are in.
 * An observer rather than a scroll handler, so it costs nothing while you read
 * and nothing has to be recomputed on every frame.
 *
 * `rootMargin` pulls the sensing line down to just under the bar, so a section
 * counts as current when its heading reaches the bar rather than when its
 * bottom edge leaves the viewport.
 */
function watchSections() {
  if (typeof IntersectionObserver !== "function") return;

  var links = {};
  var anchors = document.querySelectorAll(".topbar__links a");
  for (var i = 0; i < anchors.length; i++) {
    links[anchors[i].getAttribute("href").slice(1)] = anchors[i];
  }

  var sections = document.querySelectorAll("section[id]");
  var seen = {};

  function paint() {
    var current = "";
    for (var i = 0; i < sections.length; i++) {
      if (seen[sections[i].id]) { current = sections[i].id; break; }
    }
    for (var id in links) {
      if (Object.prototype.hasOwnProperty.call(links, id)) {
        links[id].classList.toggle("is-current", id === current);
      }
    }
  }

  var observer = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      seen[entries[i].target.id] = entries[i].isIntersecting;
    }
    paint();
  }, { rootMargin: "-4rem 0px -70% 0px" });

  for (var j = 0; j < sections.length; j++) observer.observe(sections[j]);
}

/* ------------------------------------------------------------------ *
 * Undo                                                                *
 * ------------------------------------------------------------------ *
 *
 * One step, held in memory only. Folding is a merge, so a wrong file cannot be
 * subtracted back out afterwards — the records it added and the ones it
 * updated are indistinguishable from the rest by then. Keeping the whole
 * archive from just before is the only honest way to take it back.
 */

var undoState = null;

function snapshot() {
  try { undoState = JSON.stringify(archive); } catch (e) { undoState = null; }
  refreshUndo();
}

function refreshUndo() {
  var b = $("undo");
  if (b) b.hidden = !undoState;
}

function undoImport() {
  if (!undoState) return;
  archive = JSON.parse(undoState);
  undoState = null;
  cacheSave(archive);
  if (unsavedImports > 0) { unsavedImports--; storeSaveState(); }
  note("last import undone — back to " + archive.records.length + " records");
  render();
}

/* ------------------------------------------------------------------ *
 * Importing                                                           *
 * ------------------------------------------------------------------ */

function importText(text, name) {
  var reading = readFile(text);
  if (reading.error) {
    note(name + ": " + reading.error, true);
    return;
  }

  snapshot();

  /* One of our own exports: a reading per source, folded one at a time so the
     ordinary merge does the work. `writtenOn` comes from the file rather than
     from today, or restoring an old backup would claim every day since as
     covered. */
  if (reading.archive) {
    var total = { added: 0, updated: 0, days: 0 };
    for (var i = 0; i < reading.readings.length; i++) {
      var one = reading.readings[i];
      var r = fold(archive, one, name, reading.writtenOn);
      total.added += r.added; total.updated += r.updated; total.days += r.days;
    }
    var ok = cacheSave(archive);
    note(name + " → archive (" + reading.readings.length + " sources): "
      + total.added + " new, " + total.updated + " updated, "
      + total.days + " new days" + (ok ? "" : " (cache full — keep the archive file)"));
    markUnsaved();
    render();
    return;
  }

  var out = fold(archive, reading, name);
  var saved = cacheSave(archive);
  note(name + " → " + reading.source + ": "
    + out.added + " new, " + out.updated + " updated, " + out.days + " new days"
    + (saved ? "" : " (cache full — keep the archive file)"));
  markUnsaved();
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

  /* Sources that keep everything under a single localStorage key. The first two
     export nothing at all, so this button is the only route they have that does
     not involve reading the browser's own files off disk. Synth does have its
     own export and does not need this — it is here because it costs one line
     and a trainer whose whole record sits in localStorage is exactly the case
     this archive exists for. */
  try {
    var singles = [
      { key: "mp_prog", label: "cct" },
      { key: "attentional_shield_v2", label: "ewmt" },
      { key: "synth5_en", label: "synth" },
    ];
    for (var s = 0; s < singles.length; s++) {
      var val = localStorage.getItem(singles[s].key);
      if (!val) continue;
      var wrap = {};
      wrap[singles[s].key] = val;
      importText(JSON.stringify(wrap), singles[s].label + " (this browser)");
      found++;
    }
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
  renderStreaks();
  renderHeatmap();
  renderSources();
  renderCharts();
  renderModes();
  renderOverlap();
  renderFilters();
  renderDays();
  renderSaveState();
  refreshUndo();
  $("save").disabled = archive.records.length === 0;
}

/* ------------------------------------------------------------------ *
 * The year                                                            *
 * ------------------------------------------------------------------ */

function renderStreaks() {
  var s = streaks(archive);
  var host = $("streaks");
  if (!archive.records.length) { host.innerHTML = ""; return; }

  host.innerHTML =
    "<span><b>" + s.current + "</b> day streak</span>"
    + "<span><b>" + s.longest + "</b> longest</span>"
    + (s.uncertain
        ? "<span class='dim'>" + s.uncertain + " unevidenced day(s) inside it</span>"
        : "");
}

/**
 * A square per day for the last year.
 *
 * Built as a grid of columns, one per week, so it reads the way every calendar
 * heatmap does. The title on each square carries the numbers, because a colour
 * can say "a lot" and never "forty-three minutes".
 */
function renderHeatmap() {
  var host = $("heatmap");
  if (!archive.records.length) { host.innerHTML = ""; return; }

  var cal = calendar(archive, null, 53);
  // Start the grid on a Monday so the rows are weekdays throughout.
  var lead = (new Date(cal[0].day + "T00:00:00Z").getUTCDay() + 6) % 7;

  var peak = 1;
  cal.forEach(function (d) { if (d.minutes > peak) peak = d.minutes; });

  var html = "";
  for (var i = 0; i < lead; i++) html += "<i class='cell pad'></i>";

  cal.forEach(function (d) {
    var level = d.state === "trained"
      ? 1 + Math.min(3, Math.floor(4 * d.minutes / peak))
      : 0;
    var parts = [];
    for (var src in d.bySource) if (d.bySource[src] >= 1) {
      parts.push(src + " " + fmt(d.bySource[src]) + "m");
    }
    html += "<i class='cell s-" + d.state + " L" + level + "' title='"
      + d.day + " — "
      + (d.state === "unknown" ? "no evidence either way"
         : parts.length ? parts.join(", ") : "rest day")
      + "'></i>";
  });

  host.innerHTML = html;
}

/* ------------------------------------------------------------------ *
 * Over time                                                           *
 * ------------------------------------------------------------------ */

/**
 * Minutes as bars and *difficulty* as the line, per source, drawn as inline SVG.
 *
 * Not accuracy. An adaptive trainer holds accuracy at a target and moves the
 * difficulty until it gets there, so an accuracy line is a picture of the
 * controller doing its job — flat whether you improved or not. `tools/chart.js`
 * has said so since it was written; the first version of this page drew the
 * other line anyway.
 *
 * No library, for the same reason the rest of this project has none: a chart
 * that needs a CDN is a chart that stops working the year the CDN moves, and
 * the archive is meant to still open in five years.
 */
function renderCharts() {
  var host = $("charts");
  var names = Object.keys(archive.minutes).sort();
  host.innerHTML = "";

  names.forEach(function (name) {
    var pts = series(archive, name).slice(-180);
    if (!pts.length) return;

    var W = 720, H = 120, pad = 4;

    /*
     * One line, one unit.
     *
     * This took whichever unit came last and scaled every day against one
     * range, which was harmless while a source reported the same quantity
     * forever. Syllogimous now reports its own difficulty level where it used
     * to report a premise count, so a window that straddles the change holds
     * days measured in both — and drawn this way that is a line climbing from
     * five to thirty and a caption naming one of the two scales.
     *
     * The window is drawn in the unit most of its days are in. Days in another
     * are counted and said, and the line breaks across them, for exactly the
     * reason it already breaks across a day nobody played: a segment drawn
     * through them would read as a trend, and it would be a trend between two
     * different quantities.
     */
    var counts = {};
    pts.forEach(function (p) {
      if (p.difficulty == null) return;
      counts[p.unit || ""] = (counts[p.unit || ""] || 0) + 1;
    });
    var unit = null, best = 0, otherDays = 0;
    Object.keys(counts).forEach(function (u) {
      if (counts[u] > best) { best = counts[u]; unit = u || null; }
    });
    Object.keys(counts).forEach(function (u) {
      if ((u || null) !== unit) otherDays += counts[u];
    });

    var inUnit = function (p) {
      return p.difficulty != null && (p.unit || null) === unit;
    };

    var peak = 1, dHi = null, dLo = null;
    pts.forEach(function (p) {
      if (p.minutes > peak) peak = p.minutes;
      if (!inUnit(p)) return;
      if (dHi === null || p.difficulty > dHi) dHi = p.difficulty;
      if (dLo === null || p.difficulty < dLo) dLo = p.difficulty;
    });
    var step = (W - pad * 2) / Math.max(1, pts.length);
    var range = (dHi != null && dHi > dLo) ? dHi - dLo : 1;

    var bars = "", line = "", open = false;
    pts.forEach(function (p, i) {
      var x = pad + i * step;
      var h = (H - pad * 2) * (p.minutes / peak);
      bars += "<rect x='" + fmt(x, 1) + "' y='" + fmt(H - pad - h, 1)
        + "' width='" + fmt(Math.max(1, step - 1), 1) + "' height='" + fmt(h, 1)
        + "'><title>" + p.day + " — " + fmt(p.minutes) + "m, " + p.n + " items"
        + (p.difficulty == null ? "" : ", " + fmt(p.difficulty, 1) + " " + (p.unit || "difficulty"))
        + (p.accuracy == null ? "" : ", " + fmt(100 * p.accuracy) + "% right")
        + "</title></rect>";

      /*
       * The line breaks where the day has no difficulty rather than jumping the
       * gap. A straight segment across a fortnight nobody played reads as a
       * trend through it, which is the one thing the picture must not say.
       */
      if (!inUnit(p)) { open = false; return; }
      var y = pad + (H - pad * 2) * (1 - (p.difficulty - dLo) / range);
      line += (open ? " L" : " M") + fmt(x + step / 2, 1) + " " + fmt(y, 1);
      open = true;
    });

    var div = document.createElement("div");
    div.className = "chart";
    div.innerHTML = "<h3>" + name + " <small class='dim'>"
      + pts.length + " days · bars are minutes, peak " + fmt(peak) + "m"
      + (dHi == null
          ? " · no difficulty recorded"
          : " · line is " + (unit || "difficulty") + ", "
            + fmt(dLo, 1) + "&ndash;" + fmt(dHi, 1)
            + (otherDays
                ? " · " + otherDays + " day" + (otherDays === 1 ? "" : "s")
                  + " measured differently, not drawn"
                : ""))
      + "</small></h3>"
      + "<svg viewBox='0 0 " + W + " " + H + "' preserveAspectRatio='none'>"
      + "<g class='bars'>" + bars + "</g>"
      + "<path class='acc' d='" + line + "'></path>"
      + "</svg>";
    host.appendChild(div);
  });
}

/** Volume and accuracy per mode, which is the one view the trainers cannot give. */
function renderModes() {
  var host = $("modes");
  var names = Object.keys(archive.minutes).sort();
  host.innerHTML = "";

  names.forEach(function (name) {
    var rows = byLabel(archive, name).slice(0, 12);
    if (!rows.length) return;

    var body = rows.map(function (r) {
      return "<tr><td>" + r.label + "</td><td>" + r.n + "</td><td>"
        + (r.accuracy == null ? "—" : fmt(100 * r.accuracy) + "%")
        + "</td><td>" + fmt(r.minutes) + "m</td></tr>";
    }).join("");

    var div = document.createElement("div");
    div.innerHTML = "<h3>" + name + "</h3><table>"
      + "<tr><th>label</th><th>items</th><th>right</th><th>time</th></tr>"
      + body + "</table>";
    host.appendChild(div);
  });
}

/* ------------------------------------------------------------------ *
 * Filtering, and taking the records elsewhere                         *
 * ------------------------------------------------------------------ */

var filterSource = "";
var filterFrom = "";
var filterTo = "";

/* How many days the table shows. 0 is all of them. */
var dayLimit = 60;

/* Filters are a view, not data — but retyping a date after every reload is
   the kind of small tax that stops you looking. */
var FILTER_KEY = "archive.filters.v1";

function loadFilters() {
  try {
    var f = JSON.parse(localStorage.getItem(FILTER_KEY) || "null") || {};
    filterSource = f.source || "";
    filterFrom = f.from || "";
    filterTo = f.to || "";
    dayLimit = f.limit == null ? 60 : f.limit;
  } catch (e) { /* storage off */ }
}

function storeFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      source: filterSource, from: filterFrom, to: filterTo, limit: dayLimit
    }));
  } catch (e) { /* storage off */ }
}

function renderFilters() {
  var sel = $("filterSource");
  if (!sel) return;
  var names = Object.keys(archive.minutes).sort();
  var want = filterSource;
  sel.innerHTML = "<option value=''>every source</option>"
    + names.map(function (n) {
        return "<option value='" + n + "'" + (n === want ? " selected" : "") + ">" + n + "</option>";
      }).join("");
}

function downloadCsv() {
  var rows = archive.records.filter(function (r) {
    return (!filterSource || r.source === filterSource)
      && (!filterFrom || r.day >= filterFrom)
      && (!filterTo || r.day <= filterTo);
  });
  var url = URL.createObjectURL(new Blob(
    [toCsv({ records: rows })], { type: "text/csv" }));
  var a = document.createElement("a");
  a.href = url;
  a.download = "training-records.csv";
  a.click();
  URL.revokeObjectURL(url);
  note(rows.length + " record(s) written to CSV.");
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
  var matching = days(archive).filter(function (d) {
    return (!filterFrom || d >= filterFrom) && (!filterTo || d <= filterTo);
  });
  var all = (dayLimit ? matching.slice(-dayLimit) : matching.slice()).reverse();
  var host = $("days");

  var more = $("more");
  if (more) {
    more.hidden = matching.length <= 60;
    more.textContent = dayLimit
      ? "Show all " + matching.length + " days"
      : "Show the last 60";
  }
  var names = Object.keys(archive.minutes).sort()
    .filter(function (n) { return !filterSource || n === filterSource; });

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
  markSaved();
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
  /* Restoring means the page was just handed a file that already holds all of
     this, so nothing is outstanding. */
  unsavedImports = 0;
  storeSaveState();
  note("archive restored — " + archive.records.length + " records");
  render();
  return true;
}

/* ------------------------------------------------------------------ *
 * Wiring                                                              *
 * ------------------------------------------------------------------ */

window.addEventListener("DOMContentLoaded", function () {
  watchSections();
  $("file").addEventListener("change", function (e) { takeFiles(e.target.files); e.target.value = ""; });
  $("save").addEventListener("click", saveArchive);
  $("neighbours").addEventListener("click", importNeighbours);
  $("csv").addEventListener("click", downloadCsv);
  $("undo").addEventListener("click", undoImport);
  $("filterSource").addEventListener("change", function (e) {
    filterSource = e.target.value; storeFilters(); render();
  });
  $("filterFrom").addEventListener("change", function (e) {
    filterFrom = e.target.value; storeFilters(); render();
  });
  $("filterTo").addEventListener("change", function (e) {
    filterTo = e.target.value; storeFilters(); render();
  });
  $("more").addEventListener("click", function () {
    dayLimit = dayLimit ? 0 : 60; storeFilters(); renderDays();
  });

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

  /*
   * Paste, for the common case of having the JSON on the clipboard rather than
   * on disk — copied out of a devtools console, or off another machine. An
   * archive restores; anything else folds in, exactly as a dropped file does.
   */
  document.addEventListener("paste", function (e) {
    if (!e.clipboardData) return;
    if (e.clipboardData.files && e.clipboardData.files.length) {
      e.preventDefault();
      takeFiles(e.clipboardData.files);
      return;
    }
    var text = (e.clipboardData.getData("text") || "").trim();
    if (text.charAt(0) !== "{" && text.charAt(0) !== "[") return;
    e.preventDefault();
    if (!loadArchive(text)) importText(text, "pasted text");
  });

  /* Ctrl+S means "save this" everywhere else; here the thing worth saving is
     the archive, not the page the browser would otherwise offer to write. */
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== "s" && e.key !== "S")) return;
    if (!archive.records.length) return;
    e.preventDefault();
    saveArchive();
  });

  /* The only warning this page can give before the tab that holds the only
     copy is closed. */
  window.addEventListener("beforeunload", function (e) {
    if (unsavedImports <= 0) return;
    e.preventDefault();
    e.returnValue = "";
  });

  loadSaveState();
  loadFilters();
  $("filterFrom").value = filterFrom;
  $("filterTo").value = filterTo;

  render();
});
