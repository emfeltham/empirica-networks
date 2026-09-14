# Topologies

This catalog supports the selection and validation of a network structure during study design.
See [API.md](API.md) for the surrounding programming interface.

```js
import { topology } from "empirica-networks/admin";      // server
import * as topology from "empirica-networks/topology";  // anywhere, no @empirica/core

withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.wattsStrogatz(playerCount, 4, 0.1, { rng }),
});
```

The package provides fourteen generators and six graph measures. Every generator is a pure,
dependency-free, index-based function: it
returns `Array<[number, number]>` over node indices `0…n-1`, and `withNetwork` maps indices onto
participants. A study may also supply a custom edge list from any source; the included generators
serve as conveniences rather than restrictions.

The function is called once per game with `{ game, players, playerCount, rng }`. `players[i]` is
the participant who will occupy index `i`, which is what makes who sits where addressable: to
place particular participants at particular positions, relabel the graph you generated rather than
reordering people. [BOTS §4](BOTS.md) is the worked case.

## Rules that apply to all generators

1. Randomness is always seeded. Every generator that makes a random choice takes an `rng`,
and four of them throw without one. This requirement is about reproducibility, not tidiness:
Breadboard used an unseeded generator, so a finished run stored the generator and its parameters
but not the realized graph, and for a network experiment the realized graph is often the
independent variable. `withNetwork` passes you a seeded `rng` and records the seed. Pinned by
`test/e2e/reproducibility.test.ts`.

Passing `rng` to a deterministic generator does something different and useful: it permutes
which participant occupies which structural position. On a star, that decides who is the hub.

2. Degree is checked against the envelope at game start, before provisioning and before
anything is recorded, so an out-of-envelope topology fails while the experiment is still
abandonable. The default cap is `n - 1` at n ≤ 50 and `16` above it, because those are the two
regimes that have been measured, and the error says which one you hit.

`complete`, `star` and `wheel` each have a node of degree `n - 1`, so they are fine at n ≤ 50 and
out of the envelope by construction above it. That is a property of the shape, not a bug.

3. Nothing silently repairs a disconnected graph. `erdosRenyi` and `geometricRandom` below
their percolation thresholds, and `wattsStrogatz` through rewiring, all produce isolated nodes at
some parameters. Resampling until connected would change the distribution you are sampling from,
so `isConnected(n, edges)` is offered instead and the choice stays yours.

Degenerate parameters are refused rather than quietly producing something that is not what it
claims: `ring(2)` throws instead of returning a two-node "ring" of degree 1, and `pairs(7)` throws
rather than stranding one participant.

---

## Regular

| | Degree | Needs `rng`? | Connected? | Notes |
|---|---|---|---|---|
| `ring(n, { rng })` | 2 | no | always | `ringLattice(n, 1)`. Requires n ≥ 3 |
| `ringLattice(n, m, { rng })` | 2m | no | always | Breadboard's `mRing`. Requires n ≥ 2m+1, or the ring wraps onto itself |
| `grid(w, h, { rng })` | 2–4 | no | always | n = w·h. Corner nodes have degree 2, edge nodes 3: position confounds degree |
| `grid(w, h, { periodic: true })` | 4 | no | always | A torus. Breadboard's `lattice`. Uniform degree, no boundary: usually what you want when the topology is the treatment |
| `ladder(n, { rng })` | 2–3 | no | always | `grid(2, n)`. 2n nodes, not n. Requires n ≥ 2 |
| `complete(n)` | n−1 | no | always | Inside the envelope at n ≤ 50, and measured there: a complete graph at n=20 publishes faster than a degree-8 ring at n=50 |

## Centralised

| | Degree | Needs `rng`? | Connected? | Notes |
|---|---|---|---|---|
| `star(n, { rng })` | hub n−1, spokes 1 | no | always | Requires n ≥ 2. Pass `rng` to randomize who is the hub |
| `wheel(n, { rng })` | hub n−1, rim 3 | no | always | A star whose spokes are also joined in a ring. Requires n ≥ 4 |

## Random

| | Degree | Needs `rng`? | Connected? | Notes |
|---|---|---|---|---|
| `wattsStrogatz(n, k, beta, { rng })` | ≈ k | yes, when `beta > 0` | not guaranteed | Small world. `k` must be a positive even integer, `beta ∈ [0,1]`. β=0 is the lattice, β=1 is near-random; the interesting regime is between, where path length collapses while clustering stays high |
| `barabasiAlbert(n, m, { rng })` | mean ≈ 2m, tail is the point | yes | always | Scale-free; hubs emerge by preferential attachment. Requires n ≥ m+1. Check `maxDegree(n, edges)` before committing: a hub can exceed the envelope well before n does |
| `erdosRenyi(n, p, { rng })` | expected p·(n−1) | yes, unless p is 0 or 1 | not guaranteed | G(n,p). Expected degree is the number to check against the envelope |
| `geometricRandom(n, radius, { rng })` | varies | yes | not guaranteed | Spatial, naturally clustered. `radius ∈ (0, √2]`: beyond √2 every pair in a unit square is in range, which is just `complete(n)`. Disconnected below roughly `sqrt(log n / (π·n))` |

## Controls and arbitrary graphs

| | Degree | Notes |
|---|---|---|
| `pairs(n, { rng })` | 1 | Disjoint dyads. The natural control for a network study: same interaction, no structure. `n` must be even, or one participant is left with nobody |
| `empty()` | 0 | No edges. Takes no arguments |
| `fromEdgeList(n, edges)` | yours | Normalizes: drops self-loops, deduplicates, orders each pair, sorts |

Route hand-built graphs through `fromEdgeList`. A duplicate edge is harmless to `adjacency`
but makes `edges.length` misreport the tie count in the recorded data, and the recorded edge
list is what your analysis reads.

## Measures

Pure functions over `(n, edges)`, usable before a study to check a design and after one to
describe what was realized.

| | Returns |
|---|---|
| `adjacency(n, edges)` | `number[][]`: neighbor lists by index |
| `degrees(n, edges)` | `number[]` |
| `meanDegree(n, edges)` | `number` |
| `maxDegree(n, edges)` | `number`: check this against the envelope for any random generator |
| `components(n, edges)` | `number[][]`: the partition into connected components |
| `isConnected(n, edges)` | `boolean` |

```js
const edges = topology.barabasiAlbert(n, 2, { rng });
if (topology.maxDegree(n, edges) > 16 && n > 50) { /* resample, or raise the envelope knowingly */ }
if (!topology.isConnected(n, edges)) { /* your call, not the package's */ }
```

## What the leak check can say about each

`npx empirica-networks verify --topology <name>` reproduces the neighbor-limited visibility
guarantee on a shape, and the shape decides what a pass is worth. Two properties of the realized
graph matter, and neither is a function of `n`:

- A participant adjacent to everyone has no non-neighbor, so the check cannot speak to them.
  A star's or wheel's hub, and every node of `complete`.
- A participant adjacent to nobody receives no neighbor view, so there is nothing to confirm
  arrived. `empty`, and `erdosRenyi`/`geometricRandom`/`wattsStrogatz` below their thresholds.

Either is fine in moderation: they are counted and reported. A graph where every participant is
in one of those states is refused, because a pass would mean nothing: that is `complete` at any
`n`, `empty`, and `wheel(4)`, which is `complete(4)` wearing a different name.

At `--radius 1.5` a third property decides what a pass is worth, and it disqualifies most shapes:

- A graph where nobody has two neighbors who are connected to each other has no extra structure to
  send, so radius 1.5 draws the same star radius 1 draws. `ring`, `star`, `pairs` and `ladder` are
  all triangle-free and are refused at that radius rather than passed. `wheel` is the shipped shape
  that works; for anything else, hand `runLeakCheck()` the generator you hand `withNetwork`.

`--topology` takes the shapes that need no further argument: `ring`, `star`, `wheel`, `pairs`,
`ladder`, `complete`. Everything else takes a parameter a flag cannot carry, so it is reached by
handing `runLeakCheck` the same function you hand `withNetwork`, which is also the only way to
check a `fromEdgeList` graph, and the reason to prefer it generally: it verifies the graph your
study runs rather than a stand-in for it.

```js
await runLeakCheck({
  n: 12,
  topology: ({ playerCount, rng }) => wattsStrogatz(playerCount, 4, 0.1, { rng }),
});
```

## Choosing a topology

| If you want | Use |
|---|---|
| A minimal structure where everyone is symmetric | `ring` |
| Degree as a treatment, held uniform | `ringLattice`, or `grid(…, { periodic: true })` |
| Spatial structure, or a visual layout that reads naturally | `grid`, `geometricRandom` |
| Centralisation as a treatment | `star`, `wheel` |
| Realistic-looking structure | `wattsStrogatz` (clustered + short paths), `barabasiAlbert` (heavy-tailed degree) |
| A null model matched on density | `erdosRenyi` |
| A no-structure control | `pairs`, or `empty` |
| A specific published graph | `fromEdgeList` |

## Deliberate omissions

Breadboard shipped sixteen generators; three are not reproduced here, and padding the list to
sixteen would have made two of them lies.

- `smallWorld`: the same construction as `wattsStrogatz`. Two names for one model invites an
  author to believe they differ.
- `lattice`: the same as `grid`, offered as `grid(w, h, { periodic: true })`, which is the
  only distinction that matters (a torus has no boundary nodes, so degree is uniform).
- `smallWorldColoring`: could not be reconstructed from the name with any confidence.
  A generator that decides who is adjacent to whom should not be guessed at without that
  confidence.

## Rendering and measuring elsewhere

For anything beyond the measures above (centrality, communities, shortest paths, GEXF for Gephi),
use [graphology](https://graphology.github.io) through the adapter. The package does not depend on
graphology at all, optional or otherwise: the constructor is injected, so nothing here imports it
and the subpath loads without it installed.

```js
import { UndirectedGraph } from "graphology";
import { toGraphology, fromGraphology } from "empirica-networks/topology/graphology";

const g = toGraphology(UndirectedGraph, n, edges, { order });   // order = playerIDs by position
fromGraphology(g);                                              // -> { n, edges, order }
```

> Pass `UndirectedGraph`, not `Graph`. graphology's default is a mixed graph, whose ratio
> metrics count directed slots this module never fills. `toGraphology(Graph, 12, complete(12))`
> reports a density of `0.333`; `UndirectedGraph` reports `1.000`. Same 66 edges: nothing errors,
> the number is just wrong.

`DirectedGraph` is refused outright: a one-way tie is not something the projection can deliver.
Every node carries a `topologyIndex` attribute so structural position survives the round trip.
