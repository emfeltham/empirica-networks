/**
 * Reading the radius 1.5 structure off a real channel.
 *
 * Against real `Nbhd` instances from the synthetic provider, because the thing
 * being tested is a decision about a value that arrived over the wire, and the
 * interesting cases are all malformed ones that a hand-built object would not
 * represent faithfully.
 *
 * The distinction under test is three-way. `undefined` is "this study runs at
 * radius 1", `null` is "the structure arrived and cannot be used", and only the
 * second must refuse to fall back to a star — a star is a correct-looking
 * picture of a DIFFERENT study, which is the failure this package is written
 * against.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkGraphOf } from "../../src/player/view.js";
import { provisionedChannel, publish } from "./synthetic.js";

function channel(graph?: unknown) {
  const h = provisionedChannel();
  publish(h, [{ id: "a" }, { id: "b" }], 1, graph);
  return h.mode.nbhd.getValue();
}

const WELL_FORMED = {
  radius: 1.5,
  edges: [
    [0, 1],
    [0, 2],
    [1, 2],
  ],
  positions: [
    { x: 300, y: 300 },
    { x: 100, y: 100 },
    { x: 500, y: 200 },
  ],
};

test("absent means radius 1, not a failure", () => {
  assert.equal(networkGraphOf(channel()), undefined);
  assert.equal(networkGraphOf(undefined), undefined, "no channel yet is also not a failure");
});

test("a well-formed structure comes through intact", () => {
  const g = networkGraphOf(channel(WELL_FORMED));
  assert.ok(g, "not null and not undefined");
  assert.equal(g.radius, 1.5);
  assert.equal(g.positions.length, 3);
  assert.ok(
    g.edges.some(([a, b]) => a !== 0 && b !== 0),
    "the tie between two neighbors is what radius 1.5 is for"
  );
});

test("an edge naming a node nobody was sent is dropped", () => {
  // It would otherwise be drawn to whatever coordinate happened to sit at that
  // index: a line between two real people who are not tied.
  const g = networkGraphOf(
    channel({ ...WELL_FORMED, edges: [[0, 1], [1, 9], [2, -1], [1, 1], [0]] })
  );
  assert.ok(g);
  assert.deepEqual(g.edges, [[0, 1]], "only the representable tie survives");
});

test("a malformed POSITION rejects the whole payload", () => {
  // Dropping one would compact the array, and the array is index-aligned with
  // the neighbor list — so everybody after the gap would take the place of the
  // next one along. That is the off-by-one the server side is shaped to avoid,
  // reintroduced on the client.
  for (const positions of [
    [{ x: 1, y: 2 }, { x: "no", y: 2 }, { x: 3, y: 4 }],
    [{ x: 1, y: 2 }, null, { x: 3, y: 4 }],
    [{ x: 1, y: 2 }, { x: NaN, y: 2 }],
    [{ x: 1, y: 2 }, {}],
  ]) {
    assert.equal(
      networkGraphOf(channel({ ...WELL_FORMED, positions })),
      null,
      `positions ${JSON.stringify(positions)} must reject rather than compact`
    );
  }
});

test("a structure that arrived but cannot be read is null, never undefined", () => {
  // `undefined` would mean "radius 1" and draw a star. These are all states
  // where something is wrong and the screen must wait instead.
  for (const bad of [
    42,
    "graph",
    {},
    { radius: 1.5 },
    { radius: "1.5", edges: [], positions: [] },
    { radius: 1.5, edges: [], positions: "nope" },
    { radius: 1.5, edges: "nope", positions: [] },
    { radius: Infinity, edges: [], positions: [] },
  ]) {
    assert.equal(
      networkGraphOf(channel(bad)),
      null,
      `${JSON.stringify(bad)} must not be mistaken for a radius 1 study`
    );
  }
});

test("an empty structure is usable: a viewer can genuinely have no ties to show", () => {
  const g = networkGraphOf(channel({ radius: 1.5, edges: [], positions: [{ x: 300, y: 300 }] }));
  assert.ok(g, "an isolated participant is a real result, not a malformed payload");
  assert.deepEqual(g.edges, []);
});
