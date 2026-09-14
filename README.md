# empirica-networks

Tools for running network experiments in [Empirica](https://empirica.ly). Participants occupy nodes in a graph, and each participant receives information about their neighbors alone.

The package runs complete games, although testing remains limited. All three examples in this repository run end to end against an Empirica server. See [Runnable examples](#runnable-examples), [Verifying the guarantee](#verifying-the-guarantee), and [Installation](#installation).

This project is neither affiliated with nor endorsed by the Empirica project.

| | |
|---|---|
| New here | [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — an ordered guide from installation through verification |
| API reference | [`docs/API.md`](docs/API.md) — every export and the reasoning behind its design |
| Troubleshooting | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — organized by observable symptom |
| Internal design | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the lifecycle, publication path, and location of each value |
| Choosing a structure | [`docs/TOPOLOGIES.md`](docs/TOPOLOGIES.md) — 14 generators, with their limits |
| Showing the network | [`docs/API.md`](docs/API.md#drawing-the-neighborhood) — drawing a participant's own neighborhood, and what each radius discloses |
| Planning a study | [`docs/DEPLOYING.md`](docs/DEPLOYING.md) — a preflight checklist and the current limits of the deployment guidance |
| Exporting data | [`docs/DATA-AND-ANALYSIS.md`](docs/DATA-AND-ANALYSIS.md) — the schema for every exported table |
| Study examples | [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) — two experiments reconstructed from published papers |
| Known defects | [`ISSUES.md`](ISSUES.md) |
| Artificial participants | [`docs/BOTS.md`](docs/BOTS.md) — the policy interface, placement, and why a bot's name is participant-visible |
| Everything else | [`docs/`](docs/README.md) — the documentation index |

## Before running a study

Empirica allows participants to write to any data object whose identifier they know, regardless of whether a study uses this package. Empirica Classic links every participant to every player data object (the `player` scope), so each participant already knows the identifiers of the other players. Although the documentation describes `protected: true` as preventing updates by other participants, the platform currently permits those updates.

Consequently, a participant with access to the browser console can:

- overwrite another participant's answers, score, or assigned condition;
- make the change without producing an unusual server log entry; and
- create a value that server-side code cannot distinguish from one submitted through the study interface.

Use the following safeguards:

1. Treat every participant-written value as untrusted input, just as you would treat a form field on a public website. Compute consequential values on the server from attributable inputs.
2. Store the authoritative record in the batch scope, Empirica's shared data object for a batch of games, which participants cannot modify. Both reconstructions in this repository use this approach for payoffs and document it where the values are written.
3. Consider participants' incentives. Competitive games and bonuses tied to relative performance create stronger incentives to alter another participant's state than surveys typically do.

Participant state is therefore vulnerable to tampering. The tests in `test/e2e/participant_write.test.ts` and `test/e2e/write_acl.test.ts` demonstrate this behavior, and `docs/PLATFORM-NOTES.md` §4a describes the mechanism.

Every participant also receives each co-player's recruitment identifier. The same mechanism is responsible: Classic links everyone to every player scope, which delivers the value of `?participantKey=` to the other players. Recruitment-platform identifiers, such as Prolific PIDs, can remain stable across studies. Use an opaque, study-specific token for `participantKey`, and store the mapping outside Empirica. This behavior is measured in `test/e2e/bots.test.ts` and described further in `docs/PLATFORM-NOTES.md` §21.

## Installation

<a id="not-published-yet"></a>

> ### Not published yet
>
> The package is deliberately marked `"private": true` at version `0.0.0` while the public API
> remains under development. This setting prevents an accidental `npm publish` from permanently
> registering the current name and version.
>
> Until publication, install the package from a tarball. Commands shown as
> `npx empirica-networks …` describe the eventual published form; relevant sections also provide
> the equivalent command for a cloned repository. Other documentation links to this notice.

```sh
npm pack                                    # in this repo -> empirica-networks-0.0.0.tgz
npm --prefix server install /path/to/empirica-networks-0.0.0.tgz
npm --prefix client install /path/to/empirica-networks-0.0.0.tgz
```

The package requires Node 20 or later and the Empirica CLI (`curl https://install.empirica.dev | sh`). Install it in both the `server` and `client` projects because they use separate package installations.

Install from the packed tarball instead of using an npm `file:` dependency. npm implements a `file:` dependency as a symbolic link, which loads two copies of `@empirica/core` and causes Empirica's `instanceof` checks to fail. The failure appears as a full game in which every participant remains on “Waiting for other players” (see [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) and `docs/PLATFORM-NOTES.md` §10).

The unscoped name `empirica-networks` supports discovery in an ecosystem that currently lacks a registry, plugin API, or curated package list. Choosing the name before publication also avoids a later breaking change.

## Quick start

A project created with `empirica create` requires three edits. The first registers the network scope and is essential: without it, participants receive empty neighborhoods while the server continues running. Call `assertKindsRegistered(networkKinds)` to detect the omission before startup. An automatic check provides a second safeguard by issuing a warning shortly after the first game begins.

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
  project: (neighbor, viewer, ctx) => ({
    id: neighbor.id,
    choice: ctx.stateOf(neighbor).get("choice"),
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

A list of connections is often enough. Where the subject is reasoning about who is connected to
whom, draw it instead:

```jsx
import { NetworkGraph, NetworkGraphStyles, useNetworkGraph } from "empirica-networks/player/react";

const graph = useNetworkGraph({ nodeAttrs: (n) => ({ choice: n.data?.choice }) });
<NetworkGraphStyles />
<NetworkGraph model={graph} fallback={<p>Joining the network…</p>} />
```

What that draws is a star: the participant at the centre, one node per connection, one line to
each. It cannot show more, because it is built from `useNeighbors()` and a tie between two of your
connections is not in that array — so it costs nothing, sends nothing extra, and moves no guarantee
below. `graph: { radius: 1.5 }` on the server additionally sends the ties among a participant's own
connections, which is a real widening of what they are told and is opt-in for that reason.

[`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) presents the same procedure and explains the
common failure mode at each step. [`docs/API.md`](docs/API.md) documents the complete public API.

## The guarantee and its limit

The package guarantees that projected state—the subset of a neighbor's data selected by
`project()`—never reaches non-neighbors. Each participant has a private channel scope, and the
server writes that participant's projections exclusively to this channel.

The write location determines whether a value remains private. Empirica links every participant to
every player node, so `player.set(key, value)` broadcasts the value to the entire game regardless
of topology. Store private values with `useNetworkState().set()`, and read them on the server with
`ctx.stateOf(neighbor)`.

`npm run test:browser` asserts both halves in real browsers: a non-neighbor's private value
appears nowhere in the bytes a tab received, while a player attribute does.

The realized network, meaning the graph actually generated for a run, also remains private. Its random seed and edge list are recorded on the batch
scope, a durable scope that measurements show is withheld from participants. This design preserves
reproducibility without revealing the network structure during the study. The game scope reaches
every participant and is therefore unsuitable for these values. The test in
`test/e2e/topology_visibility.test.ts` checks both participant scopes and raw network traffic.

This structural guarantee covers read privacy alone. Empirica's permissive write access leaves
participant-authored state vulnerable to alteration, as described [above](#before-running-a-study).

## Verifying the guarantee

The package includes a command that tests its central read-privacy guarantee:

```sh
node dist/verify/cli.cjs verify --n 4     # from a clone today, after `npm run build`
npx empirica-networks verify --n 4        # once published
```

The command starts Tajriba, Empirica's data service, connects four automated participants in a ring by default, and inspects their network traffic. The `--topology` option also accepts `star`, `wheel`, `pairs`, `ladder`, and `complete` — though a complete graph is refused, because it leaves no non-neighbor for the check to examine. `--radius 1.5` checks a study configured to show participants the ties among their own connections.

```
  non-neighbor sentinels received : 0/4 pairs  (must be 0)
  neighbor sentinels delivered    : 8/8  (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)
  structure payloads sent        : 0  (must be 0 at radius 1)

  PASS
```

The verification has four required checks at the default radius. The first detects information from
non-neighbors, the second confirms delivery from neighbors, and the third confirms that the
inspection mechanism can detect control values. Together, they distinguish genuine privacy from a
failed projection or an insensitive test. The fourth confirms that no local structure is sent at
all, which is what makes the default's cost a checked claim rather than a stated one.

A study configured with `graph: { radius: 1.5 }` passes `--radius 1.5`, and two further checks
replace the fourth: every tie delivered must join two people the viewer can see and must actually
exist, and all of them must arrive. These are separate arms because the sentinels cannot see them —
the bytes radius 1.5 adds are integers, so a payload full of ties to strangers carries no sentinel
and the first three checks stay clean.

Sentinels are random, server-side tokens injected into projected views for leak detection. They
are kept outside Empirica scopes, and the verifier searches for them throughout the raw network
frames. This approach detects a leak even through an unexpected channel. Because Empirica requires
bundling in this context, the CLI includes its own copy of `@empirica/core`; it prints both the
bundled and installed versions and warns when they differ.

The command requires the Empirica CLI on `PATH`, starts the server in a temporary directory, and
returns a nonzero exit code when verification fails or the run cannot start. Options and exit codes are documented in
[`docs/API.md`](docs/API.md#the-verify-cli).

## Runnable examples

The repository contains three examples. End-to-end tests import each example's `callbacks.js`
without modification, ensuring that package changes remain compatible with the examples. Keeping
the examples in this repository also allows the test suite to exercise the exact code users run.

| | What it is |
|---|---|
| [`examples/minimal`](examples/minimal) | A stock `empirica create` project with four modified files. Participants in a ring choose a color and see the choices of their two neighbors. Start here |
| [`examples/rand2011`](examples/rand2011) | A reconstruction of the design in Rand, Arbesman & Christakis (2011), *PNAS*. Cooperation in dynamic networks: rewiring during play, private decisions, four conditions |
| [`examples/shirado2017`](examples/shirado2017) | A reconstruction of Shirado & Christakis (2017), *Nature*. Color coordination on a scale-free network, with a global objective participants cannot see — both the control arm and the paper's autonomous-agent conditions |

```sh
npm install && node scripts/example-install.mjs minimal   # or: npm run example:install, for all three
cd examples/minimal && empirica
```

Open four windows with distinct `?participantKey=` values. Each participant sees a different pair
among the other three participants.

These examples are reconstructions rather than replications: both designs were rebuilt from their
published descriptions. They have produced no study data, and their outputs have not been compared
with the original results. See
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md).

## Bots

Empirica v2 omits the artificial-player facility available in version 1 (`docs/PLATFORM-NOTES.md`
§16). The `empirica-networks/bots` module supplies this capability by running each bot as a
headless participant process that uses the same network protocol as a browser.

```js
// bots.mjs — plain `node bots.mjs`, no bundler
import { runBots } from "empirica-networks/bots";

await runBots({
  url: "http://localhost:3000/query",
  identifiers: process.env.BOT_KEYS.split(","),
  policy: {
    tickMs: 1500,
    onTick(ctx) {
      const neighbors = ctx.neighbors();          // undefined until the first publish
      if (neighbors === undefined) return;
      ctx.state().set("choice", decide(neighbors, ctx.rng));
    },
  },
});
```

A bot reads through the same `project()` function and writes to the same private channel as a
human participant. Giving bots identical information access ensures that comparisons between bots
and humans reflect behavior instead of differences in available information.

Three considerations are especially important, and each has a dedicated section in
[`docs/BOTS.md`](docs/BOTS.md):

- Recruit `playerCount − botCount` humans. The treatment's player count includes bots and defines
  the size of the network. The runner reports a mismatch that would otherwise prevent the study
  from starting.
- Treat bot placement as an experimental manipulation. Configure it through
  `topology({ players })`, where `players[i]` identifies the participant assigned to index `i`.
  Relabeling the graph preserves the degree distribution across experimental arms.
- Bot identifiers are visible to participants (see above). Supply an explicit identifier list to
  `runBots`, and use the same server-held list to identify bots on the server.

`examples/shirado2017` provides a complete example with three agent types, three noise levels, and
three placements, reproducing the experimental design central to the paper.

## Supported environment

Let n denote the number of participants and d the mean number of neighbors per participant. The
payload delivered to each participant grows in proportion to d, while total outbound server
traffic grows in proportion to n·d.

| Regime | Status |
|---|---|
| Any density, n ≤ 50 | Measured, including complete graphs; degree is uncapped by default |
| Sparse (d ≤ 16), n ≤ 150 | Measured on this implementation |
| Sparse, n ≥ 200 | Games start unreliably because of an upstream limitation; 1 of 6 measured runs completed at n=200 |
| Dense, n > 50 | Unmeasured, and capped at d ≤ 16 by default. This is where client bandwidth binds |
| Sessions beyond ~10 minutes | Unverified; the current test suite contains no multi-hour run |

The package targets studies with n ≤ 50, a regime in which the measurements remain comfortably within the default limits.

End-to-end publish latency, from a watched attribute changing to a neighbor's client holding the
new value (`npm run bench`):

Each figure is the median of three runs, each against a fresh server, with the observed range
beside it (`npm run bench -- --repeats 3`, 2026-08-16):

```
  n= 25  d=8  p50 median 18.3ms   (17.7–18.5 across 3 runs)
  n= 50  d=8  p50 median  8.6ms   ( 8.6–28.7 across 3 runs)
  n=100  d=8  p50 median 12.7ms   (10.9–31.7 across 3 runs)
  n=150  d=8  p50 median 25.1ms   (14.3–29.9 across 3 runs)
  n=200  d=8  p50 median 26.8ms   (one run in three completed — upstream, see below)
```

The order of magnitude matters more than any single value, and n has little predictive value in
these measurements. Two sources of variation shape the results. **Within** this sweep, the
three runs of a cell agree closely at n=25 and diverge by a factor of two or more from n=50 up,
because `withServer` is per run: every repeat re-measures process startup, batch creation and first
publish, which is where the run-to-run variance lives. **Across** sweeps, the same n=25 cell
measured anywhere from 3.3 to 18.3 ms in one afternoon — an offset shared by every cell in a sweep
and therefore invisible to repeats. Consequently, O1's “4–17%” describes the within-sweep
agreement of that cell rather than the table as a whole. The measurement host produces this
variation: a busier host measures faster, non-monotonically, because an
idle laptop clocks its cores down (`docs/PLATFORM-NOTES.md` §19 finds that the coordinator burns
57% more CPU time for identical work when the machine is quiet). Repeats improve precision within
a sweep while leaving this systematic variation intact, so each individual value should be
interpreted as an order-of-magnitude estimate. Comparisons made
within one sweep, such as the payload table below, remain sound, because both arms see the same
clock.

The dominant factor is the number of participants sharing an event loop, an artifact of measuring
hundreds of clients on one machine. In a typical study, participants use separate browsers. The
package's own contribution falls below these measurements, and this benchmark cannot isolate it (`ISSUES.md`
O1). The n ≥ 200 start failure is discussed in §16; the degree-cap correction, in §19.

The following measurements show what a large per-neighbor payload costs, paired inside one sweep
so that the offset cancels (§21):

```
  n=20  d=19   2 fields  →  1.4KiB per publish   p50 11.5ms
  n=20  d=19  +1KiB/view →  20.6KiB              p50 21.4ms
  n=50  d=49   2 fields  →  3.7KiB               p50 22.8ms
  n=50  d=49  +1KiB/view →  53.1KiB              p50 67.0ms   ← just under maxNeighborhoodBytes
```

Every tested message was delivered. Approaching the 64 KiB default therefore increases latency
gradually: a design near the limit delivered updates in about 67 ms, compared with 10–25 ms for
smaller payloads.

The implementation enforces these limits at game start, before provisioning channels. Early
validation prevents a failed topology from leaving links that Tajriba cannot remove. The three
limits, their empirical basis, and their override mechanisms are documented in
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
things. [`docs/TESTING.md`](docs/TESTING.md) describes the three test tiers, the evidence each
provides, and how to diagnose a failing run before classifying it as a regression.

## License

MIT. See [LICENSE](LICENSE).
