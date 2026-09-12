# API reference

Organized by import path, so the line at the top of your file tells you which section to open.
Each entry carries the reasoning behind the decision, which is the part worth reading. This is
hand-written rather than generated from types for that reason.

> This surface is not yet frozen. The API freeze applies at the first
> publish, and this page is the inventory that freeze signs off. Until then, anything here can
> still change.

| Path | Loads | Use from |
|---|---|---|
| `empirica-networks/admin` | `@empirica/core/admin` | `server/src/callbacks.js`, `server/src/index.js` |
| `empirica-networks/admin/monitor` | the above, plus `node:http` | opt-in, server only |
| `empirica-networks/player` | `@empirica/core/player` | client, or a headless participant |
| `empirica-networks/player/react` | the above, plus React | client components |
| `empirica-networks/topology` | nothing | anywhere |
| `empirica-networks/topology/graphology` | nothing (constructor injected) | anywhere |
| `empirica-networks/export` | nothing at all | offline analysis scripts, plain `node` |
| `empirica-networks` | nothing | anywhere; shared keys and helpers only |

The root module deliberately does not re-export the others. Combining admin, player and React into
a single module that re-exports everything is the mistake in `@empirica/core`'s own `index.ts`,
which drags server-only code into client bundles.

The package also ships one binary, `empirica-networks`, which is not imported from anywhere. See
[The `verify` CLI](#the-verify-cli) at the end of this page.

---

## Four rules that cut across everything

1. `project()` is the only path by which one participant's data reaches another. The server
   telling you something is a different act, with its own path (`tell()`).
2. Mutate only from inside a listener. The runloop flushes the writes made while it is processing
   a callback. A mutation from a timer, an HTTP handler or a test updates the server's own state
   correctly and then reaches nobody, with no error. Reads are safe anywhere.
3. Declare every private key in `watch` or `read`. An undeclared key is readable nowhere, and
   reads back as `undefined` through the snapshot path, which is indistinguishable from "not
   written yet".
4. Register each lifecycle helper exactly once. Upstream U8: the first callback to run sets a
   scope-level marker, and every later one silently returns.

---

## `empirica-networks/admin`

### `withNetwork(collector, config): NetworkHandle`

Wires network projection into an experiment. Call it once, at module scope in `callbacks.js`.

```js
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import { topology, withNetwork } from "empirica-networks/admin";

export const Empirica = new ClassicListenersCollector();

export const net = withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),
  project: (neighbor, viewer, ctx) => ({
    id: neighbor.id,
    choice: ctx.stateOf(neighbor).get("choice"),
  }),
  watch: ["choice"],
  read: ["submission"],
});
```

#### `NetworkConfig`

##### `topology?: ({ game, players, playerCount, rng }) => Edge[]`

Builds the network at game start. Receives a seeded rng, so the realization is reproducible from
the seed recorded on the batch scope. Defaults to a ring at n ≥ 3, and no edges below that.

Returns a plain edge list over indices, so supplying your own is a one-liner:

```js
withNetwork(Empirica, { topology: ({ playerCount }) => myEdges(playerCount) });
```

The `players` argument is the seating plan. `players[i]` is the participant who will occupy
topology index `i`, so `edge [i, j]` ties `players[i]` to `players[j]`. Without it, a design cannot
place anybody deliberately: the generators return an anonymous edge list, and who lands where is
decided afterwards, out of reach.

This case is not hypothetical: Shirado and Christakis (2017) manipulate exactly this, placing
agents at central, peripheral or random nodes. Placement is done by relabeling the generated
graph rather than by reordering people, since seats are fixed before this function is called:

```js
topology: ({ players, playerCount, rng }) => {
  const graph = barabasiAlbert(playerCount, 2, { rng });
  const seats = players.flatMap((p, i) => (isBot(p) ? [i] : []));
  return placeBots(graph, playerCount, seats, "central", rng);   // see docs/BOTS.md §4
}
```

Relabeling keeps the degree distribution identical across arms, so a "central" condition differs
from a "peripheral" one only in who sits where. Pinned by `test/unit/seating.test.ts`, whose point
is the failure that would otherwise pass silently: a broken mapping still yields a perfectly
correct graph, over the wrong people.

See [TOPOLOGIES.md](TOPOLOGIES.md) for the catalog and [BOTS.md](BOTS.md) for placement.

##### `project?: (neighbor, viewer, ctx) => unknown`

This function determines what one participant may learn about one neighbor. It runs per (viewer,
neighbor) pair, and must be pure. Return plain data; returning `undefined` omits that neighbor
from the view.

There is deliberately no way to choose where this is written. The obvious alternative, writing to
the player scope, is broadcast to everyone and looks like it works.

`ctx` is a [`ProjectContext`](#projectcontext).

> Returning a scope is refused.
>
> ```js
> project: (neighbor) => neighbor                                              // ✗ throws
> project: (neighbor) => ({ id: neighbor.id, choice: neighbor.get("choice") }) // ✓
> ```
>
> The first line is the natural thing to write if `project()` is read as a filter rather than a
> serializer. An Empirica scope holds a reference to the global attribute store, so publishing one
> would ship every attribute of every participant to that client. This is the exact leak this
> module exists to prevent, arriving through the one path that cannot be locked down, because the
> content of the projection is chosen by the person writing it.
>
> Cycles, `BigInt`, functions, `Map`/`Set` and `NaN` are refused too, each naming the offending
> field: `the projection at a.b[0] is …`.

Validation happens before anything is written. A publish is one batched RPC, so a rejected
projection means nothing is sent at all, rather than some participants getting a partial view.

A throw from your own code is re-thrown naming the pair: `project() threw while building X's view
of Y`, with the original attached as `cause`.

##### `watch?: string[]` and `read?: string[]`

Both declare private keys. They are unioned internally and behave identically, so misfiling a key
between them cannot break anything.

- `watch` — keys `project()` reads. A change republishes the views that can see it.
- `read` — keys only your server consumes: a submitted answer, a decision.

One list covers both the player scope and the private channel, deliberately: which scope a key
lives on is your choice and can change, and two lists would turn a moved key into silently frozen
neighborhoods.

Empirica has no wildcard attribute listener, so the list cannot be inferred. That would normally
make this an easy mistake to make: omit `"score"` and neighbors never see scores change, with
nothing to indicate it. So `project()` runs against a recording proxy, and anything it reads that
is not declared is reported once, with the corrected list ready to paste:

```
empirica-networks: project() reads player attribute(s) "score" that are not in
`watch`, so neighbors will NOT see them change.
    withNetwork(Empirica, { watch: ["choice", "score"], ... })
  If they are set once and never change, this is safe to ignore.
```

Leave both empty for a static network whose projection never changes. Listing a key `project()`
ignores costs one listener and no wire traffic; a republished view comes out byte-identical and
is suppressed.

##### `seed?: number`

Pins a condition across sessions. Defaults to a value derived from the game id. Recorded on the
batch scope either way.

##### `envelope?: EnvelopeLimits`

See [Envelope](#envelope).

##### `chat?: boolean | { history?: number }`

Neighbor-scoped chat, off by default because it costs a listener and per-channel storage.
`history` defaults to 200 messages per participant, capped because the log is server memory and
wire payload both.

A message goes to whoever is the sender's neighbor at that moment, plus the sender. It uses the
same channel as everything else, under a different key, so there is no second privacy path.

Sending and receiving take different routes on purpose. A participant can only write to their own
channel, so `send` writes to an outbox there and the server distributes the message. Writing
straight into a neighbor's channel would work, since nothing prevents it, but doing so would rely
on the absence of write access control.

Messages land on the recipient's channel, and this is what decides what a rewire does: dropping a
tie stops new messages without erasing the conversation already delivered. It also keeps chat out
of `project()`'s output, so message volume never counts against `maxViewBytes`.

##### `views?: { file?: string, onView?: (r: ViewRecord) => void, batch?: number }`

Record what each participant was actually shown. Off by default; see
[DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md) for when to turn it on and what the rows mean.

Buffered at 256 records by default and flushed on a full batch, a 2-second idle, a game ending,
and process exit, so a hard kill loses at most one batch.

##### `log?: { file?: string, onRecord?: (r: LogRecord) => void, batch?: number }`

An append-only run log, written as the study happens. Enables [`net.log()`](#netloggame-record).

Unbuffered by default (`batch: 1`), unlike `views`, and the difference is deliberate: a facility
that exists so a killed study still has data must not default to holding its newest records in
memory. Raise this value if a given design writes enough to justify it, keeping in mind that a
SIGKILL then costs up to `n` records, measured at exactly `n` in `test/unit/sink.test.ts`.

##### `onPrivateState?: (event: PrivateStateEvent) => void`

Runs when a participant writes one of the declared keys on their own private channel. A
player-scope write, by contrast, is broadcast to everyone and is `Empirica.on("player", key,
cb)`'s business.

```js
withNetwork(Empirica, {
  watch: ["color"],
  onPrivateState: ({ gameID, playerID, key, value }) => {
    if (key !== "color") return;
    // …check whether the graph is now properly colored, and end the stage if so
  },
});
```

This callback receives player ids and the value, never scopes or topology indices. It arrives
after the republish that the write triggered, so a handler that ends the stage does so with
everyone's view already current.

The callback is synchronous: a returned promise is not awaited, and any write after an `await`
inside it lands outside the runloop's flush and reaches nobody, which is rule 2 arriving by a
different road. A throw is reported with its stack and swallowed, so one participant's handler
failing cannot stop the other nineteen's events. This is the opposite of `project()`, which
throws: there, nothing has been sent yet and a bad view must not go out, whereas here the write
has already happened and the only choice is whether to keep going.

It fires again for a value already delivered if attributes are replayed, as happens on a restart,
and it does not deduplicate.

This is a configuration field rather than a `net.onPrivateState(…)` method, and that choice is a
deliberate refusal: a method invites registration after the admin has started, and a listener
registered too late is a listener that never fires. A field is read before anything is wired.

The alternative it replaced was reaching into the package's key layout,
`Empirica.on(NBHD_KIND, stateKey("color"), …)`, which requires knowing that a plain `.on` escapes
the `unique` guard, and which fires only because `withNetwork` subscribed the admin to the `nbhd`
kind. Copied into a project that does not call `withNetwork`, those three lines produce a listener
that never runs, and nothing indicates the problem.

#### `ProjectContext`

Third argument to `project()`.

| | |
|---|---|
| `game` | the admin game scope |
| `viewerIndex`, `neighborIndex` | positions in the topology |
| `stateOf(player)` | `{ get(key) }` — a player's private state |

Use `ctx.stateOf(neighbor).get("choice")`, not `neighbor.get("choice")`. A player attribute is
broadcast to every participant, so projecting one restricts nothing; only values written to a
private channel are actually neighbor-limited.

#### `NetworkHandle`

Returned by `withNetwork`. All of it is safe to call from anywhere: nothing here writes to a
scope.

##### `net.stateOf(game, playerID, key)`

This is the read path that fails loudly, and the one to use for anything a listener acts on.

```js
const answers = net.stateOf(stage.currentGame, playerID, "rewireAnswers");
```

Here, `undefined` means one thing only: the participant has not written this key. An undeclared
key, a game this process is not networking, a player outside the graph, and an unmaterialised
channel are four other conditions, and every one of those throws, naming the fix.

That distinction matters because the alternative reads the same and is misleading.
`net.inspect().nodes[i].state[key]` collapses all five cases into `undefined`, and that is how the
Rand 2011 reconstruction ran a whole study in which the manipulation did nothing: `rewireAnswers`
was undeclared, every answer read back as "not submitted," the network never changed in the
condition whose defining feature is that it changes, every screen looked right, and nothing
produced an error (`ISSUES.md` O11).

Use `inspect()` for the seating plan and the monitor; use `stateOf()` for anything a listener acts
on.

##### `net.inspect(game): GameSnapshot | undefined`

Everything known about one game's network, as plain data. Returns `undefined` for a game this
process is not networking, which is the honest answer for a game that has ended, was never
started, or was lost to a restart. This is deliberately not an empty snapshot, because an observer
cannot tell an empty graph from a missing one, and that confusion is this package's characteristic
failure.

`GameSnapshot` carries `gameID`, `batchID`, `n`, `edges`, `order`, `seed`, `seq`, `nodes`,
`metrics`, `history`, `pendingChannels`, `awaitingPublish`, and the declared key list.

`pendingChannels` is the field to watch: it is non-empty for a moment during normal startup, and
non-empty for longer than that means the game is stalled and nobody inside it can tell.

##### `net.log(game, record)`

Append one record to the run log, now. `gameID` and `at` are stamped on.

```js
net.log(stage.currentGame, { type: "round", round: 3, rows });
```

This throws if no log is configured, if the game cannot be resolved, or if the record is not a
plain object. All three are deterministic mistakes that show up on the first run, and a logging
call that quietly went nowhere would be indistinguishable from a study that recorded nothing. A
failure to write (a full disk, a vanished directory) is reported and swallowed instead, because
that happens mid-study, and the study matters more than its telemetry.

##### `net.activeGames(): Array<{ id, startedAt }>`

The games this process is currently networking, newest first. A process runs many games
sequentially; in a batch of concurrent games this is several, and in a test suite it can include a
previous scenario's if a game was never ended.

`startedAt` is when this process began networking the game, so after a restart it reflects the
recovery time, not the original start. This is stated explicitly because a timestamp that silently
means two different things is worse than none.

##### `net.publishAll(): boolean` · `net.stats(): NetworkStats`

Recompute and republish every participant's view; and live counts of what is held. `npm run soak`
prints the latter alongside RSS.

| Field | |
|---|---|
| `games` | games this process is currently networking |
| `channels` | channel ids indexed, summed across those games |
| `channelScopes` | materialised channel scope objects held |
| `cachedViews` | serialized views kept for the byte-identical check |
| `endedGames` | finished games still remembered by id |
| `chatSeqs` | chat dedupe marks held, one per participant who has sent a message |
| `firstChannelMs` | ms from the first `addScopes` to the first channel arriving, or `undefined` |
| `pendingAtStart` | players skipped at game start for having no `participantID`, since process start |
| `lateProvisioned` | players given a channel by the connect-time repair path, since process start |

The first three return to zero between games; `endedGames` and `chatSeqs` are the exceptions, and
are reported for that reason. `endedGames` grows by one per game ended and is capped
(`ISSUES.md` O5); it is what stops a finished game's channels from being re-adopted when the kind
subscription replays them. `chatSeqs` is zero unless `chat` is enabled, and returns to zero at
game end.

`firstChannelMs` is not a resource count, but it appears here anyway: it is the quantity the
kind-registration warning above is racing against, measured once per process and never revised. A
number that decides whether someone is told their server is misconfigured should be readable by
the person being told.

`pendingAtStart` and `lateProvisioned` are occurrence counts rather than resource counts, and they
do not reset between games: the question they answer is whether this process ever saw the
late-joiner path, and a per-game reset would clear the record exactly when it started to matter.
Zero is the expected value. `ISSUES.md` O4 is open on whether the
platform can produce a player who is in `game.players` with no `participantID` at all; the entry
can be closed by reproducing that or by ruling it out at runtime, and until these counters existed
the repair fired silently, so there was no runtime to consult. A non-zero `lateProvisioned` means
the repair worked and your game is fine, and that you are holding the observation the entry has
been waiting for. `npm run soak` prints the pair in its summary.

### `network(game): GameNetwork`

The per-game mutation handle. Everything takes and returns player ids, never topology indices,
because indices are an internal representation, and asking experiment code to translate them is
how off-by-one errors get written.

```js
import { network } from "empirica-networks/admin";

Empirica.onStageStart(({ stage }) => {
  const g = network(stage.currentGame);

  g.neighbors(playerID);        // -> player ids
  g.degree(playerID);
  g.hasEdge(a, b);
  g.edges();                    // -> [playerID, playerID][]

  g.addEdge(a, b);              // false if the tie already existed
  g.removeEdge(a, b);
  g.rewire(newEdges);           // replace the whole graph

  g.publish();                  // republish everyone
  g.publishFor(playerID);
  g.history();                  // every mutation so far

  g.tell(playerID, key, value); // tell ONE participant ONE thing
});
```

Mutate only from inside a listener (rule 2). Reads are safe anywhere.

No unlinking is involved, which matters because Tajriba does not support it. The link grants a
persistent private channel; dropping a tie simply means that neighbor is absent from the next
view written there.

Both the current edge list and an append-only mutation log are recorded on the batch scope. Two
records are kept rather than one, because a snapshot cannot answer "how did it get here," and for
a rewiring study the sequence is the independent variable.

#### `tell(playerID, key, value)`

Write one server-authored value to one participant's channel. Nobody else receives it, including
the person the value is about.

```js
network(game).tell(playerID, "offer", { with: otherID, theirLastAction: "C" });
```

A second path to a client exists because that is exactly where a leak gets in. `project()` runs
per (viewer, neighbor) pair over current neighbors only, so it structurally cannot express "show
this subject one fact about someone they are not connected to." This case is not hypothetical:
Rand, Arbesman and Christakis (2011) offer a subject the chance to form a new tie and show them
that person's last action, and by definition the target is not yet a neighbor. Every route around
this problem is a broadcast.

Several properties keep this path from weakening the guarantee:

- Validation is the same as for a projection: `validateProjection` runs on the value, so a scope,
  cycle, `BigInt`, `Map` or `NaN` is refused identically.
- The namespace is separate. Server-authored values live under `told:`, participants' own under
  `state:`, so `state.set("offer", …)` cannot overwrite what the server told a participant, and the
  server cannot read a participant's answer back as its own.
- The client side is read-only. `useNetworkTold()` has no `set`. Nothing at the wire enforces
  this, since a participant can write anywhere, so this is an API that does not invite the
  mistake rather than a permission check. Server code reading a told value back would be trusting
  participant input.
- It works only from inside a listener, and it throws rather than dropping the write if the
  channel has not materialised: a told value is usually a stimulus, and a missing stimulus that
  still records a choice is worse than a crash.

The content of a told value is chosen by the person writing it, so the discipline `project()`
enforces structurally must be kept voluntarily here. In particular, do not assemble by hand a
"summary" of a third party that would not belong in a projection.

### Registration

```js
// server/src/index.js
import { networkKinds } from "empirica-networks/admin";
const ctx = await AdminContext.init(url, sessionTokenPath, "callbacks", token, {}, networkKinds);
```

| | |
|---|---|
| `networkKinds` | `classicKinds` plus the `nbhd` entry. Mandatory |
| `Nbhd` | the admin-side channel scope class |
| `REGISTRATION_DIFF` | the two-line diff, as a string |
| `assertKindsRegistered(kinds)` | throws `KindsNotRegisteredError` with that diff |

There are two checks, because `withNetwork` cannot perform the obvious one directly. It is handed
the collector, not the kind map, so it cannot verify the registration itself: reaching the map
from a listener context needs an `@internal` field plus a `protected` member of upstream's
`Scopes`.

- `assertKindsRegistered(kinds)` is eager, throws, and is opt-in. Call it in
  `server/src/index.js`, the one place that holds the map. One line, and it fails before the
  server starts.
- The automatic check runs after the first game provisions its channels: if channels were created
  and none has materialised within `registrationWaitMs(created)`, it issues a warning with the
  diff. A warning rather than a throw is used because this check fires from a timer, outside the
  runloop, where a throw is an unhandled rejection that could take down a server with participants
  in it.

#### Deadline scaling and warning retraction

The deadline scales with the number of channels created, because a flat deadline fires on correct
code at large n (`ISSUES.md` O15):

```
registrationWaitMs(created) = max(REGISTRATION_CHECK_MS,          // 5 s floor
                                  REGISTRATION_CHECK_PER_CHANNEL_MS * created)   // 100 ms each
```

"Channels materialise in milliseconds" is true at small n and false at large. Slowest
first-channel latency, three runs per cell (`docs/PLATFORM-NOTES.md` §16a): 86 ms at n=25, 2320 ms
at n=100, 4287 ms at n=150, 5870 ms at n=200. At n=150, which is inside the supported envelope, a
flat 5 s deadline would have 14% of its time left.

| | |
|---|---|
| `net.stats().firstChannelMs` | how long the first channel took, or `undefined` if none has |
| `registrationRetractionMessage(…)` | printed if a channel arrives after the warning |

The retraction is the detail worth knowing about. A deadline sized from a measurement can be
beaten by a machine slower than the one measured, so the check's residual failure is still a false
accusation, though a temporary one. If a channel turns up afterwards, the package says so, in the
same log, and states that nothing needs fixing. An operator reading the log later does not find an
unanswered claim that their server is misconfigured.

`registrationNotDetectedMessage`, `registrationRetractionMessage`, `registrationWaitMs`,
`REGISTRATION_CHECK_MS` and `REGISTRATION_CHECK_PER_CHANNEL_MS` are exported so a test can assert
the behavior and a consumer can recognize it. The wait is overridable for tests via
`EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS`, which replaces the whole computation rather than just
the floor, deliberately as an environment-variable seam rather than a configuration field.

### Reading the realized network

| | |
|---|---|
| `readNetwork(game): Edge[] \| undefined` | the recorded edge list, off the batch scope |
| `readSeed(game): number \| undefined` | the recorded seed |
| `gameIDOf(ref): string \| undefined` | the id out of a `GameRef` |

`GameRef = string \| { id?: unknown }`. Every entry point that takes a game accepts either the
scope object or its id. A listener holds `stage.currentGame`, while a test or an HTTP handler
usually holds an id; neither should have to know which the function it is calling prefers.

### Envelope

Limits on what may be published, enforced by default.

| Limit | Default | What it catches |
|---|---|---|
| `maxDegree` | `n - 1` at n ≤ 50, `16` above | A topology too dense for the measured regime |
| `maxViewBytes` | 8192 | One neighbor's view being enormous |
| `maxNeighborhoodBytes` | 65536 (64 KiB) | Degree × view size, many reasonable views adding up |

Degree is checked at game start, before provisioning and before anything is recorded, so an
out-of-envelope topology fails while the experiment is still abandonable.

There are three limits rather than one, and `maxDegree` depends on n, for the following reason. A
flat cap of 16 at every size would be a number about n enforced as a number about degree: the
sweep behind it varies n over sparse graphs, so it says nothing about degree at a fixed n, and a
published design needing a full neighborhood at n=20 would have to override it. Measured directly
(`npm run bench -- --dense`), a complete graph at n=20 publishes faster than a degree-8 ring at
n=50, which is why there is no per-node cap inside the measured regime, and 16 applies only above
it.

That benchmark projects only two fields, however, so what it establishes is that degree is cheap
at small view sizes. Degree multiplied by view size is what a participant's connection actually
carries, and guarding that quantity is `maxNeighborhoodBytes`'s job: 49 views of 1.5 KiB are each
well inside `maxViewBytes` and add up to 73 KiB. Lifting a limit is only honest if the person doing
so names what it was accidentally guarding.

Also exported: `resolveEnvelope`, `defaultMaxDegree`, `DEFAULT_ENVELOPE`, `MEASURED_DENSE_N`,
`MEASURED_SPARSE_DEGREE`, `EnvelopeError`, and the `checkDegrees` / `checkViewBytes` /
`checkNeighborhoodBytes` predicates.

### Also exported

| | |
|---|---|
| `validateProjection`, `projectionBytes`, `ProjectionError` | the projection guard, usable directly |
| `hashSeed`, `makeRng`, `randInt`, `shuffle` | seeded randomness — hang your design's own randomness off the recorded seed |
| `graphMetrics`, `historyFrames` | the pure builders behind `inspect()` |
| `provisionChannels`, `readChannels`, `resetChannels` | channel plumbing; `resetChannels` is a test seam |
| `makeViewSink`, `makeLogSink`, `makeNdjsonSink` | the NDJSON writers |
| `topology` | the whole [topology namespace](TOPOLOGIES.md) |
| `edgeRows`, `snapshotRows`, `viewRows`, `parseNdjson`, `toCSV`, `historyIsConsistent` | re-exported from `/export`, but see the warning there |

---

## `empirica-networks/admin/monitor`

### `monitor(net, options?)`

Serves a live view of a running study: the current graph, nodes carrying each participant's state,
ties appearing and disappearing as you rewire, and a scrubber back through the edge history. It
also shows what cannot be seen from inside the experiment: publish counts, and any channel that
has not materialised.

```js
// server/src/index.js
if (process.env.MONITOR) {
  const { monitor } = await import("empirica-networks/admin/monitor");
  await monitor(net);        // prints http://127.0.0.1:<port>/?t=<token>
}
```

```js
await monitor(net, {
  port: 0,              // default: the OS picks; the printed URL tells you which
  host: "127.0.0.1",    // default; anything else warns
  token: undefined,     // default: fresh 48-char token per run
  pollMs: 500,          // how often it re-reads state
});
```

> Read this before exposing the monitor. It shows exactly what participants must never see: the
> complete graph, the seating plan, and every participant's private state, on one page.
>
> - Nothing it serves enters Empirica's scope graph. It is plain HTTP on its own port, so no
>   participant's subscription can carry it, whatever the study's listeners do. That guarantee is
>   structural, and `test/e2e/monitor.test.ts` asserts it against the raw wire with the monitor
>   running and reading every secret.
> - Who can open it is a matter of access control, and access control is never structural. It
>   binds to `127.0.0.1` and requires a per-run token. Passing a different `host` will do as asked,
>   and the monitor will state loudly what that costs. Reach it remotely through an SSH tunnel
>   instead.
>
> It holds no Empirica credential: it reads the callbacks process's own memory and serves JSON,
> with no path from the page to `setAttribute`. This matters more than it sounds, because with no
> write access control anywhere in Empirica, an admin `srtoken` in a browser is not a read-only
> view with a login, but the ability to write any attribute on any node. Such a view should not be
> built.

It does not survive a server restart, because nothing does. It reports that the game is gone and
clears the picture, rather than leaving a dead study on screen as though it were live, and
`test/browser/monitor_page.ts` asserts that in a real browser. A dropped stream is deliberately
different: the graph stays, with a banner saying it is frozen, because the study itself may well
still be running. The monitor is sized for n ≤ 50.

`GET /api/state` returns `{ snapshot, positions }`, where `snapshot` is `{ n, edges, order }`,
exactly `toGraphology`'s signature, so the monitor is also the shortest route into the graphology
ecosystem on a live study.

---

## `empirica-networks/player`

### `EmpiricaNetwork`

```jsx
import { EmpiricaNetwork } from "empirica-networks/player";
<EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>
```

A superset of `EmpiricaClassic`, composed with it rather than reimplementing it, so `usePlayer`,
`useGame`, `useStage` and the whole intro/exit flow keep working. It must be installed, or none of
the hooks have anything to read.

### Derivations, usable without React

Headless clients and bots need these too; the hooks are thin wrappers over them.

| | |
|---|---|
| `neighborsOf(ctx)`, `networkSelfOf(ctx)`, `networkToldOf(ctx)` | the read paths |
| `networkStateOf(ctx)` | the participant's own private state, with `set` |
| `neighborChatOf(ctx)` | chat |
| `assertNetworkMode(ctx)` | throws `NetworkModeNotInstalledError` if `modeFunc` is missing |
| `Nbhd`, `DonesWiringError` | the client-side channel scope, and the self-check |

---

## `empirica-networks/player/react`

```jsx
import { useNeighbors, useNetworkSelf, useNetworkState } from "empirica-networks/player/react";
```

| Hook | Returns | `undefined` when |
|---|---|---|
| `useNeighbors<T>()` | `T[]` — exactly what `project()` returned, in topology order | before the first publish |
| `useNetworkSelf()` | `{ playerID, degree, … }` | before the channel is provisioned |
| `useNetworkState()` | `{ get, set }` — this participant's private state | before the channel is provisioned |
| `useNetworkTold()` | `{ get }` — server-authored values. No `set` | before the channel is provisioned |
| `useNeighborChat()` | `{ messages, send }` | chat off, or before provisioning |
| `useNbhd()` | the raw `Nbhd` scope | before the channel is provisioned |

### Writing private state

```jsx
const state = useNetworkState();
state.set("choice", "A");    // ✓ private: this participant's own channel
player.set("choice", "A");   // ✗ BROADCAST to every participant, whatever your topology
```

This is the step that decides whether the manipulation is real. Empirica cross-links every
participant to every player node, so anything written with `player.set()` is readable by everyone,
and projecting such a value restricts nothing: the experiment runs, the screens look right, and
the network has stopped being the manipulation.

### `undefined` is not `[]`

```jsx
const neighbors = useNeighbors();
if (!neighbors) return <Loading />;    // this branch matters
```

`useNeighbors()` returns `undefined` until the first publish, and `[]` only for a genuinely
isolated node. The hook refuses to conflate them: a node with no neighbors is a legitimate
result, so returning `[]` while loading would render a participant as isolated, look entirely
normal, and quietly corrupt the data. Branch on this the way one already branches on `usePlayer()`.

`useNetworkSelf()` resolves earlier, since `playerID` is written when the channel is provisioned,
and reports `degree: undefined` rather than `0` before the first publish, for the same reason.

TypeScript users can name the projection: `useNeighbors<{ id: string; choice: string }>()`.

---

## `empirica-networks/topology` · `/topology/graphology`

See [TOPOLOGIES.md](TOPOLOGIES.md): 14 generators, 6 measures, and the graphology bridge,
with the parameters, connectivity guarantees and envelope implications of each.

---

## `empirica-networks/export`

The pure row builders: `edgeRows`, `snapshotRows`, `viewRows`, `parseNdjson`, `toCSV`,
`historyIsConsistent`. Schemas in [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md).

> Import these from `/export`, not `/admin`, in anything run outside the Empirica CLI. The
> functions are identical, since `/admin` re-exports them, but `/admin` also pulls in
> `@empirica/core/admin`, which cannot be loaded from raw Node in either module system. An offline
> script importing from `/admin` fails on `cross-fetch/polyfill` before it runs a line.
>
> The subpath has no runtime imports at all, a property pinned by
> `test/unit/export_isolation.test.ts`, which is also why `parseNdjson` takes the file's text
> rather than its path: it cannot import `node:fs` either.

---

## `empirica-networks/bots`

Artificial participants. Full account, including the parts that are not API, in
[BOTS.md](BOTS.md).

This module is shipped as a bundled CJS artifact, so a bot script runs under plain `node` with no
bundler and no tsx. `@empirica/core/admin`, needed for `TajribaConnection`, cannot be loaded from
bare Node ESM ([PLATFORM-NOTES §3a](PLATFORM-NOTES.md#3a-the-published-empiricacore-cannot-be-loaded-from-raw-node-at-all-significant-risk)),
so the export map has one `default` condition rather than an `import` that would resolve and then
fail. Both `import` and `require` work.

### `runBots(options): Promise<BotRun>`

```js
import { botIdentifiers, runBots } from "empirica-networks/bots";

const run = await runBots({
  url: "http://localhost:3000/query",
  identifiers: process.env.BOT_KEYS.split(","),
  seed: 1,
  policy: {
    tickMs: 1500,
    onTick(ctx) {
      const neighbors = ctx.neighbors();
      if (neighbors === undefined) return;
      const mine = ctx.state().get("choice");
      const next = decide(mine, neighbors, ctx.rng);
      if (next !== mine) ctx.state().set("choice", next);
    },
  },
});
```

| option | |
|---|---|
| `url` | Tajriba endpoint, e.g. `http://localhost:3000/query`. The HTTP address, not the websocket one. Tajriba derives `ws://`/`wss://` itself and rejects a url that already carries a websocket scheme. |
| `identifiers` | one participant key per bot. Required: the list is the count, and the server usually needs the same list |
| `policy` | the behavior; see below |
| `seed` | seeds each bot's `ctx.rng` from `(seed, identifier)`. Default 1, fixed rather than time-derived so bot behavior is reproducible by default |
| `log` | `(record) => void`. Default: one JSON line per record on stdout |
| `pollMs` | lifecycle poll interval, default 250. Polled because the mode's subjects carry scope objects mutated in place, so `player.get("gameID")` changing pushes nothing |
| `stallMs` | warn after this long in one non-playing phase, default 30 000. Once per phase, not per poll |

`runBots` resolves once every bot has a session, not when a game ends: one fleet plays a whole
batch, following Classic's reassignment with `onEnd` then `onStart`.

`BotRun` gives `identifiers`, `playerIDs()` (the id space `project()` works in; record these to
know which nodes were bots), `phases()`, and `stop()`.

### `BotPolicy`

| | |
|---|---|
| `onStart(ctx)` | first published view, once per game |
| `onView(ctx)` | what this bot can see changed — driven by the publish counter, not by wire frames |
| `onTick(ctx)` | every `tickMs`; required for any policy that must act when nothing changed |
| `tickMs` | required whenever `onTick` is set — a missing one would mean a bot that simply never acts |
| `onEnd(ctx)` | this bot's game ended |

Every hook is synchronous: a returned promise is not awaited, and a write after an `await` lands
outside the runloop's flush and reaches nobody ([§14](PLATFORM-NOTES.md#14-writes-only-count-inside-a-callback-caution)).
A throw is caught and logged rather than propagated, because one policy failing must not leave the
study one player short.

### `BotContext`

`identifier`, `index`, `playerID`, `gameID`, and the four accessors a browser has: `neighbors()`,
`self()`, `state()`, `told()`. Plus `elapsedMs()` (since the first publish), `rng`, `log(record)`
and `submit()`.

There is deliberately no server-side path: no way to read a non-neighbor, see the graph, or learn
global state. A bot with more information than a participant would make a bot condition a
comparison between two different games.

### `botIdentifiers(n, { now?, spacingMs? })`

Keys shaped like the ones Empirica's own client generates, a 13-digit millisecond timestamp
matching `createNewParticipant`. This is a development default. Every participant receives every
co-player's `participantIdentifier` ([U10](upstream/ISSUES.md)), so in a deployed study, pass keys drawn
from the same space as the study's recruitment keys, or use three 13-digit numbers among
24-character Prolific PIDs as the three bots, in order.

`botMarkerWarning(ids)` returns the warning `runBots` prints for identifiers that name themselves
(`bot`, `agent`, `robot`, …). `assertIdentifiers(ids)` throws on an empty list or a duplicate: a
duplicate is one participant with two sockets, so the game sits one player short forever.

### `botPhase(obs)`, `stallReason(phase)`, `stallMessage(...)`

The lifecycle as a pure function, exported because it is testable and because a stalled study is
diagnosed by phase: `connecting → waiting → intro → starting → playing → ended`.

---

## `empirica-networks` (root)

Isomorphic pieces only.

| | |
|---|---|
| `NBHD_KIND`, `NBHD_KEYS`, `NETWORK_KEYS`, `GAME_KEYS` | the scope kinds and attribute keys |
| `stateKey(k)`, `toldKey(k)`, `STATE_PREFIX`, `TOLD_PREFIX`, `OUTBOX_KEY` | key construction |
| `EdgeEvent`, `ViewRecord`, `ChatMessage` | the record types |
| `waitFor`, `waitForValue`, `TimeoutError` | polling helpers, used by the tests and the harness |

`GAME_KEYS` is a named, empty record. Two things were kept on the game scope and both had to move:
the channel index (every participant got every channel id, which with no write access control is
the capability needed to write into someone else's channel) and the realized network. It is kept
as an empty record so the reason survives rather than being rediscovered.

---

## The `verify` CLI

One binary, one command. It runs the leak check against the installed copy of Empirica, so the
claim this package exists to make is something a user reproduces in about thirty seconds rather
than takes on trust, and it doubles as an upgrade canary: run it after bumping `@empirica/core`.

```sh
npx empirica-networks verify --n 4        # once published
node dist/verify/cli.cjs verify --n 4     # from a clone, after `npm run build`
```

| Option | Default | |
|---|---|---|
| `-n`, `--n <count>` | 4 | Participants. Minimum 4, and refused below that: below it every named topology makes everyone everyone's neighbor, so there is no non-neighbor and a pass would prove nothing |
| `--topology <name>` | `ring` | `ring`, `star`, `wheel`, `pairs`, `ladder`, `complete`. Refused when the shape could prove nothing — see below |
| `-q`, `--quiet` | off | Print `PASS` or `FAIL` and nothing else. The CI form |
| `-h`, `--help` | | Usage |

The exit code is 0 on PASS, and 1 on FAIL, on a usage error, and on a run that could not start.
The last of these is deliberate: a check that cannot run must not be mistaken for a check that
passed.

This command requires the Empirica CLI on PATH (`curl https://install.empirica.dev | sh`).
`verify` boots a real Tajriba in a temporary directory and cleans it up, so it touches nothing in
the project and can be run from anywhere. However, it should be run from the half of the project
where the package was installed (`server/`), because that is what makes the version line below
report the study's own `@empirica/core`.

```
  @empirica/core bundled into this CLI : 1.12.5
  @empirica/core installed here        : 1.12.5

  … connected 4 participants
  … waiting for projections to be published

  empirica-networks verify — neighbor-limited visibility
  topology: ring of 4

  non-neighbor sentinels received : 0/4 pairs  (must be 0)
  neighbor sentinels delivered    : 8/8  (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)

  note: ring of 4: degree 2-2, 4 non-neighbor pairs examined

  PASS
```

Every arm prints against what it was measured over, and arm 1's denominator is the one that took
longest to earn: `0` alone reads the same whether four non-neighbor pairs were examined and none
leaked, or the graph was complete and no such pair existed. The second is a check that establishes
nothing while announcing a PASS, which is the failure this command exists to make impossible.

Which shapes it will run is decided as follows. A topology is refused, before anything boots, when its own graph
says the run could not establish the guarantee: no non-neighbor anywhere (arm 1 has nothing to
examine) or no edges at all (arm 3 expects nothing to arrive). That refuses `complete` at every
`n`, and `wheel` at `n = 4`, where a hub plus a three-node rim is the complete graph. Shapes
that excuse only some participants are run and reported: a star's hub is adjacent to everyone,
so the verdict says `not covered: 1 adjacent to everyone` and the check still establishes the
guarantee for the spokes.

The parameterised generators (`grid`, `ringLattice`, `wattsStrogatz`, `barabasiAlbert`,
`erdosRenyi`, `geometricRandom`) take an argument a flag cannot carry. They are reachable by
handing `runLeakCheck` the same generator function you hand `withNetwork`, which is also how to
check a `fromEdgeList` graph:

```js
await runLeakCheck({
  n: 12,
  topology: ({ playerCount, rng }) => topology.wattsStrogatz(playerCount, 4, 0.1, { rng }),
});
```

There are three arms, all required. A clean result with a silent control means the check is
blind; a clean result with nothing delivered means the projection never ran. Most privacy tests
are wrong in exactly one of those two ways, so both are reported as failures rather than as a
pass.

Sentinels are high-entropy tokens held server-side and injected into projections. Nothing writes
them to a scope, and matching is by substring over raw wire frames, so a leak through a channel
nobody thought to enumerate is still caught.

When the two versions differ, the CLI says so, and states what that costs:

```
  NOTE: these differ. This run verifies the mechanism against 1.12.5,
  not against your installed 1.13.0.
```

The CLI compiles a copy of `@empirica/core` into itself, because Empirica cannot be loaded
unbundled ([§3a](PLATFORM-NOTES.md#3a-the-published-empiricacore-cannot-be-loaded-from-raw-node-at-all-significant-risk)).
A differing installation is therefore a run whose result does not transfer, and stating that is
the only honest option available; the alternative would be a green tick implying a test that was
never performed.

`bench`, `soak` and `ceiling` are not part of this binary. They are repository scripts for working
on the package itself; [TESTING.md](TESTING.md) §3 describes them.

---

## See also

| | |
|---|---|
| [GETTING-STARTED](GETTING-STARTED.md) | the ordered path, if this page is the wrong altitude |
| [ARCHITECTURE](ARCHITECTURE.md) | what happens between these calls |
| [BOTS](BOTS.md) | artificial participants, in more depth than the entry above |
| [TROUBLESHOOTING](TROUBLESHOOTING.md) | when one of them does nothing |
| [`../ISSUES.md`](../ISSUES.md) | known defects in the above |
