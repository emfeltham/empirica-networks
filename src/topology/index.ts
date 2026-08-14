/**
 * Topology generators. Pure, zero-dependency, index-based.
 *
 * Ported from Breadboard's groovy/graph.groovy. M1 ships four — ring,
 * ringLattice, complete, empty — chosen because they span the regimes the
 * envelope check cares about: sparse and fixed-degree, tunable-degree, maximally
 * dense, and disconnected (a control condition). The remaining twelve
 * (wattsStrogatz, barabasiAlbert, erdosRenyi, geometricRandom, smallWorld,
 * smallWorldColoring, star, wheel, grid, ladder, lattice, pairs) land in M2.
 *
 * Every generator that makes a random choice takes an Rng, so a recorded seed
 * reproduces the exact graph. That is not a nicety: Breadboard used an unseeded
 * generator, so a finished run stored the generator and its parameters but not
 * the realised graph — which for a network experiment is often the independent
 * variable. See admin/seed.ts, and test/e2e/reproducibility.test.ts for the
 * end-to-end check that the recorded seed regenerates what participants were
 * actually given.
 */
import type { Rng } from "../admin/seed.js";
import { shuffle } from "../admin/seed.js";

/** An undirected edge between two node indices. */
export type Edge = [number, number];

export interface TopologyOptions {
  /** Randomise which participant occupies which structural position. */
  rng?: Rng;
}

/** Order nodes, optionally permuting positions with the supplied rng. */
function positions(n: number, opts: TopologyOptions = {}): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  return opts.rng ? shuffle(idx, opts.rng) : idx;
}

/**
 * Ring lattice: each node connected to `m` neighbours on each side.
 * Mean degree 2m. Breadboard called this `mRing`.
 */
export function ringLattice(n: number, m: number, opts: TopologyOptions = {}): Edge[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`ringLattice: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(m) || m < 1) throw new Error(`ringLattice: m must be a positive integer, got ${m}`);
  if (n < 2 * m + 1) {
    throw new Error(`ringLattice: needs n >= 2m+1 (got n=${n}, m=${m}); the ring would wrap onto itself`);
  }
  const p = positions(n, opts);
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 1; j <= m; j++) {
      edges.push([p[i]!, p[(i + j) % n]!]);
    }
  }
  return edges;
}

/** Simple ring. Degree 2. Requires n >= 3. */
export function ring(n: number, opts: TopologyOptions = {}): Edge[] {
  return ringLattice(n, 1, opts);
}

/** Every node connected to every other. Degree n-1. */
export function complete(n: number): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) edges.push([i, j]);
  }
  return edges;
}

/** No edges. Useful as a control condition. */
export function empty(): Edge[] {
  return [];
}

/**
 * Adjacency list. Deduplicates, drops self-loops, and returns sorted neighbour
 * lists so a projection is stable across runs with the same graph.
 */
export function adjacency(n: number, edges: Edge[]): number[][] {
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (const [a, b] of edges) {
    if (a === b) continue;
    if (a < 0 || a >= n || b < 0 || b >= n) {
      throw new Error(`adjacency: edge [${a}, ${b}] is outside [0, ${n})`);
    }
    sets[a]!.add(b);
    sets[b]!.add(a);
  }
  return sets.map((s) => [...s].sort((x, y) => x - y));
}

export function degrees(n: number, edges: Edge[]): number[] {
  return adjacency(n, edges).map((nbrs) => nbrs.length);
}

export function meanDegree(n: number, edges: Edge[]): number {
  if (n === 0) return 0;
  return degrees(n, edges).reduce((a, b) => a + b, 0) / n;
}

export function maxDegree(n: number, edges: Edge[]): number {
  return degrees(n, edges).reduce((a, b) => Math.max(a, b), 0);
}
