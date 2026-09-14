/**
 * What a graph lets the leak check establish, and the shapes its CLI can name.
 *
 * Its own module, importing nothing but `../topology/index.js`, for the same
 * reason `src/shared/wait.ts` exists: `verify/cli.ts` imports
 * `@empirica/core/console` and calls `main()` at module scope, and
 * `verify/leak_test.ts` reaches `@empirica/core/admin`, so neither can be loaded
 * from the unit tier at all (PLATFORM-NOTES §3a). That is why
 * `test/unit/cli_version.test.ts` has to assert against CLI source *text*.
 * Accounting that decides whether a verification result means anything should
 * not be reachable only through a bundler.
 *
 * THE ACCOUNTING. Three of the leak check's arms have a denominator that the
 * graph fixes before the run starts:
 *
 *   arm 1 (candidate)    — how many non-neighbor pairs are there to examine?
 *   arm 3 (non-vacuity)  — how many neighbor sentinels should arrive?
 *   arm 5 (structure)    — how many ties BETWEEN a participant's own neighbors
 *                          should be delivered, at radius 1.5?
 *
 * Summed over participants the first two are `candidatePairs` and
 * `expectedDeliveries`, and they partition every ordered pair:
 * `candidatePairs + expectedDeliveries` is always `n(n-1)`. So each arm is
 * vacuous exactly when its own denominator is zero, and stating the rule on the
 * denominators rather than on node classes is both shorter and checkable — the
 * identity above is a unit invariant over every generator in
 * `docs/TOPOLOGIES.md`.
 *
 * The third, `expectedBeyondStar`, is not part of that partition and is zero for
 * most shapes, which is why the RADIUS is an input here rather than something
 * checked afterwards. A ring is a fine subject at radius 1 and a useless one at
 * 1.5: it has no ties among anyone's neighbors, so the extra structure is empty
 * and the run would pass having demonstrated nothing. Whether the setting shows
 * a participant anything is a property of the graph.
 *
 * A participant can be excused from either arm without the run being spoiled:
 *
 *   - SATURATED (no non-neighbors) — a star's hub, every node of `complete`.
 *   - ISOLATED (no neighbors) — `empty()`, or `erdosRenyi`/`geometricRandom`/
 *     `wattsStrogatz` below their percolation thresholds.
 *
 * Neither is a fault; both are legitimate shapes a study may run, so they are
 * counted and reported. It is only when a denominator reaches zero that the run
 * proves nothing, and the repo already treats that as a failure rather than a
 * pass: `test/e2e/shirado2017.test.ts:173` asserts its own leak count is above
 * zero precisely "because the graph is complete, so there was no leak to detect".
 */
import {
  adjacency,
  complete,
  ladder,
  pairs,
  ring,
  star,
  wheel,
  type Edge,
} from "../topology/index.js";

export interface VacuityAccounting {
  n: number;
  /**
   * Ties BETWEEN a participant's own neighbors, summed over participants.
   *
   * The denominator for the structural arms, and the quantity that decides
   * whether a `--radius 1.5` run can establish anything. Counted per DELIVERY
   * rather than per tie: a tie with three common neighbors is three deliveries,
   * because three participants are each told about it.
   *
   * Zero for most shapes, and that is the point. A ring has no ties among
   * anyone's neighbors at all — your two neighbors sit on opposite sides of you
   * — so radius 1.5 on a ring draws exactly the star radius 1 draws. Whether
   * this setting shows a participant anything is a property of the graph, not
   * of the setting, and a run on a triangle-free graph would pass while
   * demonstrating nothing.
   */
  expectedBeyondStar: number;
  /** Indices with no non-neighbor. They contribute nothing to arm 1. */
  saturated: number[];
  /** Indices with no neighbor. They contribute nothing to arm 3. */
  isolated: number[];
  /** Ordered non-neighbor pairs arm 1 will examine. Zero means arm 1 is vacuous. */
  candidatePairs: number;
  /** Neighbor sentinel deliveries arm 3 expects. Zero means arm 3 is vacuous. */
  expectedDeliveries: number;
  /** Reasons this graph cannot establish the guarantee. Empty is the usual case. */
  failures: string[];
  /** What the run could not speak to, said out loud rather than left implicit. */
  notes: string[];
}

/**
 * `radius` is the one the run will be made at. It changes what counts as
 * vacuous, not what is measured: the counts are computed either way so the
 * report can state them, and only the failure is conditional.
 */
export function accountVacuity(n: number, edges: Edge[], radius = 1): VacuityAccounting {
  const adj = adjacency(n, edges);
  const saturated: number[] = [];
  const isolated: number[] = [];
  let candidatePairs = 0;
  let expectedDeliveries = 0;

  for (let i = 0; i < n; i++) {
    const degree = adj[i]?.length ?? 0;
    const nonNeighbors = n - 1 - degree;
    candidatePairs += nonNeighbors;
    expectedDeliveries += degree;
    if (nonNeighbors === 0) saturated.push(i);
    if (degree === 0) isolated.push(i);
  }

  const expectedBeyondStar = countBeyondStar(adj);

  const failures: string[] = [];
  const notes: string[] = [];

  // Stated on the denominators, not on the node classes: `candidatePairs === 0`
  // is the same statement as "every participant is saturated", and it is the one
  // that reads as the reason rather than as a symptom.
  if (candidatePairs === 0) {
    failures.push(
      `VACUOUS: every participant is adjacent to every other, so there is no ` +
        `non-neighbor whose state could leak. A pass here would mean nothing.`
    );
  }
  if (expectedDeliveries === 0) {
    failures.push(
      `VACUOUS: the graph has no edges, so no neighbor sentinel was ever expected ` +
        `to arrive. A pass here would not show the projection ran at all.`
    );
  }
  // Stated on its own denominator, exactly like the two above. A triangle-free
  // graph is a perfectly good graph and a perfectly useless subject for this
  // arm: radius 1.5 on it delivers the same star radius 1 does, so the run
  // would pass without the feature having done anything.
  if (radius > 1 && expectedBeyondStar === 0) {
    failures.push(
      `VACUOUS at radius 1.5: no participant has two neighbors who are connected ` +
        `to each other, so the extra structure is empty and radius 1.5 draws the ` +
        `same star radius 1 draws. Whether this setting shows anything is a ` +
        `property of the graph: try --topology wheel, or pass your study's own ` +
        `generator to runLeakCheck().`
    );
  }

  if (saturated.length > 0 && candidatePairs > 0) {
    notes.push(
      `${saturated.length} of ${n} participants are adjacent to everyone (index ` +
        `${saturated.join(", ")}), so arm 1 says nothing about them — that is the ` +
        `shape, not a fault`
    );
  }
  if (isolated.length > 0 && expectedDeliveries > 0) {
    notes.push(
      `${isolated.length} of ${n} participants have no neighbor (index ` +
        `${isolated.join(", ")}), so arm 3 expects nothing from them — the graph ` +
        `is disconnected, which some generators do by design`
    );
  }

  return {
    n,
    saturated,
    isolated,
    candidatePairs,
    expectedDeliveries,
    expectedBeyondStar,
    failures,
    notes,
  };
}

/**
 * Deliveries of a tie that is not incident to the viewer, summed over viewers.
 *
 * Pure over the adjacency, and separate from `accountVacuity` so the quantity
 * can be asserted on its own: it is the denominator the structural arms are
 * judged against, and a denominator computed inside the thing it judges is not
 * a denominator.
 */
export function countBeyondStar(adj: number[][]): number {
  let total = 0;
  for (const neighbors of adj) {
    const inside = new Set(neighbors);
    for (const a of neighbors) {
      for (const b of adj[a] ?? []) {
        // `b > a` counts each pair once; `inside.has(b)` keeps only ties whose
        // BOTH ends the viewer can see.
        if (b > a && inside.has(b)) total++;
      }
    }
  }
  return total;
}

/**
 * The shapes `verify --topology` can name.
 *
 * Each entry is a function of the PARTICIPANT count, which is not the same as
 * the generator's own first argument: `ladder(n)` builds `2n` nodes, so its
 * entry halves. Only shapes that need no further parameter are here; `grid`,
 * `ringLattice`, `wattsStrogatz`, `barabasiAlbert`, `erdosRenyi` and
 * `geometricRandom` all take one, and a command line has nowhere to put it —
 * they are reachable by handing `runLeakCheck` the same generator function a
 * study hands `withNetwork`.
 *
 * NO `rng` IS FORWARDED, deliberately. Every generator here is deterministic in
 * structure; an rng would only permute which index sits where (`positions`, in
 * `../topology/index.ts`). `withNetwork` seeds from `hashSeed(String(game.id))`
 * and the game id is fresh every run, so forwarding it would make the realized
 * graph differ run to run — and a verification tool whose subject changes
 * between runs cannot be used to attribute a failure.
 */
export const CLI_TOPOLOGIES: Record<string, (n: number) => Edge[]> = {
  ring: (n) => ring(n),
  star: (n) => star(n),
  wheel: (n) => wheel(n),
  pairs: (n) => pairs(n),
  complete: (n) => complete(n),
  // Wrapped rather than passed through: `ladder(n / 2)` on an odd n reports
  // "n must be an integer >= 2, got 2.5", naming a number the user never typed.
  ladder: (n) => {
    if (n % 2 !== 0) {
      throw new Error(`ladder: needs an even participant count, got ${n} (a ladder is two rails wide)`);
    }
    return ladder(n / 2);
  },
};

export const CLI_TOPOLOGY_NAMES = Object.keys(CLI_TOPOLOGIES).sort();

/**
 * Build a named topology and decide whether it is worth booting a server for.
 *
 * Possible only for the NAMED form, and the asymmetry is worth knowing: these
 * are pure over `n`, so the whole graph is knowable before anything starts. A
 * caller-supplied generator has the signature `NetworkConfig.topology` has, which
 * takes `game`, `players` and `rng` — none of which exist until game start — so
 * that path can only be judged after the fact.
 */
export function preflightCliTopology(
  name: string,
  n: number,
  radius = 1
): { edges: Edge[] } | { refusal: string } {
  const build = CLI_TOPOLOGIES[name];
  if (!build) {
    return {
      refusal:
        `unknown topology "${name}". Known: ${CLI_TOPOLOGY_NAMES.join(", ")}.\n` +
        `  Parameterised generators (grid, ringLattice, wattsStrogatz, barabasiAlbert,\n` +
        `  erdosRenyi, geometricRandom) take an argument a flag cannot carry — pass the\n` +
        `  generator to runLeakCheck() instead.`,
    };
  }

  let edges: Edge[];
  try {
    edges = build(n);
  } catch (e) {
    return { refusal: `${name} cannot be built at n=${n}: ${e instanceof Error ? e.message : String(e)}` };
  }

  // The same accounting the run itself uses, so a shape that could not prove
  // anything is refused in milliseconds rather than after a server boot. This is
  // general rather than a list of known-bad names: it catches `complete` at every
  // n, `wheel` at n=4 (which is K4), and whatever is added next.
  const account = accountVacuity(n, edges, radius);
  if (account.failures.length > 0) {
    return { refusal: `${name} of ${n} would prove nothing: ${account.failures.join(" ")}` };
  }
  return { edges };
}
