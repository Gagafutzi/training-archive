#!/usr/bin/env node
"use strict";

/*
 * One source's history, drawn.
 *
 *     node tools/chart.js --source syllogimous --origin 4skinskywalker --out v4.svg
 *     node tools/chart.js --source anki --out anki.svg
 *
 * Writes a standalone SVG. No dependencies, for the same reason as everything
 * else here: a chart library is a thing that stops working while you are not
 * looking, and the whole of what this draws is rectangles and lines.
 *
 * TWO DECISIONS THAT ARE ABOUT HONESTY RATHER THAN LOOKS
 * -----------------------------------------------------
 * **A real time axis.** Days are placed by date, not side by side. Training
 * happens in bursts with weeks of nothing between them, and evenly spacing the
 * days you trained turns a three-month record with two gaps into a smooth run
 * and makes an interruption invisible.
 *
 * **Accuracy is drawn with its sample size.** A day with one item answered
 * wrongly is 0%, and plotted as a point like any other it reads as a collapse.
 * The dots are sized by the number of items behind them and the line is drawn
 * only through days that carry enough to mean something, so a single bad answer
 * looks like what it is.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/* ---------------------------------------------------------------- options */

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ARCHIVE = opt("archive", path.join(os.homedir(), "training-archive.json"));
const SOURCE = opt("source", "syllogimous");
const ORIGIN = opt("origin", null);          // substring match on raw.origin
const OUT = opt("out", "chart.svg");
/** Days below this many items get a dot but no line: too few to read. */
const MIN_ITEMS_FOR_LINE = Number(opt("min-items", 10));

/* ---------------------------------------------------------------- data */

const archive = JSON.parse(fs.readFileSync(ARCHIVE, "utf8"));

const records = archive.records.filter(r => {
  if (r.source !== SOURCE) return false;
  if (!ORIGIN) return true;
  return r.raw && typeof r.raw.origin === "string" && r.raw.origin.includes(ORIGIN);
});

if (!records.length) {
  console.error("No records for source=" + SOURCE + (ORIGIN ? " origin~" + ORIGIN : ""));
  process.exit(1);
}

const byDay = new Map();
for (const r of records) {
  const d = byDay.get(r.day) || { day: r.day, n: 0, correct: 0, difficulty: 0, seconds: 0, graded: 0 };
  d.n++;
  d.seconds += r.seconds;
  if (r.correct != null) { d.correct += r.correct; d.graded++; }
  if (r.difficulty != null) d.difficulty += r.difficulty;
  byDay.set(r.day, d);
}

const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
for (const d of days) {
  d.accuracy = d.graded ? d.correct / d.graded : null;
  d.meanDifficulty = d.n ? d.difficulty / d.n : 0;
  d.minutes = d.seconds / 60;
  d.at = Date.parse(d.day + "T00:00:00Z");
}

/* ---------------------------------------------------------------- layout */

const W = 940, H = 560;
const M = { top: 46, right: 62, bottom: 46, left: 56 };
const PANEL_GAP = 46;
const panelH = (H - M.top - M.bottom - PANEL_GAP) / 2;

const t0 = days[0].at, t1 = days[days.length - 1].at;
const span = Math.max(1, t1 - t0);
const x = (at) => M.left + ((at - t0) / span) * (W - M.left - M.right);

const topY0 = M.top, topY1 = M.top + panelH;
const botY0 = topY1 + PANEL_GAP, botY1 = botY0 + panelH;

const maxItems = Math.max(...days.map(d => d.n));
const yItems = (n) => topY1 - (n / maxItems) * panelH;

const yAcc = (a) => botY1 - a * panelH;
const maxDiff = Math.max(1, ...days.map(d => d.meanDifficulty));
const yDiff = (v) => botY1 - (v / maxDiff) * panelH;

/* Bars: one day wide at most, and never thinner than a hairline — a
   three-month span with 24 days in it would otherwise draw slivers. */
const dayWidth = Math.max(3, Math.min(14, (W - M.left - M.right) / (span / 86400000) - 1));

/* ---------------------------------------------------------------- drawing */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmtDay = (day) => {
  const d = new Date(day + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

const parts = [];
const push = (s) => parts.push(s);

push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, system-ui, sans-serif">`);
push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`);

const title = SOURCE + (ORIGIN ? " · " + ORIGIN : "");
push(`<text x="${M.left}" y="26" fill="#d7dee8" font-size="15" font-weight="600">${esc(title)}</text>`);
push(`<text x="${W - M.right}" y="26" fill="#7d8ca6" font-size="12" text-anchor="end">`
  + `${records.length} items · ${days.length} days · ${fmtDay(days[0].day)} to ${fmtDay(days[days.length - 1].day)}</text>`);

/* ---- month gridlines, so the gaps have something to be gaps against ---- */

const months = [];
for (let m = new Date(t0); m.getTime() <= t1; m.setUTCMonth(m.getUTCMonth() + 1)) {
  const first = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1);
  if (first >= t0 && first <= t1) months.push(first);
}
for (const at of months) {
  push(`<line x1="${x(at).toFixed(1)}" y1="${topY0}" x2="${x(at).toFixed(1)}" y2="${botY1}" stroke="#272e38" stroke-width="1"/>`);
  push(`<text x="${(x(at) + 4).toFixed(1)}" y="${botY1 + 16}" fill="#7d8ca6" font-size="11">`
    + new Date(at).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }) + `</text>`);
}

/* ---- panel one: how much ---- */

push(`<text x="${M.left}" y="${topY0 - 10}" fill="#7d8ca6" font-size="11" letter-spacing="0.06em">ITEMS PER DAY</text>`);
push(`<line x1="${M.left}" y1="${topY1}" x2="${W - M.right}" y2="${topY1}" stroke="#39424f"/>`);

for (const tick of [0, 0.5, 1]) {
  const v = Math.round(maxItems * tick);
  push(`<text x="${M.left - 8}" y="${(yItems(v) + 4).toFixed(1)}" fill="#7d8ca6" font-size="10" text-anchor="end">${v}</text>`);
}

for (const d of days) {
  const h = topY1 - yItems(d.n);
  push(`<rect x="${(x(d.at) - dayWidth / 2).toFixed(1)}" y="${yItems(d.n).toFixed(1)}"`
    + ` width="${dayWidth.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="#58a6ff" opacity="0.85"/>`);
}

/* ---- panel two: how it went ---- */

push(`<text x="${M.left}" y="${botY0 - 10}" fill="#7d8ca6" font-size="11" letter-spacing="0.06em">`
  + `ACCURACY <tspan fill="#3fb950">●</tspan>   AND MEAN PREMISES <tspan fill="#f0883e">●</tspan></text>`);
push(`<line x1="${M.left}" y1="${botY1}" x2="${W - M.right}" y2="${botY1}" stroke="#39424f"/>`);

for (const tick of [0, 0.5, 1]) {
  push(`<line x1="${M.left}" y1="${yAcc(tick).toFixed(1)}" x2="${W - M.right}" y2="${yAcc(tick).toFixed(1)}" stroke="#1c2330"/>`);
  push(`<text x="${M.left - 8}" y="${(yAcc(tick) + 4).toFixed(1)}" fill="#3fb950" font-size="10" text-anchor="end">${Math.round(tick * 100)}%</text>`);
}
for (const tick of [0, 0.5, 1]) {
  const v = maxDiff * tick;
  push(`<text x="${W - M.right + 8}" y="${(yDiff(v) + 4).toFixed(1)}" fill="#f0883e" font-size="10">${v.toFixed(1)}</text>`);
}

/* Mean difficulty first, so the accuracy dots sit over it. */
const solid = days.filter(d => d.n >= MIN_ITEMS_FOR_LINE);
if (solid.length > 1) {
  push(`<polyline fill="none" stroke="#f0883e" stroke-width="1.6" opacity="0.8" points="`
    + solid.map(d => `${x(d.at).toFixed(1)},${yDiff(d.meanDifficulty).toFixed(1)}`).join(" ") + `"/>`);
  push(`<polyline fill="none" stroke="#3fb950" stroke-width="1.6" points="`
    + solid.map(d => `${x(d.at).toFixed(1)},${yAcc(d.accuracy).toFixed(1)}`).join(" ") + `"/>`);
}

/*
 * Every day gets a dot, sized by how many items are behind it.
 *
 * This is the part that keeps the picture honest. One item answered wrongly is
 * a day at 0%, and drawn like any other point it reads as a collapse — where
 * what happened was that somebody opened the page, got one question wrong and
 * closed it again.
 */
for (const d of days) {
  if (d.accuracy == null) continue;
  const r = Math.max(2, Math.min(9, Math.sqrt(d.n) * 0.75));
  const faint = d.n < MIN_ITEMS_FOR_LINE;
  push(`<circle cx="${x(d.at).toFixed(1)}" cy="${yAcc(d.accuracy).toFixed(1)}" r="${r.toFixed(1)}"`
    + ` fill="#3fb950" opacity="${faint ? 0.35 : 0.95}"/>`);
}

push(`<text x="${M.left}" y="${H - 12}" fill="#586074" font-size="10">`
  + `dot size is the day's item count — a faint dot is fewer than ${MIN_ITEMS_FOR_LINE} items and carries no line</text>`);

push(`</svg>`);

fs.writeFileSync(OUT, parts.join("\n"));

const graded = records.filter(r => r.correct != null);
console.log(`${records.length} items over ${days.length} days`
  + `, ${(graded.reduce((a, r) => a + r.correct, 0) / graded.length * 100).toFixed(0)}% correct overall`);
console.log("Written to " + OUT);
