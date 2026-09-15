/**
 * Payload assembly: what gets pushed, and when nothing does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { GameSnapshot } from "../../src/admin/inspect.js";
import { graphMetrics, historyFrames } from "../../src/admin/inspect.js";
import { buildPayload, payloadChanged } from "../../src/admin/monitor/payload.js";
import type { Edge } from "../../src/topology/index.js";
import { ring } from "../../src/topology/index.js";

const ORDER = ["p0", "p1", "p2", "p3", "p4", "p5"];

function snapshot(over: Partial<GameSnapshot> = {}): GameSnapshot {
  const edges = (over.edges ?? ring(6)) as Edge[];
  const order = over.order ?? ORDER;
  return {
    gameID: "g1",
    batchID: "b1",
    n: 6,
    edges,
    order,
    seed: 42,
    radius: 1,
    radii: [],
    seq: 1,
    nodes: order.map((playerID, index) => ({
      index,
      playerID,
      degree: 2,
      neighbors: [],
      channel: true,
      attrs: {},
      state: {},
    })),
    metrics: graphMetrics(6, edges),
    history: historyFrames("g1", [], order),
    pendingChannels: [],
    awaitingPublish: false,
    watch: ["color"],
    ...over,
  };
}

test("an unchanged snapshot produces an unchanged digest", () => {
  const a = buildPayload(snapshot());
  const b = buildPayload(snapshot(), { previous: a });
  assert.equal(payloadChanged(a, b), false, "a quiet study must cost no pushes");
});

test("a changed attribute changes the digest but NOT the positions", () => {
  // The property that makes the monitor usable for what it is usually watched
  // for. If a participant's choice moved the whole graph, watching a value
  // spread across a network would be impossible.
  const before = buildPayload(snapshot());
  const after = buildPayload(
    snapshot({
      nodes: snapshot().nodes.map((n, i) =>
        i === 0 ? { ...n, state: { color: "red" } } : n,
      ),
    }),
    { previous: before },
  );

  assert.ok(payloadChanged(before, after), "the change must reach the browser");
  assert.deepEqual(after.positions, before.positions, "and must move nobody");
});

test("a changed graph re-runs the layout", () => {
  const before = buildPayload(snapshot());
  const rewired = ring(6).filter(([a, b]) => !(a === 0 && b === 1));
  rewired.push([0, 3]);
  const after = buildPayload(snapshot({ edges: rewired }), { previous: before });

  assert.ok(payloadChanged(before, after));
  assert.notDeepEqual(after.positions, before.positions);
});

test("the same graph in a different edge order does not re-run the layout", () => {
  // A `rewire()` that happens to reproduce the current graph must not make the
  // picture jump. Shape is compared as a set, not as a list.
  const before = buildPayload(snapshot());
  const shuffled = [...ring(6)].reverse().map(([a, b]) => [b, a] as Edge);
  const after = buildPayload(snapshot({ edges: shuffled }), { previous: before });
  assert.deepEqual(after.positions, before.positions);
});

test("a different game never inherits the previous game's positions", () => {
  // `previous` is keyed by game id as well as by shape. Two games with the same
  // topology are different people, and carrying coordinates across would show
  // the second game the first game's arrangement.
  const before = buildPayload(snapshot({ gameID: "g1", seed: 1 }));
  const after = buildPayload(snapshot({ gameID: "g2", seed: 2 }), { previous: before });
  assert.notDeepEqual(after.positions, before.positions);
});

test("positions carry the seed, so the picture is reproducible from stored data", () => {
  const a = buildPayload(snapshot({ seed: 99 }));
  const b = buildPayload(snapshot({ seed: 99 }));
  const c = buildPayload(snapshot({ seed: 100 }));
  assert.deepEqual(a.positions, b.positions);
  assert.notDeepEqual(a.positions, c.positions);
});

test("sub-pixel drift does not count as a change", () => {
  // Warm-started layouts differ in the last float digits for structurally
  // identical graphs. Without rounding in the digest, an idle study would push
  // an SSE frame on every poll — a busy loop wearing a change-detection costume.
  const base = buildPayload(snapshot());
  const drifted = {
    ...base,
    positions: base.positions.map((p) => ({ x: p.x + 1e-9, y: p.y - 1e-9 })),
  };
  const rebuilt = buildPayload(snapshot(), { previous: drifted });
  assert.equal(payloadChanged(base, rebuilt), false);
});

test("no previous payload always counts as a change", () => {
  assert.ok(payloadChanged(undefined, buildPayload(snapshot())));
});

test("the radius reaches the payload, and a change to it is a change", () => {
  // `GameSnapshot.radius` was carried by three fixtures because TypeScript
  // requires the field, and asserted by nothing — so `buildPayload` could have
  // dropped it and every test in this file would still pass. An operator reading
  // a monitor that silently lost the radius would be watching a study without
  // knowing how much of it its participants can see.
  const built = buildPayload(snapshot({ radius: 1.5 }));
  assert.equal(built.snapshot.radius, 1.5, "the payload carries it");

  assert.equal(
    payloadChanged(buildPayload(snapshot({ radius: 1 })), buildPayload(snapshot({ radius: 1.5 }))),
    true,
    "a run at the other radius is a different picture and must push"
  );
});

test("a recorded radius that disagrees with the live one reaches the payload", () => {
  // The pair exists so the disagreement is visible. If the payload carried only
  // one of them it would be picking a side, and the side it picked would look
  // authoritative.
  const built = buildPayload(snapshot({ radius: 1.5, recordedRadius: 1 }));
  assert.equal(built.snapshot.radius, 1.5, "what participants are shown now");
  assert.equal(built.snapshot.recordedRadius, 1, "what the run's own data says");

  assert.equal(
    payloadChanged(
      buildPayload(snapshot({ radius: 1.5, recordedRadius: 1.5 })),
      buildPayload(snapshot({ radius: 1.5, recordedRadius: 1 }))
    ),
    true,
    "a game that starts disagreeing with its own record must push"
  );
});
