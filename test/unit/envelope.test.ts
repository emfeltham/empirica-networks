import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENVELOPE,
  EnvelopeError,
  checkDegrees,
  checkViewBytes,
  resolveEnvelope,
} from "../../src/admin/envelope.js";
import { adjacency, complete, ring, ringLattice } from "../../src/topology/index.js";

function collectWarnings() {
  const seen: string[] = [];
  return { warn: (m: string) => seen.push(m), seen };
}

test("defaults encode the measured envelope", () => {
  assert.equal(DEFAULT_ENVELOPE.maxDegree, 16, "sparse, per SPIKE-REPORT §4");
  assert.equal(DEFAULT_ENVELOPE.onExceed, "throw", "enforced unless opted out");
  assert.deepEqual(resolveEnvelope(), DEFAULT_ENVELOPE);
  assert.equal(resolveEnvelope({ maxDegree: 4 }).maxDegree, 4);
  assert.equal(resolveEnvelope({ maxDegree: 4 }).onExceed, "throw", "partial override");
});

test("a ring passes at any n", () => {
  // Degree 2 regardless of size — the topology this module is built around.
  for (const n of [4, 50, 500]) {
    assert.doesNotThrow(() => checkDegrees(adjacency(n, ring(n))));
  }
});

test("a complete graph is REJECTED — it fails on client bandwidth", () => {
  // The case the spike found unsupportable however fast the server is.
  const n = 40;
  const adj = adjacency(n, complete(n));

  assert.throws(() => checkDegrees(adj), EnvelopeError);
  assert.throws(() => checkDegrees(adj), /exceeds the supported envelope/);
  assert.throws(() => checkDegrees(adj), /CLIENT\s+bandwidth/);
});

test("the rejection names how many, and the worst offender", () => {
  const adj = adjacency(30, complete(30)); // every node has degree 29
  try {
    checkDegrees(adj);
    assert.fail("should have thrown");
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /30 of 30 participants/);
    assert.match(m, /with 29/);
    assert.match(m, /maxDegree: 29/, "the message includes a working opt-out");
  }
});

test("the boundary is exact: 16 passes, 17 throws", () => {
  // A ring lattice with k neighbours each side gives degree 2k.
  assert.doesNotThrow(() => checkDegrees(adjacency(40, ringLattice(40, 8))), "degree 16");
  assert.throws(() => checkDegrees(adjacency(40, ringLattice(40, 9))), "degree 18");
});

test('onExceed: "warn" proceeds instead of throwing', () => {
  const { warn, seen } = collectWarnings();
  const adj = adjacency(30, complete(30));

  assert.doesNotThrow(() => checkDegrees(adj, { onExceed: "warn" }, warn));
  assert.equal(seen.length, 1, "warns once, not once per participant");
  assert.match(seen[0]!, /^empirica-networks: /);
});

test("raising maxDegree admits a denser graph", () => {
  const adj = adjacency(30, complete(30));
  assert.doesNotThrow(() => checkDegrees(adj, { maxDegree: 29 }));
  assert.throws(() => checkDegrees(adj, { maxDegree: 28 }));
});

test("an empty or isolated topology is fine", () => {
  assert.doesNotThrow(() => checkDegrees([]));
  assert.doesNotThrow(() => checkDegrees([[], [], []]));
});

test("view size: under the limit is silent, over it throws", () => {
  assert.doesNotThrow(() => checkViewBytes([{ bytes: 200, label: "a's view of b" }]));
  assert.throws(
    () => checkViewBytes([{ bytes: 9000, label: "a's view of b" }]),
    EnvelopeError
  );
});

test("view size reports only the worst offender", () => {
  // At n=100 with degree 16, a systematic mistake would otherwise emit 1600
  // identical messages per publish and bury everything else in the log.
  const { warn, seen } = collectWarnings();
  const views = Array.from({ length: 50 }, (_, i) => ({
    bytes: 9000 + i,
    label: `view-${i}`,
  }));

  checkViewBytes(views, { onExceed: "warn" }, warn);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /50 neighbour view\(s\)/);
  assert.match(seen[0]!, /view-49 at 9049 bytes/, "names the largest");
});

test("the view-size message does not claim to be a performance measurement", () => {
  // It is a footgun detector. Saying otherwise would present a guessed number as
  // an established one.
  try {
    checkViewBytes([{ bytes: 9000, label: "x" }]);
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /mistake detector, not a measured/);
    assert.match((e as Error).message, /maxViewBytes: 18000/, "suggests a working override");
  }
});
