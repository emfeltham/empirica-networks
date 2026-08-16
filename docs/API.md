# API reference

Organised by import path, so the line at the top of your file tells you which section to open.
Each entry carries the reasoning behind the decision, which is the part worth reading — this is
hand-written rather than generated from types for that reason.

> **The surface is not frozen.** `PUBLICATION-PLAN.md` §2 freezes it at the first publish. This
> page was extracted from the README against the post-M6 surface on 2026-08-16 and needs a
> read-through at freeze time.

| Path | Loads | Use from |
|---|---|---|
| `empirica-networks/admin` | `@empirica/core/admin` | `server/src/callbacks.js`, `server/src/index.js` |
| `empirica-networks/admin/monitor` | the above, plus `node:http` | opt-in, server only |
| `empirica-networks/player` | `@empirica/core/player` | client, or a headless participant |
| `empirica-networks/player/react` | the above, plus React | client components |
| `empirica-networks/topology` | nothing | anywhere |
| `empirica-networks/topology/graphology` | nothing (constructor injected) | anywhere |
| `empirica-networks/export` | **nothing at all** | offline analysis scripts, plain `node` |
| `empirica-networks` | nothing | anywhere; shared keys and helpers only |

The root barrel deliberately does **not** re-export the others. Pulling admin, player and React
into one barrel is the mistake in `@empirica/core`'s own `index.ts`, which drags server-only code
into client bundles.

---

## Four rules that cut across everything

**1. `project()` is the only path by which one participant's data reaches another.** The server
telling *you* something is a different act with its own path (`tell()`).

**2. Mutate only from inside a listener.** The runloop flushes the writes made while it is
processing a callback. A mutation from a timer, an HTTP handler or a test updates the server's own
state correctly and then **reaches nobody, with no error**. Reads are safe anywhere.

**3. Declare every private key** in `watch` or `read`. An undeclared key is readable nowhere and
reads back as `undefined` through the snapshot path, which is indistinguishable from "not written
yet".

**4. Register each lifecycle helper exactly once.** Upstream U8: the first callback to run sets a
scope-level marker and every later one silently returns.

---

# `empirica-networks/admin`

## `withNetwork(collector, config): NetworkHandle`

Wires network projection into an experiment. Call it once, at module scope in `callbacks.js`.

```js
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import { topology, withNetwork } from "empirica-networks/admin";

export const Empirica = new ClassicListenersCollector();

export const net = withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),
  project: (neighbour, viewer, ctx) => ({
    id: neighbour.id,
    choice: ctx.stateOf(neighbour).get("choice"),
  }),
  watch: ["choice"],
  read: ["submission"],
});
```

### `NetworkConfig`

#### `topology?: ({ game, playerCount, rng }) => Edge[]`

Builds the network at game start. Receives a **seeded** rng, so the realisation is reproducible
from the seed recorded on the batch scope. Defaults to a ring at n ≥ 3, and no edges below that.

Returns a plain edge list over indices, so supplying your own is a one-liner:

```js
withNetwork(Empirica, { topology: ({ playerCount }) => myEdges(playerCount) });
```

See [TOPOLOGIES.md](TOPOLOGIES.md) for the catalogue.

#### `project?: (neighbour, viewer, ctx) => unknown`

**What one participant may learn about one neighbour.** Runs per (viewer, neighbour) pair. Pure.
Return plain data; returning `undefined` omits that neighbour from the view.

There is deliberately no way to choose *where* this is written. The obvious alternative — writing
to the player scope — is broadcast to everyone and looks like it works.

`ctx` is a [`ProjectContext`](#projectcontext).

> **Returning a scope is refused.**
>
> ```js
> project: (neighbour) => neighbour                                              // ✗ throws
> project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get("choice") }) // ✓
> ```
>
> The first line is the natural thing to write if you read `project()` as a filter rather than a
> serialiser. An Empirica scope holds a reference to the *global* attribute store, so publishing
> one would ship every attribute of every participant to that client — the exact leak this module
> exists to prevent, arriving through the one path that cannot be locked down, because you choose
> what goes in it.
>
> Cycles, `BigInt`, functions, `Map`/`Set` and `NaN` are refused too, each naming the offending
> field: `the projection at a.b[0] is …`.

Validation happens **before anything is written**. A publish is one batched RPC, so a rejected
projection means nothing is sent at all, rather than some participants getting a partial view.

A throw from your own code is re-thrown naming the pair: `project() threw while building X's view
of Y`, with the original attached as `cause`.

#### `watch?: string[]` and `read?: string[]`

Both declare private keys. They are **unioned internally and behave identically**, so misfiling a
key between them cannot break anything.

- **`watch`** — keys `project()` reads. A change republishes the views that can see it.
- **`read`** — keys only your server consumes: a submitted answer, a decision.

One list covers both the player scope and the private channel, deliberately: which scope a key
lives on is your choice and can change, and two lists would turn a moved key into silently frozen
neighbourhoods.

Empirica has no wildcard attribute listener, so the list cannot be inferred. That would normally
make it a footgun — forget `"score"` and neighbours never see scores change, with nothing to
indicate it. So `project()` runs against a **recording proxy**, and anything it reads that is not
declared is reported once, with the corrected list ready to paste:

```
empirica-networks: project() reads player attribute(s) "score" that are not in
`watch`, so neighbours will NOT see them change.
    withNetwork(Empirica, { watch: ["choice", "score"], ... })
  If they are set once and never change, this is safe to ignore.
```

Leave both empty for a static network whose projection never changes. Listing a key `project()`
ignores costs one listener and no wire traffic — a republished view comes out byte-identical and
is suppressed.

#### `seed?: number`

Pins a condition across sessions. Defaults to a value derived from the game id. Recorded on the
batch scope either way.

#### `envelope?: EnvelopeLimits`

See [Envelope](#envelope).

#### `chat?: boolean | { history?: number }`

Neighbour-scoped chat, off by default because it costs a listener and per-channel storage.
`history` defaults to 200 messages per participant, capped because the log is server memory and
wire payload both.

A message goes to whoever is the sender's neighbour **at that moment**, plus the sender. Same
channel as everything else, a different key — no second privacy path, which is the point.

Sending and receiving take different routes on purpose. A participant can only write to their own
channel, so `send` writes to an outbox there and the server fans out. Writing straight into a
neighbour's channel would work — nothing prevents it — and would be building on the absence of
write access control.

**Messages land on the recipient's channel**, which decides what a rewire does: dropping a tie
stops new messages without erasing the conversation already delivered. It also keeps chat out of
`project()`'s output, so message volume never counts against `maxViewBytes`.

#### `views?: { file?: string, onView?: (r: ViewRecord) => void, batch?: number }`

Record what each participant was actually shown. Off by default; see
[DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md) for when to turn it on and what the rows mean.

Buffered at 256 records by default and flushed on a full batch, a 2-second idle, a game ending,
and process exit — so a hard kill loses at most one batch.

#### `log?: { file?: string, onRecord?: (r: LogRecord) => void, batch?: number }`

An append-only run log, written as the study happens. Enables [`net.log()`](#netloggame-record).

**Unbuffered by default** (`batch: 1`), unlike `views`, and the difference is deliberate: a
facility that exists so a killed study still has data must not default to holding its newest
records in memory. Raise it if your design writes enough to care, knowing a SIGKILL then costs up
to `n` records — measured, at exactly `n`, in `test/unit/sink.test.ts`.

#### `onPrivateState?: (event: PrivateStateEvent) => void`

Runs when a participant writes one of the declared keys **on their own private channel** — a
player-scope write is broadcast to everyone and is `Empirica.on("player", key, cb)`'s business.

```js
withNetwork(Empirica, {
  watch: ["color"],
  onPrivateState: ({ gameID, playerID, key, value }) => {
    if (key !== "color") return;
    // …check whether the graph is now properly coloured, and end the stage if so
  },
});
```

You get player ids and the value, never scopes or topology indices. It arrives **after** the
republish that write triggered, so a handler that ends the stage does so with everyone's view
already current.

**Synchronous.** A returned promise is not awaited, and any write after an `await` inside it lands
outside the runloop's flush and reaches nobody — rule 2, arriving by a different road. A throw is
reported with its stack and swallowed, so one participant's handler failing cannot stop the other
nineteen's events. (That is the opposite of `project()`, which throws: there, nothing has been
sent yet and a bad view must not go out; here the write has already happened and the only choice
is whether to keep going.)

It **fires again for a value already delivered if attributes are replayed** (a restart), and does
not dedupe.

A config field rather than a `net.onPrivateState(…)` method, and that is a deliberate refusal: a
method invites registration after the admin has started, and a listener registered too late is a
listener that never fires. A field is read before anything is wired.

*The alternative it replaced* was reaching into the package's key layout —
`Empirica.on(NBHD_KIND, stateKey("color"), …)` — which requires knowing that a plain `.on` escapes
the `unique` guard, and which fires only because `withNetwork` subscribed the admin to the `nbhd`
kind. Copied into a project that does not call `withNetwork`, those three lines produce a listener
that never runs, and nothing says so.

### `ProjectContext`

Third argument to `project()`.

| | |
|---|---|
| `game` | the admin game scope |
| `viewerIndex`, `neighbourIndex` | positions in the topology |
| `stateOf(player)` | `{ get(key) }` — a player's **private** state |

Use `ctx.stateOf(neighbour).get("choice")`, not `neighbour.get("choice")`. A player attribute is
broadcast to every participant, so projecting one restricts nothing; only values written to a
private channel are actually neighbour-limited.

### `NetworkHandle`

Returned by `withNetwork`. All of it is safe to call from anywhere — nothing here writes to a
scope.

#### `net.stateOf(game, playerID, key)`

**The loud read path**, and the one to use for anything a listener acts on.

```js
const answers = net.stateOf(stage.currentGame, playerID, "rewireAnswers");
```

**`undefined` means one thing only: the participant has not written this key.** An undeclared key,
a game this process is not networking, a player outside the graph, an unmaterialised channel —
every one of those **throws**, naming the fix.

That matters because the alternative reads the same and lies. `net.inspect().nodes[i].state[key]`
collapses all five cases into `undefined`, and that is how the Rand 2011 reconstruction ran a whole
study in which the manipulation did nothing: `rewireAnswers` was undeclared, every answer read
back as "not submitted", the network never changed in the condition whose defining feature is that
it changes, every screen looked right, and nothing errored (`ISSUES.md` O11).

Use `inspect()` for the seating plan and the monitor; use `stateOf()` for anything a listener acts
on.

#### `net.inspect(game): GameSnapshot | undefined`

Everything known about one game's network, as plain data. Returns `undefined` for a game this
process is not networking — the honest answer for a game that has ended, was never started, or was
lost to a restart. Deliberately **not** an empty snapshot: an observer cannot tell an empty graph
from a missing one, and that confusion is this package's characteristic failure.

`GameSnapshot` carries `gameID`, `batchID`, `n`, `edges`, `order`, `seed`, `seq`, `nodes`,
`metrics`, `history`, `pendingChannels`, `awaitingPublish`, and the declared key list.

`pendingChannels` is the field to watch: non-empty for a moment during normal startup, and
non-empty for longer than that means **the game is stalled and nobody inside it can tell.**

#### `net.log(game, record)`

Append one record to the run log, now. `gameID` and `at` are stamped on.

```js
net.log(stage.currentGame, { type: "round", round: 3, rows });
```

**Throws** if no log is configured, if the game cannot be resolved, or if the record is not a plain
object — all three are deterministic mistakes that show up on the first run, and a logging call
that quietly went nowhere would be indistinguishable from a study that recorded nothing. A failure
to *write* (a full disk, a vanished directory) is reported and swallowed instead: that happens
mid-study, and the study matters more than its telemetry.

#### `net.activeGames(): Array<{ id, startedAt }>`

Games **this process** is currently networking, newest first. A process runs many games
sequentially; in a batch of concurrent games this is several, and in a test suite it can include a
previous scenario's if a game was never ended.

`startedAt` is when *this process* began networking the game — so after a restart it is the
**recovery** time, not the original start. Stated because a timestamp that silently means two
different things is worse than none.

#### `net.publishAll(): boolean` · `net.stats(): NetworkStats`

Recompute and republish every participant's view; and live counts of what is held
(`games`, `channels`, `channelScopes`, `cachedViews`). `npm run soak` prints the latter alongside
RSS.

## `network(game): GameNetwork`

The per-game mutation handle. **Everything takes and returns player ids, never topology indices** —
indices are an internal representation, and asking experiment code to translate is how off-by-one
errors get written.

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

**Mutate only from inside a listener** (rule 2). Reads are safe anywhere.

No unlinking is involved, which matters because Tajriba does not support it. The link grants a
persistent private *channel*; dropping a tie simply means that neighbour is absent from the next
view written there.

Both the current edge list and an append-only mutation log are recorded on the batch scope. Two
records rather than one, because a snapshot cannot answer "how did it get here" — and for a
rewiring study the sequence is the independent variable.

### `tell(playerID, key, value)`

Write one server-authored value to one participant's channel. **Nobody else receives it —
including the person the value is about.**

```js
network(game).tell(playerID, "offer", { with: otherID, theirLastAction: "C" });
```

**Why a second path to a client exists**, since that is exactly where a leak gets in. `project()`
runs per (viewer, neighbour) pair over *current neighbours only*, so it structurally cannot express
"show this subject one fact about someone they are not connected to". Not hypothetical: Rand,
Arbesman & Christakis (2011) offer a subject the chance to form a *new* tie and show them that
person's last action, and by definition the target is not yet a neighbour. Every route around it is
a broadcast. The full account, with the four rejected alternatives, is in
[M5-ADOPTION.md](M5-ADOPTION.md) §7.

What keeps it from weakening the guarantee:

- **Same validation as a projection** — `validateProjection` runs on the value, so a scope, cycle,
  `BigInt`, `Map` or `NaN` is refused identically.
- **A separate namespace.** Server-authored values live under `told:`, participants' own under
  `state:`, so `state.set("offer", …)` cannot overwrite what the server told you, and the server
  cannot read a participant's answer back as its own.
- **Read-only on the client.** `useNetworkTold()` has no `set`. Nothing at the wire enforces that —
  a participant can write anywhere — so it is an API that does not invite the mistake, not a
  permission check. Server code reading a told value back would be trusting participant input.
- **Only from inside a listener**, and it **throws** rather than dropping the write if the channel
  has not materialised: a told value is usually a stimulus, and a missing stimulus that still
  records a choice is worse than a crash.

You choose what goes in it, so the discipline `project()` enforces structurally is yours to keep
here. In particular, do not assemble by hand a "summary" of a third party that you would not have
put in a projection.

## Registration

```js
// server/src/index.js
import { networkKinds } from "empirica-networks/admin";
const ctx = await AdminContext.init(url, sessionTokenPath, "callbacks", token, {}, networkKinds);
```

| | |
|---|---|
| `networkKinds` | `classicKinds` plus the `nbhd` entry. **Mandatory** |
| `Nbhd` | the admin-side channel scope class |
| `REGISTRATION_DIFF` | the two-line diff, as a string |
| `assertKindsRegistered(kinds)` | throws `KindsNotRegisteredError` with that diff |

> **`assertKindsRegistered` is never called by the package — `ISSUES.md` O14.** It is exported and
> works, but nothing invokes it and no test covers it, so **skipping the registration is still
> silently fatal**: no channels are modelled, nothing errors, and every participant sits with an
> empty neighbourhood forever. Until that is wired up, confirm it yourself after your first game
> starts — `net.stats().channelScopes` should not be zero.

## Reading the realised network

| | |
|---|---|
| `readNetwork(game): Edge[] \| undefined` | the recorded edge list, off the batch scope |
| `readSeed(game): number \| undefined` | the recorded seed |
| `gameIDOf(ref): string \| undefined` | the id out of a `GameRef` |

`GameRef = string \| { id?: unknown }` — every entry point that takes a game accepts either the
scope object or its id. A listener holds `stage.currentGame`; a test or an HTTP handler usually
holds an id; neither should have to know which the function it is calling prefers.

## Envelope

Limits on what may be published, enforced by default.

| Limit | Default | What it catches |
|---|---|---|
| `maxDegree` | `n - 1` at n ≤ 50, `16` above | A topology too dense for the measured regime |
| `maxViewBytes` | 8192 | One neighbour's view being enormous |
| `maxNeighbourhoodBytes` | 65536 (64 KiB) | **Degree × view size** — many reasonable views adding up |

Degree is checked at game start, before provisioning and before anything is recorded, so an
out-of-envelope topology fails while the experiment is still abandonable.

**Why three and not one.** The measurement behind the old flat cap of 16 swept *sparse* graphs
while varying n, so 16 was a number about **n** being enforced as a number about **degree** — and a
published design needing a full neighbourhood at n=20 had to override it. When that was measured
properly (`npm run bench -- --dense`), a complete graph at n=20 published *faster* than a degree-8
ring at n=50. So the per-node cap came off within the measured regime.

But the bench projected two fields, so it established that degree is cheap **at small view sizes**.
Degree × view size is what a participant's connection actually carries. `maxNeighbourhoodBytes`
went on as the cap came off: 49 views of 1.5 KiB are each well inside `maxViewBytes` and add up to
73 KiB. **Lifting a limit is only honest if you name what it was accidentally guarding.**

Also exported: `resolveEnvelope`, `defaultMaxDegree`, `DEFAULT_ENVELOPE`, `MEASURED_DENSE_N`,
`MEASURED_SPARSE_DEGREE`, `EnvelopeError`, and the `checkDegrees` / `checkViewBytes` /
`checkNeighbourhoodBytes` predicates.

## Also exported

| | |
|---|---|
| `validateProjection`, `projectionBytes`, `ProjectionError` | the projection guard, usable directly |
| `hashSeed`, `makeRng`, `randInt`, `shuffle` | seeded randomness — hang your design's own randomness off the recorded seed |
| `graphMetrics`, `historyFrames` | the pure builders behind `inspect()` |
| `provisionChannels`, `readChannels`, `resetChannels` | channel plumbing; `resetChannels` is a test seam |
| `makeViewSink`, `makeLogSink`, `makeNdjsonSink` | the NDJSON writers |
| `topology` | the whole [topology namespace](TOPOLOGIES.md) |
| `edgeRows`, `snapshotRows`, `viewRows`, `parseNdjson`, `toCSV`, `historyIsConsistent` | re-exported from `/export` — **but see the warning there** |

---

# `empirica-networks/admin/monitor`

## `monitor(net, options?)`

Serves a live view of a running study: the current graph, nodes carrying each participant's state,
ties appearing and disappearing as you rewire, and a scrubber back through the edge history. It
also shows what you cannot see from inside the experiment — publish counts, and any channel that
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

> **Read this before you expose it.** The monitor shows exactly what participants must never see:
> the complete graph, the seating plan, and every participant's private state, on one page.
>
> - **Nothing it serves enters Empirica's scope graph.** It is plain HTTP on its own port, so no
>   participant's subscription can carry it whatever your listeners do. That is structural, and
>   `test/e2e/monitor.test.ts` asserts it against the raw wire with the monitor running and reading
>   every secret.
> - **Who can open it is access control, and access control is never structural.** It binds to
>   `127.0.0.1` and requires a per-run token. Pass a different `host` and it will do as you ask,
>   and say loudly what that costs. Reach it remotely through an SSH tunnel instead.
>
> It holds **no Empirica credential** — it reads the callbacks process's own memory and serves
> JSON, with no path from the page to `setAttribute`. This matters more than it sounds: with no
> write access control anywhere in Empirica, an admin `srtoken` in a browser is not a read-only
> view with a login, it is the ability to write any attribute on any node. Do not build one.

It does not survive a server restart, because nothing does — it says the game is gone rather than
showing a stale picture as though it were live. And it is sized for n ≤ 50.

`GET /api/state` returns `{ snapshot, positions }`, where `snapshot` is `{ n, edges, order }` —
exactly `toGraphology`'s signature, so the monitor is also the shortest route into the graphology
ecosystem on a live study.

---

# `empirica-networks/player`

## `EmpiricaNetwork`

```jsx
import { EmpiricaNetwork } from "empirica-networks/player";
<EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>
```

A **superset** of `EmpiricaClassic`, composed with it rather than reimplementing it — so
`usePlayer`, `useGame`, `useStage` and the whole intro/exit flow keep working. Install it, or none
of the hooks have anything to read.

## Derivations, usable without React

Headless clients and bots need these too; the hooks are thin wrappers over them.

| | |
|---|---|
| `neighborsOf(ctx)`, `networkSelfOf(ctx)`, `networkToldOf(ctx)` | the read paths |
| `networkStateOf(ctx)` | the participant's own private state, with `set` |
| `neighborChatOf(ctx)` | chat |
| `assertNetworkMode(ctx)` | throws `NetworkModeNotInstalledError` if `modeFunc` is missing |
| `Nbhd`, `DonesWiringError` | the client-side channel scope, and the self-check |

---

# `empirica-networks/player/react`

```jsx
import { useNeighbors, useNetworkSelf, useNetworkState } from "empirica-networks/player/react";
```

| Hook | Returns | `undefined` when |
|---|---|---|
| `useNeighbors<T>()` | `T[]` — exactly what `project()` returned, in topology order | before the first publish |
| `useNetworkSelf()` | `{ playerID, degree, … }` | before the channel is provisioned |
| `useNetworkState()` | `{ get, set }` — **this participant's private state** | before the channel is provisioned |
| `useNetworkTold()` | `{ get }` — server-authored values. No `set` | before the channel is provisioned |
| `useNeighborChat()` | `{ messages, send }` | chat off, or before provisioning |
| `useNbhd()` | the raw `Nbhd` scope | before the channel is provisioned |

### Writing private state

```jsx
const state = useNetworkState();
state.set("choice", "A");    // ✓ private: this participant's own channel
player.set("choice", "A");   // ✗ BROADCAST to every participant, whatever your topology
```

This is the step that decides whether your manipulation is real. Empirica cross-links every
participant to every player node, so anything written with `player.set()` is readable by everyone,
and projecting such a value restricts nothing — the experiment runs, the screens look right, and
the network has stopped being the manipulation.

### `undefined` is not `[]`

```jsx
const neighbors = useNeighbors();
if (!neighbors) return <Loading />;    // this branch matters
```

**`useNeighbors()` returns `undefined` until the first publish, and `[]` only for a genuinely
isolated node.** The hook refuses to conflate them: a node with no neighbours is a legitimate
result, so returning `[]` while loading would render a participant as isolated, look entirely
normal, and quietly corrupt the data. Branch on it the way you already branch on `usePlayer()`.

`useNetworkSelf()` resolves earlier — `playerID` is written when the channel is provisioned — and
reports `degree: undefined` rather than `0` before the first publish, for the same reason.

TypeScript users can name the projection: `useNeighbors<{ id: string; choice: string }>()`.

---

# `empirica-networks/topology` · `/topology/graphology`

See **[TOPOLOGIES.md](TOPOLOGIES.md)** — 15 generators, 6 measures, and the graphology bridge,
with the parameters, connectivity guarantees and envelope implications of each.

---

# `empirica-networks/export`

The pure row builders: `edgeRows`, `snapshotRows`, `viewRows`, `parseNdjson`, `toCSV`,
`historyIsConsistent`. Schemas in **[DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)**.

> **Import these from `/export`, not `/admin`, in anything you run outside the Empirica CLI.** The
> functions are identical — `/admin` re-exports them — but `/admin` also pulls in
> `@empirica/core/admin`, which cannot be loaded from raw Node in either module system. An offline
> script importing from `/admin` dies on `cross-fetch/polyfill` before it runs a line.
>
> The subpath has **no runtime imports at all**, pinned by `test/unit/export_isolation.test.ts` —
> which is also why `parseNdjson` takes the file's text rather than its path: it cannot import
> `node:fs` either.

---

# `empirica-networks` (root)

Isomorphic pieces only.

| | |
|---|---|
| `NBHD_KIND`, `NBHD_KEYS`, `NETWORK_KEYS`, `GAME_KEYS` | the scope kinds and attribute keys |
| `stateKey(k)`, `toldKey(k)`, `STATE_PREFIX`, `TOLD_PREFIX`, `OUTBOX_KEY` | key construction |
| `EdgeEvent`, `ViewRecord`, `ChatMessage` | the record types |
| `waitFor`, `waitForValue`, `TimeoutError` | polling helpers, used by the tests and the harness |

`GAME_KEYS` is a named, **empty** record. Two things were kept on the game scope and both had to
move — the channel index (every participant got every channel id, which with no write ACL is the
capability needed to write into someone else's channel) and the realised network. It is kept as an
empty record so the reason survives rather than being rediscovered.

---

## See also

| | |
|---|---|
| [GETTING-STARTED](GETTING-STARTED.md) | the ordered path, if this page is the wrong altitude |
| [ARCHITECTURE](ARCHITECTURE.md) | what happens between these calls |
| [TROUBLESHOOTING](TROUBLESHOOTING.md) | when one of them does nothing |
| [`../ISSUES.md`](../ISSUES.md) | known defects in the above |
