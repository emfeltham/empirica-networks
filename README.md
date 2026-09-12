# empirica-networks

Network experiments for [Empirica](https://empirica.ly): participants are nodes in a graph, and each participant sees only the state of their neighbours.

The package runs real games today but is not yet published. All three examples in this repository play end to end against a real Empirica server, and the read-privacy guarantee they depend on is enforced and tested, not merely documented; see [Runnable examples](#runnable-examples) and [Verifying the guarantee](#verifying-the-guarantee). What does not yet hold is the public API, which remains unfrozen, and the package is kept at `private: true`, version `0.0.0`, pending disclosure of an unpatched upstream vulnerability to Empirica's maintainers (`NEXT_STEPS.md` §1); see [Installation](#installation). Development is tracked by milestone: [M7](CHANGELOG.md#unreleased) is the latest, complete as of 2026-08-16, and `NEXT_STEPS.md` describes what remains.

This project is not affiliated with, or endorsed by, the Empirica project.

| | |
|---|---|
| New here | [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — install to verified guarantee, in order |
| The API | [`docs/API.md`](docs/API.md) — every export, with the reasoning behind each decision |
| Something is silently wrong | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — indexed by symptom, not by cause |
| How it works inside | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the lifecycle, the publish path, where every value lives |
| Choosing a structure | [`docs/TOPOLOGIES.md`](docs/TOPOLOGIES.md) — 14 generators, with their limits |
| Planning a real study | [`docs/DEPLOYING.md`](docs/DEPLOYING.md) — the pre-flight checklist, and what is not yet documented |
| Getting the data out | [`docs/DATA-AND-ANALYSIS.md`](docs/DATA-AND-ANALYSIS.md) — every column of every table |
| A real study to read | [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) — two reconstructed papers |
| Known defects | [`ISSUES.md`](ISSUES.md) — ours and upstream's |
| What is left to do | [`NEXT_STEPS.md`](NEXT_STEPS.md) — the route to a first release, the open defects, and what is deliberately not scheduled |
| Artificial participants | [`docs/BOTS.md`](docs/BOTS.md) — the policy interface, placement, and why a bot's name is participant-visible |
| Everything else | [`docs/`](docs/README.md) — the documentation index |

## Before running a study

Empirica has no write access control, and this affects a study whether or not it uses this package. Any participant who knows a node id can set any attribute on it, including on another participant's `player` scope, whose id every participant already knows, because Classic cross-links everyone to everyone. `protected: true` is documented as "not updatable by other Participants," but this is not enforced.

In practice, for a participant who opens the browser console:

- they can overwrite another participant's answers, score, or assigned condition;
- they can do it without the server logging anything unusual;
- and your server-side code cannot tell an altered value from an honest one.

What to do about it, in order:

1. Treat every participant-written value as untrusted input, exactly as you would a form field on a public website. Compute anything that matters server-side, from values you can attribute.
2. Keep the record of account somewhere participants cannot write — the batch scope. Both reconstructions in this repository do this for payoffs, and say so at the call site.
3. Judge whether your design gives anyone a reason to bother. A study where altering someone else's state pays — a competitive game, a bonus tied to relative performance — is exposed in a way a survey is not.

This module does not, and cannot, claim that a participant's state is tamper-proof. This is measured in `test/e2e/participant_write.test.ts` and `test/e2e/upstream_u1.test.ts`, with the mechanism described in `docs/PLATFORM-NOTES.md` §4a and tracked as `ISSUES.md` U1, which is going through private disclosure to Empirica's maintainers (`docs/upstream/DISCLOSURE.md`).

Every participant also learns every co-player's recruitment identifier. The root cause is the same: Classic cross-links everyone to every player scope, so the value of `?participantKey=` is delivered to everyone else in the game. If that key is a recruitment-platform participant ID, a Prolific PID for instance, subjects are handed each other's identifiers, and such identifiers are stable across studies. Make `participantKey` an opaque per-study token and keep the mapping outside Empirica. This is measured in `test/e2e/bots.test.ts`; see also `docs/PLATFORM-NOTES.md` §22 and `ISSUES.md` U10.

## Installation

<a id="not-published-yet"></a>

> ### Not published yet
>
> The package is `"private": true` at `0.0.0`, deliberately: U1 above is an unpatched
> cross-participant write vulnerability affecting every Empirica study, and it is going through
> disclosure first (`NEXT_STEPS.md` §1.1). Publishing an install path before that window closes
> gets the order wrong, and `private: true` is the only thing standing between a stray
> `npm publish` and an outcome that cannot be undone.
>
> Until then, install from a packed tarball. Anywhere the docs show `npx empirica-networks …`,
> that is what the command becomes once published; the from-a-clone form is given alongside where
> it matters. This is the one place that caveat is written down; everything else links here.

```sh
npm pack                                    # in this repo -> empirica-networks-0.0.0.tgz
npm --prefix server install /path/to/empirica-networks-0.0.0.tgz
npm --prefix client install /path/to/empirica-networks-0.0.0.tgz
```

Requires Node 20+ and the Empirica CLI (`curl https://install.empirica.dev | sh`). Install into both halves, since the package ships server code and client code separately.

Do not use a `file:` link. npm turns it into a symbolic link, which loads two copies of `@empirica/core` and breaks every `instanceof` inside Empirica. The resulting symptom names nothing in particular: every participant is stuck on "Waiting for other players" with a full game (see [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) and `docs/PLATFORM-NOTES.md` §11).

The name is settled as `empirica-networks`, unscoped, chosen over `@yale-hnl/empirica-networks` because discovery is the binding constraint in an ecosystem with no registry, no plugin API, and no curated list. Renaming after the first publish would be a breaking change, which is why the decision was made before publication rather than at it (the API freeze, `NEXT_STEPS.md` §1.2).

## Quick start

Three edits to a stock `empirica create` project. The first is mandatory, and skipping it is silently fatal in itself: nothing errors, and participants are left with empty neighbourhoods indefinitely. The package checks for this omission, since `assertKindsRegistered(networkKinds)` fails before the server starts; failing that, an automatic check warns a few seconds into the first game.

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
state.set("choice", "A");                  // private. player.set() would broadcast
```

[`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) walks the same path with the trap at each
step named where it bites. [`docs/API.md`](docs/API.md) is the full surface.

## The guarantee and its limit

What holds is that a participant never receives a non-neighbour's projected state: the bytes
themselves never arrive, rather than merely being hidden by the interface. Each participant has a
private channel scope linked to them alone, and projections are written only there.

Where participants write also matters. Empirica cross-links every participant to every player
node, so anything written with `player.set(key, value)` is broadcast to everyone, regardless of
topology. Projecting such a value restricts nothing, since the raw attribute is already out. Write
with `useNetworkState().set()`, and read on the server through `ctx.stateOf(neighbour)`.

`npm run test:browser` asserts both halves in real browsers: a non-neighbour's private value
appears nowhere in the bytes a tab received, while a player attribute does.

The network itself is private too. The seed and realised edge list are recorded on the batch
scope, the one durable scope measured not to be delivered to participants, so that a finished run
stays reproducible from stored data without handing the seating plan to the people inside it. The
game scope would be the obvious place to keep them, but doing so would deliver both to every
participant; this is prevented by `test/e2e/topology_visibility.test.ts`, which checks both the
participant's own scope and the raw wire.

Write integrity, however, does not hold. Read privacy is structural, but write integrity does not
exist at all in Empirica; see [above](#before-running-a-study).

## Verifying the guarantee

The read guarantee is the whole point, so it ships as a command rather than a claim:

```sh
node dist/verify/cli.cjs verify --n 4     # from a clone today, after `npm run build`
npx empirica-networks verify --n 4        # once published
```

It boots a real Tajriba, connects four headless participants on a ring by default (`--topology` takes `star`, `wheel`, `pairs` or `ladder` too), and checks the wire:

```
  non-neighbour sentinels received : 0/4 pairs  (must be 0)
  neighbour sentinels delivered    : 8/8  (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)

  PASS
```

Three arms, all required. A clean result with a silent control means the check is blind, and a
clean result with nothing delivered means the projection never ran; both are reported as
failures, because most privacy tests are wrong in exactly one of those two ways.

Sentinels are high-entropy tokens held server-side and injected into projections; nothing writes
them to a scope, and matching is by substring over raw wire frames, so a leak through a channel
nobody enumerated is still caught. The CLI compiles a copy of `@empirica/core` in, because
Empirica cannot be loaded unbundled — it prints the bundled version alongside yours and warns if
they differ, rather than implying it tested yours.

It needs the Empirica CLI on PATH, boots its server in a temporary directory, and exits non-zero
on a failure or on a run that could not start. Options and exit codes are documented in
[`docs/API.md`](docs/API.md#the-verify-cli).

## Runnable examples

Three, all in-package, each one's `callbacks.js` imported unmodified by a test in `test/e2e/`,
so that none of them can rot unnoticed. There is deliberately no template repository;
`docs/M5-ADOPTION.md` §2 explains why.

| | What it is |
|---|---|
| [`examples/minimal`](examples/minimal) | A stock `empirica create` project with four files changed. Participants on a ring pick a colour and see only their two neighbours'. Start here |
| [`examples/rand2011`](examples/rand2011) | A reconstruction of the design in Rand, Arbesman & Christakis (2011), *PNAS*. Cooperation in dynamic networks: rewiring during play, private decisions, four conditions |
| [`examples/shirado2017`](examples/shirado2017) | A reconstruction of Shirado & Christakis (2017), *Nature*. Colour coordination on a scale-free network, with a global objective participants cannot see — both the control arm and the paper's autonomous-agent conditions |

```sh
npm install && node scripts/example-install.mjs minimal   # or: npm run example:install, for all three
cd examples/minimal && empirica
```

Open four windows with different `?participantKey=` values. Each sees 2 of the other 3, and a
different 2.

These are reconstructions, not replications: both designs were rebuilt from their papers, no data
has been collected with them, and nothing has been compared against the authors' results; see
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md).

## Bots

Empirica v2 ships no artificial-player facility of any kind. Version 1 had them, so assuming they
still exist is a natural mistake to make (`docs/PLATFORM-NOTES.md` §17). `empirica-networks/bots`
is one, built the only way the platform allows: a headless participant process, indistinguishable
from a browser at the wire.

```js
// bots.mjs — plain `node bots.mjs`, no bundler
import { runBots } from "empirica-networks/bots";

await runBots({
  url: "http://localhost:3000/query",
  identifiers: process.env.BOT_KEYS.split(","),
  policy: {
    tickMs: 1500,
    onTick(ctx) {
      const neighbours = ctx.neighbors();          // undefined until the first publish
      if (neighbours === undefined) return;
      ctx.state().set("choice", decide(neighbours, ctx.rng));
    },
  },
});
```

A bot reads through the same `project()` and writes to the same private channel a human does.
There is deliberately no server-side path: a bot that could see the graph or a non-neighbour would
turn any comparison against humans into a comparison of access rather than of behaviour.

Three things are worth knowing before using it, each the subject of a section in
[`docs/BOTS.md`](docs/BOTS.md):

- Recruit `playerCount − botCount` humans. The treatment's count is the size of the network,
  bots included, and getting it wrong produces a study that never starts, so the runner names the
  discrepancy.
- Placement is a manipulation, and it goes through `topology({ players })`, where `players[i]`
  is whoever will occupy index `i`. Relabel the graph rather than reordering people, since that is
  what keeps the degree distribution identical across arms.
- A bot's name is participant-visible (U10 above), so `runBots` takes an identifier list
  rather than inventing one, and the server should recognise its bots by holding that list.

`examples/shirado2017` is the worked case: 3 agents × 3 noise levels × 3 placements, which is the
contribution of the paper it reconstructs.

## Supported environment

Per-participant payload is O(d), independent of n; server egress is O(n·d).

| Regime | Status |
|---|---|
| Any density, n ≤ 50 | Measured, including complete graphs. No degree cap by default |
| Sparse (d ≤ 16), n ≤ 150 | Measured on this implementation |
| Sparse, n ≥ 200 | Games do not reliably start: 1 run in 6 at n=200, and not this package's doing (`ISSUES.md` U7) |
| Dense, n > 50 | Unmeasured, and capped at d ≤ 16 by default. This is where client bandwidth binds |
| Sessions beyond ~10 minutes | Unverified. The mechanism is not in doubt, but no multi-hour run has been observed |

The regime this package was written for is n ≤ 50, where every figure has margin to spare.

End-to-end publish latency, from a watched attribute changing to a neighbour's client holding the
new value (`npm run bench`):

Each figure is the median of three runs, each against a fresh server, with the observed range
beside it (`npm run bench -- --repeats 3`, 2026-08-16):

```
  n= 25  d=8  p50 median 18.3ms   (17.7–18.5 across 3 runs)
  n= 50  d=8  p50 median  8.6ms   ( 8.6–28.7 across 3 runs)
  n=100  d=8  p50 median 12.7ms   (10.9–31.7 across 3 runs)
  n=150  d=8  p50 median 25.1ms   (14.3–29.9 across 3 runs)
  n=200  d=8  p50 median 26.8ms   (one run in three completed — see U7)
```

The scale matters here more than any single value, and n barely predicts the result. Those ranges
are not noise around a true figure: the same n=25 cell measured anywhere from 3.3 to 18.3 ms across
one afternoon, while repeats within any sweep agreed to under 17%. The cause is the measuring
machine rather than the package: a busier host measures faster, non-monotonically, because an
idle laptop clocks its cores down (`docs/PLATFORM-NOTES.md` §21 finds that the coordinator burns
57% more CPU time for identical work when the machine is quiet). Repeats buy precision, not
accuracy, so any single figure here should be treated as an order of magnitude. Comparisons made
within one sweep, such as the payload table below, remain sound, because both arms see the same
clock.

The dominant term is how many participants share an event loop, which is an artefact of measuring
hundreds of clients on one machine; real participants in separate browsers do not. The package's
own contribution is somewhere below these numbers, and this bench cannot resolve it (`ISSUES.md`
O1). The n ≥ 200 start failure is discussed in §16; the degree-cap correction, in §19.

The following measurements show what a large per-neighbour payload costs, paired inside one sweep
so that the offset cancels (§21):

```
  n=20  d=19   2 fields  →  1.4KiB per publish   p50 11.5ms
  n=20  d=19  +1KiB/view →  20.6KiB              p50 21.4ms
  n=50  d=49   2 fields  →  3.7KiB               p50 22.8ms
  n=50  d=49  +1KiB/view →  53.1KiB              p50 67.0ms   ← just under maxNeighbourhoodBytes
```

Nothing was dropped at any size, so the 64 KiB default behaves as a slope rather than a cliff: a
design sitting against it delivers around 67 ms rather than 10–25 ms.

The limits are enforced, not just documented: an out-of-envelope topology is refused at game
start, before channels are provisioned, since Tajriba cannot unlink and a late failure would leave
links behind. The three limits, what each rests on, and how to override them are documented in
[`docs/API.md`](docs/API.md#envelope).

## Development

```sh
npm test                # unit + mode + e2e
npm test -- unit mode   # the cheap tiers, no server needed
npm run check           # typecheck
npm run check:links     # documentation links
npm run build
```

[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) has the repository layout, the build, and how to add
things. [`docs/TESTING.md`](docs/TESTING.md) has the three tiers, what each one can and cannot
prove, and, importantly, how to read a red run before concluding that it is a regression.

## Licence

MIT. See [LICENSE](LICENSE).
