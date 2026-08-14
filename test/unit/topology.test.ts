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
  complete,
  degrees,
  empty,
  maxDegree,
  meanDegree,
  ring,
  ringLattice,
  type Edge,
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
  // Silently dropping it would mean a participant is missing a neighbour with
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
  // The point of seeding: a run's realised network is recoverable from the seed
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
