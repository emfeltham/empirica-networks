/**
 * Topology generators. Pure, zero-dependency, index-based.
 *
 * Loosely follows Breadboard's `graph.groovy`, but not name for name. Its list
 * was `ring · mRing · wattsStrogatz · barabasiAlbert · erdosRenyi ·
 * geometricRandom · smallWorld · smallWorldColoring · star · wheel · grid ·
 * ladder · lattice · pairs · complete · fromEdgeList`, and three of those are
 * not shipped as separate functions on purpose:
 *
 *   smallWorld          — the same construction as `wattsStrogatz`. Two names
 *                         for one model invites an author to think they differ.
 *   lattice             — the same as `grid`. Offered instead as
 *                         `grid(w, h, { periodic: true })`, which is the only
 *                         real distinction (a torus has no boundary nodes, so
 *                         degree is uniform).
 *   smallWorldColoring  — could not be reconstructed from the name with any
 *                         confidence, and guessing at a generator that decides
 *                         who is adjacent to whom is not a guess worth making.
 *
 * Padding the list to sixteen would have been easy and would have made two of
 * them lies.
 *
 * Every generator that makes a random choice takes an Rng, so a recorded seed
 * reproduces the exact graph. That is not a nicety: Breadboard used an unseeded
 * generator, so a finished run stored the generator and its parameters but not
 * the realised graph — which for a network experiment is often the independent
 * variable. See admin/seed.ts, and test/e2e/reproducibility.test.ts for the
 * end-to-end check that the recorded seed regenerates what participants were
 * actually given.
 *
 * DEGREE MATTERS HERE, and how much depends on n. The default envelope permits
 * degree up to n-1 at n <= 50 and caps it at 16 above that, because those are the
 * two regimes that have been measured (`src/admin/envelope.ts`
 * `defaultMaxDegree`). So `complete`, `star` and `wheel` — every one of which has
 * a node of degree n-1 — are fine at n <= 50 and out of the envelope by
 * construction above it. That is a property of the shape rather than a bug, and
 * the check at game start says which measurement was hit.
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

// ------------------------------------------------------------------ structural

/**
 * One hub connected to everyone else. Hub degree n-1, spoke degree 1.
 *
 * Exceeds the supported envelope for n > 17 by construction — see the note at
 * the top. Still useful below that, and as a deliberate centralisation
 * condition.
 */
export function star(n: number, opts: TopologyOptions = {}): Edge[] {
  requireCount("star", n, 2);
  const p = positions(n, opts);
  const edges: Edge[] = [];
  for (let i = 1; i < n; i++) edges.push([p[0]!, p[i]!]);
  return edges;
}

/** A star whose spokes are also joined in a ring. Hub degree n-1, rim degree 3. */
export function wheel(n: number, opts: TopologyOptions = {}): Edge[] {
  requireCount("wheel", n, 4);
  const p = positions(n, opts);
  const edges: Edge[] = [];
  const rim = n - 1;
  for (let i = 1; i < n; i++) {
    edges.push([p[0]!, p[i]!]);
    edges.push([p[i]!, p[(i % rim) + 1]!]);
  }
  return edges;
}

export interface GridOptions extends TopologyOptions {
  /**
   * Wrap the edges into a torus, so every node has degree 4.
   *
   * This is what Breadboard called `lattice` as distinct from `grid`. It is the
   * only difference worth a flag: on a plain grid, corner nodes have degree 2
   * and edge nodes 3, so position in the grid confounds degree. On a torus it
   * does not, which is usually what you want when the topology is a treatment.
   */
  periodic?: boolean;
}

/** `w` by `h` grid, four-neighbour. n = w*h. */
export function grid(w: number, h: number, opts: GridOptions = {}): Edge[] {
  if (!Number.isInteger(w) || w < 1) throw new Error(`grid: w must be a positive integer, got ${w}`);
  if (!Number.isInteger(h) || h < 1) throw new Error(`grid: h must be a positive integer, got ${h}`);
  if (opts.periodic && (w < 3 || h < 3)) {
    throw new Error(
      `grid: a periodic grid needs w >= 3 and h >= 3 (got ${w}x${h}); below that the ` +
        `wrap-around edge is the same edge as the direct one, giving a shape that is not a torus`
    );
  }
  const n = w * h;
  const p = positions(n, opts);
  const at = (x: number, y: number) => p[y * w + x]!;
  const edges: Edge[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x + 1 < w) edges.push([at(x, y), at(x + 1, y)]);
      else if (opts.periodic && w > 2) edges.push([at(x, y), at(0, y)]);
      if (y + 1 < h) edges.push([at(x, y), at(x, y + 1)]);
      else if (opts.periodic && h > 2) edges.push([at(x, y), at(x, 0)]);
    }
  }
  return edges;
}

/** Two parallel paths of `n` joined by rungs. n*2 nodes, degree 2 or 3. */
export function ladder(n: number, opts: TopologyOptions = {}): Edge[] {
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(`ladder: n must be an integer >= 2, got ${n}`);
  }
  // Only `rng` is forwarded: a ladder is two rails wide, and `grid` rejects a
  // periodic grid narrower than 3 — so passing `periodic` through would surface
  // as a confusing error about a grid the author never asked for.
  return grid(2, n, opts.rng ? { rng: opts.rng } : {});
}

/**
 * Disjoint dyads: n/2 pairs, nobody connected to anyone else. Degree 1.
 *
 * The natural control for a network study — same interaction, no structure.
 */
export function pairs(n: number, opts: TopologyOptions = {}): Edge[] {
  requireCount("pairs", n, 2);
  if (n % 2 !== 0) throw new Error(`pairs: n must be even, got ${n}; one participant would be left with nobody`);
  const p = positions(n, opts);
  const edges: Edge[] = [];
  for (let i = 0; i < n; i += 2) edges.push([p[i]!, p[i + 1]!]);
  return edges;
}

// ------------------------------------------------------------------ random

/**
 * Watts–Strogatz small world: a ring lattice of degree `k`, each edge rewired
 * with probability `beta`.
 *
 * beta = 0 leaves the lattice untouched; beta = 1 is close to a random graph.
 * The interesting regime is in between, where path length collapses while
 * clustering stays high.
 *
 * Rewiring can disconnect the graph. That is a property of the model rather
 * than a defect, so it is not silently repaired — check with `isConnected` and
 * decide deliberately, because resampling until connected changes the
 * distribution you are sampling from.
 */
export function wattsStrogatz(
  n: number,
  k: number,
  beta: number,
  opts: TopologyOptions = {}
): Edge[] {
  if (!Number.isInteger(k) || k < 2 || k % 2 !== 0) {
    throw new Error(`wattsStrogatz: k must be a positive even integer, got ${k}`);
  }
  if (!(beta >= 0 && beta <= 1)) {
    throw new Error(`wattsStrogatz: beta must be in [0, 1], got ${beta}`);
  }
  const rng = opts.rng;
  if (!rng && beta > 0) {
    throw new Error("wattsStrogatz: an rng is required when beta > 0, so the graph is reproducible");
  }
  const base = ringLattice(n, k / 2, opts);
  if (beta === 0 || !rng) return base;

  const present = new Set(base.map(([a, b]) => key(a, b)));
  const out: Edge[] = [];
  for (const [a, b] of base) {
    if (rng() >= beta) {
      out.push([a, b]);
      continue;
    }
    // Rewire the far end of the edge, keeping `a`. Give up after a bounded
    // number of tries rather than loop forever on a nearly-complete graph.
    let rewired = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      const c = randIndex(rng, n);
      if (c === a || present.has(key(a, c))) continue;
      present.delete(key(a, b));
      present.add(key(a, c));
      out.push([a, c]);
      rewired = true;
      break;
    }
    if (!rewired) out.push([a, b]);
  }
  return out;
}

/**
 * Barabási–Albert preferential attachment: scale-free, heavy-tailed degree.
 *
 * Starts from a complete graph of `m+1` and adds each remaining node with `m`
 * edges, choosing targets with probability proportional to current degree.
 *
 * Note the degree tail: early nodes become hubs, and a hub can exceed the
 * supported envelope well before n does. `maxDegree` on the result is worth
 * checking before committing to a treatment.
 */
export function barabasiAlbert(n: number, m: number, opts: TopologyOptions = {}): Edge[] {
  if (!Number.isInteger(m) || m < 1) throw new Error(`barabasiAlbert: m must be a positive integer, got ${m}`);
  requireCount("barabasiAlbert", n, m + 1);
  const rng = opts.rng;
  if (!rng) throw new Error("barabasiAlbert: an rng is required, so the graph is reproducible");

  const p = positions(n, opts);
  const edges: Edge[] = [];
  // Repeated-node list: sampling it uniformly IS sampling proportional to
  // degree, which avoids recomputing a distribution per node.
  const targets: number[] = [];

  for (let i = 0; i <= m; i++) {
    for (let j = i + 1; j <= m; j++) {
      edges.push([p[i]!, p[j]!]);
      targets.push(i, j);
    }
  }

  for (let v = m + 1; v < n; v++) {
    const chosen = new Set<number>();
    while (chosen.size < m) {
      chosen.add(targets[randIndex(rng, targets.length)]!);
    }
    for (const t of chosen) {
      edges.push([p[v]!, p[t]!]);
      targets.push(v, t);
    }
  }
  return edges;
}

/**
 * Erdős–Rényi G(n, p): every pair joined independently with probability `p`.
 *
 * Frequently disconnected for small `p` — see the note on `wattsStrogatz`.
 * Expected degree is p*(n-1), which is the number to check against the envelope.
 */
export function erdosRenyi(n: number, p: number, opts: TopologyOptions = {}): Edge[] {
  requireCount("erdosRenyi", n, 2);
  if (!(p >= 0 && p <= 1)) throw new Error(`erdosRenyi: p must be in [0, 1], got ${p}`);
  const rng = opts.rng;
  if (!rng && p > 0 && p < 1) {
    throw new Error("erdosRenyi: an rng is required, so the graph is reproducible");
  }
  const edges: Edge[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      if (p === 1 || (rng && rng() < p)) edges.push([i, j]);
    }
  }
  return edges;
}

/**
 * Random geometric graph: nodes dropped uniformly in the unit square, joined
 * when within `radius` of each other.
 *
 * Produces the clustering that spatial proximity gives you and social ties
 * often have, unlike G(n, p). Disconnection is common below the percolation
 * threshold (roughly radius < sqrt(log n / (pi*n))).
 */
export function geometricRandom(n: number, radius: number, opts: TopologyOptions = {}): Edge[] {
  requireCount("geometricRandom", n, 2);
  if (!(radius > 0 && radius <= Math.SQRT2)) {
    throw new Error(
      `geometricRandom: radius must be in (0, sqrt(2)], got ${radius}; ` +
        `beyond sqrt(2) every pair in a unit square is within range, which is just complete(n)`
    );
  }
  const rng = opts.rng;
  if (!rng) throw new Error("geometricRandom: an rng is required, so the graph is reproducible");

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push(rng());
    ys.push(rng());
  }
  const r2 = radius * radius;
  const edges: Edge[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[i]! - xs[j]!;
      const dy = ys[i]! - ys[j]!;
      if (dx * dx + dy * dy <= r2) edges.push([i, j]);
    }
  }
  return edges;
}

// ------------------------------------------------------------------ arbitrary

/**
 * Normalise an author-supplied edge list: drop self-loops, deduplicate, order
 * each pair, and sort.
 *
 * Worth routing hand-built graphs through this rather than passing them
 * straight to `withNetwork`. A duplicate edge is harmless to `adjacency` but
 * makes `edges.length` misreport the tie count in the recorded data, and the
 * recorded edge list is what analysis reads.
 */
export function fromEdgeList(n: number, edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const [a, b] of edges) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      throw new Error(`fromEdgeList: edge [${a}, ${b}] is not a pair of integers`);
    }
    if (a < 0 || a >= n || b < 0 || b >= n) {
      throw new Error(`fromEdgeList: edge [${a}, ${b}] is outside [0, ${n})`);
    }
    if (a === b) continue;
    const k = key(a, b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a < b ? [a, b] : [b, a]);
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

// ------------------------------------------------------------------ helpers

function requireCount(name: string, n: number, min: number): void {
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name}: n must be an integer >= ${min}, got ${n}`);
  }
}

/** Canonical key for an undirected pair. */
function key(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Uniform integer in [0, n). Local copy so this module stays zero-dependency. */
function randIndex(rng: Rng, n: number): number {
  return Math.floor(rng() * n) % n;
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

/**
 * Connected components, as arrays of node indices.
 *
 * Needed because three of the generators here can legitimately produce a
 * disconnected graph — `erdosRenyi` and `geometricRandom` below their
 * percolation thresholds, and `wattsStrogatz` through rewiring. None of them
 * repairs it silently, so this is how an author checks.
 *
 * Union-find with path compression; linear in practice.
 */
export function components(n: number, edges: Edge[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (const [a, b] of edges) {
    if (a < 0 || a >= n || b < 0 || b >= n) {
      throw new Error(`components: edge [${a}, ${b}] is outside [0, ${n})`);
    }
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()];
}

/**
 * Is every node reachable from every other?
 *
 * An isolated participant is a legitimate result, not an error — which is
 * exactly why `useNeighbors()` distinguishes `[]` from `undefined`. But it is
 * usually not what a study intends, so check before running rather than
 * discovering it in the data.
 *
 * Deliberately NOT enforced by the generators: resampling until connected
 * changes the distribution being sampled from, and that is a decision for
 * whoever has to defend the design.
 */
export function isConnected(n: number, edges: Edge[]): boolean {
  if (n === 0) return true;
  return components(n, edges).length === 1;
}
