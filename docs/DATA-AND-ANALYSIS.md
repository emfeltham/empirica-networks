# Data and analysis — what a run produces

Starts where a study ends: **you have a finished run, what do you have?** Written against the
post-M6 surface, where the run log is part of the package rather than something each example
built for itself.

One thing to decide *before* the run rather than after, so it is first:

> **Turn on view capture if `project()` does anything beyond passing values through.** Views are
> published `ephemeral` — nothing durable holds them. An edge log plus an attribute export tells
> you what a participant **could have known**; only view capture tells you what they were
> **told**. If your projection buckets, adds noise, or keys off `stateOf()`, those are not the
> same table, and the second one cannot be reconstructed afterwards.
>
> ```js
> withNetwork(Empirica, { …, views: { file: "data/views.ndjson" } });
> ```

---

## 1. The inventory

| What | Where it comes from | Durable? | Contains |
|---|---|---|---|
| **The Tajriba store** | `.empirica/local/tajriba.json`, always | Yes | Every scope and attribute, with change timestamps. Includes each participant's private state |
| **The realised network** | batch scope, always | Yes | `network:<gameID>` — the edge list as it now stands |
| **The seed** | batch scope, always | Yes | `networkSeed:<gameID>` — enough to re-derive the topology |
| **The edge history** | batch scope, always | Yes | `networkHistory:<gameID>` — every tie change, including the initial graph as a `start` event |
| **The run log** | `log: { file }`, opt-in | Yes | Whatever your listeners wrote, as the study happened |
| **Captured views** | `views: { file }`, opt-in | Yes | Exactly what each participant was delivered, per delivery |
| **The views themselves** | — | **No** | Published `ephemeral`. Gone unless captured |

Two of these need saying plainly.

**The store holds private state.** Everything a participant wrote to their own channel is in
`tajriba.json`, prefixed `state:`. It was neighbour-limited *in transit*; it is not anonymised at
rest. Treat the store as identifiable data.

**`onGameEnded` is not a reliable place to write files.** It fires only when a game ends
*naturally*. A study that is killed, crashes, or is stopped mid-session never reaches it — and
after `ISSUES.md` U2 a crash mid-study is the normal shape of "something went wrong", since a
restarted server cannot put participants back in their game anyway. That is what the run log is
for: unbuffered by default, so a hard kill loses nothing.

Measured, not imagined: a green run of `test/e2e/rand2011.test.ts` left `views.ndjson` and not one
CSV.

## 2. Getting the rows out

Two import paths, and picking the wrong one is the most common first stumble.

```js
// Inside your callbacks, server-side, running under the Empirica CLI:
import { network } from "empirica-networks/admin";

// In an analysis script you run yourself with plain `node`:
import { edgeRows, snapshotRows, viewRows, parseNdjson, toCSV } from "empirica-networks/export";
```

`empirica-networks/export` exists because `@empirica/core` **cannot be loaded from raw Node in
either module system** (`docs/PLATFORM-NOTES.md` §3a), and anything reaching through `/admin`
pulls it in. The export subpath has no `@empirica/core` anywhere in its graph, and
`test/unit/export_isolation.test.ts` enforces that by refusing the module any runtime import at
all — including `node:fs`. That is why `parseNdjson` takes the file's *text*, not its path: your
`fs.readFileSync(path, "utf8")` is the line you already had.

The row builders are **pure**: they take a game id and an event log, not Empirica objects. So the
same functions run offline over data collected months ago, and unit test in milliseconds with no
server.

```js
// server-side, in a listener
const history = network(game).history();
writeFileSync("data/edges.csv", toCSV(edgeRows(game.id, history)));
writeFileSync("data/snapshots.csv", toCSV(snapshotRows(game.id, history)));

// offline
const { records, dropped } = parseNdjson(readFileSync("data/views.ndjson", "utf8"));
writeFileSync("data/views.csv", toCSV(viewRows(records)));
```

## 3. Schemas

### `edgeRows()` → one row per tie change

| Column | Type | Notes |
|---|---|---|
| `game_id` | string | |
| `t` | number | Wall clock, **milliseconds**, from the event that caused the change |
| `event` | `connected` \| `disconnected` | |
| `player_a`, `player_b` | string | Player ids, in the order the event recorded them |

The initial graph appears as `connected` rows at game start, because `withNetwork` records it as
a `start` event — so **a study that never rewires still exports its network here** rather than an
empty file.

Removals come before additions within one event: a rewire that drops (a,b) and adds (a,c) reads
as a departure then an arrival, and someone scanning for "when did a lose b" should not have to
look past an add. No attempt is made to canonicalise a/b — for a directed reading of who
connected to whom, the caller may care.

### `snapshotRows()` → the full edge list after each event

| Column | Type | Notes |
|---|---|---|
| `game_id` | string | |
| `t` | number | ms |
| `size` | number | Edge count at this point |
| `edges` | string | The whole edge list: `a\|b` pairs, space separated, sorted |

Derived by replaying the log rather than stored, so it cannot drift from the events it came from.
`historyIsConsistent(history)` checks the log's own `size` against a replay — worth running once
during analysis, because the log is written by a live server across a run that may include a
restart.

### `viewRows()` → one row per viewer per neighbour per delivery

| Column | Type | Notes |
|---|---|---|
| `game_id` | string | |
| `viewer` | string | Player id of the participant this was delivered **to** |
| `seq` | number | Publish counter for the game — the same value the client saw as `_seq` |
| `t` | number | ms |
| `neighbour_index` | number | Position within the view. Stable, and defined even for a projection with no `id` |
| `neighbour_id` | string | The projected `id` when there is one, empty otherwise |
| *…your fields* | string \| number | One column per field `project()` returned |

**Long, not wide** — one row per neighbour rather than one row per view with the neighbours packed
into a cell — so the table joins directly against `edges.csv` on `(viewer, neighbour_id, t)`.

A record is written per **delivery**, not per tick: views are republished only when they change
(the byte-identical check in `publish`), so the log says what arrived and when, rather than
resampling a value nobody was re-sent. Participants skipped by that check correctly produce no
row — they were not sent anything.

Nested values are JSON-encoded into their cell rather than flattened into `a.b.c` columns, which
would guess at a schema you did not declare. A projection returning a bare value
(`project: (n) => n.id`) gets a `value` column.

### The run log → one NDJSON line per `net.log()` call

```js
net.log(stage.currentGame, { type: "round", round: 3, rows });
```

`gameID` and `at` are stamped on; everything in your record is written beside them. **One file
for the whole study, not one per game** — every record carries its `gameID`, so a batch of
concurrent games interleaves safely and you group by game offline.

`net.log()` **throws** if no log is configured. A logging call that quietly went nowhere would be
indistinguishable from a study that recorded nothing, which is the failure the facility exists to
prevent. A failure to *write* (full disk, vanished directory) is reported and swallowed instead —
that happens mid-study, and the study matters more than its telemetry.

`parseNdjson` tolerates the half-written final line a hard kill leaves, and **reports** it:

```js
const { records, dropped } = parseNdjson(text);
if (dropped) console.warn(`${dropped} unparseable line(s)`);
```

`dropped` is reported rather than swallowed because a recovery that quietly dropped a round would
be indistinguishable from a session that ran one round fewer. Blank lines are skipped and not
counted — a log ending in a newline is a normal log.

### `toCSV()`

Quotes every field rather than guessing which need it, and takes headers from the **union** of
every row's keys in first-seen order, not from the first row's. Edge and snapshot rows are
uniform so it never mattered there — but view rows carry your columns, and an optional field
absent from record 1 would otherwise be dropped from the whole export without a word.

## 4. Reproducing a finished run

Everything needed is durable, and in two places:

```js
import { readNetwork, readSeed } from "empirica-networks/admin";   // server-side
const edges = readNetwork(game);   // batch: network:<gameID>
const seed  = readSeed(game);      // batch: networkSeed:<gameID>
```

Offline, the same two values are attributes on the batch scope in `tajriba.json`, keyed
`network:<gameID>` and `networkSeed:<gameID>`.

The realised edge list is recorded, not just the seed, so the graph a run actually used is read
back rather than re-derived and hoped to match. To re-derive anyway — to check, or to generate a
matched graph for a new condition — `makeRng(seed)` and the generator reproduce it exactly.
Pinned by `test/e2e/reproducibility.test.ts`.

**What the edge list does not tell you is who sat where.** It is index pairs. The seat mapping
lives on each channel as `topologyIndex`, which is what makes a restart non-destructive and what
`edgeRows()` has already resolved into player ids for you. If you are working from the raw
attribute rather than the export, you need the seats too.

## 5. Into an analysis environment

**JavaScript.** The graphology bridge:

```js
import { toGraphology } from "empirica-networks/topology/graphology";
import { UndirectedGraph } from "graphology";
const g = toGraphology(UndirectedGraph, n, edges, { order });
```

Pass `UndirectedGraph`, **not** `Graph`. graphology's default is a *mixed* graph, whose ratio
metrics count directed slots this module never fills, so density comes back wrong with nothing
erroring — [TOPOLOGIES.md](TOPOLOGIES.md#rendering-and-measuring-elsewhere) has the figures.

`GET /api/state` on a running monitor returns `{ snapshot, positions }` where `snapshot` is
`{ n, edges, order }`, which is exactly that signature. It is the shortest route into the
graphology ecosystem on a *live* study.

**R and Python.** Go through the CSVs. `edges.csv` is an edge list with timestamps, which
`igraph`, `networkx` and `tidygraph` all read directly; `snapshots.csv` gives you a sequence of
graphs for a dynamic network; `views.csv` joins to `edges.csv` on `(viewer, neighbour_id, t)`.

> **Not yet walked end to end.** No analysis of a real dataset has been done in either language
> from this package's output — the schemas above are read off the code, and the join keys are
> stated by design rather than exercised. Most network researchers analyse in R or Python, so
> this is the section most likely to be wrong in a way only doing it will reveal.

## 6. Recovery scripts

Both reconstructions ship a `recover.mjs` that rebuilds their CSVs from a run's NDJSON after the
fact — the thing you reach for when a session ended badly. They are worth reading as worked
examples of §2's offline path.

They are worth reading for one design decision in particular. `examples/shirado2017`'s network is
static and lives only on the batch scope, so a script left to reconstruct an edge list from a
snapshot recovers an **empty** `edges.csv` — or, at best, one whose timestamps it has invented.
Instead the example logs the package's own events verbatim —
`net.log(game, { type: "graph", …, events: network(game).history() })` — which is what makes
recovery *byte-identical*: `edgeRows` keys every row's `t` on the event's own `at`. Verified
against a real log, including a game torn down mid-run.

The generalisable rule: **log the events, not the state they add up to.** A snapshot can always be
replayed from events; events cannot be recovered from a snapshot.

## 7. What to keep

A minimum that makes a run re-analysable by someone else, in order:

1. `tajriba.json` — the store. Everything else can be re-derived from it; nothing can be
   re-derived without it.
2. `views.ndjson`, if capture was on. **Irreplaceable** — this is the only copy.
3. The run log, if used. Also irreplaceable for anything your listeners computed and did not
   store.
4. The derived CSVs. Convenience: regenerable from 1–3.
5. The package version and the `@empirica/core` version. The row builders are pure and stable,
   but the study's behaviour is not a property of the CSVs.

And treat 1–3 as identifiable participant data, because they are.
