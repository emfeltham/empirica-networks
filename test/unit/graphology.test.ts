/**
 * graphology interop.
 *
 * The adapter's job is to hand the graphology ecosystem (metrics, components,
 * gexf, sigma) the *same* graph the module publishes neighborhoods from. So the
 * assertions are about agreement, not about the adapter agreeing with itself:
 * degree sequences are compared against `degrees()`, and the round trip is
 * compared in canonical form against the original edge list.
 *
 * A monitor that renders a graph subtly different from the one participants are
 * actually in would be worse than no monitor, and it is exactly the sort of bug
 * that looks fine on screen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Graph, { DirectedGraph, MultiGraph, UndirectedGraph } from "graphology";
import { complete, degrees, empty, ring, ringLattice, type Edge } from "../../src/topology/index.js";
import {
  TOPOLOGY_INDEX_ATTRIBUTE,
  fromGraphology,
  toGraphology,
} from "../../src/topology/graphology.js";

/** Canonical form, so two edge lists compare regardless of order or endpoint order. */
function canonical(edges: Edge[]): string {
  return edges
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(",");
}

const M1_TOPOLOGIES: Array<[string, number, Edge[]]> = [
  ["ring(20)", 20, ring(20)],
  ["ringLattice(20, 3)", 20, ringLattice(20, 3)],
  ["complete(12)", 12, complete(12)],
  ["empty(8)", 8, empty()],
];

test("round trip: every M1 topology survives toGraphology -> fromGraphology", () => {
  for (const [label, n, edges] of M1_TOPOLOGIES) {
    const { n: n2, edges: edges2 } = fromGraphology(toGraphology(Graph, n, edges));
    assert.equal(n2, n, `${label}: node count preserved`);
    assert.equal(canonical(edges2), canonical(edges), `${label}: edge list preserved`);
  }
});

test("the graphology graph has the degree sequence degrees() reports", () => {
  // The agreement that matters: what a researcher measures with
  // graphology-metrics must be what the module actually wired up.
  for (const [label, n, edges] of M1_TOPOLOGIES) {
    const g = toGraphology(Graph, n, edges);
    const viaGraphology = Array.from({ length: n }, (_, i) => g.degree(String(i)));
    assert.deepEqual(viaGraphology, degrees(n, edges), `${label}: degree sequences agree`);
  }
});

test("order labels nodes by playerID while topologyIndex keeps the position", () => {
  // This is the property the adapter exists to protect. graphology keys by
  // string, so labeling by playerID alone would erase the structural index the
  // reproducibility record depends on.
  const n = 5;
  const order = ["pA", "pB", "pC", "pD", "pE"];
  const edges = ring(n);
  const g = toGraphology(Graph, n, edges, { order });

  assert.deepEqual(g.nodes().sort(), [...order].sort(), "nodes are keyed by playerID");
  for (const [i, id] of order.entries()) {
    assert.equal(g.getNodeAttribute(id, TOPOLOGY_INDEX_ATTRIBUTE), i, `${id} keeps position ${i}`);
  }

  const back = fromGraphology(g);
  assert.deepEqual(back.order, order, "order round-trips in position order");
  assert.equal(canonical(back.edges), canonical(edges), "structure round-trips");
});

test("fromGraphology recovers position from topologyIndex, not insertion order", () => {
  // Insertion order and recorded position are deliberately made to disagree: if
  // the attribute were ignored, `order` would come back as the insertion order
  // and every participant would be seated somewhere other than the record says.
  const g = new Graph();
  g.addNode("pC", { [TOPOLOGY_INDEX_ATTRIBUTE]: 2 });
  g.addNode("pA", { [TOPOLOGY_INDEX_ATTRIBUTE]: 0 });
  g.addNode("pB", { [TOPOLOGY_INDEX_ATTRIBUTE]: 1 });
  g.addUndirectedEdge("pA", "pB");

  const { order, edges, n } = fromGraphology(g);
  assert.equal(n, 3);
  assert.deepEqual(order, ["pA", "pB", "pC"], "seated by recorded index");
  assert.deepEqual(edges, [[0, 1]], "edge expressed in recorded indices");
});

test("fromGraphology falls back to insertion order for a generator-built graph", () => {
  // graphology-generators produce graphs with no topologyIndex. They must still
  // be usable as a topology source, otherwise `erdosRenyi` cannot be borrowed.
  const g = new Graph();
  for (const id of ["x", "y", "z"]) g.addNode(id);
  g.addUndirectedEdge("x", "z");

  const { order, edges } = fromGraphology(g);
  assert.deepEqual(order, ["x", "y", "z"]);
  assert.deepEqual(edges, [[0, 2]]);
});

test("toGraphology applies adjacency()'s cleaning, so the two cannot disagree", () => {
  // Duplicates and self-loops are dropped exactly as adjacency() drops them.
  // Taking the raw edge list instead would let the rendered graph and the
  // published neighborhoods diverge.
  const messy: Edge[] = [
    [0, 1],
    [1, 0], // same undirected edge
    [0, 1], // duplicate
    [2, 2], // self-loop
  ];
  const g = toGraphology(Graph, 3, messy);
  assert.equal(g.size, 1, "one surviving edge");
  assert.equal(g.order, 3, "all nodes present, including the isolated one");
  assert.deepEqual(fromGraphology(g).edges, [[0, 1]]);
});

test("toGraphology rejects out-of-range edges the way adjacency() does", () => {
  assert.throws(() => toGraphology(Graph, 3, [[0, 7]]), /outside \[0, 3\)/);
});

test("toGraphology rejects an order that cannot seat the nodes", () => {
  assert.throws(() => toGraphology(Graph, 3, ring(3), { order: ["a", "b"] }), /order has 2 entries but n is 3/);
  assert.throws(
    () => toGraphology(Graph, 3, ring(3), { order: ["a", "b", "a"] }),
    /duplicate keys/,
  );
});

test("fromGraphology refuses a partially indexed graph", () => {
  const g = new Graph();
  g.addNode("a", { [TOPOLOGY_INDEX_ATTRIBUTE]: 0 });
  g.addNode("b"); // no index
  assert.throws(() => fromGraphology(g), /1 of 2 nodes carry a "topologyIndex" attribute/);
});

test("fromGraphology refuses indices that do not form a seating plan", () => {
  const dup = new Graph();
  dup.addNode("a", { [TOPOLOGY_INDEX_ATTRIBUTE]: 1 });
  dup.addNode("b", { [TOPOLOGY_INDEX_ATTRIBUTE]: 1 });
  assert.throws(() => fromGraphology(dup), /used by more than one node/);

  const oob = new Graph();
  oob.addNode("a", { [TOPOLOGY_INDEX_ATTRIBUTE]: 0 });
  oob.addNode("b", { [TOPOLOGY_INDEX_ATTRIBUTE]: 5 });
  assert.throws(() => fromGraphology(oob), /outside \[0, 2\)/);
});

test("fromGraphology collapses parallel and directed edges to a simple undirected list", () => {
  const g = new MultiGraph();
  for (const id of ["a", "b"]) g.addNode(id);
  g.addUndirectedEdge("a", "b");
  g.addUndirectedEdge("a", "b"); // parallel
  g.addDirectedEdge("b", "a"); // opposite direction
  assert.equal(g.size, 3, "graphology keeps all three");
  assert.deepEqual(fromGraphology(g).edges, [[0, 1]], "we keep one undirected tie");
});

test("UndirectedGraph and MultiGraph work; DirectedGraph is refused", () => {
  for (const Ctor of [Graph, UndirectedGraph, MultiGraph]) {
    const g = toGraphology(Ctor, 6, ring(6));
    assert.equal(g.size, 6, `${Ctor.name} builds the ring`);
  }
  // Not a gap: a directed tie is one-way visibility, which the projection has no
  // way to deliver. Failing loudly beats silently building half a network.
  assert.throws(() => toGraphology(DirectedGraph, 6, ring(6)));
});

test("mixed Graph vs UndirectedGraph changes ratio metrics — the documented trap", () => {
  // Pins the one silent misuse: both graphs hold the same 66 edges, but a mixed
  // graph counts directed slots this module never fills, so a complete graph
  // measures as one third dense. Recomputed here rather than imported from
  // graphology-metrics so the test carries no extra dependency; the formulas are
  // graphology's own (mixed: n(n-1) + n(n-1)/2 potential edges, undirected:
  // n(n-1)/2). If graphology ever makes `Graph` undirected by default, this test
  // fails and the warning at the top of the adapter should be removed with it.
  const n = 12;
  const mixed = toGraphology(Graph, n, complete(n));
  const undirected = toGraphology(UndirectedGraph, n, complete(n));

  assert.equal(mixed.size, undirected.size, "same number of edges either way");
  assert.equal(mixed.type, "mixed");
  assert.equal(undirected.type, "undirected");

  const undirectedDensity = undirected.size / ((n * (n - 1)) / 2);
  const mixedDensity = mixed.size / (n * (n - 1) + (n * (n - 1)) / 2);
  assert.equal(undirectedDensity, 1, "complete graph is fully dense when read as undirected");
  assert.ok(mixedDensity < 0.4, `mixed reads as ${mixedDensity.toFixed(3)}, not 1 — hence the warning`);
});

test("nothing outside the adapter imports graphology", () => {
  // The whole design claim is that the core carries no graph dependency. A
  // stray import in admin/ or player/ would quietly make graphology mandatory
  // for every consumer, and would only surface in someone else's install.
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const adapter = path.join(src, "topology", "graphology.ts");
  const offenders: string[] = [];

  for (const entry of fs.readdirSync(src, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = path.join(entry.parentPath ?? entry.path ?? src, entry.name);
    if (file === adapter) continue;
    if (/from\s+["']graphology/.test(fs.readFileSync(file, "utf8"))) {
      offenders.push(path.relative(src, file));
    }
  }
  assert.deepEqual(offenders, [], "only src/topology/graphology.ts may reference graphology");
});

test("the adapter imports graphology for types only", () => {
  // `import type` is erased at build time. If this ever becomes a value import,
  // graphology stops being optional and becomes a real runtime dependency.
  const adapter = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/topology/graphology.ts",
  );
  const source = fs.readFileSync(adapter, "utf8");
  const imports = source.match(/^import\s+.*?from\s+["']graphology.*?["'];?$/gm) ?? [];
  assert.ok(imports.length > 0, "the adapter does reference graphology types");
  for (const line of imports) {
    assert.match(line, /^import\s+type\s/, `must be a type-only import: ${line}`);
  }
});
