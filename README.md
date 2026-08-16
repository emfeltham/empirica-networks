# empirica-networks

Network experiments for [Empirica](https://empirica.ly): participants are nodes in a graph,
and **each participant sees only their neighbours' state**.

Status: **M6 complete, 2026-08-16.** The mechanism works end to end and is covered by tests; two
published network experiments are reconstructed here and exercised by the same suite. The public
API is not frozen and **the package is not on npm yet** — see [Installing](#installing).

Not affiliated with, or endorsed by, the Empirica project. The name is descriptive.

| | |
|---|---|
| **New here?** | [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — install to verified guarantee, in order |
| **The API** | [`docs/API.md`](docs/API.md) — every export, with the reasoning behind each decision |
| Something is silently wrong | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — indexed by symptom, not by cause |
| How it works inside | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the lifecycle, the publish path, where every value lives |
| Choosing a structure | [`docs/TOPOLOGIES.md`](docs/TOPOLOGIES.md) — 15 generators, with their limits |
| Planning a real study | [`docs/DEPLOYING.md`](docs/DEPLOYING.md) — the pre-flight checklist, and what is not yet documented |
| Getting the data out | [`docs/DATA-AND-ANALYSIS.md`](docs/DATA-AND-ANALYSIS.md) — every column of every table |
| A real study to read | [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) — two reconstructed papers |
| Known defects | [`ISSUES.md`](ISSUES.md) — ours and upstream's |
| Everything else | [`docs/`](docs/README.md) — the documentation index |
| Why it is shaped this way | `MODULE-DESIGN.md` — the design record, kept alongside the investigation that produced it rather than in this repo |

## Read this before running a study on Empirica

**Empirica has no write access control, and this affects your study whether or not you use this
package.** Any participant who knows a node id can set any attribute on it — including on another
participant's `player` scope, whose id every participant already knows, because Classic
cross-links everyone to everyone. `protected: true` is documented as "not updatable by other
Participants" and is **not enforced**.

In practice, for a participant who opens the browser console:

- they can overwrite another participant's answers, score, or assigned condition;
- they can do it without the server logging anything unusual;
- and your server-side code cannot tell an altered value from an honest one.

What to do about it, in order:

1. **Treat every participant-written value as untrusted input**, exactly as you would a form
   field on a public website. Compute anything that matters server-side, from values you can
   attribute.
2. **Keep the record of account somewhere participants cannot write** — the batch scope. Both
   reconstructions in this repo do this for payoffs, and say so at the call site.
3. **Judge whether your design gives anyone a reason to bother.** A study where altering
   someone else's state pays — a competitive game, a bonus tied to relative performance — is
   exposed in a way a survey is not.

This module does not, and cannot, claim that a participant's state is tamper-proof. Measured in
`test/e2e/participant_write.test.ts` and `test/e2e/upstream_u1.test.ts`; mechanism in
`docs/PLATFORM-NOTES.md` §4a; tracked as `ISSUES.md` U1, which is going through private
disclosure to Empirica's maintainers (`docs/upstream/DISCLOSURE.md`).

## Installing

<a id="not-published-yet"></a>

> ### Not published yet
>
> The package is `"private": true` at `0.0.0`, deliberately: U1 above is an unpatched
> cross-participant write vulnerability affecting every Empirica study, and it is going through
> disclosure first (`PUBLICATION-PLAN.md`). Publishing an install path before that window closes
> gets the order wrong, and `private: true` is the only thing standing between a stray
> `npm publish` and an outcome that cannot be undone.
>
> Until then, install from a packed tarball. Anywhere the docs show `npx empirica-networks …`,
> that is what the command becomes once published; the from-a-clone form is given alongside where
> it matters. **This is the one place that caveat is written down** — everything else links here.

```sh
npm pack                                    # in this repo -> empirica-networks-0.0.0.tgz
npm --prefix server install /path/to/empirica-networks-0.0.0.tgz
npm --prefix client install /path/to/empirica-networks-0.0.0.tgz
```

Requires **Node 20+** and the Empirica CLI (`curl https://install.empirica.dev | sh`). Install
into **both** halves: the package ships server code and client code separately.

Do **not** use a `file:` link. npm makes it a symlink, which loads two copies of `@empirica/core`
and breaks every `instanceof` inside Empirica, with a symptom that names nothing — every
participant stuck on "Waiting for other players" with a full game
([TROUBLESHOOTING](docs/TROUBLESHOOTING.md), `docs/PLATFORM-NOTES.md` §11).

**The name is settled** (`MODULE-DESIGN.md` §13, decision 3): `empirica-networks`, unscoped,
chosen over `@yale-hnl/empirica-networks` because discovery is the binding constraint in an
ecosystem with no registry, no plugin API and no curated list. Renaming after the first publish
would be a breaking change, which is why it was decided before rather than at publish time.

## Quickstart

Three edits to a stock `empirica create` project. The first is **mandatory and silently fatal if
skipped** ([O14](ISSUES.md) — nothing checks it for you yet).

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
import { topology, withNetwork } from "empirica-networks/admin";

export const net = withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),
  project: (neighbour, viewer, ctx) => ({
    id: neighbour.id,
    choice: ctx.stateOf(neighbour).get("choice"),
  }),
  watch: ["choice"],          // project() reads it, so a change republishes
  read: ["submission"],       // only the server reads it
});
```

```jsx
// client/src/App.jsx
import { EmpiricaNetwork } from "empirica-networks/player";
<EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>

// client/src/Game.jsx
import { useNeighbors, useNetworkState } from "empirica-networks/player/react";

const neighbors = useNeighbors();          // undefined until the first publish
const state = useNetworkState();
state.set("choice", "A");                  // ✓ private. player.set() would broadcast
```

[`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) walks the same path with the trap at each
step named where it bites. [`docs/API.md`](docs/API.md) is the full surface.

## The guarantee, and its limit

**What holds.** A participant never receives a non-neighbour's projected state. Not "the UI
doesn't render it" — the bytes never arrive. Each participant has a private channel scope linked
to them alone, and projections are written only there.

**Where participants write matters.** Empirica cross-links every participant to every player
node, so anything written with `player.set(key, value)` is broadcast to **everyone**, whatever the
topology. Projecting such a value restricts nothing — the raw attribute is already out. Write with
`useNetworkState().set()`, and read on the server through `ctx.stateOf(neighbour)`.

`npm run test:browser` asserts both halves in real browsers: a non-neighbour's private value
appears nowhere in the bytes a tab received, while a player attribute does.

**The network itself is private too.** The seed and realised edge list are recorded on the *batch*
scope — the one durable scope measured not to be delivered to participants — so a finished run
stays reproducible from stored data without handing the seating plan to the people inside it. They
were briefly on the game scope, where every participant received both; that is fixed and locked by
`test/e2e/topology_visibility.test.ts`, which checks the participant's own scope *and* the raw
wire.

**What does not hold: write integrity.** Read privacy is structural; write integrity does not exist
at all, anywhere in Empirica — see [above](#read-this-before-running-a-study-on-empirica).

## Verify it yourself

The read guarantee is the whole point, so it ships as a command rather than a claim:

```sh
node dist/verify/cli.cjs verify --n 4     # from a clone today, after `npm run build`
npx empirica-networks verify --n 4        # once published
```

It boots a real Tajriba, connects four headless participants on a ring, and checks the wire:

```
  non-neighbour sentinels received : 0   (must be 0)
  neighbour sentinels delivered    : 8/8 (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)

  PASS
```

Three arms, all required. A clean result with a **silent control** means the check is blind, and a
clean result with **nothing delivered** means the projection never ran — both are reported as
failures, because most privacy tests are wrong in exactly one of those two ways.

Sentinels are high-entropy tokens held server-side and injected into projections; nothing writes
them to a scope, and matching is by substring over raw wire frames, so a leak through a channel
nobody enumerated is still caught. The CLI compiles a copy of `@empirica/core` in, because
Empirica cannot be loaded unbundled — it prints the bundled version alongside yours and warns if
they differ, rather than implying it tested yours.

## Runnable examples

Three, all in-package, each one's `callbacks.js` imported **unmodified** by a test in `test/e2e/`,
so none of them can rot unnoticed. There is deliberately no template repo;
`docs/M5-ADOPTION.md` §2 says why.

| | What it is |
|---|---|
| [`examples/minimal`](examples/minimal) | A stock `empirica create` project with four files changed. Participants on a ring pick a colour and see only their two neighbours'. Start here |
| [`examples/rand2011`](examples/rand2011) | **A reconstruction of the design in** Rand, Arbesman & Christakis (2011), *PNAS*. Cooperation in dynamic networks: rewiring during play, private decisions, four conditions |
| [`examples/shirado2017`](examples/shirado2017) | **A reconstruction of the human-only arm of** Shirado & Christakis (2017), *Nature*. Colour coordination on a scale-free network, with a global objective participants cannot see |

```sh
npm install && node scripts/example-install.mjs minimal   # or: npm run example:install, for all three
cd examples/minimal && empirica
```

Open four windows with different `?participantKey=` values. Each sees 2 of the other 3, and a
different 2.

**Reconstructions, not replications.** Both ported designs were rebuilt from their papers. No data
has been collected with them and nothing has been compared to the authors' results — see
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md).

## Supported envelope

Per-participant payload is O(d), independent of n; server egress is O(n·d).

| Regime | Status |
|---|---|
| **Any density, n ≤ 50** | Measured, including complete graphs. No degree cap by default |
| Sparse (d ≤ 16), n ≤ 150 | Measured on **this** implementation |
| Sparse, n ≥ 200 | **Games do not reliably start.** 1 run in 6 at n=200; not this package's doing (`ISSUES.md` U7) |
| Dense, n > 50 | **Unmeasured**, and capped at d ≤ 16 by default. This is where client bandwidth binds |
| Sessions beyond ~10 minutes | **Unverified.** The mechanism is not in doubt, but no multi-hour run has been observed |

The regime this was written for is **n ≤ 50**, where every figure has margin to spare.

End-to-end publish latency — a watched attribute changing, to a neighbour's client holding the new
value (`npm run bench`):

```
  n= 25  d=8  shards=2  p50    6.6ms  p95    8.1ms  max    9.4ms   (760 receipts)
  n= 50  d=8  shards=2  p50   11.6ms  p95   13.9ms  max   15.9ms   (760 receipts)
  n=100  d=8  shards=4  p50   14.3ms  p95   17.7ms  max   19.5ms   (760 receipts)
  n=150  d=8  shards=6  p50   23.7ms  p95   29.2ms  max   32.0ms   (760 receipts)
  n=200  d=8  shards=8  p50   26.7ms  p95   35.6ms  max   41.0ms   (760 receipts)
```

**Read these as upper bounds, and as single runs.** The dominant term is how many participants
share an event loop, which is an artefact of measuring hundreds of clients on one machine — real
participants in separate browsers do not. The package's own contribution is somewhere below these
numbers and this bench cannot resolve it (`ISSUES.md` O1). The dense measurements, and the
correction to the degree cap they forced, are in `docs/PLATFORM-NOTES.md` §19; the n ≥ 200
start failure is §16.

The limits are **enforced, not just documented** — an out-of-envelope topology is refused at game
start, before channels are provisioned, since Tajriba cannot unlink and a late failure would leave
links behind. The three limits, what each rests on, and how to override them:
[`docs/API.md`](docs/API.md#envelope).

## Development

```sh
npm test                # unit + mode + e2e
npm test -- unit mode   # the cheap tiers, no server needed
npm run check           # typecheck
npm run check:links     # documentation links
npm run build
```

[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) has the repo layout, the build, and how to add
things. [`docs/TESTING.md`](docs/TESTING.md) has the three tiers, what each one can and cannot
prove, and — importantly — **how to read a red run before concluding it is a regression.**

## Licence

MIT. See [LICENSE](LICENSE).
