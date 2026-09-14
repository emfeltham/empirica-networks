/**
 * The radius 1.5 payload: what is sent, and where the nodes are put.
 *
 * Two properties here would fail SILENTLY if they broke, and both are about
 * warm starting rather than about drawing:
 *
 *   - positions follow PEOPLE, not array slots. A neighborhood renumbers when a
 *     tie is dropped, so an index-keyed cache hands every survivor the
 *     coordinates of whoever used to sit there. The picture stays beautifully
 *     still while the identities under it slide by one.
 *   - the same SHAPE can hold different people. One rewire that swaps two ties
 *     leaves the edge set identical, so reusing on the shape alone places each
 *     newcomer exactly where the person they replaced had been.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { adjacency } from "../../src/topology/index.js";
import { buildGraphPayload } from "../../src/admin/graph_payload.js";
import { inducedEdges } from "../../src/admin/subgraph.js";

const SIZE = 600;
const CENTER = SIZE / 2;
const near = (a: number, b: number, tol = 1.5) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b}`);

/** 0 is tied to 1, 2, 3; and 1-2 are tied to each other. */
const TRIANGLE_PLUS = adjacency(4, [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
]);

// `buildGraphPayload` lays out what it is given; the caller decides which ties
// the radius delivers. At 1.5 that is the whole induced subgraph, which is what
// `inducedEdges` has always returned, so these cases are unchanged in substance.
const build = (nodes: number[], ids: string[], cache?: any) =>
  buildGraphPayload({
    ids,
    edges: inducedEdges(TRIANGLE_PLUS, nodes),
    radius: 1.5,
    seed: 7,
    cache,
  });

test("the payload carries the ties among the viewer's neighbors, and its own radius", () => {
  const { payload } = build([0, 1, 2, 3], ["me", "a", "b", "c"]);
  assert.equal(payload.radius, 1.5, "the client must tell radius 1 from a missing subgraph");
  assert.ok(
    payload.edges.some(([a, b]) => a !== 0 && b !== 0),
    "the 1-2 tie is the whole reason this payload exists"
  );
  assert.equal(payload.positions.length, 4, "index-aligned with the delivered neighborhood");
});

test("the drawing fills the canvas and nothing leaves it", () => {
  const { payload } = build([0, 1, 2, 3], ["me", "a", "b", "c"]);
  const xs = payload.positions.map((p) => p.x);
  const ys = payload.positions.map((p) => p.y);

  for (const p of payload.positions) {
    // Every node centre is inside the box with room for the node's own radius;
    // a centre on the edge is a circle half off the canvas.
    assert.ok(p.x >= 40 - 1 && p.x <= SIZE - 40 + 1, `${p.x} is clipped`);
    assert.ok(p.y >= 40 - 1 && p.y <= SIZE - 40 + 1, `${p.y} is clipped`);
  }

  // And it USES the box. Centring on the viewer instead of on the bounding box
  // shrinks a densely connected neighborhood into a corner at roughly a third
  // of the available size, which is what this replaced.
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  assert.ok(
    span > SIZE * 0.6,
    `the drawing spans only ${span.toFixed(0)} of ${SIZE} and is wasting the canvas`
  );

  // The bounding box is centred, so the picture is not shoved to one side.
  near((Math.min(...xs) + Math.max(...xs)) / 2, CENTER);
  near((Math.min(...ys) + Math.max(...ys)) / 2, CENTER);
});

test("a star neighborhood still puts the viewer in the middle", () => {
  // The common case, and the one where Breadboard's pinned ego and a bounding
  // box agree: in a star the viewer IS the centre, so nothing is given up.
  const star = adjacency(5, [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ]);
  const { payload } = buildGraphPayload({
    ids: ["me", "a", "b", "c", "d"],
    edges: inducedEdges(star, [0, 1, 2, 3, 4]),
    radius: 1.5,
    seed: 7,
  });
  const me = payload.positions[0]!;
  assert.ok(
    Math.hypot(me.x - CENTER, me.y - CENTER) < SIZE * 0.12,
    `the viewer sits at ${me.x},${me.y}, which is not near the middle of a star`
  );
});

test("coordinates are integers", () => {
  // Not tidiness: a warm-started layout lands on different float tails for the
  // same graph, so unrounded coordinates defeat the byte-identical suppression
  // and republish the whole neighborhood on every tick.
  for (const p of build([0, 1, 2, 3], ["me", "a", "b", "c"]).payload.positions) {
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), `${p.x},${p.y} is not integral`);
  }
});

test("an unchanged neighborhood produces an identical picture", () => {
  // A neighbor changing a watched attribute republishes. If that moved anybody,
  // the change a participant is watching for would be invisible under everything
  // rearranging around it.
  const first = build([0, 1, 2, 3], ["me", "a", "b", "c"]);
  const again = build([0, 1, 2, 3], ["me", "a", "b", "c"], first.cache);
  assert.deepEqual(again.payload.positions, first.payload.positions);
});

test("positions follow people when a neighbor is dropped", () => {
  const first = build([0, 1, 2, 3], ["me", "a", "b", "c"]);
  const wasA = first.cache.positions.get("a")!;
  const wasB = first.cache.positions.get("b")!;
  const wasC = first.cache.positions.get("c")!;

  // "a" goes, so "b" and "c" each shift down a slot. The shape genuinely
  // changed, so the layout re-runs and everybody is expected to MOVE — warm
  // starting means "begin from where you were", not "stay". What must not
  // happen is each survivor beginning from the coordinates of whoever used to
  // hold their new slot, which is what an index-keyed cache does and which
  // produces an almost-still picture of a neighborhood that changed.
  const after = build([0, 2, 3], ["me", "b", "c"], first.cache);
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.hypot(p.x - q.x, p.y - q.y);

  const nowB = after.cache.positions.get("b")!;
  const nowC = after.cache.positions.get("c")!;
  assert.ok(
    dist(nowB, wasB) < dist(nowB, wasA),
    `b ended nearer a's old place (${dist(nowB, wasA).toFixed(0)}) than its own ` +
      `(${dist(nowB, wasB).toFixed(0)}) — the identities have slid by one`
  );
  assert.ok(
    dist(nowC, wasC) < dist(nowC, wasB),
    "c ended nearer b's old place than its own — the identities have slid by one"
  );
  assert.ok(
    !after.cache.positions.has("a"),
    "a departed and must not be carried forward to be seeded onto somebody else"
  );
});

test("an identical SHAPE holding different people is laid out afresh", () => {
  // The shape key alone would match here: a star of three, before and after.
  // Reusing on it would put the newcomer exactly where the person they replaced
  // had been — a still picture of a neighborhood that changed.
  const star = adjacency(5, [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ]);
  const args = { radius: 1.5 as const, seed: 7 };
  const first = buildGraphPayload({
    ...args,
    ids: ["me", "a", "b"],
    edges: inducedEdges(star, [0, 1, 2]),
  });
  const swapped = buildGraphPayload({
    ...args,
    ids: ["me", "a", "z"],
    edges: inducedEdges(star, [0, 1, 3]),
    cache: first.cache,
  });
  assert.equal(first.cache.key, swapped.cache.key, "the shapes really are identical");
  assert.ok(
    !swapped.cache.positions.has("b"),
    "the departed neighbor is not carried into the new cache"
  );
  assert.ok(swapped.cache.positions.has("z"), "the newcomer was laid out");
});

test("a viewer with no neighbors, and one with a single neighbor", () => {
  const alone = build([0], ["me"]).payload;
  assert.deepEqual(alone.edges, []);
  assert.equal(alone.positions.length, 1);
  near(alone.positions[0]!.x, CENTER);
  near(alone.positions[0]!.y, CENTER);

  const pair = build([0, 3], ["me", "c"]).payload;
  assert.equal(pair.positions.length, 2);
  for (const p of pair.positions) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "no NaN from a degenerate layout");
  }
});

test("same inputs, same picture, in any process", () => {
  // The seed is the game's own, so two people watching one study see one thing,
  // and a stored run can be redrawn from its data.
  assert.deepEqual(
    build([0, 1, 2, 3], ["me", "a", "b", "c"]).payload,
    build([0, 1, 2, 3], ["me", "a", "b", "c"]).payload
  );
});
