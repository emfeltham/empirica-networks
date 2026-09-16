/**
 * How `verify` reads its flags.
 *
 * Worth a file of its own because flag parsing is where a setting quietly
 * becomes a different setting, and this repository has had that bug twice
 * already: `examples/minimal` compared `NBHD_RADIUS` against the string `"1.5"`
 * and sent `2` to the default without a word, and `readRadius` tested for a
 * number and read a recorded `"whole"` back as nothing recorded at all. Both
 * were invisible from outside. Nothing could reach this parser until now.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, refuseArgs } from "../../src/verify/args.js";

test("the defaults are the documented ones", () => {
  const a = parseArgs(["verify"]);
  assert.equal(a.command, "verify");
  assert.equal(a.n, 4);
  assert.equal(a.topology, "ring");
  assert.equal(a.radius, 1);
  assert.equal(a.radii, undefined);
  assert.equal(a.projectFar, false);
});

test("--radius takes every legal spelling, in both forms", () => {
  for (const [flag, want] of [
    ["1.5", 1.5],
    ["2", 2],
    ["2.5", 2.5],
    ["whole", "whole"],
  ] as Array<[string, number | string]>) {
    assert.equal(parseArgs(["verify", "--radius", flag]).radius, want);
    assert.equal(parseArgs(["verify", `--radius=${flag}`]).radius, want);
  }
});

test("a radius that is not a number becomes NaN rather than silently a 1", () => {
  // The refusal downstream prints what it was given. Coercing to the default
  // here would run the study the caller did not ask for and say nothing — which
  // is exactly what `NBHD_RADIUS` did.
  assert.ok(Number.isNaN(parseArgs(["verify", "--radius", "banana"]).radius as number));
  assert.ok(Number.isNaN(parseArgs(["verify", "--radius", "all"]).radius as number));
});

test("--radii takes a list, in both forms, and keeps `whole` a word", () => {
  assert.deepEqual(parseArgs(["verify", "--radii", "1,2"]).radii, [1, 2]);
  assert.deepEqual(parseArgs(["verify", "--radii=1,2,2.5"]).radii, [1, 2, 2.5]);
  assert.deepEqual(parseArgs(["verify", "--radii", "1,whole"]).radii, [1, "whole"]);
});

test("--project-far is a boolean and takes no value", () => {
  const a = parseArgs(["verify", "--project-far", "--n", "6"]);
  assert.equal(a.projectFar, true);
  assert.equal(a.n, 6, "the flag did not swallow the next argument");
});

test("the flags compose in any order", () => {
  const a = parseArgs(["verify", "--radii", "2,1", "--topology", "ring", "--n", "8", "--project-far"]);
  assert.deepEqual(a.radii, [2, 1]);
  assert.equal(a.topology, "ring");
  assert.equal(a.n, 8);
  assert.equal(a.projectFar, true);
});

// ------------------------------------------------------------- the refusals
//
// Every one of these lived inside `main()`, which boots a real server, so none
// of them could be reached by a test. A refusal that fires when it should not is
// a tool that will not run; one that does not fire when it should is a PASS over
// a check that examined nothing, which is the result this command exists to
// prevent. Both directions are asserted for each.

const args = (argv: string[]) => parseArgs(["verify", ...argv]);

test("a legal run is not refused", () => {
  for (const argv of [
    [],
    ["--radius", "1.5"],
    ["--radius", "2.5"],
    ["--radii", "1,2"],
    ["--radii", "1,whole"],
    ["--radii", "2,1", "--project-far"],
  ]) {
    assert.equal(refuseArgs(args(argv)), undefined, `refused a legal run: ${argv.join(" ")}`);
  }
});

test("--radius and --radii together are refused rather than one silently winning", () => {
  const m = refuseArgs(args(["--radius", "2", "--radii", "1,2"]));
  assert.match(m ?? "", /two spellings of one setting/);
  // But the DEFAULT radius alongside --radii is not a conflict: nobody typed it.
  assert.equal(refuseArgs(args(["--radii", "1,2"])), undefined);
});

test("a radius between the steps is refused, in either spelling", () => {
  assert.match(refuseArgs(args(["--radius", "1.2"])) ?? "", /multiple of 0\.5/);
  assert.match(refuseArgs(args(["--radius", "banana"])) ?? "", /multiple of 0\.5/);
  assert.match(refuseArgs(args(["--radii", "1,1.2"])) ?? "", /is not one of them/);
  assert.match(refuseArgs(args(["--radii", "1,all"])) ?? "", /is not one of them/);
});

test("radius 0.5 and 0 are refused: half a step reaches nobody", () => {
  assert.match(refuseArgs(args(["--radius", "0.5"])) ?? "", /at least 1/);
  assert.match(refuseArgs(args(["--radius", "0"])) ?? "", /at least 1/);
});

/**
 * The refusal that inverts under per-seat radii.
 *
 * `whole` for EVERYBODY leaves no non-neighbor, so confinement has an empty
 * denominator. `whole` for SOME is the opposite: every narrow seat is a live
 * test and the wide one is the hazard worth watching, which makes it the more
 * interesting run rather than an unverifiable one.
 */
test("whole for everybody is refused; whole for somebody is not", () => {
  assert.match(refuseArgs(args(["--radius", "whole"])) ?? "", /no confinement to verify/);
  assert.match(refuseArgs(args(["--radii", "whole,whole"])) ?? "", /no confinement to verify/);
  assert.equal(
    refuseArgs(args(["--radii", "1,whole"])),
    undefined,
    "a mixed run with one wide seat is checkable, and is the shape worth running"
  );
});
