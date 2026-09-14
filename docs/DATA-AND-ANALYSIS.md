# Data and analysis — what a run produces

This document describes the data available after a study run. It reflects the post-M6 API, in
which the package provides a shared run log for all examples.

Decide whether to capture projected views before beginning data collection:

> Enable view capture when `project()` transforms values through operations such as grouping,
> adding noise, or consulting `stateOf()`. Empirica publishes views as `ephemeral`, meaning it
> delivers them without retaining a durable copy. An edge log and attribute export describe the
> information available to a participant, whereas captured views record the information actually
> delivered. The latter cannot be reconstructed retrospectively after a transformation.
>
> ```js
> withNetwork(Empirica, { …, views: { file: "data/views.ndjson" } });
> ```

---

## 1. The inventory

| What | Where it comes from | Durable? | Contains |
|---|---|---|---|
| The Tajriba store | `.empirica/local/tajriba.json`, always | Yes | Every scope and attribute, with change timestamps. Includes each participant's private state |
| The realized network | batch scope, always | Yes | `network:<gameID>`, the edge list as it now stands |
| The seed | batch scope, always | Yes | `networkSeed:<gameID>`, enough to re-derive the topology |
| The edge history | batch scope, always | Yes | `networkHistory:<gameID>`, every tie change, including the initial graph as a `start` event |
| The radius | batch scope, always | Yes | `networkRadius:<gameID>`, how much of the network participants were shown |
| The run log | `log: { file }`, opt-in | Yes | Whatever your listeners wrote, as the study happened |
| Captured views | `views: { file }`, opt-in | Yes | Exactly what each participant was delivered, per delivery — at radius 1.5 including the ties among their neighbors and where everything was drawn |
| The views themselves | — | No | Published `ephemeral`. Gone unless captured |

Two properties of these outputs deserve particular attention.

The store contains private state. Every value a participant writes to their channel appears in
`tajriba.json` with a `state:` prefix. Although delivery was limited to neighbors, the stored data
remain identifiable and should be handled accordingly.

`onGameEnded` runs only after a game ends normally, so it provides an incomplete basis for durable
file output. A killed, crashed, or manually stopped session bypasses the callback. Because the
upstream platform cannot resume such a session, use the run log for recovery. Its default
unbuffered writes preserve all records already emitted before a hard termination.

In a measured run of `test/e2e/rand2011.test.ts`, early termination preserved `views.ndjson` while
producing no CSV output.

## 2. Getting the rows out

Choose the import path according to the execution environment.

```js
// Inside your callbacks, server-side, running under the Empirica CLI:
import { network } from "empirica-networks/admin";

// In an analysis script you run yourself with plain `node`:
import { edgeRows, snapshotRows, viewRows, parseNdjson, toCSV } from "empirica-networks/export";
```

`empirica-networks/export` exists because `@empirica/core` cannot be loaded from raw Node in
either module system (`docs/PLATFORM-NOTES.md` §3a), and anything reaching through `/admin`
pulls it in. The export subpath has no `@empirica/core` anywhere in its graph, and
`test/unit/export_isolation.test.ts` enforces that by refusing the module any runtime import at
all, including `node:fs`. That is why `parseNdjson` takes the file's text, not its path: your
`fs.readFileSync(path, "utf8")` is the line you already had.

The row builders are pure functions that accept a game identifier and event log rather than
Empirica objects. The same functions can therefore analyze archived data offline and run in unit
tests without a server.

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
| `t` | number | Wall clock, milliseconds, from the event that caused the change |
| `event` | `connected` \| `disconnected` | |
| `player_a`, `player_b` | string | Player ids, in the order the event recorded them |

The initial graph appears as `connected` rows at game start, because `withNetwork` records it as
a `start` event, so a study that never rewires still exports its network here rather than an
empty file.

Removals come before additions within one event: a rewire that drops (a,b) and adds (a,c) reads
as a departure then an arrival, and someone scanning for "when did a lose b" should not have to
look past an add. No attempt is made to canonicalise a/b; for a directed reading of who
connected to whom, the caller may care.

### `snapshotRows()` → the full edge list after each event

| Column | Type | Notes |
|---|---|---|
| `game_id` | string | |
| `t` | number | ms |
| `size` | number | Edge count at this point |
| `edges` | string | The whole edge list: `a\|b` pairs, space separated, sorted |

Derived by replaying the log rather than stored, so it cannot drift from the events it came from.
`historyIsConsistent(history)` checks the log's own `size` against a replay; worth running once
during analysis, because the log is written by a live server across a run that may include a
restart.

### `viewRows()` → one row per viewer per neighbor per delivery

| Column | Type | Notes |
|---|---|---|
| `game_id` | string | |
| `viewer` | string | Player id of the participant this was delivered to |
| `seq` | number | Publish counter for the game, the same value the client saw as `_seq` |
| `t` | number | ms |
| `neighbor_index` | number | Position within the view. Stable, and defined even for a projection with no `id` |
| `neighbor_id` | string | The projected `id` when there is one, empty otherwise |
| …your fields | string \| number | One column per field `project()` returned |

### `structureRows()` → one row per tie one viewer was shown, per delivery

Empty unless the study ran at `graph: { radius: 1.5 }`.

| Column | Type | Notes |
|---|---|---|
| `game_id`, `viewer`, `seq`, `t` | | As above |
| `a_index`, `b_index` | number | Local index of each end: `0` is the viewer, `1..d` index into that delivery's view |
| `a_id`, `b_id` | string | The projected `id` of each end when there is one, empty otherwise |

### `positionRows()` → one row per node in one viewer's drawing, per delivery

| Column | Type | Notes |
|---|---|---|
| `game_id`, `viewer`, `seq`, `t` | | As above |
| `node_index` | number | `0` is the viewer; `1..d` index into that delivery's view |
| `node_id` | string | As `a_id` above |
| `x`, `y` | number | Integers in a 600×600 box |

Both carry the local indices as well as the resolved ids, which is what makes them join two ways:
on the ids to `edges.csv`, answering "was this tie real"; and on
`(viewer, seq, neighbor_index = a_index - 1)` to `views.csv`, which still works for a projection
that carries no `id` at all.

Two builders rather than one because a viewer with no ties still has a position — their own — and
denormalizing `x`/`y` onto edge rows would drop exactly the isolated participant, who in a
rewiring design is the one worth looking at.

Positions are captured rather than recomputed because they cannot be recomputed. They are
warm-started, so they follow the session's history rather than its final graph, and are not a
function of anything else stored. This is the same criterion that makes capture worth turning on
at all: the delivered view is not recoverable from the edge log afterwards.

The table is long, not wide (one row per neighbor rather than one row per view with the neighbors
packed into a cell), so the table joins directly against `edges.csv` on `(viewer, neighbor_id, t)`.

A record is written per delivery, not per tick: views are republished only when they change
(the byte-identical check in `publish`), so the log says what arrived and when, rather than
resampling a value nobody was re-sent. Participants skipped by that check correctly produce no
row: they were not sent anything.

Nested values are JSON-encoded into their cell rather than flattened into `a.b.c` columns, which
would guess at a schema you did not declare. A projection returning a bare value
(`project: (n) => n.id`) gets a `value` column.

### The run log → one newline-delimited JSON (NDJSON) record per `net.log()` call

```js
net.log(stage.currentGame, { type: "round", round: 3, rows });
```

`gameID` and `at` are stamped on; everything in your record is written beside them. One file
for the whole study, not one per game: every record carries its `gameID`, so a batch of
concurrent games interleaves safely and you group by game offline.

`net.log()` throws if no log is configured. A logging call that quietly went nowhere would be
indistinguishable from a study that recorded nothing, which is the failure the facility exists to
prevent. A failure to write (full disk, vanished directory) is reported and suppressed instead:
that happens mid-study, and the study matters more than its telemetry.

`parseNdjson` tolerates the half-written final line a hard kill leaves, and reports it:

```js
const { records, dropped } = parseNdjson(text);
if (dropped) console.warn(`${dropped} unparseable line(s)`);
```

`dropped` is reported rather than suppressed because a recovery that quietly dropped a round would
be indistinguishable from a session that ran one round fewer. Blank lines are skipped and not
counted: a log ending in a newline is a normal log.

### `toCSV()`

Quotes every field rather than guessing which need it, and takes headers from the union of
every row's keys in first-seen order, not from the first row's. Edge and snapshot rows are
uniform so it never mattered there, but view rows carry your columns, and an optional field
absent from record 1 would otherwise be dropped from the whole export without a word.

## 4. Reproducing a finished run

Everything needed is durable, and in one place:

```js
import { readNetwork, readRadius, readSeed } from "empirica-networks/admin";   // server-side
const edges  = readNetwork(game);   // batch: network:<gameID>
const seed   = readSeed(game);      // batch: networkSeed:<gameID>
const radius = readRadius(game);    // batch: networkRadius:<gameID>
```

Offline, the same three values are attributes on the batch scope in `tajriba.json`, keyed
`network:<gameID>`, `networkSeed:<gameID>` and `networkRadius:<gameID>`.

The realized edge list is recorded, not just the seed, so the graph a run actually used is read
back rather than re-derived and hoped to match. To re-derive anyway (to check, or to generate a
matched graph for a new condition), `makeRng(seed)` and the generator reproduce it exactly.
Pinned by `test/e2e/reproducibility.test.ts`.

The radius is recorded for a different reason: it is not a property of the graph at all, and
nothing else in the record implies it. Two studies on one topology, one at each radius, leave
identical edge lists, identical seeds and identical attribute exports — and showed their
participants different things. It is written at every radius, including the default, so an absent
value means "this record predates the key" and never "this study drew a star"; `readRadius`
returns `undefined` rather than `1` for exactly that reason.

> **A restart can make it ambiguous.** A game already under way is recovered rather than
> re-recorded, so a process restarted with a different `graph.radius` leaves the original value in
> place while showing participants the new one. The server says so loudly when it happens
> (`test/e2e/restart.test.ts`), and a game that produced that warning should be treated as having
> no single radius.

The edge list does not tell you who sat where. It is index pairs. The seat mapping
lives on each channel as `topologyIndex`, which is what makes a restart non-destructive and what
`edgeRows()` has already resolved into player ids for you. If you are working from the raw
attribute rather than the export, you need the seats too.

## 5. Moving into an analysis environment

JavaScript: the graphology bridge.

```js
import { toGraphology } from "empirica-networks/topology/graphology";
import { UndirectedGraph } from "graphology";
const g = toGraphology(UndirectedGraph, n, edges, { order });
```

Pass `UndirectedGraph`, not `Graph`. graphology's default is a mixed graph, whose ratio
metrics count directed slots this module never fills, so density comes back wrong with nothing
erroring; [TOPOLOGIES.md](TOPOLOGIES.md#rendering-and-measuring-elsewhere) has the figures.

`GET /api/state` on a running monitor returns `{ snapshot, positions }` where `snapshot` is
`{ n, edges, order }`, which is exactly that signature. It is the shortest route into the
graphology ecosystem on a live study.

R and Python: go through the CSVs. `edges.csv` is an edge list with timestamps, which
`igraph`, `networkx` and `tidygraph` all read directly; `snapshots.csv` gives you a sequence of
graphs for a dynamic network; `views.csv` joins to `edges.csv` on `(viewer, neighbor_id, t)`.

> This section has not yet been walked end to end. No analysis of a real dataset has been done in either language
> from this package's output: the schemas above are read off the code, and the join keys are
> stated by design rather than exercised. Most network researchers analyze in R or Python, so
> this is the section most likely to be wrong in a way only doing it will reveal.

## 6. Recovery scripts

Both reconstructions ship a `recover.mjs` that rebuilds their CSVs from a run's NDJSON after the
fact: the script to reach for when a session ended badly. They are worth reading as worked
examples of §2's offline path.

They are worth reading for one design decision in particular. `examples/shirado2017`'s network is
static and lives only on the batch scope, so a script left to reconstruct an edge list from a
snapshot recovers an empty `edges.csv`, or at best one whose timestamps it has invented.
Instead the example logs the package's own events verbatim,
`net.log(game, { type: "graph", …, events: network(game).history() })`, which is what makes
recovery byte-identical: `edgeRows` keys every row's `t` on the event's own `at`. Verified
against a real log, including a game torn down mid-run.

The generalisable rule: log the events, not the state they add up to. A snapshot can always be
replayed from events; events cannot be recovered from a snapshot.

## 7. What to keep

A minimum that makes a run re-analysable by someone else, in order:

1. `tajriba.json`: the store. Everything else can be re-derived from it; nothing can be
   re-derived without it.
2. `views.ndjson`, if capture was on. Irreplaceable: this is the only copy.
3. The run log, if used. Also irreplaceable for anything your listeners computed and did not
   store.
4. The derived CSVs. Convenience: regenerable from 1–3.
5. The package version and the `@empirica/core` version. The row builders are pure and stable,
   but the study's behavior is not a property of the CSVs.

Treat 1–3 as identifiable participant data, because they are.
