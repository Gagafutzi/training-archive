#!/usr/bin/env node
"use strict";

/*
 * Build the archive from everything on this machine.
 *
 *     node tools/build.js
 *
 * Finds the Anki collections, the trainer exports in ~/Downloads and any archive
 * you already have, folds the lot together and writes one file.
 *
 * WHY THIS USES THE PAGE'S OWN MODULES
 * ------------------------------------
 * The merge is the whole promise of the project, and it is tested. A second
 * implementation of it here — in Python, or hand-rolled — would be a second
 * source of truth about what "already imported" means, and the two would drift
 * in the direction nobody notices: quietly counting something twice. So this
 * requires `js/record.js` and `js/archive.js` and does no merging of its own.
 *
 * WHERE THE ARCHIVE GOES
 * ----------------------
 * **Outside the repository**, in your home directory. This repo can be pushed to
 * GitHub; your training record should not be. `.gitignore` covers the filenames
 * too, in case one is ever written here by hand.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { readFile } = require("../js/adapters.js");
const A = require("../js/archive.js");

const HOME = os.homedir();

/* Where things live on this machine. Automated deliberately: the archive never
   leaves this computer, so there is nothing to be gained by making a person
   type the same four paths every week. */
const SOURCES = {
  archive: path.join(HOME, "training-archive.json"),
  /* Downloads is where an export lands, and the folders where one gets moved
     when it is being kept on purpose. The oldest records on this machine were
     in Dokumente, four months out of reach of a scan that only looked in
     Downloads — which is the ordinary fate of a file somebody filed. */
  folders: [
    path.join(HOME, "Downloads"),
    path.join(HOME, "Dokumente"),
    path.join(HOME, "Documents"),
    path.join(HOME, "Schreibtisch"),
    path.join(HOME, "Desktop"),
  ],
  patterns: [
    /^syllogimous-export.*\.json$/,
    /^rnb-.*\.json$/,
  ],
  ankiScript: path.join(__dirname, "anki-export.py"),
  firefoxScript: path.join(__dirname, "firefox-storage.py"),
};

function say(line) { process.stdout.write(line + "\n"); }

/* ------------------------------------------------------------------ *
 * Gathering                                                           *
 * ------------------------------------------------------------------ */

function exportsOnDisk() {
  const found = [];

  for (const folder of SOURCES.folders) {
    let names;
    try { names = fs.readdirSync(folder); } catch (e) { continue; }
    for (const name of names) {
      if (SOURCES.patterns.some(p => p.test(name))) found.push(path.join(folder, name));
    }
  }

  /* Oldest first, so where two exports disagree about one record the newer
     reading is the one left standing — the merge replaces on a repeated id, and
     a later export saw the same event with more history behind it. */
  return found.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function ankiSource() {
  const out = path.join(os.tmpdir(), "training-archive-anki-source.json");
  try {
    const log = execFileSync("python3", [SOURCES.ankiScript, "--out", out],
      { encoding: "utf8" });
    log.trim().split("\n").forEach(l => say("   " + l));
    return out;
  } catch (e) {
    say("   (no anki collection read: " + String(e.message).split("\n")[0] + ")");
    return null;
  }
}

/**
 * The trainers' *live* storage, read off disk rather than exported.
 *
 * This is the part that makes a reset survivable without anybody remembering
 * anything. An export only exists if it was made, and the moment nobody makes
 * one is the moment they are about to clear site data to fix a bug.
 *
 * Returns a directory of files in each app's own export format, so the ordinary
 * adapters read them and nothing here knows where they came from.
 */
function liveStorage() {
  const out = path.join(os.tmpdir(), "training-archive-live");
  try {
    fs.rmSync(out, { recursive: true, force: true });
  } catch (e) { /* first run */ }

  try {
    const log = execFileSync("python3", [SOURCES.firefoxScript, "--outdir", out],
      { encoding: "utf8" });
    log.trim().split("\n").filter(Boolean).forEach(l => say("   " + l.trim()));
  } catch (e) {
    say("   (nothing read from the browser: " + String(e.message).split("\n")[0] + ")");
    return [];
  }

  try {
    return fs.readdirSync(out).map(n => path.join(out, n));
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Building                                                            *
 * ------------------------------------------------------------------ */

function load() {
  /* An archive that already exists is the starting point, not something to be
     overwritten: it may hold records from an export that has since been deleted
     from Downloads, which is the whole reason the file is the archive. */
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES.archive, "utf8"));
    if (parsed && parsed.schema === 1 && Array.isArray(parsed.records)) {
      say("Starting from " + SOURCES.archive + " (" + parsed.records.length + " records)");
      return parsed;
    }
  } catch (e) { /* no archive yet, which is the ordinary first run */ }
  return A.emptyArchive();
}

function main() {
  const archive = load();
  const before = archive.records.length;

  say("\nAnki");
  const anki = ankiSource();

  say("\nLive browser storage");
  const live = liveStorage();

  say("\nExports on disk");
  const files = exportsOnDisk();
  if (!files.length) say("   (none found in " + SOURCES.folders.length + " folders)");

  /* Exports first, live storage last: where the two disagree about one record
     the live one is current, and the merge keeps whichever arrives later. */
  const all = files.concat(anki ? [anki] : []).concat(live);
  for (const file of all) {
    let reading;
    try {
      reading = readFile(fs.readFileSync(file, "utf8"));
    } catch (e) {
      say("   " + path.basename(file) + ": unreadable");
      continue;
    }
    if (reading.error) {
      say("   " + path.basename(file) + ": " + reading.error);
      continue;
    }

    const out = A.fold(archive, reading, path.basename(file));
    if (out.added || out.updated) {
      say("   " + path.basename(file).padEnd(40) + " " + reading.source.padEnd(12)
        + " +" + out.added + " new, " + out.updated + " updated");
    }
  }

  if (!archive.records.length) {
    say("\nNothing to write.");
    return;
  }

  fs.writeFileSync(SOURCES.archive, JSON.stringify(archive, null, 1));

  /* ---- what it now holds ---- */

  say("\nArchive: " + SOURCES.archive);
  say("   " + archive.records.length + " records ("
    + (archive.records.length - before) + " added this run)");

  const names = Object.keys(archive.minutes).sort();
  for (const name of names) {
    const s = A.sourceSummary(archive, name);
    if (!s) continue;
    say("   " + name.padEnd(13)
      + String(s.records).padStart(6) + " " + (s.kind + "s").padEnd(9)
      + String(s.days).padStart(4) + " days "
      + String(Math.round(s.minutes)).padStart(5) + " min   "
      + s.first + " to " + s.last);
  }

  say("");
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const pair = A.overlap(archive, names[i], names[j]);
      say("   " + (names[i] + " x " + names[j]).padEnd(32) + " "
        + String(pair.days.length).padStart(3) + " days, "
        + String(pair.weeks.length).padStart(2) + " week(s) trained in both");
    }
  }

  if (anki) { try { fs.unlinkSync(anki); } catch (e) { /* leave it */ } }
}

main();
