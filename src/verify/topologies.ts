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
  ringLattice,
  star,
  wheel,
  type Edge,
  type Radius,
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
  /**
   * Ties the structure payload should carry in total, summed over participants.
   *
   * The completeness denominator at ANY radius, where `expectedBeyondStar` is
   * only meaningful at 1.5. At 1.5 the two are related — this is that plus one
   * per neighbor — and above it neither the star nor the beyond-star split says
   * anything useful, because most ties are then incident to neither the viewer
   * nor another neighbor.
   */
  expectedStructureTies: number;
  /**
   * People delivered who are NOT the viewer's own neighbors, summed over
   * participants. Zero at radius 1 and 1.5, where the ball is exactly the
   * viewer and their neighbors.
   */
  expectedFar: number;
  /**
   * What this radius delivers that the step below it does not.
   *
   * The non-vacuity denominator, generalized. `prev(1.5)` is 1 and `prev(2)` is
   * 1.5, so at 1.5 the edge half of this IS `expectedBeyondStar` and the node
   * half is zero — a half step adds ties, never people. Zero means the setting
   * shows this particular graph nothing that the step below already showed it,
   * which is a property of the graph rather than of the setting.
   */
  expectedIncrement: { nodes: number; edges: number };
  /** Indices who may learn about everybody. They contribute nothing to arm 1. */
  saturated: number[];
  /** Indices who may learn about nobody. They contribute nothing to arm 3. */
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
/**
 * What radius `r` should deliver to viewer `i`, computed WITHOUT `ball()`.
 *
 * Deliberately a second implementation, and that is the whole reason it exists.
 * `ball()` is the function the server uses to decide what to send; using it here
 * to decide what should have been sent makes the structural arms a check of the
 * publish path against itself, and a bug inside `ball()` moves both sides
 * together and passes. Measured: breaking `ball()`'s edge filter and running
 * `verify --n 8 --topology ring --radius 2` reported 32/32 ties and PASS.
 *
 * So the two disagree by construction. `ball()` is a FIFO walk carrying a
 * distance array; this grows shells by set union and never computes a distance
 * at all — a node's shell index IS its distance, and the edge rule reads off
 * shell membership. Same contract, different shape, so one being wrong shows up
 * as the two disagreeing rather than as both agreeing about the wrong answer.
 *
 * This is not the duplicate-type mistake O21 records. That was one FACT written
 * down twice, where the copies drifted apart silently and nothing compared them.
 * This is one fact computed twice ON PURPOSE, by a tool whose entire job is to
 * compare them, and the comparison is the product.
 */
/**
 * Everyone within `radius` of `i`, by the same shell walk and for the same
 * reason. Exported because `leak_test.ts` needs the SET where the accounting
 * needs the count, and a third implementation would be one more thing to keep
 * honest without buying any more independence — both are already independent of
 * the function under test, which is the property that matters.
 */
export function reachableWithin(adj: number[][], i: number, radius: Radius): number[] {
  return [...shellsOf(adj, i, radius).reached].filter((v) => v !== i);
}

function shellsOf(
  adj: number[][],
  i: number,
  radius: Radius
): { reached: Set<number>; shells: Array<Set<number>>; depth: number; induced: boolean } {
  const n = adj.length;
  const depth = radius === "whole" ? n : Math.floor(radius as number);
  const induced = radius === "whole" || (radius as number) > Math.floor(radius as number);

  // Shell k is everyone first reached in k steps. Membership, not distance.
  const shells: Array<Set<number>> = [new Set([i])];
  const reached = new Set([i]);
  while (shells.length - 1 < depth) {
    const next = new Set<number>();
    for (const v of shells[shells.length - 1]!) {
      for (const u of adj[v] ?? []) if (!reached.has(u)) next.add(u);
    }
    if (next.size === 0) break;
    for (const u of next) reached.add(u);
    shells.push(next);
  }
  if (radius === "whole") for (let v = 0; v < n; v++) reached.add(v);

  return { reached, shells, depth, induced };
}

function expectedFor(
  adj: number[][],
  i: number,
  radius: Radius
): { nodes: number; edges: number } {
  const { reached, shells, depth, induced } = shellsOf(adj, i, radius);
  const shellOf = (v: number): number => {
    for (let k = 0; k < shells.length; k++) if (shells[k]!.has(v)) return k;
    return Infinity;
  };

  let edges = 0;
  for (const v of reached) {
    for (const u of adj[v] ?? []) {
      if (u <= v || !reached.has(u)) continue;
      // An edge is delivered when the half step includes everything induced, or
      // when one of its ends sits in a shell nearer than the outermost one.
      if (induced || shellOf(v) < depth || shellOf(u) < depth) edges++;
    }
  }
  return { nodes: reached.size, edges };
}

/**
 * The setting one step below this one: `k.5` sits on `k`, and `k` sits on
 * `(k-1).5`. `1.5` sits on `1`, which is the floor.
 *
 * `"whole"` has no step below it that can be named — it is whatever the graph
 * happens to be — so it is compared against the star, which makes the vacuity
 * question "does anybody see anyone they are not connected to".
 */
function stepBelow(radius: Radius): Radius {
  if (radius === "whole" || radius <= 1.5) return 1;
  return Number.isInteger(radius) ? (radius as number) - 0.5 : Math.floor(radius as number);
}

/** `1.5` rather than `"1.5"`, and `whole` without quotes, in a sentence. */
const fmt = (r: Radius): string => (r === "whole" ? "whole" : String(r));

export function accountVacuity(
  n: number,
  edges: Edge[],
  radius: Radius = 1,
  /**
   * Does the run project at distance?
   *
   * It changes who arm 1 and arm 3 are about, and nothing else. Without it the
   * data rule is still "neighbors only" however wide the radius is — a wider
   * radius discloses topology, and topology carries nobody's attributes — so the
   * denominators stay degree-based and every number this function returned
   * before `projectFar` existed is unchanged. With it, the permitted set for
   * DATA becomes the ball, and the two arms have to be about that instead.
   */
  projectsFar = false
): VacuityAccounting {
  const adj = adjacency(n, edges);
  const saturated: number[] = [];
  const isolated: number[] = [];
  let candidatePairs = 0;
  let expectedDeliveries = 0;

  for (let i = 0; i < n; i++) {
    // Who may this participant learn something ABOUT? Their neighbors, unless
    // the study projects at distance, in which case everyone in their ball.
    const reach = projectsFar
      ? expectedFor(adj, i, radius).nodes - 1
      : adj[i]?.length ?? 0;
    const beyond = n - 1 - reach;
    candidatePairs += beyond;
    expectedDeliveries += reach;
    if (beyond === 0) saturated.push(i);
    if (reach === 0) isolated.push(i);
  }

  const expectedBeyondStar = countBeyondStar(adj);
  let expectedStructureTies = 0;
  let expectedFar = 0;
  const expectedIncrement = { nodes: 0, edges: 0 };
  if (radius !== 1) {
    const below = stepBelow(radius);
    for (let i = 0; i < n; i++) {
      const at = expectedFor(adj, i, radius);
      expectedStructureTies += at.edges;
      expectedFar += at.nodes - 1 - (adj[i]?.length ?? 0);
      // `below` is 1 for 1.5, where the star is drawn from the view array and
      // no structure is sent at all — so the increment there is the whole
      // payload, which is what makes `expectedBeyondStar` and this agree.
      const under = expectedFor(adj, i, below);
      expectedIncrement.nodes += at.nodes - under.nodes;
      expectedIncrement.edges += at.edges - under.edges;
    }
  }

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
  if (radius !== 1 && expectedIncrement.nodes === 0 && expectedIncrement.edges === 0) {
    const below = stepBelow(radius);
    failures.push(
      `VACUOUS at radius ${fmt(radius)}: it delivers nothing on this graph that ` +
        `radius ${fmt(below)} does not, so the run would pass without the setting ` +
        `having done anything. Whether it shows anything is a property of the ` +
        `graph, not of the setting.\n` +
        (Number.isInteger(radius as number)
          ? `  At an integer radius the usual cause is that everybody is already ` +
            `within reach: try more participants, or a shape with a larger diameter.\n`
          : `  At a half step the usual cause is that nobody has two people at the ` +
            `outer edge who are connected to each other: try --topology ringLattice, ` +
            `or a shape with triangles at that depth.\n`) +
        `  Or pass your study's own generator to runLeakCheck().`
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
    expectedStructureTies,
    expectedFar,
    expectedIncrement,
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
 * entry halves. Shapes that need a further parameter are not here — `grid`,
 * `wattsStrogatz`, `barabasiAlbert`, `erdosRenyi` and `geometricRandom` all take
 * one and a command line has nowhere to put it; they are reachable by handing
 * `runLeakCheck` the same generator function a study hands `withNetwork`.
 *
 * ONE EXCEPTION, AND THE PARAMETER IT FIXES IS NAMED. `ringLattice` is here at
 * `m = 2`, because without it `--radius 1.5` had exactly one usable subject.
 * Every other shape a flag can name is triangle-free — `ring`, `star`, `pairs`
 * and `ladder` — or refused for having no non-neighbor, which leaves `wheel`
 * alone, and a verification tool with one subject is one shape away from having
 * none. The alternatives do not work: `barabasiAlbert` and `geometricRandom`
 * both REFUSE to build without an rng, which the next paragraph explains this
 * table cannot supply, and `wattsStrogatz(n, k, 0)` is a ring lattice under a
 * longer name. `m = 2` is the smallest value that produces a triangle at all,
 * and it needs n >= 5.
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
  // Each node tied to its two nearest on each side, so every neighborhood holds
  // a triangle. The `m` is fixed at 2 and said so above; `ringLattice(n, 2)`
  // needs n >= 5 or the ring wraps onto itself, and the generator's own error
  // says that.
  ringLattice: (n) => ringLattice(n, 2),
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
  radius: Radius = 1
): { edges: Edge[] } | { refusal: string } {
  const build = CLI_TOPOLOGIES[name];
  if (!build) {
    return {
      refusal:
        `unknown topology "${name}". Known: ${CLI_TOPOLOGY_NAMES.join(", ")}.\n` +
        `  Parameterised generators (grid, wattsStrogatz, barabasiAlbert, erdosRenyi,\n` +
        `  geometricRandom) take an argument a flag cannot carry — pass the generator to\n` +
        `  runLeakCheck() instead. \`ringLattice\` is named above with its m fixed at 2.`,
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
