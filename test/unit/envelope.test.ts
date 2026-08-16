import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENVELOPE,
  EnvelopeError,
  MEASURED_DENSE_N,
  MEASURED_SPARSE_DEGREE,
  checkDegrees,
  checkNeighbourhoodBytes,
  checkViewBytes,
  defaultMaxDegree,
  resolveEnvelope,
} from "../../src/admin/envelope.js";
import { adjacency, complete, ring, ringLattice } from "../../src/topology/index.js";

function collectWarnings() {
  const seen: string[] = [];
  return { warn: (m: string) => seen.push(m), seen };
}

test("defaults encode the measured envelope", () => {
  // 16 stays as the default for an UNKNOWN n, which is the conservative branch:
  // it is the one that rests on the wider evidence (SPIKE-REPORT §4's sparse
  // sweep to n=100).
  assert.equal(DEFAULT_ENVELOPE.maxDegree, MEASURED_SPARSE_DEGREE);
  assert.equal(MEASURED_SPARSE_DEGREE, 16, "sparse, per SPIKE-REPORT §4");
  assert.equal(DEFAULT_ENVELOPE.onExceed, "throw", "enforced unless opted out");
  assert.equal(DEFAULT_ENVELOPE.maxNeighbourhoodBytes, 65536);
  assert.deepEqual(resolveEnvelope(), DEFAULT_ENVELOPE);
  assert.equal(resolveEnvelope({ maxDegree: 4 }).maxDegree, 4);
  assert.equal(resolveEnvelope({ maxDegree: 4 }).onExceed, "throw", "partial override");
});

test("the degree default is n-dependent, and each branch matches its evidence", () => {
  // Below the dense-measured ceiling there is NO cap: a complete graph at n=20 was
  // measured faster than a degree-8 ring at n=50 (2026-08-16), so capping degree
  // here would be enforcing a number nothing supports.
  assert.equal(defaultMaxDegree(2), 1);
  assert.equal(defaultMaxDegree(20), 19, "the Rand 2011 reconstruction's cell");
  assert.equal(defaultMaxDegree(MEASURED_DENSE_N), MEASURED_DENSE_N - 1);

  // Above it, the limit stays exactly where the sparse sweep put it. This is the
  // conservative direction and it is the point: nothing dense has been run at
  // n=100, so the old ceiling is what the evidence still says.
  assert.equal(defaultMaxDegree(MEASURED_DENSE_N + 1), MEASURED_SPARSE_DEGREE);
  assert.equal(defaultMaxDegree(100), MEASURED_SPARSE_DEGREE);
  assert.equal(defaultMaxDegree(1000), MEASURED_SPARSE_DEGREE);

  // n=0 and n=1 have no edges to have a degree; the floor keeps the number sane
  // rather than -1.
  assert.equal(defaultMaxDegree(0), 0);
  assert.equal(defaultMaxDegree(1), 0);
  assert.equal(defaultMaxDegree(Infinity), MEASURED_SPARSE_DEGREE, "unknown n is cautious");
});

test("resolveEnvelope only uses the permissive branch when it is told n", () => {
  // The asymmetry is deliberate. `checkViewBytes` has no idea what n is, and a
  // helper that guessed a permissive default from missing information would lift
  // a limit on the strength of not knowing.
  assert.equal(resolveEnvelope().maxDegree, MEASURED_SPARSE_DEGREE);
  assert.equal(resolveEnvelope({}, 20).maxDegree, 19);
  assert.equal(resolveEnvelope({ maxDegree: 3 }, 20).maxDegree, 3, "explicit still wins");
});

test("a ring passes at any n", () => {
  // Degree 2 regardless of size — the topology this module is built around.
  for (const n of [4, 50, 500]) {
    assert.doesNotThrow(() => checkDegrees(adjacency(n, ring(n))));
  }
});

test("a complete graph is ACCEPTED at n <= 50 and REJECTED above it", () => {
  // Both halves in one test, because the pair is the claim. The old version of
  // this test rejected a complete graph at n=40 and cited client bandwidth; the
  // measurement says that cell is fine, and the cell that is genuinely unmeasured
  // is the large dense one.
  assert.doesNotThrow(
    () => checkDegrees(adjacency(40, complete(40))),
    "n=40 complete is inside the dense measurement"
  );
  assert.doesNotThrow(
    () => checkDegrees(adjacency(MEASURED_DENSE_N, complete(MEASURED_DENSE_N))),
    "n=50 complete is the largest dense cell measured"
  );

  const big = adjacency(80, complete(80));
  assert.throws(() => checkDegrees(big), EnvelopeError);
  assert.throws(() => checkDegrees(big), /exceeds the supported envelope/);
  assert.throws(() => checkDegrees(big), /CLIENT\s+bandwidth/);
});

test("the rejection names how many, the worst offender, and which evidence", () => {
  const adj = adjacency(80, complete(80)); // every node has degree 79
  try {
    checkDegrees(adj);
    assert.fail("should have thrown");
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /80 of 80 participants/);
    assert.match(m, /with 79/);
    assert.match(m, /maxDegree: 79/, "the message includes a working opt-out");
    // Which measurement is being enforced, so the reader can judge it rather than
    // just obey it.
    assert.match(m, /COMPLETE graph is fine up to n = 50/);
    assert.match(m, /SPIKE-REPORT §4/);
  }
});

test("a breach of a limit the AUTHOR set says so, instead of citing our evidence", () => {
  // The two cases need different messages. Blaming the spike's sweep for a limit
  // somebody typed themselves sends them to read the wrong document.
  try {
    checkDegrees(adjacency(20, complete(20)), { maxDegree: 4 });
    assert.fail("should have thrown");
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /This is the limit YOU set/);
    assert.match(m, /default at n = 20 would be 19/);
    assert.doesNotMatch(m, /SPIKE-REPORT/, "not our measurement's fault");
  }
});

test("the boundary is exact, at the n where the sparse limit applies", () => {
  // Above the dense-measured n the old boundary is unchanged: degree 16 passes,
  // 18 does not.
  assert.doesNotThrow(() => checkDegrees(adjacency(80, ringLattice(80, 8))), "degree 16");
  assert.throws(() => checkDegrees(adjacency(80, ringLattice(80, 9))), "degree 18");

  // And the n boundary itself is exact.
  assert.doesNotThrow(
    () => checkDegrees(adjacency(50, ringLattice(50, 12))),
    "n=50 degree 24 is inside the dense measurement"
  );
  assert.throws(
    () => checkDegrees(adjacency(51, ringLattice(51, 12))),
    "n=51 degree 24 is not"
  );
});

test('onExceed: "warn" proceeds instead of throwing', () => {
  const { warn, seen } = collectWarnings();
  const adj = adjacency(80, complete(80));

  assert.doesNotThrow(() => checkDegrees(adj, { onExceed: "warn" }, warn));
  assert.equal(seen.length, 1, "warns once, not once per participant");
  assert.match(seen[0]!, /^empirica-networks: /);
});

test("lowering maxDegree still constrains a graph the default would admit", () => {
  const adj = adjacency(30, complete(30)); // degree 29, now inside the default
  assert.doesNotThrow(() => checkDegrees(adj), "the default admits it");
  assert.throws(() => checkDegrees(adj, { maxDegree: 28 }), "an explicit limit still binds");
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

test("MANY reasonable views add up: the case neither other limit can see", () => {
  // The whole reason `maxNeighbourhoodBytes` exists. Lifting the degree cap rests
  // on a latency bench that published two fields per view, so it established that
  // degree is cheap AT SMALL VIEW SIZES. Degree x view size is what a
  // participant's connection carries, and it is invisible to both a per-view limit
  // and a per-node degree limit.
  const views = Array.from({ length: 49 }, (_, i) => ({
    bytes: 1500, // comfortably inside maxViewBytes: 8192
    label: `alice's view of n${i}`,
    viewer: "alice",
  }));

  assert.doesNotThrow(
    () => checkViewBytes(views.map(({ bytes, label }) => ({ bytes, label }))),
    "without a viewer there is nothing to group by, and nothing is claimed"
  );
  assert.doesNotThrow(
    () => checkDegrees(adjacency(50, complete(50))),
    "and the degree cap now permits exactly this graph"
  );

  // 49 x 1500 = 73500 bytes, over the 65536 default.
  try {
    checkNeighbourhoodBytes(views);
    assert.fail("should have thrown");
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /1 participant\(s\) would receive more than 65536 bytes/);
    assert.match(m, /alice at 73500 bytes across 49 neighbours/);
    assert.match(m, /individually inside `maxViewBytes`/);
    assert.match(m, /maxNeighbourhoodBytes: 147000/, "a working override");
  }
});

test("the aggregate check groups per participant, not across the whole publish", () => {
  // The publish that would be reported wrongly by a naive total: two participants
  // at 40 KiB each is 80 KiB across the game and fine for both of them.
  const views = [
    ...Array.from({ length: 40 }, (_, i) => ({ bytes: 1024, label: `a/${i}`, viewer: "a" })),
    ...Array.from({ length: 40 }, (_, i) => ({ bytes: 1024, label: `b/${i}`, viewer: "b" })),
  ];
  assert.doesNotThrow(() => checkNeighbourhoodBytes(views));

  // And when several DO breach, one message names the worst.
  const { warn, seen } = collectWarnings();
  const heavy = ["a", "b", "c"].flatMap((viewer, k) =>
    Array.from({ length: 50 }, (_, i) => ({
      bytes: 2000 + k,
      label: `${viewer}/${i}`,
      viewer,
    }))
  );
  checkNeighbourhoodBytes(heavy, { onExceed: "warn" }, warn);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /3 participant\(s\)/);
  assert.match(seen[0]!, /worst: c at 100100 bytes/);
});

test("checkViewBytes runs the aggregate check too, and reports the sharper one first", () => {
  // One enormous view and a heavy total at once. The per-view breach is the more
  // actionable of the two — it names a single projection to go and look at — so it
  // is the one that throws.
  const views = [
    { bytes: 90_000, label: "a's view of b", viewer: "a" },
    ...Array.from({ length: 40 }, (_, i) => ({ bytes: 1000, label: `a/${i}`, viewer: "a" })),
  ];
  assert.throws(() => checkViewBytes(views), /neighbour view\(s\) exceed/);

  // With `warn` both are reported, because both are true and the fix may be one
  // change or two.
  const { warn, seen } = collectWarnings();
  checkViewBytes(views, { onExceed: "warn" }, warn);
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /neighbour view\(s\) exceed/);
  assert.match(seen[1]!, /would receive more than/);
});
