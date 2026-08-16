/**
 * The read-only introspection surface.
 *
 * Pure functions over an edge list and an event log, so all of this runs with no
 * server and no Empirica — which is the point of keeping `inspect.ts` free of
 * Empirica types in the first place.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { graphMetrics, historyFrames } from "../../src/admin/inspect.js";
import type { EdgeEvent } from "../../src/shared/keys.js";
import { complete, ring } from "../../src/topology/index.js";

test("density of a complete graph is 1, not 0.333", () => {
  // The pin for MODULE-DESIGN §6's one silent trap. graphology's default mixed
  // `Graph` reports 0.333 for exactly this graph, because its denominator counts
  // directed slots this module never fills — measured in
  // test/unit/graphology.test.ts. The monitor derives density from the edge list
  // instead, so it cannot inherit that number.
  const m = graphMetrics(12, complete(12));
  assert.equal(m.edgeCount, 66);
  assert.equal(m.density, 1);
  assert.ok(m.density > 0.4, "if this ever reads ~0.333 the mixed-graph denominator got in");
});

test("ring metrics are the ring's", () => {
  const m = graphMetrics(6, ring(6));
  assert.equal(m.edgeCount, 6);
  assert.equal(m.density, (2 * 6) / (6 * 5));
  assert.equal(m.components, 1);
  assert.deepEqual(m.isolated, []);
  assert.equal(m.minDegree, 2);
  assert.equal(m.maxDegree, 2);
  assert.equal(m.meanDegree, 2);
});

test("an empty graph is n components of one, all isolated", () => {
  // `topology.empty()` is a legitimate control condition, so this is a real
  // answer rather than a degenerate case — and a monitor that reported one
  // component here would be describing a graph nobody is in.
  const m = graphMetrics(5, []);
  assert.equal(m.components, 5);
  assert.deepEqual(m.isolated, [0, 1, 2, 3, 4]);
  assert.equal(m.density, 0);
  assert.equal(m.maxDegree, 0);
});

test("disjoint pieces are counted, and a lone node counts as one", () => {
  const m = graphMetrics(7, [
    [0, 1],
    [1, 2],
    [3, 4],
  ]);
  // A path of three, a pair, and two lone seats: four components, not two. An
  // isolated participant is a component, and reporting only the joined pieces
  // would hide the participants who can see nobody.
  assert.equal(m.components, 4);
  assert.deepEqual(m.isolated, [5, 6]);
});

test("duplicates and self-loops do not inflate the edge count", () => {
  // adjacency() dedupes and drops self-loops, so the published graph is smaller
  // than the raw list. Counting the raw list would describe a denser network
  // than any participant is actually in.
  const m = graphMetrics(4, [
    [0, 1],
    [1, 0],
    [0, 1],
    [2, 2],
  ]);
  assert.equal(m.edgeCount, 1);
  assert.deepEqual(m.isolated, [2, 3]);
});

test("n = 0 and n = 1 do not divide by zero", () => {
  assert.equal(graphMetrics(0, []).density, 0);
  assert.equal(graphMetrics(0, []).components, 0);
  assert.equal(graphMetrics(1, []).density, 0);
  assert.equal(graphMetrics(1, []).components, 1);
});

// ------------------------------------------------------------------ history

const ORDER = ["pA", "pB", "pC", "pD"];

function log(): EdgeEvent[] {
  return [
    {
      op: "start",
      added: [
        ["pA", "pB"],
        ["pB", "pC"],
        ["pC", "pD"],
        ["pD", "pA"],
      ],
      removed: [],
      size: 4,
      at: 1000,
    },
    { op: "remove", a: "pA", b: "pB", added: [], removed: [["pA", "pB"]], size: 3, at: 2000 },
    { op: "add", a: "pA", b: "pC", added: [["pA", "pC"]], removed: [], size: 4, at: 3000 },
  ];
}

test("frames replay the log into index pairs, one per event", () => {
  const { frames, consistent, dropped } = historyFrames("g1", log(), ORDER);
  assert.equal(frames.length, 3);
  assert.equal(consistent, true);
  assert.equal(dropped, 0);

  assert.equal(frames[0]!.op, "start");
  assert.deepEqual(sorted(frames[0]!.edges), [
    [0, 1],
    [0, 3],
    [1, 2],
    [2, 3],
  ]);

  // The removal is gone from the full list AND named in `removed`, which is what
  // lets the scrubber draw the tie that just disappeared rather than only what
  // survived it.
  assert.equal(frames[1]!.edges.length, 3);
  assert.deepEqual(frames[1]!.removed, [[0, 1]]);
  assert.ok(!sorted(frames[1]!.edges).some(([a, b]) => a === 0 && b === 1));

  assert.deepEqual(frames[2]!.added, [[0, 2]]);
  assert.equal(frames[2]!.edges.length, 4);
});

test("frame edge counts agree with the log's own sizes", () => {
  // The scrubber and `network_snapshots.csv` are built from the same replay, so
  // if this ever disagrees the export disagrees too.
  const events = log();
  const { frames } = historyFrames("g1", events, ORDER);
  for (const [i, frame] of frames.entries()) {
    assert.equal(frame.edges.length, events[i]!.size, `event ${i}`);
  }
});

test("a log whose counts lie is reported, not repaired", () => {
  const events = log();
  events[1]!.size = 99;
  const { consistent } = historyFrames("g1", events, ORDER);
  assert.equal(consistent, false, "the monitor must surface this, not quietly renumber it");
});

test("a player the seating table does not know is counted as dropped", () => {
  // A history event naming somebody absent from `order` means the seating record
  // and the event log disagree. Silently drawing a smaller graph would be the
  // exact class of failure this package keeps designing against, so it is
  // counted and shown.
  const events = log();
  events.push({
    op: "add",
    a: "pA",
    b: "GHOST",
    added: [["pA", "GHOST"]],
    removed: [],
    size: 5,
    at: 4000,
  });
  const { dropped, consistent } = historyFrames("g1", events, ORDER);
  assert.ok(dropped > 0, "the unmappable pair must be counted");
  // Separate flags: the log itself is coherent, we just cannot seat one end.
  // Folding these together would report a seating mismatch as a corrupt log.
  assert.equal(consistent, true);
});

test("an empty log yields no frames and is trivially consistent", () => {
  const { frames, consistent, dropped } = historyFrames("g1", [], ORDER);
  assert.deepEqual(frames, []);
  assert.equal(consistent, true);
  assert.equal(dropped, 0);
});

function sorted(edges: Array<[number, number]>): Array<[number, number]> {
  return [...edges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
