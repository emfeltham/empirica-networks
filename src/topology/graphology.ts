/**
 * Interop with graphology (https://graphology.github.io).
 *
 * This module exists because of what graphology *does* have, not what it
 * replaces. Its generators cover four of our sixteen topologies and include
 * neither wattsStrogatz nor barabasiAlbert, so there was nothing to adopt on
 * that side. What it does have, and what this package will never hand-roll, is
 * the analysis and rendering ecosystem: graphology-metrics, -components,
 * -shortest-path, -communities-louvain, the gexf/graphml writers (Gephi), and
 * sigma.js, which consumes a graphology Graph natively.
 *
 * The constructor is INJECTED rather than imported, which is graphology's own
 * convention for its generators (`complete(Graph, order)`). Three consequences,
 * all of them the point:
 *
 *   1. This package gains no dependency on graphology at all — not even an
 *      optional peer. Nothing here is imported at runtime.
 *   2. There is no dual-instance hazard. The graph is built by the caller's own
 *      constructor, so their `instanceof` checks and their graphology-* helpers
 *      all agree with it.
 *   3. The caller chooses the flavour: Graph, UndirectedGraph, MultiGraph and
 *      MultiUndirectedGraph all work. `DirectedGraph` throws a graphology
 *      UsageGraphError, which is the correct outcome rather than a gap — this
 *      module's model is a simple undirected graph, and a directed tie would be
 *      visible in one direction only, which `adjacency()` cannot express and the
 *      projection could not deliver.
 *
 * PASS `UndirectedGraph`, NOT `Graph`.
 *
 * This is the one way to misuse the adapter and get no error, only a wrong
 * number. graphology's default `Graph` is *mixed*, so ratio metrics size their
 * denominator to n(n-1) directed slots plus n(n-1)/2 undirected ones — slots
 * this module never fills. Measured 2026-08-15 with graphology@0.26.0 and
 * graphology-metrics@2.4.0:
 *
 *   toGraphology(Graph,           12, complete(12))  ->  density 0.333
 *   toGraphology(UndirectedGraph, 12, complete(12))  ->  density 1.000
 *
 * Both graphs hold the same 66 edges; only the denominator differs. 0.333 for a
 * complete graph is wrong but entirely plausible-looking, and nothing in
 * graphology or here will flag it — which is why it is stated at the top of the
 * file rather than in a footnote. `test/unit/graphology.test.ts` pins the
 * discrepancy so it cannot be quietly documented away.
 *
 * The graphology types are imported as `import type`, so they are erased at
 * build time and a consumer who never imports this subpath never needs the
 * package installed.
 */
import type Graph from "graphology";
import { adjacency, type Edge } from "./index.js";

/**
 * The subset of a graphology constructor this module uses.
 *
 * Deliberately structural rather than `typeof Graph`: it accepts the whole
 * family (Graph, UndirectedGraph, MultiGraph, ...) without the caller having to
 * cast, and it does not pin a graphology major version.
 */
export type GraphConstructor = new () => Graph;

/**
 * Node attribute carrying the structural position.
 *
 * This is the whole reason the adapter is more than three lines. This package
 * keeps structural index (`number`) and participant identity (`order[i]`)
 * separate — the seed permutes who sits where, never the structure, which is
 * what makes seed + edge list a complete record of a run. graphology keys nodes
 * by string, so labelling by playerID would destroy that distinction. Writing
 * the index as an attribute keeps both, and makes the round trip exact.
 */
export const TOPOLOGY_INDEX_ATTRIBUTE = "topologyIndex";

export interface ToGraphologyOptions {
  /**
   * Node keys in topology order — i.e. `NetworkState.order`, the playerID
   * occupying each structural position. Defaults to `String(i)`.
   */
  order?: string[];
}

/**
 * Build a graphology graph from an edge list.
 *
 * ```ts
 * import { UndirectedGraph } from "graphology";
 * import { density } from "graphology-metrics/graph/index.js";
 * import { ring } from "empirica-networks/topology";
 * import { toGraphology } from "empirica-networks/topology/graphology";
 *
 * const g = toGraphology(UndirectedGraph, 20, ring(20), { order });
 * density(g);
 * ```
 *
 * Note the explicit `/index.js`: graphology-metrics ships no `exports` map, so
 * bare Node ESM rejects the bare directory subpath with ERR_UNSUPPORTED_DIR_IMPORT
 * — the same packaging failure documented in PLATFORM-NOTES §3a for
 * cross-fetch/polyfill. Bundlers resolve it either way; plain `node` does not.
 *
 * Edges are taken from `adjacency()` rather than from the raw list, so this
 * graph is by construction the same one the module publishes neighbourhoods
 * from: same deduplication, same dropped self-loops, same out-of-range error.
 * Reading the raw list instead would let the two disagree — and a graph that
 * renders in the monitor differently from the one participants are in is worse
 * than no monitor.
 */
export function toGraphology(
  GraphCtor: GraphConstructor,
  n: number,
  edges: Edge[],
  opts: ToGraphologyOptions = {},
): Graph {
  const { order } = opts;
  if (order && order.length !== n) {
    throw new Error(`toGraphology: order has ${order.length} entries but n is ${n}`);
  }

  const key = (i: number): string => order?.[i] ?? String(i);

  // Reject duplicate keys up front. graphology would throw on the second
  // addNode, but only after building a partial graph, and its message names the
  // key without saying that the caller's `order` is what produced it.
  if (order) {
    const seen = new Set(order);
    if (seen.size !== order.length) {
      throw new Error("toGraphology: order contains duplicate keys; each node needs a distinct key");
    }
  }

  const graph = new GraphCtor();
  for (let i = 0; i < n; i++) {
    graph.addNode(key(i), { [TOPOLOGY_INDEX_ATTRIBUTE]: i });
  }

  // adjacency() validates range, dedupes and drops self-loops. Emitting only
  // i < j turns its symmetric lists back into each undirected edge exactly once.
  const adj = adjacency(n, edges);
  for (let i = 0; i < n; i++) {
    for (const j of adj[i]!) {
      if (i < j) graph.addUndirectedEdge(key(i), key(j));
    }
  }
  return graph;
}

export interface FromGraphologyResult {
  n: number;
  edges: Edge[];
  /** Node key occupying each structural position. */
  order: string[];
}

/**
 * Read a graphology graph back into this package's representation.
 *
 * Directed edges are collapsed to undirected and parallel edges are deduped,
 * because the module's model is a simple undirected graph — a directed edge
 * would otherwise become a tie visible in one direction only, which is not
 * something `adjacency()` can express and not something the projection could
 * deliver.
 *
 * Node order comes from the `topologyIndex` attribute when every node carries
 * one (so `toGraphology` round-trips exactly), and from graphology's insertion
 * order otherwise (so a graph built by graphology-generators still works).
 */
export function fromGraphology(graph: Graph): FromGraphologyResult {
  const nodes = graph.nodes();
  const n = nodes.length;

  const indices = nodes.map((node) => graph.getNodeAttribute(node, TOPOLOGY_INDEX_ATTRIBUTE));
  const withIndex = indices.filter((v) => v !== undefined).length;

  // All or nothing. A partially-indexed graph has no defensible reading: mixing
  // recorded positions with insertion order would silently seat some
  // participants somewhere other than where the record says.
  if (withIndex !== 0 && withIndex !== n) {
    throw new Error(
      `fromGraphology: ${withIndex} of ${n} nodes carry a "${TOPOLOGY_INDEX_ATTRIBUTE}" attribute; ` +
        `expected all or none`,
    );
  }

  const order: string[] = new Array(n);
  if (withIndex === n) {
    for (const [at, node] of nodes.entries()) {
      const i = indices[at];
      if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= n) {
        throw new Error(
          `fromGraphology: node "${node}" has ${TOPOLOGY_INDEX_ATTRIBUTE}=${String(i)}, outside [0, ${n})`,
        );
      }
      if (order[i as number] !== undefined) {
        throw new Error(`fromGraphology: ${TOPOLOGY_INDEX_ATTRIBUTE}=${String(i)} is used by more than one node`);
      }
      order[i as number] = node;
    }
  } else {
    for (const [i, node] of nodes.entries()) order[i] = node;
  }

  const indexOf = new Map(order.map((node, i) => [node, i]));

  // Dedupe here rather than leaning on adjacency(): a MultiGraph can carry
  // parallel edges and a mixed graph can carry both directions of the same
  // pair, and the caller should get back a list they can compare directly.
  const seen = new Set<string>();
  const edges: Edge[] = [];
  graph.forEachEdge((_edge, _attr, source, target) => {
    const a = indexOf.get(source)!;
    const b = indexOf.get(target)!;
    if (a === b) return;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(a < b ? [a, b] : [b, a]);
  });

  return { n, edges, order };
}
