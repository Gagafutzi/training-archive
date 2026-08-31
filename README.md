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

## Using it

- **Drop any export** on the page. Sources are recognised by the *shape* of the
  file, not its name, because a third-party export always arrives called
  `export (3).json`.
- **Drop the archive itself** to restore it after a reset.
- **Read this browser** pulls straight from Syllogimous and RNB when the page is
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
