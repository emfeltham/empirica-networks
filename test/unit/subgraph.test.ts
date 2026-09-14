/**
 * The closed neighborhood, in local indices.
 *
 * The assertions that matter here are about IDENTITY, not geometry: a subgraph
 * whose indices are off by one still draws a complete, plausible network, and
 * nothing downstream can tell. So the cases below are mostly about the ways the
 * delivered neighbor list differs from the adjacency list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { adjacency } from "../../src/topology/index.js";
import { edgeKey, inducedEdges } from "../../src/admin/subgraph.js";

/**
 * Ties not incident to the viewer — what radius 1.5 adds over a star.
 *
 * Spelled out here rather than imported. `subgraph.ts` used to export this and
 * nothing in `src/` ever called it: both places that need the count —
 * `src/verify/leak_test.ts` and `test/e2e/subgraph.test.ts` — tally it while
 * validating each edge, so they must count the ones that survived validation
 * rather than the whole array. An exported helper neither could use, whose
 * docstring claimed the e2e test failed on it, was worse than three lines.
 */
const beyondStar = (edges: Array<[number, number]>) =>
  edges.filter(([a, b]) => a !== 0 && b !== 0).length;

test("a triangle: the tie between the two neighbors is the thing radius 1.5 adds", () => {
  // 0-1, 1-2, 0-2. Viewer 0 sees 1 and 2, and at radius 1.5 also 1-2.
  const adj = adjacency(3, [
    [0, 1],
    [1, 2],
    [0, 2],
  ]);
  const edges = inducedEdges(adj, [0, 1, 2]);
  assert.equal(edgeKey(edges), "0-1 0-2 1-2");
  assert.equal(beyondStar(edges), 1, "exactly one tie beyond the star");
});

test("a star: radius 1.5 adds nothing, and says so", () => {
  // Hub 0 with three leaves. The leaves are not tied to each other.
  const adj = adjacency(4, [
    [0, 1],
    [0, 2],
    [0, 3],
  ]);
  const edges = inducedEdges(adj, [0, 1, 2, 3]);
  assert.equal(edgeKey(edges), "0-1 0-2 0-3");
  assert.equal(
    beyondStar(edges),
    0,
    "a run where this is zero everywhere published the channel and put nothing in it"
  );
});

test("edges to nodes OUTSIDE the neighborhood are not in it", () => {
  // 0-1, 1-2. Viewer 0's neighborhood is {0,1}; 1-2 leaves it and must not
  // appear — it is a fact about a participant the viewer cannot see.
  const adj = adjacency(3, [
    [0, 1],
    [1, 2],
  ]);
  assert.equal(edgeKey(inducedEdges(adj, [0, 1])), "0-1");
});

test("local indices follow the DELIVERED list, not the adjacency list", () => {
  // The silent one. Viewer 0 is adjacent to 1, 2 and 3, but 2 was dropped —
  // their player is gone, or project() returned undefined. The delivered
  // neighbors are therefore [1, 3], so 3 is local index 2.
  const adj = adjacency(4, [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 3],
  ]);
  const edges = inducedEdges(adj, [0, 1, 3]);
  assert.equal(edgeKey(edges), "0-1 0-2 1-2");

  // Had the mapping come from adj[0] = [1,2,3], the 1-3 tie would have been
  // emitted as local 1-3 — an index nobody was sent, drawn between the wrong
  // people or dropped. Both are a correct-looking picture of another graph.
  assert.ok(
    !edgeKey(edges).includes("1-3"),
    "a dropped neighbor must renumber everyone after it"
  );
});

test("a viewer with no neighbors, and a viewer with one", () => {
  const adj = adjacency(2, [[0, 1]]);
  assert.deepEqual(inducedEdges(adj, [0]), [], "isolated is a real answer");
  assert.equal(edgeKey(inducedEdges(adj, [0, 1])), "0-1");
});

test("every pair appears once, whichever way the adjacency lists it", () => {
  const adj = adjacency(3, [
    [0, 1],
    [1, 2],
    [0, 2],
  ]);
  const edges = inducedEdges(adj, [0, 1, 2]);
  assert.equal(edges.length, 3, "a tie is stored on both endpoints and must emit once");
  for (const [a, b] of edges) assert.ok(a < b, "normalized so the key is stable");
});

test("a repeated or self-adjacent node is dropped, not drawn", () => {
  // Both are server bugs. A throw here would take the whole game's views down;
  // an impossible tie omitted from one drawing will not.
  const adj = adjacency(3, [
    [0, 1],
    [1, 2],
  ]);
  const edges = inducedEdges(adj, [0, 1, 1, 2]);
  for (const [a, b] of edges) assert.notEqual(a, b, "no self-loop");
  assert.ok(edges.length > 0, "the legitimate ties still survive the bad entry");
});

test("edgeKey ignores order, so a rewire to the same graph is not a shape change", () => {
  assert.equal(
    edgeKey([
      [1, 2],
      [0, 1],
    ]),
    edgeKey([
      [0, 1],
      [1, 2],
    ]),
    "recomputing a layout for an unchanged graph moves every node for no reason"
  );
});
