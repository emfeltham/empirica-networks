/**
 * The ball: who a participant can see at radius r, and which ties among them.
 *
 * The claim worth testing hardest is the HALF-STEP RULE, because it is the one
 * thing that cannot be observed from the outside once it is wrong. `k` and `k.5`
 * deliver the same PEOPLE and differ only in whether the outermost ring's
 * internal ties come too — so a build that ignored the fraction would draw a
 * complete, plausible, slightly-too-generous network, and every count downstream
 * would agree with it. The cases below therefore compare 2 against 2.5 on a graph
 * built so the difference is exactly one tie.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  adjacency,
  ball,
  complete,
  ladder,
  ring,
  ringLattice,
  star,
  wheel,
} from "../../src/topology/index.js";
import { inducedEdges } from "../../src/admin/subgraph.js";

/** 0-1-2-3-4-0 with a chord 1-4, so node 0's two neighbors are tied. */
const CHORD = adjacency(5, [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 0],
  [1, 4],
]);

test("radius 1 is a star: the viewer's own ties and nothing else", () => {
  const b = ball(CHORD, 0, 1);
  assert.deepEqual(b.nodes, [0, 1, 4]);
  assert.deepEqual(b.edges, [
    [0, 1],
    [0, 4],
  ]);
  // The 1-4 chord is inside the node set and still not delivered: at radius 1 a
  // tie between two of your neighbors is not yours to see.
  assert.equal(b.eccentricityWithin, 1);
});

test("radius 1.5 adds the tie between two neighbors, and no new people", () => {
  const one = ball(CHORD, 0, 1);
  const half = ball(CHORD, 0, 1.5);
  assert.deepEqual(half.nodes, one.nodes, "the same people");
  assert.deepEqual(half.edges, [
    [0, 1],
    [0, 4],
    [1, 4],
  ]);
});

/**
 * The case the whole rule exists for.
 *
 * A ring lattice of 12 with m=2: node 0 sees 1, 2, 10, 11 at distance 1 and
 * 3, 4, 8, 9 at distance 2, leaving 5, 6, 7 outside. The ties 3-4 and 8-9 each
 * join two nodes that are BOTH exactly two hops away, so they are what 2.5 adds
 * over 2 — and they are what a build that ignored the fraction would hand over.
 *
 * n=12 and not 8: at 8 the radius-2 ball is the entire lattice, so there is no
 * fringe to withhold and the test would pass on an implementation that ignored
 * the rule entirely.
 */
test("integer radius withholds the ties between two outermost nodes; the half step adds them", () => {
  const adj = adjacency(12, ringLattice(12, 2));
  const two = ball(adj, 0, 2);
  const half = ball(adj, 0, 2.5);

  assert.deepEqual(two.nodes, half.nodes, "2 and 2.5 show the same people");
  assert.equal(two.nodes.length, 9, "everyone but the far side of the lattice");

  const bothAtTwo = ([a, b]: [number, number]) => two.dist[a] === 2 && two.dist[b] === 2;
  assert.equal(two.edges.filter(bothAtTwo).length, 0, "radius 2 delivers no fringe-fringe tie");
  assert.ok(half.edges.filter(bothAtTwo).length > 0, "radius 2.5 delivers at least one");

  // And the half step is strictly additive: everything 2 sent, 2.5 sends too.
  for (const e of two.edges) {
    assert.ok(
      half.edges.some(([a, b]) => a === e[0] && b === e[1]),
      `radius 2.5 dropped ${JSON.stringify(e)}, which radius 2 delivered`
    );
  }
});

/**
 * The compatibility claim the whole feature rests on.
 *
 * `inducedEdges(adj, [viewer, ...neighbors])` is what the server has shipped at
 * radius 1.5 since the feature existed. If `ball(adj, v, 1.5)` disagreed with it
 * on any graph, turning the new code path on would silently change what every
 * existing 1.5 study shows its participants — and the change would look like a
 * correct picture, which is the failure this package is written against.
 *
 * Checked over every shipped shape rather than a fixture, because the two
 * implementations agree trivially on a star and could disagree on a lattice.
 */
test("radius 1.5 agrees, edge for edge, with the inducedEdges path it replaces", () => {
  const shapes: Array<[string, number, ReturnType<typeof ring>]> = [
    ["ring", 8, ring(8)],
    ["star", 8, star(8)],
    ["ringLattice", 12, ringLattice(12, 2)],
    ["wheel", 8, wheel(8)],
    ["complete", 6, complete(6)],
    ["ladder", 8, ladder(4)],
  ];
  for (const [name, n, edges] of shapes) {
    const adj = adjacency(n, edges);
    for (let v = 0; v < n; v++) {
      const nodes = [v, ...(adj[v] ?? [])];
      const asShipped = inducedEdges(adj, nodes)
        .map(([a, b]) => {
          const x = nodes[a]!;
          const y = nodes[b]!;
          return (x < y ? [x, y] : [y, x]) as [number, number];
        })
        .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      assert.deepEqual(
        ball(adj, v, 1.5).edges,
        asShipped,
        `${name}: ball(…, 1.5) and inducedEdges disagree for viewer ${v}`
      );
    }
  }
});

test("distances are recorded, and are the thing local hops are derived from", () => {
  const b = ball(adjacency(6, ring(6)), 0, 2);
  assert.equal(b.dist[0], 0);
  assert.equal(b.dist[1], 1);
  assert.equal(b.dist[5], 1);
  assert.equal(b.dist[2], 2);
  assert.equal(b.dist[4], 2);
  assert.equal(b.dist[3], Infinity, "outside the ball, so never measured");
  assert.equal(b.eccentricityWithin, 2);
});

test("the viewer comes first and the rest in BFS order, deterministically", () => {
  const adj = adjacency(6, ring(6));
  const a = ball(adj, 3, 2);
  const b = ball(adj, 3, 2);
  assert.deepEqual(a.nodes, b.nodes);
  assert.equal(a.nodes[0], 3, "the viewer is always local index 0");
  // Distance is non-decreasing along the list, which is what lets a consumer
  // slice the rings apart without re-walking the graph.
  const ds = a.nodes.map((v) => a.dist[v]!);
  assert.deepEqual([...ds].sort((x, y) => x - y), ds);
});

test("an isolated viewer is a legitimate answer, not an error", () => {
  const adj = adjacency(3, [[1, 2]]);
  const b = ball(adj, 0, 2);
  assert.deepEqual(b.nodes, [0]);
  assert.deepEqual(b.edges, []);
  assert.equal(b.eccentricityWithin, 0);
});

test("a radius wider than the graph is the graph, not an error", () => {
  const adj = adjacency(6, ring(6));
  const b = ball(adj, 0, 50);
  assert.equal(b.nodes.length, 6);
  assert.equal(b.edges.length, 6);
});

/**
 * `"whole"` is everybody, including other components.
 *
 * The alternative reading — the viewer's own component — is still expressible as
 * a large finite radius, and this one is not expressible any other way. So the
 * setting that cannot be spelled otherwise gets the word.
 */
test('"whole" reaches across a disconnected graph', () => {
  const adj = adjacency(4, [
    [0, 1],
    [2, 3],
  ]);
  const b = ball(adj, 0, "whole");
  assert.deepEqual([...b.nodes].sort((x, y) => x - y), [0, 1, 2, 3]);
  assert.deepEqual(b.edges, [
    [0, 1],
    [2, 3],
  ]);
  assert.equal(b.dist[2], Infinity, "reachability is still reported honestly");
  assert.equal(b.eccentricityWithin, 1, "and the unreachable do not inflate it");

  const far = ball(adj, 0, 50);
  assert.deepEqual(far.nodes, [0, 1], "a large finite radius stays in the component");
});

test("a star's hub sees everyone at radius 1; a leaf needs 2", () => {
  const adj = adjacency(5, star(5));
  assert.equal(ball(adj, 0, 1).nodes.length, 5, "the hub is seat 0");
  assert.equal(ball(adj, 1, 1).nodes.length, 2);
  assert.equal(ball(adj, 1, 2).nodes.length, 5);
});

test("edges are global indices, sorted, each pair once", () => {
  const b = ball(adjacency(4, [[0, 1], [1, 2], [2, 3], [0, 3]]), 0, "whole");
  assert.deepEqual(b.edges, [
    [0, 1],
    [0, 3],
    [1, 2],
    [2, 3],
  ]);
});

/**
 * Refusals. Each one is a setting somebody could plausibly write, and rounding
 * any of them would show participants something other than what was asked for.
 */
test("a radius that is not a whole or half step is refused rather than rounded", () => {
  const adj = adjacency(4, ring(4));
  assert.throws(() => ball(adj, 0, 1.2), /multiple of 0\.5/);
  assert.throws(() => ball(adj, 0, 0.5), /at least 1/);
  assert.throws(() => ball(adj, 0, 0), /at least 1/);
  assert.throws(() => ball(adj, 0, -1), /at least 1/);
});

test('Infinity is refused rather than aliased to "whole"', () => {
  const adj = adjacency(4, ring(4));
  assert.throws(() => ball(adj, 0, Infinity), /"whole" is the one spelling/);
  assert.throws(() => ball(adj, 0, NaN), /"whole" is the one spelling/);
});

test("a source outside the graph is refused", () => {
  const adj = adjacency(4, ring(4));
  assert.throws(() => ball(adj, 4, 1), /outside \[0, 4\)/);
  assert.throws(() => ball(adj, -1, 1), /outside \[0, 4\)/);
});
