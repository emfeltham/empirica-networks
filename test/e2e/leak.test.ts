/**
 * The leak test, run as part of the suite.
 *
 * Same code path as `npx empirica-networks verify`, so the guarantee a user can
 * reproduce is the guarantee CI enforces.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fromEdgeList } from "../../src/topology/index.js";
import { runLeakCheck } from "../../src/verify/leak_test.js";

test("ring of 4: no participant ever receives a non-neighbor's state", async () => {
  const result = await runLeakCheck({ n: 4 });

  // Report everything before asserting, so a CI failure is diagnosable from the
  // log alone rather than needing a rerun.
  if (!result.pass) console.error(result.failures.join("\n"));

  assert.equal(result.crossParticipantLeaks, 0, "no non-neighbor sentinel may be received");
  assert.equal(
    result.delivered,
    result.expectedDeliveries,
    "every neighbor sentinel must arrive — otherwise a clean result is vacuous"
  );
  assert.ok(
    result.controlLeaks > 0,
    "the player-scope control must leak, proving the detector can see a leak at all"
  );
  assert.ok(result.pass, `leak check failed:\n${result.failures.join("\n")}`);
});

test("star of 4: the hub is adjacent to everyone, and that is not a failure", async () => {
  // The shape that used to FAIL a check it passes. A star's hub has no
  // non-neighbor by construction, so arm 1 can say nothing about it — the old
  // code recorded that as a failure, which would have condemned every
  // centralised design in `docs/TOPOLOGIES.md`. The three spokes each have two
  // non-neighbors, and the guarantee is established for them.
  const result = await runLeakCheck({ n: 4, topology: "star" });

  if (!result.pass) console.error(result.failures.join("\n"));
  assert.equal(result.crossParticipantLeaks, 0);
  assert.equal(result.delivered, result.expectedDeliveries);
  assert.ok(result.controlLeaks > 0);
  assert.equal(result.saturated, 1, "the hub, noted rather than failed");
  assert.equal(result.candidatePairs, 6, "and six pairs were still examined");
  assert.ok(result.pass, `leak check failed:\n${result.failures.join("\n")}`);
});

test("a disconnected graph: an isolated participant is a result, not a hang", async () => {
  // Two things at once, and both are load-bearing.
  //
  // The isolated node is what proves the publication wait is right: it never gets
  // a neighbor, so a wait on `neighbors.length > 0` would sit until the timeout
  // and then report a dead server. This test fails loudly if that is reverted.
  //
  // The graph is hand-built rather than drawn from `erdosRenyi` below its
  // percolation threshold, and not merely to avoid flake: `withNetwork` seeds from
  // `hashSeed(String(game.id))` and the game id is fresh every run, so a random
  // generator's REALIZED graph differs between runs of this same test. Expected
  // values would be a function of something that changes underneath them.
  const result = await runLeakCheck({
    n: 4,
    topology: ({ playerCount }) => fromEdgeList(playerCount, [[0, 1], [1, 2]]),
  });

  if (!result.pass) console.error(result.failures.join("\n"));
  assert.equal(result.crossParticipantLeaks, 0);
  assert.equal(result.delivered, result.expectedDeliveries);
  assert.ok(result.controlLeaks > 0);
  assert.equal(result.isolated, 1, "the participant with no edge");
  assert.equal(result.expectedDeliveries, 4, "two edges, counted from both ends");
  assert.equal(result.candidatePairs, 8);
  assert.ok(result.pass, `leak check failed:\n${result.failures.join("\n")}`);
});

test("refuses to run below n=4, where the check would be vacuous", async () => {
  await assert.rejects(() => runLeakCheck({ n: 3 }), /vacuous|n >= 4/);
});

test("a complete graph is refused rather than passed", async () => {
  // Not a server test in substance — `accountVacuity` decides it and is covered
  // in the unit tier — but asserted through the real entry point because this is
  // the failure the whole file exists to prevent: a run that examines nothing and
  // reports PASS. `test/e2e/shirado2017.test.ts` relies on the same rule.
  const result = await runLeakCheck({ n: 4, topology: "complete" });

  assert.equal(result.candidatePairs, 0, "there is no non-neighbor to leak to");
  assert.equal(result.pass, false, "a check that examined nothing must not pass");
  assert.match(result.failures.join(" "), /VACUOUS/);
});
