# Training archive

One record across every trainer, kept in a file.

## Why it is a file

Nothing a browser holds survives "clear site data" — not localStorage, not
IndexedDB, not a saved File System Access handle, since the handle lives in
IndexedDB and the permission goes with it. An archive kept in a browser is an
archive that disappears on the day you debug the app it belongs to, which is
exactly how two trainers came to have six days of history between them.

So the file is the archive and this page is the tool that maintains it. Drop
exports in, take the archive out, keep it somewhere that is not a browser.

## The loop

```
node tools/build.js                     # gather everything on this machine
```

then open `index.html` and drop `~/training-archive.json` on it.

It looks in Downloads, Dokumente, Documents, Schreibtisch and Desktop — an export
lands in the first and gets moved to one of the others precisely when it is being
kept on purpose, which is how this machine's oldest records sat four months out of
reach of a scan that only knew about Downloads. The page caches
what it reads, so it is there next time without dropping it again — until you
clear site data, which is the day the file earns its keep.

Run the build after a training session, or before a reset, or on a schedule. It
is idempotent: running it twice costs nothing and changes nothing.

## Using it

- **Drop any export** on the page. Sources are recognised by the *shape* of the
  file, not its name, because a third-party export always arrives called
  `export (3).json`.
- **Drop the archive itself** to restore it after a reset.
- **Read this browser** pulls straight from Syllogimous, RNB, CCT, eWMT and Synth when the page is
  served from the same origin they are — on GitHub Pages every repo of one
  account shares an origin, so on the deployed site no export is needed. Locally
  they are separate origins and it finds nothing.
- **Download archive** writes the file. Do this whenever you have imported
  something.

Keep the original exports too. The adapters will be wrong sometimes and a site
will change its format without telling anybody; the file you kept is what lets a
fixed adapter re-read it. Nothing here is ever the only copy of anything.

## The rules it is built on

**Merging is a union, never an addition.** Records key on `source + id`;
importing the same file twice changes nothing, and two overlapping exports come
to their union rather than their sum. Minutes take the larger of two readings for
a day, since minutes accumulate through a day and adding them would double it.
This is the whole promise of the project and it is what `test/run.js` mostly
tests.

**Difficulty never leaves its own units.** Every record carries a `unit` —
`rnb-load`, `syllogimous-premises` — and nothing compares two records whose units
differ. There is no axis on which an n-back load of 41 and a premise count of 6
can be placed together, and a schema that implied one would manufacture findings.

**The overlap counter comes before any comparison.** Two trainers with 35 modes
on one side and half a dozen measures on the other make about 200 candidate
pairs. Simulated, the *strongest* correlation among 200 pairs of pure noise runs
at about 0.96 on six paired points, 0.78 on twelve, 0.56 on twenty-six. So a
cross-app number computed today would be at its most convincing when it had least
reason to be. The page counts the weeks and refuses until there are enough.

When there are, the comparison still has to be built carefully: on week-to-week
*changes* rather than levels, since both series trend upward with practice and
two rising lines correlate near 1 whatever they measure; with a lead-lag
asymmetry, since transfer has a direction and a plain correlation cannot come out
against the hypothesis; against control modes, since a lift that appears
everywhere equally is practice; and with a permutation null shown beside the
number, along with how many pairs were tested.

## Building it from this machine

```
node tools/build.js
```

Finds the Anki collections, every trainer export in `~/Downloads`, and the
archive you already have, and folds the lot into `~/training-archive.json`.

The archive is written **outside the repository** and `.gitignore` covers the
filenames besides: this repo can be pushed to GitHub and your training record
should not be.

It uses the page's own merge rather than repeating it. A second implementation
would be a second source of truth about what "already imported" means, and the
two would drift in the direction nobody notices — quietly counting something
twice.

Exports are folded oldest first, so where two disagree about one record the newer
reading is the one left standing.

## Charts

```
node tools/chart.js --source all --out all.svg              # every source, one axis
node tools/chart.js --source syllogimous --out syl.svg      # one source, in detail
node tools/chart.js --source syllogimous --origin 4skinskywalker --out v4.svg
```

`--source all` is the one the archive exists to draw: a row per source on a
shared time axis, with the days carrying two or more marked underneath. That
strip is what every cross-app question is gated on, and where the columns line up
is much easier to see than to read off a table.

Note that `--origin` only matches records that *have* an origin, which means the
ones read out of browser storage. A record that came from an export file carries
none, so filtering by origin quietly excludes it — on this machine that was 1639
of 2753 Syllogimous items.

A standalone SVG per source: items per day above, accuracy and mean difficulty
below. No chart library — the whole of what it draws is rectangles and lines, and
a dependency is a thing that stops working while you are not looking.

Two of its choices are about honesty rather than looks:

**A real time axis.** Days sit where their dates are, not side by side. Training
happens in bursts with weeks of nothing between them, and evenly spacing the days
you trained turns a three-month record into a smooth run and makes an
interruption invisible.

**Accuracy carries its sample size.** A day with one item answered wrongly is 0%,
and plotted like any other point it reads as a collapse — where what happened is
that somebody opened the page, got one question wrong and closed it. Dots are
sized by the day's item count and the line only joins days above `--min-items`.

## Reading the browser directly

The page's own "Read this browser" button can only see the origin it is *served
from*. Opened as a `file://` page it has its own isolated storage and finds
nothing — that is not a permission problem and granting something cannot fix it.

`tools/firefox-storage.py` goes around it by reading Firefox's own storage off
disk. Every origin's localStorage is a SQLite database under
`storage/default/<origin>/ls/data.sqlite`, so the trainers' *live* records can be
snapshotted with no export at all, and no browser running. `tools/build.js` calls
it for you.

That is the part that makes a reset survivable without anybody remembering
anything: an export only exists if it was made, and the moment nobody makes one
is the moment they are about to clear site data to fix a bug.

Firefox stores larger values Snappy-compressed. Python has no Snappy in its
standard library, so the raw format is implemented in that file — small, and a
better trade than a dependency in a project whose one promise is that it still
runs in five years. Chromium keeps its localStorage in LevelDB instead, which is
not implemented.

Syllogimous **v3** is read too, from `sllgms-v3-app-state`. It is kept as its own
source rather than folded in with v4, for the reason units are kept apart
everywhere: its modes are its own — `space-time`, `anchor-space`,
`Analogy: Vertical` — and its premise counts sit on their own scale.

Its item durations are **derived, not recorded**: v3 stores when a question
started and nothing about when it ended, so an item's length is the gap to the
next question, clamped at five minutes. That is a real measure of time on task,
and honestly a better one than a self-reported duration — right up until somebody
walks away mid-session, which is what the clamp is for.

**Syllogimous keeps everything.** `raw.item` is the stored question untouched —
all 36 fields — and `archive.state` keeps every non-history key each export
carried, snapshotted by the day it was taken: the ability estimates, the trial
log, the Customise overrides, the progression config.

That was a curated handful of fields to begin with, on the argument that a
stored question is mostly rendered HTML. The argument is right about size and
wrong about archives: what you cannot do later is recover a field you decided not
to keep, and every analysis here has wanted something nobody thought to save. The
trial log is the sharpest case — it holds the ability estimate at the moment each
item was chosen, the only place that number is ever written down, and being
per-export rather than per-item it could never have been a record.

**RNB and Anki keep everything too.** `raw.block` is the whole block including
its keypress log — which matters because RNB *sheds* `presses` from older blocks
the moment its own storage runs short, so the archive is the only place that
survives. `archive.state` holds each export's ladder, staircase posterior,
per-tier tunables and free-play config.

Anki keeps the whole revlog row, `cid` included. That one is the difference
between knowing how a day went and being able to follow a single card: nothing
else says two reviews were of the same card, and no aggregate reconstructs it.

Records carry the **origin** they came from in `raw.origin`. The original v4, a
fork, a dev server and your deployed copy all write the same keys and are not the
same app; they stay one source so the day counting is not fragmented, and the
tag is there for any analysis that needs them apart.

## Anki

Anki keeps its reviews in a SQLite database, so the reading happens outside the
browser:

```
python3 tools/anki-export.py            # finds your collection
```

It writes `anki-source.json`; drop that on the page. Python's standard library
has `sqlite3`, so there is nothing to install.

**It reads every collection it can find, not the likeliest one.** The packaged
Linux builds are why that matters: Snap and Flatpak each confine Anki to their
own home, so a collection lives nowhere near `~/.local/share/Anki2` — while that
classic directory is often still sitting there from an older install, holding a
stale profile that looks perfectly plausible. Reading the wrong one is not a
failure you notice; it reports a real collection with real reviews, just not
yours. It also reads every *profile*, since a profile per subject is a normal way
to use Anki and your studying is the sum of them.

Reviews are deduplicated on their own ids across every collection read, and the
daily minutes are **derived from the deduplicated reviews** rather than summed
per collection. Those look equivalent and are not: a profile migration, a
restored backup or a move between Anki packagings puts the same reviews in two
collections, and summing per collection would have counted those days twice
while the review count stayed right.

It reads **only the review log** — when each review happened, how long it took,
and whether the card came back — plus deck names. It never opens `notes`, so no
card content, question, answer or media reaches the archive. That matters because
an archive is a file you might hand to someone, and because none of it would tell
you anything about your training anyway. The collection is copied before it is
opened, since Anki holds a lock on the live file.

**No difficulty is recorded for a review, deliberately.** An interval is a
schedule, not a measure of how hard the review was, and the archive's rule is
that a difficulty has to mean something in its own units. Inventing one here
would be the first step towards comparing it with another app's.

One caveat the script prints for itself: if your studying happens on a phone or
through AnkiWeb, the desktop profile is not where it lands, and the collection it
finds may be months stale.

## Synth

The grapheme-colour synesthesia trainer. Read from its own export (Tools → Data →
Export) or straight from `synth5_en` in localStorage; both carry the same object.

Its difficulty is **symbols per minute**, and the inversion is the point. Synth
runs a weighted staircase that pins accuracy at a target — 85% by default — and
moves the time window until it gets there. Accuracy is therefore flat by
construction and carries no signal about improvement; what improves is how fast
the window can get while accuracy stays pinned. The app stores that window as
milliseconds per *distinct* symbol, which falls as you improve, so the adapter
inverts it to a rate that rises. Its modes stay under one source and are told
apart by the label, as the rotation trainer's are.

It also takes two automaticity measures on itself, and both are withheld until
they have the trials to mean anything:

- `stroopInterferenceMs` — median incongruent minus median congruent reaction
  time, held back below 30 trials.
- `searchSlopeMsPerItem` — least-squares slope of reaction time against set size
  in the pop-out search. Near zero means the target is found in parallel rather
  than scanned for. Needs two set sizes and 30 trials.

Sessions written before the app recorded a clock have only a day; those land at
noon UTC with `raw.inferredTime` set, and a duration derived from mean response
time is flagged `raw.inferredSeconds` so nothing later reads it as measured.

## Adding a source

Two ways, and the second is usually the right one.

**A JSON export you can read in the browser**: one function in `js/adapters.js`
that takes the parsed file and returns `{ source, records, minutes }`, or `null`
if the file is not its own. Add it to `ADAPTERS`. Records come from `makeRecord`,
and a source with no ids of its own gets `hashRow` over the row's text so the same
row is the same record in every export it appears in.

**Anything else** — a database, a zip, a CSV, a page that has to be scraped —
gets a script that emits

```json
{ "schema": "training-archive-source/1", "source": "…", "records": [...], "minutes": {...} }
```

which the page takes as it stands. `tools/anki-export.py` is the worked example.
This is the path for the sites you did not write: it keeps their formats out of a
page whose one structural promise is that it still runs without a toolchain, and
it means a new source never requires the page to change at all. Prepared files
are validated rather than trusted — a row with no id or no timestamp is dropped
and the rest of the file still lands.

## Tests

```
node test/run.js
```

No framework and no build. The modules end with a `module.exports` guard so the
same files serve as `<script>` tags and as requires — a suite run against a
transpiled copy is a suite about the copy. The adapter cases run against real
exports in `~/Downloads` when there are any, and skip when there are not.
