/**
 * The participant graph model.
 *
 * This file is the reason `src/player/graph.ts` is pure. PLATFORM-NOTES §8 says
 * a hook cannot be rendered against a synthetic mode here, so a component that
 * computed its own geometry would be held by nothing but eyesight — and the
 * failure mode of a network picture is never a thrown error, it is a plausible
 * diagram of a graph nobody has.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  egoRingLayout,
  graphModelOf,
  svgAttrs,
  type Subgraph,
} from "../../src/player/graph.js";

const SIZE = 600;
const CENTER = SIZE / 2;
const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !~= ${b}`);

test("undefined neighbors is not an isolated node", () => {
  // The distinction the whole module inherits from `view.ts`: rendering [] while
  // loading shows the viewer as abandoned, which in a rewiring design is a real
  // state and therefore looks entirely normal.
  assert.equal(graphModelOf({ neighbors: undefined }), undefined);

  const isolated = graphModelOf({ neighbors: [] });
  assert.ok(isolated, "an empty neighbor list is a real answer, not a loading state");
  assert.equal(isolated.nodes.length, 1);
  assert.equal(isolated.nodes[0]!.self, true);
  assert.deepEqual(isolated.edges, []);
});

test("the ring is evenly spaced and stays inside the box", () => {
  for (const degree of [1, 2, 3, 5, 8, 16]) {
    const pts = egoRingLayout(degree);
    assert.equal(pts.length, degree);

    const radii = pts.map((p) => Math.hypot(p.x - CENTER, p.y - CENTER));
    for (const r of radii) near(r, radii[0]!, 1e-9);

    // Alter radius 30 + padding 10 must both fit.
    assert.ok(radii[0]! + 30 + 10 <= SIZE / 2 + 1e-9, "a node would be clipped");

    const angles = pts
      .map((p) => Math.atan2(p.y - CENTER, p.x - CENTER))
      .map((a) => (a + 2 * Math.PI) % (2 * Math.PI))
      .sort((x, y) => x - y);
    if (degree > 1) {
      const step = (2 * Math.PI) / degree;
      for (let i = 1; i < angles.length; i++) near(angles[i]! - angles[i - 1]!, step, 1e-9);
    }
  }
  assert.deepEqual(egoRingLayout(0), []);
});

test("the first alter is straight up, and the layout does not drift", () => {
  const [first] = egoRingLayout(4);
  near(first!.x, CENTER);
  assert.ok(first!.y < CENTER, "-pi/2 is up in SVG coordinates");

  // Same input, same picture: a participant's own screen must not rearrange
  // itself between publishes.
  assert.deepEqual(egoRingLayout(7), egoRingLayout(7));
});

test("edges stop at the circle boundaries, not the centers", () => {
  const model = graphModelOf({ neighbors: [{}, {}, {}] })!;
  assert.equal(model.edges.length, 3);

  for (const e of model.edges) {
    const from = model.nodes[e.source]!;
    const to = model.nodes[e.target]!;
    // The drawn segment starts exactly one ego radius out and ends one alter
    // radius short. A center-to-center line under an opaque fill reads as a
    // rendering bug rather than the geometry error it is.
    near(Math.hypot(e.x1 - from.at.x, e.y1 - from.at.y), from.r, 1e-9);
    near(Math.hypot(e.x2 - to.at.x, e.y2 - to.at.y), to.r, 1e-9);

    const full = Math.hypot(to.at.x - from.at.x, to.at.y - from.at.y);
    const drawn = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    near(drawn, full - from.r - to.r, 1e-9);
  }
});

test("coincident centers do not produce NaN", () => {
  // Reachable whenever a server-sent layout has not separated two nodes yet.
  const subgraph: Subgraph = {
    edges: [[0, 1]],
    positions: [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    ],
  };
  const model = graphModelOf({ neighbors: [{}], subgraph })!;
  for (const v of Object.values(model.edges[0]!)) {
    if (typeof v === "number") assert.ok(Number.isFinite(v), "NaN renders as nothing at all");
  }
});

test("at the default radius the picture is a star centered on the viewer", () => {
  const model = graphModelOf({ neighbors: [{}, {}, {}, {}] })!;
  assert.equal(model.nodes.length, 5);
  assert.equal(model.nodes.filter((n) => n.self).length, 1);
  // Every tie is incident to the viewer. This is the claim that makes the
  // display free: it draws nothing that was not already on this browser.
  for (const e of model.edges) assert.ok(e.source === 0 || e.target === 0);
});

test("a server subgraph can join two neighbors; a bad index is dropped, not drawn", () => {
  const subgraph: Subgraph = {
    edges: [
      [0, 1],
      [1, 2],
      [2, 9],
      [1, 1],
    ],
  };
  const model = graphModelOf({ neighbors: [{}, {}], subgraph })!;
  assert.deepEqual(
    model.edges.map((e) => [e.source, e.target]),
    [
      [0, 1],
      [1, 2],
    ],
    "an out-of-range endpoint and a self-loop are dropped rather than drawn somewhere plausible"
  );
});

test("expectSubgraph refuses to degrade to a star", () => {
  // Without the flag a missing subgraph draws a correct-looking picture of a
  // DIFFERENT study, and nothing anywhere says so.
  assert.ok(graphModelOf({ neighbors: [{}, {}] }), "radius 1 needs no subgraph");
  assert.equal(
    graphModelOf({ neighbors: [{}, {}] }, { expectSubgraph: true }),
    undefined,
    "a study above radius 1 must wait rather than draw the wrong graph"
  );
});

test("the viewer's own node is stylable", () => {
  // In Shirado & Christakis the participant's own circle carries their own
  // chosen color; a screen showing everyone's color but theirs is another task.
  const model = graphModelOf(
    { neighbors: [{ color: "green" }], self: { color: "orange" } },
    { nodeAttrs: (n) => ({ color: (n.data as any)?.color }) }
  )!;
  assert.equal(model.nodes[0]!.attrs["color"], "orange");
  assert.equal(model.nodes[1]!.attrs["color"], "green");
});

test("edge attributes see both endpoints", () => {
  const model = graphModelOf(
    { neighbors: [{ color: "green" }, { color: "orange" }], self: { color: "green" } },
    {
      edgeAttrs: (a, b) => ({
        conflict: (a.data as any)?.color === (b.data as any)?.color,
      }),
    }
  )!;
  assert.equal(model.edges[0]!.attrs["conflict"], "1", "a shared color is a conflict");
  assert.equal(model.edges[1]!.attrs["conflict"], "0");
});

test("svgAttrs keeps what CSS can select and drops what the DOM would misread", () => {
  const out = svgAttrs({
    color: "green",
    degree: 3,
    conflict: true,
    quiet: false,
    // `id` is the one that matters: every projection in this repository's own
    // examples carries one, so passing it through would put the same DOM id on
    // several elements on the majority of real screens.
    id: "player-abc",
    className: "x",
    r: 99,
    onClick: () => {},
    nested: { a: 1 },
    missing: undefined,
    empty: null,
    infinite: Infinity,
  });
  assert.deepEqual(out, { color: "green", degree: 3, conflict: "1", quiet: "0" });
  assert.deepEqual(svgAttrs(undefined), {});
});

/**
 * The outer ring.
 *
 * This is the case the node list had to stop being built from `neighbors`. With
 * the old construction a radius 2 payload rendered as a complete, internally
 * consistent radius 1.5 picture: the far nodes had no ref to draw, so every edge
 * touching them failed the `!from || !to` guard and was dropped silently. The
 * result looked entirely correct and was a picture of a different study — which
 * is the failure `expectSubgraph` exists to prevent one level up, arriving by
 * another road.
 */
test("a payload with people beyond the neighbors draws all of them", () => {
  const model = graphModelOf({
    neighbors: [{ id: "a" }],
    self: { id: "me" },
    subgraph: {
      // 0 me, 1 neighbor a, 2 and 3 two hops out. The 2-3 tie is the one a
      // radius 2 payload would not carry and a 2.5 payload would.
      edges: [
        [0, 1],
        [1, 2],
        [1, 3],
        [2, 3],
      ],
      positions: [
        { x: 300, y: 300 },
        { x: 300, y: 150 },
        { x: 200, y: 60 },
        { x: 400, y: 60 },
      ],
      far: [
        { ref: "k3m9x2pq", d: 2 },
        { ref: "b7t4wz01", d: 2 },
      ],
    },
  });

  assert.ok(model);
  assert.equal(model.nodes.length, 4, "viewer, one neighbor, two people further out");
  assert.equal(model.edges.length, 4, "no edge was dropped for naming a node nobody drew");

  const far = model.nodes.filter((n) => n.distance > 1);
  assert.equal(far.length, 2);
  assert.deepEqual(
    far.map((n) => n.ref),
    ["k3m9x2pq", "b7t4wz01"],
    "each distant node keeps the name this viewer was given for it"
  );
  assert.equal(far[0]!.data, undefined, "no data at distance unless the study projected it");
  assert.ok(
    far.every((n) => n.r < model.nodes[1]!.r),
    "somebody you cannot act on should not be drawn the size of somebody you can"
  );
});

test("a far node carries its projection when the study sent one", () => {
  const model = graphModelOf({
    neighbors: [{ id: "a" }],
    subgraph: {
      edges: [[0, 1]],
      positions: [
        { x: 300, y: 300 },
        { x: 300, y: 150 },
        { x: 200, y: 60 },
      ],
      far: [{ ref: "k3m9x2pq", d: 3, view: { color: "green" } }],
    },
    // The styling hook must see a far node exactly as it sees any other, or a
    // design cannot colour the outer ring by whatever it was told about them.
  }, { nodeAttrs: (n) => ({ color: (n.data as { color?: string } | undefined)?.color, hop: n.distance }) });

  assert.ok(model);
  const far = model.nodes[2]!;
  assert.equal(far.distance, 3);
  assert.deepEqual(far.attrs, { color: "green", hop: 3 });
});

test("with no far array the picture is exactly what it was", () => {
  const without = graphModelOf({
    neighbors: [{ id: "a" }, { id: "b" }],
    self: { id: "me" },
    subgraph: {
      edges: [
        [0, 1],
        [0, 2],
        [1, 2],
      ],
      positions: [
        { x: 300, y: 300 },
        { x: 300, y: 100 },
        { x: 450, y: 400 },
      ],
    },
  });
  assert.ok(without);
  assert.equal(without.nodes.length, 3);
  assert.ok(without.nodes.every((n) => n.distance <= 1));
  assert.ok(without.nodes.every((n) => n.ref === undefined));
});
