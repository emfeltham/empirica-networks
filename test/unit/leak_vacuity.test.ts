/**
 * What the leak check can establish on a given graph — `src/verify/topologies.ts`.
 *
 * This is the tier where the fourteen generators get covered. The accounting is
 * pure over `(n, edges)`, so every shape can be checked here in milliseconds;
 * the e2e tier then only has to prove that the three shapes with a distinct
 * accounting branch also behave against a real server, at the smallest n that
 * can show it (`docs/TESTING.md` §4 — the cost of a test is a property of the
 * test, and the e2e tier's margin is one participant wide).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeRng } from "../../src/admin/seed.js";
import {
  accountVacuity,
  preflightCliTopology,
  CLI_TOPOLOGIES,
  CLI_TOPOLOGY_NAMES,
} from "../../src/verify/topologies.js";
import {
  barabasiAlbert,
  complete,
  empty,
  erdosRenyi,
  fromEdgeList,
  geometricRandom,
  grid,
  ladder,
  pairs,
  ring,
  ringLattice,
  star,
  wattsStrogatz,
  wheel,
  type Edge,
} from "../../src/topology/index.js";

/** Every shipped generator, at an n each one accepts. */
const EVERY_GENERATOR: Array<[string, number, () => Edge[]]> = [
  ["ring(6)", 6, () => ring(6)],
  ["ringLattice(9, 2)", 9, () => ringLattice(9, 2)],
  ["grid(3, 4)", 12, () => grid(3, 4)],
  ["grid(3, 3, periodic)", 9, () => grid(3, 3, { periodic: true })],
  ["ladder(4)", 8, () => ladder(4)],
  ["complete(5)", 5, () => complete(5)],
  ["star(6)", 6, () => star(6)],
  ["wheel(6)", 6, () => wheel(6)],
  ["pairs(6)", 6, () => pairs(6)],
  ["empty()", 6, () => empty()],
  ["fromEdgeList(6, path)", 6, () => fromEdgeList(6, [[0, 1], [1, 2], [2, 3]])],
  ["wattsStrogatz(10, 4, 0.3)", 10, () => wattsStrogatz(10, 4, 0.3, { rng: makeRng(1) })],
  ["barabasiAlbert(10, 2)", 10, () => barabasiAlbert(10, 2, { rng: makeRng(2) })],
  ["erdosRenyi(10, 0.3)", 10, () => erdosRenyi(10, 0.3, { rng: makeRng(3) })],
  ["geometricRandom(10, 0.4)", 10, () => geometricRandom(10, 0.4, { rng: makeRng(4) })],
];

test("the two denominators partition every ordered pair, for every generator", () => {
  // The identity that makes the failure rule checkable rather than merely
  // plausible: a pair of distinct participants is either a neighbor pair (arm 3
  // expects a delivery) or a non-neighbor pair (arm 1 examines it), never both
  // and never neither. If this ever fails, the accounting has lost track of
  // somebody and both arms are reporting against the wrong base.
  for (const [label, n, build] of EVERY_GENERATOR) {
    const a = accountVacuity(n, build());
    assert.equal(
      a.candidatePairs + a.expectedDeliveries,
      n * (n - 1),
      `${label}: ${a.candidatePairs} + ${a.expectedDeliveries} != ${n * (n - 1)}`
    );
  }
});

test("a complete graph is refused: there is no non-neighbor to leak to", () => {
  const a = accountVacuity(4, complete(4));
  assert.equal(a.candidatePairs, 0);
  assert.deepEqual(a.saturated, [0, 1, 2, 3]);
  assert.match(a.failures.join(" "), /VACUOUS: every participant is adjacent/);
  // The note is suppressed when the failure already says it: one statement, not
  // the same fact twice in two registers.
  assert.deepEqual(a.notes, []);
});

test("an empty graph is refused: nothing was ever expected to arrive", () => {
  const a = accountVacuity(4, empty());
  assert.equal(a.expectedDeliveries, 0);
  assert.deepEqual(a.isolated, [0, 1, 2, 3]);
  assert.match(a.failures.join(" "), /VACUOUS: the graph has no edges/);
});

test("a star passes, and the hub is NOTED rather than failed", () => {
  // The behavior this change exists for. The hub is adjacent to everyone by
  // construction, so arm 1 can say nothing about it — but the three spokes each
  // have two non-neighbors, and the run establishes the guarantee for them.
  // Reporting the hub as a failure would fail a check the star actually passes.
  const a = accountVacuity(4, star(4));
  assert.deepEqual(a.failures, [], "a star is a legitimate shape");
  assert.deepEqual(a.saturated, [0], "the hub, and only the hub");
  assert.equal(a.candidatePairs, 6);
  assert.equal(a.expectedDeliveries, 6);
  assert.match(a.notes.join(" "), /adjacent to everyone/);
});

test("a disconnected graph passes, and the isolated node is NOTED", () => {
  const a = accountVacuity(4, fromEdgeList(4, [[0, 1], [1, 2]]));
  assert.deepEqual(a.failures, []);
  assert.deepEqual(a.isolated, [3]);
  assert.deepEqual(a.saturated, []);
  assert.equal(a.expectedDeliveries, 4);
  assert.equal(a.candidatePairs, 8);
  assert.match(a.notes.join(" "), /no neighbor/);
});

test("a ring of 4 has neither, which is why it is the default", () => {
  const a = accountVacuity(4, ring(4));
  assert.deepEqual(a.failures, []);
  assert.deepEqual(a.notes, [], "nothing to excuse, so nothing to say");
  assert.equal(a.candidatePairs, 4);
  assert.equal(a.expectedDeliveries, 8);
});

test("the pre-flight refuses wheel at n=4, because a wheel of 4 is K4", () => {
  // The trap a list of known-bad names would have missed. `wheel` is legal at
  // n >= 4 as a GENERATOR — but hub plus a 3-cycle rim is the complete graph on
  // four nodes, so at the CLI's default n it proves nothing. Refused by the same
  // accounting that refuses `complete`, rather than by being named.
  const bad = preflightCliTopology("wheel", 4);
  assert.ok("refusal" in bad, "wheel of 4 must not be allowed to report a PASS");
  assert.match(bad.refusal, /would prove nothing/);

  const good = preflightCliTopology("wheel", 5);
  assert.ok("edges" in good, "a wheel of 5 has a rim with non-neighbors");
});

test("the pre-flight refuses complete at every n", () => {
  for (const n of [4, 5, 8, 20]) {
    const r = preflightCliTopology("complete", n);
    assert.ok("refusal" in r, `complete of ${n} must be refused`);
  }
});

test("an unknown name is refused by name, and says what is known", () => {
  const r = preflightCliTopology("smallWorld", 4);
  assert.ok("refusal" in r);
  assert.match(r.refusal, /unknown topology "smallWorld"/);
  for (const name of CLI_TOPOLOGY_NAMES) assert.match(r.refusal, new RegExp(name));
  // The parameterised ones are not simply missing — the message says where they
  // went, because "unknown" is the wrong word for a generator that ships.
  assert.match(r.refusal, /runLeakCheck/);
});

test("a generator's own refusal is passed through, naming the count the user typed", () => {
  const odd = preflightCliTopology("pairs", 5);
  assert.ok("refusal" in odd);
  assert.match(odd.refusal, /pairs/);

  // `ladder` halves its argument, so an unwrapped throw would report "got 2.5"
  // — a number nobody typed.
  const oddLadder = preflightCliTopology("ladder", 5);
  assert.ok("refusal" in oddLadder);
  assert.match(oddLadder.refusal, /even participant count, got 5/);
  assert.doesNotMatch(oddLadder.refusal, /2\.5/);
});

test("every named topology builds a graph over exactly n participants", () => {
  // `ladder` is why this is asserted rather than assumed: the generator takes the
  // number of RUNGS and builds twice that many nodes.
  for (const name of CLI_TOPOLOGY_NAMES) {
    const edges = CLI_TOPOLOGIES[name]!(6);
    const highest = edges.reduce((m, [a, b]) => Math.max(m, a, b), -1);
    assert.ok(highest < 6, `${name}(6) referenced index ${highest}, so it is not a graph over 6`);
  }
});
