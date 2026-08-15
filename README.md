# empirica-networks

Network experiments for [Empirica](https://empirica.ly): participants are nodes in a graph,
and **each participant sees only their neighbours' state**.

Status: **M1, in development.** The mechanism works end to end and is covered by tests, but
the public API is not stable and the package is not published.

## The guarantee, and its limit

**What holds.** A participant never receives a non-neighbour's projected state. Not "the UI
doesn't render it" — the bytes never arrive. Each participant has a private channel scope
linked to them alone, and projections are written only there.

**Where participants write matters.** Empirica cross-links every participant to every player
node, so anything written with `player.set(key, value)` is broadcast to **everyone**, whatever
the topology. Projecting such a value restricts nothing — the raw attribute is already out.

```js
// ✗ broadcast to every participant, neighbour or not
player.set("choice", "A");

// ✓ private: written to this participant's own channel
const state = useNetworkState();
state.set("choice", "A");
```

and on the server, read it through the projection context rather than off the player:

```js
project: (neighbour, viewer, ctx) => ({
  choice: ctx.stateOf(neighbour).get("choice"),   // ✓ neighbour-limited
  // choice: neighbour.get("choice")              // ✗ was already public
})
```

`npm run test:browser` asserts both halves in real browsers: a non-neighbour's private value
appears nowhere in the bytes a tab received, while a player attribute does. Mechanism in
`docs/PLATFORM-NOTES.md` §4b.

**The network itself is private too.** The seed and realised edge list are recorded on the
*batch* scope — the one durable scope measured not to be delivered to participants — so a
finished run stays reproducible from stored data without handing the seating plan to the people
inside it. Read them with `readNetwork(game)` / `readSeed(game)`.

They were briefly on the game scope, where every participant received both; that is fixed and
locked by `test/e2e/topology_visibility.test.ts`, which checks the participant's own scope *and*
the raw wire. `docs/PLATFORM-NOTES.md` §4c has the measurement.

**What does not hold: write integrity.** Empirica has no write access control. Any
participant that knows a node id can set attributes on it, and `protected: true` does not
prevent this — including on another participant's `player` scope, whose id every participant
already knows. So:

- server-side code must treat participant-written values as **untrusted input**
- this module does not, and cannot, claim that a participant's state is tamper-proof

That is an Empirica-wide property, not something this module introduces. Measured in
`test/e2e/participant_write.test.ts`; details in `docs/PLATFORM-NOTES.md` §4a.

## Verify it yourself

The read guarantee is the whole point, so it ships as a command rather than a claim:

```sh
npx empirica-networks verify --n 4
```

Requires the Empirica CLI on PATH (`curl https://install.empirica.dev | sh`). It boots a real
Tajriba, connects four headless participants on a ring, and checks the wire:

```
  non-neighbour sentinels received : 0   (must be 0)
  neighbour sentinels delivered    : 8/8 (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)

  PASS
```

Three arms, all required. A clean result with a **silent control** means the check is blind,
and a clean result with **nothing delivered** means the projection never ran — both are
reported as failures, because most privacy tests are wrong in exactly one of those two ways.

Sentinels are high-entropy tokens held server-side and injected into projections; nothing
writes them to a scope, and matching is done by substring over raw wire frames, so a leak
through a channel nobody enumerated is still caught.

Note: the CLI compiles a copy of `@empirica/core` in, because Empirica cannot be loaded
unbundled (`docs/PLATFORM-NOTES.md` §3a). It prints the bundled version alongside your
installed one and warns if they differ, rather than implying it tested yours.

## A runnable example

[`examples/minimal`](examples/minimal) is a stock `empirica create` project with four files
changed — participants on a ring pick a colour and see only their two neighbours':

```sh
npm install && npm run build
cd examples/minimal && empirica
```

Open four windows with different `?participantKey=` values. Each sees 2 of the other 3, and a
different 2. Its `callbacks.js` is imported unmodified by `test/e2e/example.test.ts`, so the
server half is covered by this repo's suite rather than left to rot.

## Usage

Registering the scope kind is **mandatory** and silently fatal if skipped:

```diff
  // server/src/index.js
- import { Classic, classicKinds, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { Classic, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { networkKinds } from "empirica-networks/admin";

  const ctx = await AdminContext.init(
    argv["url"], argv["sessionTokenPath"], "callbacks", argv["token"], {},
-   classicKinds
+   networkKinds
  );
```

```js
// server/src/callbacks.js
import { withNetwork, topology } from "empirica-networks/admin";

withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),
  project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
  watch: ["choice"],   // republish neighbours when this changes
});
```

### Keeping views live

`watch` lists the player attributes your projection depends on. When one changes, the
participants who can see it get a new view — and only they: a change is republished to the
changed player's neighbours, not broadcast. Views that come out byte-identical are not
rewritten at all, so a quiet network costs nothing.

Empirica has no wildcard attribute listener, so this list can't be inferred. That would
normally make it a footgun — forget `"score"` and neighbours never see scores change, with
nothing to indicate it. So `project()` runs against a recording proxy, and anything it reads
that isn't watched is reported once, with the corrected list ready to paste:

```
empirica-networks: project() reads player attribute(s) "score" that are not in
`watch`, so neighbours will NOT see them change.
    withNetwork(Empirica, { watch: ["choice", "score"], ... })
  If they are set once and never change, this is safe to ignore.
```

Leave `watch` empty for a static network whose projection never changes.

```jsx
// client/src/App.jsx
import { EmpiricaNetwork } from "empirica-networks/player";
<EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>
```

`EmpiricaNetwork` is a superset of `EmpiricaClassic`, so `usePlayer`, `useGame`, `useStage`
and friends keep working.

```jsx
// client/src/Neighbors.jsx
import { useNeighbors, useNetworkSelf } from "empirica-networks/player/react";

export function Neighbors() {
  const neighbors = useNeighbors();      // exactly what project() returned
  const { degree } = useNetworkSelf();

  if (!neighbors) return <Loading />;    // see below — this branch matters
  return <ul>{neighbors.map((n) => <li key={n.id}>{n.choice}</li>)}</ul>;
}
```

TypeScript users can name the projection: `useNeighbors<{ id: string; choice: string }>()`.

**`useNeighbors()` returns `undefined` until the first publish, and `[]` only for a genuinely
isolated node.** Those two are not the same and the hook refuses to conflate them: a node with
no neighbours is a legitimate result, so returning `[]` while loading would render a
participant as isolated, look entirely normal, and quietly corrupt the data. Branch on it the
same way you already branch on `usePlayer()`.

`useNetworkSelf()` resolves earlier — `playerID` is written when the channel is provisioned —
and reports `degree: undefined` rather than `0` before the first publish, for the same reason.

## `project()` is the only path to a client

Whatever it returns is what gets published, so it is validated before anything is
written — a publish is one batched RPC, and a rejected projection means nothing is sent
at all rather than some participants getting a partial view.

The check that matters most: **returning a scope is refused.**

```js
project: (neighbour) => neighbour            // ✗ throws
project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get("choice") })  // ✓
```

The first line is the natural thing to write if you read `project()` as a filter rather
than a serialiser. An Empirica scope holds a reference to the *global* attribute store, so
publishing one would ship every attribute of every participant to that client — the exact
leak this module exists to prevent, arriving through the one path we cannot lock down,
because you choose what goes in it. Cycles, `BigInt`, functions, `Map`/`Set` and `NaN` are
refused too, each naming the offending field: `the projection at a.b[0] is ...`.

## Topologies

```js
import { topology } from "empirica-networks/admin";

// regular
topology.ring(n, { rng })                     // degree 2
topology.ringLattice(n, m, { rng })           // degree 2m
topology.grid(w, h, { rng })                  // degree 2–4; n = w*h
topology.grid(w, h, { periodic: true })       // a torus: degree 4 everywhere
topology.ladder(n, { rng })                   // 2n nodes, degree 2–3
topology.complete(n)                          // degree n-1 — exceeds the envelope

// centralised
topology.star(n, { rng })                     // hub degree n-1, spokes 1
topology.wheel(n, { rng })                    // hub degree n-1, rim 3

// random
topology.wattsStrogatz(n, k, beta, { rng })   // small world: lattice, rewired
topology.barabasiAlbert(n, m, { rng })        // scale-free, hubs emerge
topology.erdosRenyi(n, p, { rng })            // G(n, p)
topology.geometricRandom(n, radius, { rng })  // spatial, naturally clustered

// controls and arbitrary graphs
topology.pairs(n, { rng })                    // disjoint dyads; degree 1
topology.empty()                              // no edges
topology.fromEdgeList(n, edges)               // normalise your own

// measures
topology.adjacency(n, edges)                  // neighbour lists
topology.degrees(n, edges)
topology.meanDegree(n, edges)
topology.maxDegree(n, edges)
topology.components(n, edges)                 // partition into components
topology.isConnected(n, edges)
```

Or supply your own — `topology` returns a plain edge list:

```js
withNetwork(Empirica, { topology: ({ playerCount }) => myEdges(playerCount) });
```

**Three of Breadboard's sixteen are deliberately absent.** `smallWorld` is the same
construction as `wattsStrogatz`; `lattice` is `grid(w, h, { periodic: true })`; and
`smallWorldColoring` could not be reconstructed from its name with enough confidence to be
worth guessing at a generator that decides who is adjacent to whom.

**Some of these can hand you a disconnected graph, and none of them quietly fixes it.**
`erdosRenyi` and `geometricRandom` below their percolation thresholds, and `wattsStrogatz`
through rewiring, all produce isolated nodes at some parameters. Resampling until connected
would silently change the distribution you are sampling from, so `isConnected(n, edges)` is
offered instead and the choice stays yours.

Degenerate parameters are refused rather than quietly producing something that isn't what it
claims — `ring(2)` throws instead of returning a two-node "ring" of degree 1, and `pairs(7)`
throws rather than stranding one participant.

## Rewiring during play

Ties can be added and dropped while a game runs — the capability that motivated this package.

```js
import { network } from "empirica-networks/admin";

Empirica.onStageStart(({ stage }) => {
  const net = network(stage.currentGame);

  net.neighbors(playerID);        // -> player ids
  net.degree(playerID);
  net.hasEdge(a, b);
  net.edges();                    // -> [playerID, playerID][]

  net.addEdge(a, b);              // returns false if the tie already existed
  net.removeEdge(a, b);
  net.rewire(newEdges);           // replace the whole graph

  net.history();                  // every mutation so far
});
```

Everything takes and returns **player ids**, never topology indices. Indices are an internal
representation, and asking experiment code to translate is how off-by-one errors get written.

**Mutate only from inside a listener.** The runloop flushes the writes made while it is
processing a callback; a mutation driven from a timer, an HTTP handler or a test updates the
server's own state correctly and then reaches nobody, with no error. Reads are safe anywhere.

No unlinking is involved, which matters because Tajriba does not support it. The link grants a
persistent private *channel*; dropping a tie simply means that neighbour is absent from the
next view written there.

Both the current edge list and an append-only mutation log are recorded on the batch scope.
Two records rather than one, because a snapshot cannot answer "how did it get here" — and for
a rewiring study the sequence is the independent variable.

## Neighbour-scoped chat

Off by default. `chat: true` in `withNetwork(...)` turns it on.

```jsx
import { useNeighborChat } from "empirica-networks/player/react";

const chat = useNeighborChat();
chat?.messages.map((m) => <li key={`${m.from}-${m.seq}`}>{m.text}</li>);
chat?.send("hello");
```

A message goes to whoever is the sender's neighbour **at that moment**, plus the sender. Same
channel as everything else, different key — no second privacy path, which is the point.
`npm test` asserts at the wire that a non-neighbour's traffic never contains the text.

Sending and receiving take different routes on purpose. A participant can only write to their
own channel, so `send` writes to an outbox there and the server fans out. Writing straight into
a neighbour's channel would work — nothing prevents it (`docs/PLATFORM-NOTES.md` §4a) — and
would be building on the absence of write access control.

**Messages land on the recipient's channel**, which decides what a rewire does: dropping a tie
stops new messages without erasing the conversation already delivered. That was left open in
the design as a research-design call; storing per-recipient answers it structurally rather than
by policy. It also keeps chat out of `project()`'s output, so message volume never counts
against `maxViewBytes`.

Retention is capped at 200 messages per participant (`chat: { history: 500 }` to change it),
because the log is server memory and wire payload both.

## Exporting the network

```js
import { network, edgeRows, snapshotRows, toCSV } from "empirica-networks/admin";

const history = network(game).history();
toCSV(edgeRows(game.id, history));      // game_id, t, event, player_a, player_b
toCSV(snapshotRows(game.id, history));  // game_id, t, size, edges
```

`edges.csv` is the `connected`/`disconnected` sequence Breadboard produced, so existing
analysis ports with little change — and it **includes the initial graph**, so a study that
never rewires still exports its network rather than an empty file.

Snapshots are replayed from the events rather than stored separately, so they cannot disagree
with the log they summarise. `historyIsConsistent(history)` checks the recorded edge counts
against that replay.

These take a game id and an event log, not Empirica objects, so the same functions run offline
over data collected months ago.

### Reproducible by default

Every generator taking randomness takes a seeded RNG, and `withNetwork` records the seed and
the realised edge list on the game scope. **The seed alone regenerates the graph participants
were actually placed in.**

This is a real gap in Breadboard, not a refinement: it used an unseeded generator, so a
finished run stored the generator and its parameters but not the graph — and for a network
experiment the realised graph is often the independent variable. Verified end to end in
`test/e2e/reproducibility.test.ts`, which checks the recorded seed, the recorded edge list,
and the neighbourhoods that reached clients all agree.

Pass `seed` explicitly to pin a condition across sessions; otherwise it is derived from the
game id.

**Once you rewire, the seed no longer describes the realised network** — it regenerates the
graph as it stood at game start. The recorded edge list plus `network(game).history()` are the
ground truth from then on, which is why both are stored.

### Analysis and rendering, via graphology

Topologies are plain edge lists, which is what gets recorded and exported — but for measuring or
drawing a network you probably want [graphology](https://graphology.github.io) and its ecosystem
(`graphology-metrics`, `-components`, `-shortest-path`, `-communities-louvain`, GEXF export for
Gephi, and sigma.js). There is an adapter:

```js
import { UndirectedGraph } from "graphology";
import { density } from "graphology-metrics/graph/index.js";
import { toGraphology, fromGraphology } from "empirica-networks/topology/graphology";

const g = toGraphology(UndirectedGraph, n, edges, { order });  // order = playerIDs by position
density(g);
g.neighbors("player-3");

fromGraphology(g);  // -> { n, edges, order }, back to this package's representation
```

**graphology is not a dependency of this package** — not even an optional one. The constructor
is injected (graphology's own convention for its generators), so nothing here imports it at
runtime and the subpath loads fine without it installed. Bring your own copy, and your
`instanceof` checks and graphology-\* helpers will all agree with the graph you get back.

Nodes are keyed by `order[i]` when you pass one, and every node carries a `topologyIndex`
attribute so structural position survives the round trip — this package keeps position and
identity separate on purpose, and labelling by playerID alone would lose that.

Two things worth knowing before you trust a number:

- **Pass `UndirectedGraph`, not `Graph`.** graphology's default is a *mixed* graph, whose ratio
  metrics count directed slots this module never fills. `toGraphology(Graph, 12, complete(12))`
  reports a density of `0.333`; `UndirectedGraph` reports `1.000`. Same 66 edges — nothing
  errors, the number is just wrong.
- `graphology-metrics` ships no `exports` map, so under plain Node ESM you need the explicit
  `graphology-metrics/graph/index.js`, not the bare directory. Bundlers resolve either.

`toGraphology` builds from `adjacency()`, so the graph you measure or render is by construction
the one participants are actually in. `DirectedGraph` is refused: a one-way tie is not something
the projection can deliver.

## Supported envelope

Per-participant payload is O(d), independent of n; server egress is O(n·d).

| Regime | Status |
|---|---|
| Sparse (d ≤ 16), n ≤ 150 | Measured on **this** implementation — see below |
| Sparse, n ≥ 200 | **Games do not reliably start.** 1 run in 6 at n=200; not this package's doing, see below |
| Dense / complete | **Unsupported** — fails on client bandwidth regardless of server speed |

`npm run bench` measures end-to-end publish latency — a watched attribute changing, to a
neighbour's client holding the new value. Participants run in child processes, and receipts are
taken on the client's own flush:

```
  n= 25  d=8  shards=2  p50    6.6ms  p95    8.1ms  max    9.4ms   (760 receipts)
  n= 50  d=8  shards=2  p50   11.6ms  p95   13.9ms  max   15.9ms   (760 receipts)
  n=100  d=8  shards=4  p50   14.3ms  p95   17.7ms  max   19.5ms   (760 receipts)
  n=150  d=8  shards=6  p50   23.7ms  p95   29.2ms  max   32.0ms   (760 receipts)
  n=200  d=8  shards=8  p50   26.7ms  p95   35.6ms  max   41.0ms   (760 receipts)
```

Every round's delivery is counted at every recipient, so the tail is the slowest neighbour
rather than an average one, and `delivered/expected` is reported alongside: no run above lost a
single receipt once its game started.

**Read these as an upper bound.** Sweeping participants-per-process at n=100 moved p50 from
43.1ms to 10.1ms to 8.0ms as the slice went 50 → 25 → 13, and n=50 in *one* process (36.2ms)
was slower than n=100 across *four* (10.1ms). The dominant term is how many participants share
an event loop — an artefact of measuring hundreds of clients on one machine, which real
participants in separate browsers do not do. The package's own contribution is somewhere below
these numbers; this bench cannot resolve it.

**n ≥ 200 is where games stop starting reliably** — 1 of 6 runs at n=200 against 5/5 at n=100
and 3/3 at n=150. The failure is a malformed websocket close frame during Empirica's O(n²)
game-start burst, it reproduces with stock Classic and no `withNetwork` registered at all, and
the server logs nothing. Detail and reproduction: `docs/PLATFORM-NOTES.md` §16. Once a game
starts, n=200 runs fine — the table row is about *starting*, not about steady state.

Two earlier claims here were wrong and are replaced rather than carried forward. "Verified: ~1×
the theoretical floor" was inherited from the spike, a different codebase measured before
projection, validation, the recording proxy and the private state path existed. The figures that
replaced it (`p50 52.4ms`, praised for a "very tight" distribution) were an artefact of the
bench's own 25ms polling: measured side by side on the same rounds, polled p50 52.4ms against a
true 33.3ms, with 49 of 55 samples on one bin edge. The bench no longer polls.

Each line above is still a single run, where `SPIKE-REPORT.md` §5–6 asks for three with fresh
servers before a number is published.

This is enforced, not just documented. A topology with degree > 16 is refused at game
start — *before* channels are provisioned, since Tajriba cannot unlink and a late failure
would leave links behind:

```js
withNetwork(Empirica, {
  topology: ...,
  envelope: {
    maxDegree: 16,        // measured (SPIKE-REPORT §4)
    maxViewBytes: 8192,   // NOT measured — a mistake detector, see below
    onExceed: "throw",    // "warn" to proceed anyway
  },
});
```

The two limits rest on different evidence and the error messages say so. `maxDegree` comes
from measurement. `maxViewBytes` does not: it is there because a single neighbour view over
8 KiB almost always means `project()` returned more than intended. Raise it freely if your
projection is genuinely that large.

## Development

```sh
npm test          # unit (fast) + mode (synthetic provider) + e2e (real Tajriba)
npm run check
npm run build
```

Requires **Node 20** and the Empirica CLI. e2e tests are bundled before running, because the
published `@empirica/core` cannot be loaded from raw Node in either module system — see
`docs/PLATFORM-NOTES.md`, which records every platform constraint with the date and versions
it was measured against.
