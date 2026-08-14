/**
 * The leak test, run as part of the suite.
 *
 * Same code path as `npx empirica-networks verify`, so the guarantee a user can
 * reproduce is the guarantee CI enforces.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runLeakCheck } from "../../src/verify/leak_test.js";

test("ring of 4: no participant ever receives a non-neighbour's state", async () => {
  const result = await runLeakCheck({ n: 4 });

  // Report everything before asserting, so a CI failure is diagnosable from the
  // log alone rather than needing a rerun.
  if (!result.pass) console.error(result.failures.join("\n"));

  assert.equal(result.crossParticipantLeaks, 0, "no non-neighbour sentinel may be received");
  assert.equal(
    result.delivered,
    result.expectedDeliveries,
    "every neighbour sentinel must arrive — otherwise a clean result is vacuous"
  );
  assert.ok(
    result.controlLeaks > 0,
    "the player-scope control must leak, proving the detector can see a leak at all"
  );
  assert.ok(result.pass, `leak check failed:\n${result.failures.join("\n")}`);
});

test("ring of 6: the guarantee holds with more non-neighbours", async () => {
  // n=6 gives each participant 2 neighbours and 3 non-neighbours, so there is
  // more for a broken projection to leak.
  const result = await runLeakCheck({ n: 6 });

  if (!result.pass) console.error(result.failures.join("\n"));
  assert.equal(result.crossParticipantLeaks, 0);
  assert.equal(result.delivered, result.expectedDeliveries);
  assert.ok(result.controlLeaks > 0);
});

test("refuses to run below n=4, where the check would be vacuous", async () => {
  await assert.rejects(() => runLeakCheck({ n: 3 }), /vacuous|n >= 4/);
});
