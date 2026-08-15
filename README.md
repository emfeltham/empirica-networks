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

topology.ring(n, { rng })            // degree 2
topology.ringLattice(n, m, { rng })  // degree 2m
topology.complete(n)                 // degree n-1 — exceeds the envelope, see below
topology.empty()                     // no edges; a control condition

topology.adjacency(n, edges)         // neighbour lists
topology.degrees(n, edges)
topology.meanDegree(n, edges)
topology.maxDegree(n, edges)
```

Twelve more (`wattsStrogatz`, `barabasiAlbert`, `erdosRenyi`, `star`, `grid`, …) are deferred
to M2. `topology` takes a plain edge list, so you can supply your own meanwhile:

```js
withNetwork(Empirica, { topology: ({ playerCount }) => myEdges(playerCount) });
```

Degenerate parameters are refused rather than quietly producing something that isn't what it
claims — `ring(2)` throws instead of returning a two-node "ring" of degree 1.

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

## Supported envelope

Per-participant payload is O(d), independent of n; server egress is O(n·d).

| Regime | Status |
|---|---|
| Sparse (d ≤ 16), n ≤ 100 | Measured on **this** implementation — see below |
| Sparse, n up to 500 | Bandwidth fine analytically; **latency unverified** |
| Dense / complete | **Unsupported** — fails on client bandwidth regardless of server speed |

`npm run bench` measures end-to-end publish latency — a watched attribute changing, to the
neighbour's client holding the new value:

```
  n= 25  d=8  p50   52.4ms  p95   53.3ms  max   53.4ms   (95 samples)
  n= 50  d=8  p50   52.4ms  p95   53.2ms  max   54.0ms   (95 samples)
  n=100  d=8  p50   77.5ms  p95   78.9ms  max   79.2ms   (95 samples)
```

The distribution is very tight, which is the interesting part: latency here is quantised by a
scheduling interval rather than by anything proportional to the work, so the cost this package
adds on top of the transport does not show up at these sizes.

**Two caveats, and they matter.** Every participant in the bench runs in one Node process
sharing one event loop, which real participants in separate browsers do not; and the numbers
above are one run, where `SPIKE-REPORT.md` §5–6 asks for three repetitions with fresh servers
before any number is published. Read p50 as indicative rather than as a benchmark.

The earlier "Verified: ~1× the theoretical floor" was inherited from the spike — a different
codebase, measured before projection, validation, the recording proxy and the private state
path existed. It is replaced above rather than carried forward.

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
