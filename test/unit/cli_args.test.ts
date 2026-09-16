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
import { parseArgs } from "../../src/verify/args.js";

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
