/**
 * Topology.
 *
 * These generators decide who can see whom, so a bug here is not a rendering
 * glitch — it silently changes the experimental design. A ring that quietly
 * partitions into two components, or a permutation that drops an edge, produces
 * a run that looks completely normal and answers a different question than the
 * one asked.
 *
 * So the assertions are structural (degree sequence, edge count, connectivity)
 * rather than "the output equals this array", and connectivity is recomputed
 * here with an independent union-find rather than by calling the module's own
 * helpers, which would just be checking it agrees with itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeRng, hashSeed } from "../../src/admin/seed.js";
import {
  adjacency,
  barabasiAlbert,
  complete,
  components,
  degrees,
  empty,
  erdosRenyi,
  fromEdgeList,
  geometricRandom,
  grid,
  isConnected,
  ladder,
  maxDegree,
  meanDegree,
  pairs,
  ring,
  ringLattice,
  star,
  type Edge,
  wattsStrogatz,
  wheel,
} from "../../src/topology/index.js";

/** Independent connectivity check: number of connected components. */
function componentCount(n: number, edges: Edge[]): number {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const [a, b] of edges) parent[find(a)] = find(b);
  return new Set(Array.from({ length: n }, (_, i) => find(i))).size;
}

/** Canonical form, so two edge lists can be compared regardless of order. */
function canonical(edges: Edge[]): string {
  return edges
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(",");
}

test("ring: n edges, every degree 2, and ONE component", () => {
  // The single-component assertion is the one that matters. A ring built with a
  // wrong modulus still gives every node degree 2 — as two disjoint cycles.
  for (const n of [3, 4, 5, 20, 101]) {
    const edges = ring(n);
    assert.equal(edges.length, n, `ring(${n}) has ${n} edges`);
    assert.deepEqual(degrees(n, edges), Array(n).fill(2), `ring(${n}) is 2-regular`);
    assert.equal(componentCount(n, edges), 1, `ring(${n}) is a single cycle`);
  }
});

test("ringLattice: n*m edges and degree 2m", () => {
  for (const [n, m] of [
    [10, 1],
    [10, 2],
    [11, 3],
    [40, 8],
  ] as const) {
    const edges = ringLattice(n, m);
    assert.equal(edges.length, n * m);
    assert.deepEqual(degrees(n, edges), Array(n).fill(2 * m), `ringLattice(${n},${m})`);
    assert.equal(componentCount(n, edges), 1);
  }
});

test("ringLattice at its minimum n is the complete graph", () => {
  // n = 2m+1 is the boundary the validation allows. Each node reaches every
  // other, so it must coincide with complete(n) exactly — a good check that the
  // wrap-around arithmetic is right at the edge of the permitted range.
  for (const m of [1, 2, 3, 5]) {
    const n = 2 * m + 1;
    assert.equal(canonical(ringLattice(n, m)), canonical(complete(n)), `n=${n}, m=${m}`);
  }
});

test("complete: n(n-1)/2 edges, degree n-1", () => {
  for (const n of [2, 3, 6, 20]) {
    const edges = complete(n);
    assert.equal(edges.length, (n * (n - 1)) / 2);
    assert.deepEqual(degrees(n, edges), Array(n).fill(n - 1));
  }
  assert.deepEqual(complete(1), [], "one node has no edges");
  assert.deepEqual(complete(0), []);
});

test("empty: no edges, every node isolated", () => {
  const edges = empty();
  assert.deepEqual(edges, []);
  assert.deepEqual(degrees(5, edges), [0, 0, 0, 0, 0]);
  assert.equal(componentCount(5, edges), 5, "five isolated nodes");
});

test("rejects degenerate parameters rather than producing a broken graph", () => {
  // ring(2) would emit [0,1] and [1,0] — one edge after dedup, so degree 1 not
  // 2. Silently returning a "ring" that is not one is worse than refusing.
  assert.throws(() => ring(2), /n >= 2m\+1/);
  assert.throws(() => ring(1), /n >= 2m\+1/);
  assert.throws(() => ring(0), /n >= 2m\+1/);
  assert.throws(() => ringLattice(10, 0), /m must be a positive integer/);
  assert.throws(() => ringLattice(10, -1), /m must be a positive integer/);
  assert.throws(() => ringLattice(-1, 1), /n must be a non-negative integer/);
  assert.throws(() => ringLattice(4.5, 1), /n must be a non-negative integer/);
  assert.throws(() => ringLattice(10, 5), /wrap onto itself/, "n < 2m+1");
});

test("adjacency: symmetric, deduplicated, sorted, no self-loops", () => {
  const adj = adjacency(4, [
    [0, 1],
    [1, 0], // duplicate in the other direction
    [0, 1], // exact duplicate
    [2, 2], // self-loop
    [0, 3],
    [0, 2],
  ]);

  assert.deepEqual(adj[0], [1, 2, 3], "sorted, so projections are stable run to run");
  assert.deepEqual(adj[1], [0]);
  assert.deepEqual(adj[2], [0], "the self-loop is dropped, the real edge is kept");
  assert.deepEqual(adj[3], [0]);
});

test("adjacency: an out-of-range edge throws instead of being ignored", () => {
  // Silently dropping it would mean a participant is missing a neighbor with
  // nothing to indicate it.
  assert.throws(() => adjacency(3, [[0, 3]]), /outside \[0, 3\)/);
  assert.throws(() => adjacency(3, [[-1, 0]]), /outside \[0, 3\)/);
});

test("degree summaries", () => {
  const edges = ringLattice(10, 2);
  assert.equal(meanDegree(10, edges), 4);
  assert.equal(maxDegree(10, edges), 4);
  assert.equal(meanDegree(0, []), 0, "no division by zero");
  assert.equal(maxDegree(5, []), 0);

  // A star: one hub, four leaves. Mean and max must differ, or the summary is
  // not telling the envelope check anything useful.
  const star: Edge[] = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ];
  assert.equal(maxDegree(5, star), 4);
  assert.equal(meanDegree(5, star), 1.6);
});

test("the same seed reproduces the exact graph", () => {
  // The point of seeding: a run's realized network is recoverable from the seed
  // recorded on its game scope. Without this, the independent variable of a
  // network experiment is unrecoverable from stored data.
  const seed = hashSeed("game-abc");

  const first = ring(30, { rng: makeRng(seed) });
  const second = ring(30, { rng: makeRng(seed) });

  assert.equal(canonical(first), canonical(second));
  assert.deepEqual(first, second, "identical down to edge order");
});

test("a different seed gives a different graph", () => {
  // Otherwise the rng is not being consumed and every run is the same network —
  // which would pass the reproducibility test above perfectly.
  const a = ring(30, { rng: makeRng(hashSeed("game-abc")) });
  const b = ring(30, { rng: makeRng(hashSeed("game-xyz")) });

  assert.notEqual(canonical(a), canonical(b));
});

test("the rng permutes WHO sits where, never the structure", () => {
  // Randomisation must assign participants to positions without changing the
  // graph's shape. A permutation that corrupted structure would show up as a
  // changed degree sequence or a partition.
  for (const seedStr of ["a", "b", "c", "d", "e"]) {
    const n = 25;
    const edges = ring(n, { rng: makeRng(hashSeed(seedStr)) });

    assert.equal(edges.length, n);
    assert.deepEqual(degrees(n, edges), Array(n).fill(2), `seed ${seedStr}: still 2-regular`);
    assert.equal(componentCount(n, edges), 1, `seed ${seedStr}: still one cycle`);
  }

  const n = 40;
  const lattice = ringLattice(n, 4, { rng: makeRng(hashSeed("lattice")) });
  assert.deepEqual(degrees(n, lattice), Array(n).fill(8));
  assert.equal(componentCount(n, lattice), 1);
});

test("hashSeed is stable and spreads distinct ids apart", () => {
  assert.equal(hashSeed("game-abc"), hashSeed("game-abc"), "same input, same seed");
  assert.notEqual(hashSeed("game-abc"), hashSeed("game-abd"));

  // Adjacent game ids must not collide, or two games in a batch share a network.
  const seeds = new Set(Array.from({ length: 500 }, (_, i) => hashSeed(`game-${i}`)));
  assert.equal(seeds.size, 500, "no collisions across 500 sequential ids");
});

test("seeds survive the truncation makeRng applies", () => {
  // hashSeed returns up to 53 bits; makeRng keeps the low 32. Distinct games
  // must still get distinct streams after that truncation — otherwise the
  // collision check above passes while the actual generators agree.
  const streams = new Set(
    Array.from({ length: 500 }, (_, i) => {
      const rng = makeRng(hashSeed(`game-${i}`));
      return [rng(), rng(), rng()].join(",");
    })
  );
  assert.equal(streams.size, 500, "no two games draw the same sequence");
});

// --------------------------------------------------------------- M2 generators
//
// Each generator is checked against the property that makes it worth having,
// not merely that it returns something edge-shaped. Where a model can
// legitimately produce a disconnected graph, that is asserted as a fact about
// the model rather than treated as a defect to paper over.

test("star: one hub, everyone else degree 1, connected", () => {
  const n = 8;
  const edges = star(n);
  const d = degrees(n, edges).sort((a, b) => a - b);

  assert.equal(edges.length, n - 1, "a tree on n nodes has n-1 edges");
  assert.deepEqual(d.slice(0, n - 1), Array(n - 1).fill(1), "every spoke has degree 1");
  assert.equal(d[n - 1], n - 1, "the hub reaches everyone");
  assert.ok(isConnected(n, edges));
});

test("wheel: hub degree n-1, every rim node degree 3", () => {
  const n = 9;
  const edges = wheel(n);
  const d = degrees(n, edges).sort((a, b) => a - b);

  assert.equal(d[n - 1], n - 1, "hub");
  assert.deepEqual(d.slice(0, n - 1), Array(n - 1).fill(3), "two rim neighbors plus the hub");
  assert.ok(isConnected(n, edges));
});

test("grid: interior degree 4, corners 2 — position confounds degree", () => {
  const edges = grid(3, 3);
  const d = degrees(9, edges);
  const counted = d.reduce<Record<number, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

  assert.deepEqual(counted, { 2: 4, 3: 4, 4: 1 }, "4 corners, 4 edges, 1 center");
  assert.ok(isConnected(9, edges));
});

test("grid periodic: a torus, so degree is uniform and position does not", () => {
  // The whole reason the flag exists: on a plain grid, where you sit determines
  // how many neighbors you have, which confounds any treatment that uses
  // position. On a torus it cannot.
  const edges = grid(4, 4, { periodic: true });
  assert.deepEqual(degrees(16, edges), Array(16).fill(4), "every node has exactly 4");
  assert.ok(isConnected(16, edges));
});

test("grid rejects a periodic grid too narrow to be a torus", () => {
  assert.throws(() => grid(2, 5, { periodic: true }), /not a torus/);
});

test("ladder: 2n nodes, rails degree 2 or 3, connected", () => {
  const rungs = 5;
  const n = rungs * 2;
  const edges = ladder(rungs);
  const d = degrees(n, edges).sort((a, b) => a - b);

  assert.deepEqual(d, [2, 2, 2, 2, 3, 3, 3, 3, 3, 3], "four corners at 2, the rest at 3");
  assert.ok(isConnected(n, edges));
});

test("pairs: disjoint dyads — degree 1 everywhere, n/2 components", () => {
  const n = 10;
  const edges = pairs(n);
  assert.equal(edges.length, n / 2);
  assert.deepEqual(degrees(n, edges), Array(n).fill(1));
  assert.equal(components(n, edges).length, n / 2, "deliberately disconnected: this is the control");
  assert.equal(isConnected(n, edges), false);
});

test("pairs refuses an odd n rather than stranding someone", () => {
  assert.throws(() => pairs(7), /must be even/);
});

test("wattsStrogatz at beta=0 is exactly the ring lattice", () => {
  const n = 20;
  const k = 4;
  const lattice = ringLattice(n, k / 2);
  const ws = wattsStrogatz(n, k, 0);
  assert.equal(canonical(ws), canonical(lattice), "no rewiring means no change");
  assert.deepEqual(degrees(n, ws), Array(n).fill(k));
});

test("wattsStrogatz preserves the edge COUNT while rewiring, so degree is only redistributed", () => {
  const n = 40;
  const k = 4;
  const rng = makeRng(hashSeed("ws-seed"));
  const ws = wattsStrogatz(n, k, 0.3, { rng });

  assert.equal(ws.length, (n * k) / 2, "rewiring moves an endpoint, it does not add or drop edges");
  const total = degrees(n, ws).reduce((a, b) => a + b, 0);
  assert.equal(total, n * k, "sum of degrees is 2|E| — unchanged");
  assert.notEqual(canonical(ws), canonical(ringLattice(n, k / 2)), "and it did rewire something");
});

test("wattsStrogatz requires an rng once it would make a random choice", () => {
  assert.doesNotThrow(() => wattsStrogatz(20, 4, 0), "beta=0 is deterministic");
  assert.throws(() => wattsStrogatz(20, 4, 0.2), /rng is required/);
});

test("barabasiAlbert: heavy-tailed — max degree well above the mean", () => {
  const n = 60;
  const m = 2;
  const rng = makeRng(hashSeed("ba-seed"));
  const ba = barabasiAlbert(n, m, { rng });

  assert.ok(isConnected(n, ba), "preferential attachment always yields one component");
  assert.ok(
    maxDegree(n, ba) > 3 * meanDegree(n, ba),
    `expected a hub: max=${maxDegree(n, ba)} mean=${meanDegree(n, ba).toFixed(1)}`
  );
});

test("erdosRenyi: p=0 and p=1 are the degenerate ends", () => {
  assert.deepEqual(erdosRenyi(6, 0), []);
  assert.equal(canonical(erdosRenyi(6, 1)), canonical(complete(6)));
});

test("erdosRenyi: sparse graphs are often disconnected, and that is the model", () => {
  // Asserted rather than avoided. A generator that quietly resampled until
  // connected would be sampling a different distribution than the one named on
  // the tin, which is exactly the kind of thing that invalidates a design.
  const n = 30;
  let disconnected = 0;
  for (let s = 0; s < 20; s++) {
    const g = erdosRenyi(n, 0.02, { rng: makeRng(hashSeed(`er-${s}`)) });
    if (!isConnected(n, g)) disconnected++;
  }
  assert.ok(disconnected > 0, "well below the threshold, some draws must be disconnected");
});

test("geometricRandom: radius controls density monotonically", () => {
  const n = 40;
  const small = geometricRandom(n, 0.15, { rng: makeRng(hashSeed("geo")) });
  const large = geometricRandom(n, 0.45, { rng: makeRng(hashSeed("geo")) });
  assert.ok(
    large.length > small.length,
    `a wider radius must join more pairs: ${small.length} -> ${large.length}`
  );
});

test("geometricRandom rejects a radius that just means complete(n)", () => {
  assert.throws(() => geometricRandom(10, 2, { rng: makeRng(1) }), /complete\(n\)/);
});

test("fromEdgeList normalizes: self-loops dropped, duplicates collapsed, order canonical", () => {
  const raw: [number, number][] = [
    [2, 1],
    [1, 2],
    [3, 3],
    [0, 1],
  ];
  assert.deepEqual(fromEdgeList(4, raw), [
    [0, 1],
    [1, 2],
  ]);
});

test("fromEdgeList rejects an out-of-range edge rather than silently dropping it", () => {
  assert.throws(() => fromEdgeList(3, [[0, 9]]), /outside \[0, 3\)/);
});

test("components: finds the actual partition", () => {
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [4, 5],
  ];
  const got = components(7, edges)
    .map((c) => c.sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(got, [[0, 1, 2], [3], [4, 5], [6]]);
});

test("every random generator is reproducible from its seed", () => {
  // The property the whole seeding design exists for, applied to the new
  // generators rather than assumed to carry over from ring().
  const seed = hashSeed("reproduce-me");
  const cases: [string, () => Edge[]][] = [
    ["wattsStrogatz", () => wattsStrogatz(30, 4, 0.4, { rng: makeRng(seed) })],
    ["barabasiAlbert", () => barabasiAlbert(30, 2, { rng: makeRng(seed) })],
    ["erdosRenyi", () => erdosRenyi(30, 0.1, { rng: makeRng(seed) })],
    ["geometricRandom", () => geometricRandom(30, 0.25, { rng: makeRng(seed) })],
    ["star", () => star(30, { rng: makeRng(seed) })],
    ["grid", () => grid(5, 6, { rng: makeRng(seed) })],
    ["pairs", () => pairs(30, { rng: makeRng(seed) })],
  ];
  for (const [name, gen] of cases) {
    assert.equal(canonical(gen()), canonical(gen()), `${name} is not reproducible from its seed`);
  }
});
