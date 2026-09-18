/**
 * The leak test, run as part of the suite.
 *
 * Same code path as `npx empirica-networks verify`, so the guarantee a user can
 * reproduce is the guarantee CI enforces.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fromEdgeList, ring } from "../../src/topology/index.js";
import { formatLeakResult, runLeakCheck } from "../../src/verify/leak_test.js";
import { accountVacuity, preflightCliTopology } from "../../src/verify/topologies.js";

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


// ------------------------------------------- the structural arms (radius 1.5)
//
// `test/e2e/subgraph.test.ts` proves the FEATURE is correct. These prove the
// TOOL can tell: a verification command that passes whatever it is shown is
// worse than no command, and the structural arms are the ones most easily
// written that way, because the payload they judge carries no sentinel and
// every other arm stays clean however wrong it is.

test("radius 1: the default sends no structure, and the run says so", async () => {
  const result = await runLeakCheck({ n: 4 });

  if (!result.pass) console.error(result.failures.join("\n"));
  assert.equal(result.radius, 1, "the result reports the radius it ran at");
  assert.equal(
    result.structureFramesAtRadius1,
    0,
    "the default's cost is a checked claim, not a stated one"
  );
  assert.ok(result.pass, `leak check failed:\n${result.failures.join("\n")}`);
});

test("radius 1.5: every delivered tie is contained, real, and all of them arrive", async () => {
  // A wheel because it is the only shipped shape with ties among anyone's
  // neighbors. On a ring this run would be refused rather than passed, which is
  // the case below.
  const result = await runLeakCheck({ n: 6, topology: "wheel", radius: 1.5 });

  if (!result.pass) console.error(result.failures.join("\n"));

  assert.equal(result.radius, 1.5);
  assert.equal(result.structureViolations, 0, "no tie may name somebody the viewer cannot see");
  assert.ok(
    result.structureTies > 0,
    "no structure was examined at all, so the containment arm said nothing"
  );

  // Hub 0 plus a 5-cycle rim. The hub sees all five rim ties; each rim node sees
  // its two ties to the hub and not the tie between its rim neighbors, who are
  // two apart. Pinned as a number rather than compared to itself, because
  // `delivered === expected` is satisfied by zero equalling zero.
  assert.equal(result.expectedBeyondStar, 15);
  assert.equal(
    result.beyondStarDelivered,
    result.expectedBeyondStar,
    "participants must be shown everything radius 1.5 promises, not some of it"
  );

  // The state arms still hold, unchanged, at the wider radius.
  assert.equal(result.crossParticipantLeaks, 0);
  assert.equal(result.delivered, result.expectedDeliveries);
  assert.ok(result.controlLeaks > 0);
  assert.ok(result.pass, `leak check failed:\n${result.failures.join("\n")}`);
});

test("radius 1.5 on a triangle-free shape is refused, not passed", async () => {
  // A ring is a fine subject at radius 1 and a useless one at 1.5: nobody's two
  // neighbors are connected, so the extra structure is empty and a pass would
  // mean the feature had done nothing. Refused from the accounting, before a
  // server boots — the same path `--topology complete` takes.
  const account = accountVacuity(6, ring(6), 1.5);
  assert.equal(account.expectedBeyondStar, 0);
  assert.match(account.failures.join(" "), /VACUOUS at radius 1\.5/);
  assert.ok("refusal" in preflightCliTopology("ring", 6, 1.5));

  // And the same shape is accepted at the radius it can speak to.
  assert.ok(!("refusal" in preflightCliTopology("ring", 6, 1)));
});

/**
 * A study where participants see different distances, end to end.
 *
 * Run by hand against a real server while this was built and never by anything
 * automated, which is the wrong footing for the arm that exists to separate two
 * rules from each other: "the VIEWER's radius decides who they may learn about"
 * and "the SUBJECT's radius decides who may learn about them" agree on every
 * pair of a uniform study, so every other test here passes under either.
 *
 * Seat 0 at radius 2 on a ring of 8 reaches seats 2 and 6, and neither reaches
 * back — that asymmetry is the whole subject, and `accountVacuity` refuses a run
 * that does not have it.
 */
test("mixed radii: each participant is held to their own, and the run says which", async () => {
  const radii = Array.from({ length: 8 }, (_, i) => (i === 0 ? 2 : 1));
  const r = await runLeakCheck({ n: 8, topology: "ring", radius: radii, projectFar: true });

  assert.ok(r.pass, r.failures.join("\n"));
  assert.deepEqual(r.radius, radii, "the result reports the assignment it ran");
  assert.ok(r.projectsFar);

  // The denominators moved, and by the right amount: seven seats reach two
  // people each and one reaches four, so 18 deliveries and 38 forbidden pairs
  // out of the 56 ordered pairs of eight participants.
  assert.equal(r.expectedDeliveries, 18);
  assert.equal(r.candidatePairs, 38);
  assert.equal(
    r.candidatePairs + r.expectedDeliveries,
    8 * 7,
    "and they still partition every ordered pair"
  );
  assert.equal(r.crossParticipantLeaks, 0);
  assert.ok(r.controlLeaks > 0, "the control still proves detection works");

  // The report has to name the shape, or a reader cannot tell which study the
  // verdict is about.
  assert.match(formatLeakResult(r), /radius: 1 \/ 2 by seat/);
});

test("mixed radii on a graph where no pair disagrees is refused, not passed", async () => {
  // A complete graph: everybody is one hop from everybody, so a wider radius
  // reaches nobody new and the two rules agree on every pair however the radii
  // are set. The run would pass while proving nothing about which rule is in
  // force, which is the one thing a mixed run is for.
  const r = await runLeakCheck({
    n: 6,
    topology: "complete",
    radius: [2, 1, 1, 1, 1, 1],
    projectFar: true,
  });
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /cannot tell a build that keys delivery/);
});
