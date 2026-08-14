# empirica-networks

Network experiments for [Empirica](https://empirica.ly): participants are nodes in a graph,
and **each participant sees only their neighbours' state**.

Status: **M1, in development.** The mechanism works end to end and is covered by tests, but
the public API is not stable and the package is not published.

## The guarantee, and its limit

**What holds.** A participant never receives a non-neighbour's projected state. Not "the UI
doesn't render it" — the bytes never arrive. Each participant has a private channel scope
linked to them alone, and projections are written only there.

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

## Supported envelope

Per-participant payload is O(d), independent of n; server egress is O(n·d).

| Regime | Status |
|---|---|
| Sparse (d ≤ 16), n ≤ 100 | Verified: ~1× the theoretical floor |
| Sparse, n up to 500 | Bandwidth fine analytically; **latency unverified** |
| Dense / complete | **Unsupported** — fails on client bandwidth regardless of server speed |

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
