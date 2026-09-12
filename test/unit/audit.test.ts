/**
 * The `views.ndjson` audit: C1 over complete sessions, and its denominators.
 *
 * The audit is pure over text, so it tests without a server — the same discipline
 * as `export.ts` and `verify/topologies.ts`, and for the same reason: nothing that
 * decides whether a verification result means anything should be reachable only
 * through a bundler (PLATFORM-NOTES §3a).
 *
 * THE CASE THIS FILE EXISTS FOR is the third one below. An audit that reports "no
 * leaks" over an empty file has the exact shape this repository keeps finding: the
 * check ran, said nothing, and meant nothing. That is why this file is not
 * optional, and why the denominator is a binding requirement — "zero non-neighbour
 * views" over an unstated number of views is not a result.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  auditViews,
  formatAuditResult,
  canonicalEdges,
  mergeAuditResults,
  parseEdgesCsv,
  structuralEdges,
} from "../../src/verify/audit.js";

/**
 * A path of three: a-b, a-c. So `a` has two neighbours and `b` and `c` have one
 * each — and b/c are non-adjacent, which is what gives the leak arm something to
 * be about. A complete graph here would make every pass vacuous.
 */
const EDGES_CSV = [
  `"game_id","t","event","player_a","player_b"`,
  `"g1","1000","connected","a","b"`,
  `"g1","1000","connected","a","c"`,
].join("\n");

const ndjson = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

const CLEAN = ndjson(
  { gameID: "g1", viewer: "a", seq: 1, at: 1000, view: [{ id: "b" }, { id: "c" }] },
  { gameID: "g1", viewer: "b", seq: 1, at: 1000, view: [{ id: "a" }] },
  { gameID: "g1", viewer: "c", seq: 1, at: 1000, view: [{ id: "a" }] }
);

const edges = () => parseEdgesCsv(EDGES_CSV);

test("edges.csv parses into a neighbour map in the player-id space", () => {
  // The same id space as `ViewRecord.viewer` and `view[].id`, so the audit compares
  // without an index mapping. `edgeRows` emits player ids for exactly this reason.
  const g1 = parseEdgesCsv(EDGES_CSV).graphs.get("g1")!;
  assert.deepEqual([...g1.get("a")!].sort(), ["b", "c"]);
  assert.deepEqual([...g1.get("b")!].sort(), ["a"]);
  assert.deepEqual([...g1.get("c")!].sort(), ["a"]);
});

test("a clean file passes, and says how many records and deliveries it checked", () => {
  const r = auditViews({ views: CLEAN, edges: edges() });
  assert.equal(r.pass, true);
  assert.deepEqual(r.failures, []);
  assert.equal(r.sessions, 1);
  assert.equal(r.recordsChecked, 3);
  // Four (viewer, neighbour) deliveries: a->b, a->c, b->a, c->a. This is the
  // denominator that makes `leaks: 0` falsifiable.
  assert.equal(r.deliveriesChecked, 4);
  assert.equal(r.leaks, 0);
  assert.equal(r.missingDeliveries, 0);
  assert.deepEqual(r.vacuousSessions, []);
  // And the formatted report carries both numbers, not just the numerator.
  assert.match(formatAuditResult(r), /0\/4/);
});

test("an empty file is VACUOUS, not a pass", () => {
  // The failure mode this file exists for. Nothing leaked because nothing was
  // examined, and a PASS here would be a lie told with true numbers.
  const r = auditViews({ views: "", edges: edges() });
  assert.equal(r.pass, false);
  assert.equal(r.recordsChecked, 0);
  assert.deepEqual(r.vacuousSessions, ["g1"]);
  assert.match(r.failures.join(" "), /VACUOUS/);
  assert.doesNotMatch(formatAuditResult(r), /PASS/);
});

test("a session with no records is vacuous even when another session is clean", () => {
  // Per-session vacuity, not just overall: ten clean sessions do not license a
  // silent eleventh, and the runbook requires vacuous sessions counted separately.
  const g = parseEdgesCsv(
    EDGES_CSV + "\n" + [`"g2","1000","connected","d","e"`].join("\n")
  );
  const r = auditViews({ views: CLEAN, edges: g });
  assert.equal(r.pass, false);
  assert.deepEqual(r.vacuousSessions, ["g2"]);
  assert.equal(r.recordsChecked, 3, "the clean session was still audited");
});

test("a non-neighbour in a view is a leak, and names the pair", () => {
  // C1 failing. b and c are not adjacent, so c's presence in b's view is the
  // thing the whole package exists to prevent.
  const leaked = ndjson(
    { gameID: "g1", viewer: "a", seq: 1, at: 1000, view: [{ id: "b" }, { id: "c" }] },
    { gameID: "g1", viewer: "b", seq: 1, at: 1000, view: [{ id: "a" }, { id: "c" }] }
  );
  const r = auditViews({ views: leaked, edges: edges() });
  assert.equal(r.pass, false);
  assert.equal(r.leaks, 1);
  assert.match(r.failures.join(" "), /LEAK/);
  assert.match(r.failures.join(" "), /b/);
  assert.match(r.failures.join(" "), /c/);
});

test("a missing neighbour is a delivery defect, recorded and not counted as a leak", () => {
  // Under-delivery looks like a sparser network than the one that ran. It is not
  // C1 failing — nothing reached anyone who should not have had it — so it is
  // reported on its own line rather than ending the evaluation.
  const short = ndjson({
    gameID: "g1",
    viewer: "a",
    seq: 1,
    at: 1000,
    view: [{ id: "b" }],
  });
  const r = auditViews({ views: short, edges: edges() });
  assert.equal(r.leaks, 0);
  assert.equal(r.missingDeliveries, 1);
  assert.match(r.notes.join(" ") + r.failures.join(" "), /missing/i);
});

test("the same neighbour twice in one view is an error, not silence", () => {
  const dup = ndjson({
    gameID: "g1",
    viewer: "a",
    seq: 1,
    at: 1000,
    view: [{ id: "b" }, { id: "b" }, { id: "c" }],
  });
  const r = auditViews({ views: dup, edges: edges() });
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /twice|duplicate/i);
});

test("a viewer who is not in the graph is an error, not silence", () => {
  // Either the wrong edges.csv was paired with this views file, or someone was
  // delivered a view in a game they were not seated in. Both are worth stopping
  // for, and neither should read as a clean audit.
  const stranger = ndjson({
    gameID: "g1",
    viewer: "zz",
    seq: 1,
    at: 1000,
    view: [{ id: "a" }],
  });
  const r = auditViews({ views: stranger, edges: edges() });
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /not in the graph|unknown viewer/i);
});

test("a view entry without a string id is an error rather than an unaudited record", () => {
  // `project()` need not emit an id — `viewRows` falls back to a positional index
  // — but an audit that cannot name who was seen cannot check C1 for that record,
  // and skipping it quietly would shrink the denominator without saying so.
  const anon = ndjson({
    gameID: "g1",
    viewer: "a",
    seq: 1,
    at: 1000,
    view: [{ color: "red" }],
  });
  const r = auditViews({ views: anon, edges: edges() });
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /id/);
});

test("a torn final line is counted, not swallowed", () => {
  // The expected cause is a hard kill cutting the last record in half — runbook §8
  // injects exactly that — and a recovery that quietly dropped it would be
  // indistinguishable from a session that published one view fewer.
  const r = auditViews({ views: CLEAN + '{"gameID":"g1","viewer":"a"', edges: edges() });
  assert.equal(r.dropped, 1);
  assert.match(r.notes.join(" ") + r.failures.join(" "), /dropped|truncat/i);
});

test("a rewiring game is refused rather than audited against its final graph", () => {
  // Shirado never rewires, so the audit assumes one static neighbour set per game.
  // Against a design that does rewire, comparing every view to the final graph
  // would manufacture leaks for views that were correct when delivered. Refuse,
  // rather than report a number that means something else.
  const rewired = [
    EDGES_CSV,
    `"g1","2000","disconnected","a","c"`,
  ].join("\n");
  const r = auditViews({ views: CLEAN, edges: parseEdgesCsv(rewired) });
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /rewir/i);
});

test("a mass leak reports exact counts but a bounded number of examples", () => {
  // The most important result this audit can produce must not also be the most
  // unreadable. At n=20 over five minutes a real C1 failure would run to tens of
  // thousands of lines, and an unbounded list of them goes into manifest.json and
  // into memory. Cap the prose; never cap the count.
  const many = ndjson(
    ...Array.from({ length: 300 }, (_, i) => ({
      gameID: "g1",
      viewer: "b",
      seq: i,
      at: 1000 + i,
      view: [{ id: "a" }, { id: "c" }],
    }))
  );
  const r = auditViews({ views: many, edges: edges() });
  assert.equal(r.pass, false);
  assert.equal(r.leaks, 300, "every leak is counted");
  assert.equal(r.deliveriesChecked, 600, "and so is the denominator");
  assert.ok(r.failures.length < 40, `quoted ${r.failures.length} messages; expected a cap`);
  assert.match(r.failures.join(" "), /not quoted/);
});

test("merging session audits sums the counts and keeps per-session attribution", () => {
  const a = auditViews({ views: CLEAN, edges: edges() });
  const b = auditViews({ views: CLEAN, edges: edges() });
  const m = mergeAuditResults([a, b]);
  assert.equal(m.pass, true);
  assert.equal(m.sessions, 2);
  assert.equal(m.recordsChecked, 6);
  assert.equal(m.deliveriesChecked, 8);
  assert.equal(m.perSession.length, 2, "a failure still names the session that produced it");
});

test("an arm with no auditable session at all is vacuous, not a clean pass", () => {
  // Summing zero results would otherwise report PASS over nothing — the same
  // failure shape as the empty file, one level up.
  const m = mergeAuditResults([]);
  assert.equal(m.pass, false);
  assert.match(m.failures.join(" "), /VACUOUS/);
});

test("canonical edge lists ignore pair orientation and list order", () => {
  // Neither the generator nor the export promises an orientation or an order, so
  // a comparison sensitive to either would report a difference that is not one.
  assert.equal(
    canonicalEdges([[2, 0], [1, 0]]),
    canonicalEdges([[0, 1], [0, 2]])
  );
  assert.notEqual(canonicalEdges([[0, 1]]), canonicalEdges([[0, 2]]));
});

test("edges.csv maps into index space through the recorded seating", () => {
  const csv = [
    `"game_id","t","event","player_a","player_b"`,
    `"g1","1","connected","p0","p2"`,
    `"g1","1","connected","p1","p0"`,
  ].join("\n");
  assert.equal(
    canonicalEdges(structuralEdges(csv, "g1", ["p0", "p1", "p2"])),
    canonicalEdges([[0, 2], [0, 1]])
  );
});

test("an edge naming someone outside the seating is an error, not a dropped edge", () => {
  // The export and the seating would then describe different games, and silently
  // skipping the edge would shrink the graph being compared — making a
  // reproducibility check pass on a smaller graph than the one that ran.
  const csv = [
    `"game_id","t","event","player_a","player_b"`,
    `"g1","1","connected","p0","STRANGER"`,
  ].join("\n");
  assert.throws(() => structuralEdges(csv, "g1", ["p0", "p1"]), /not in the recorded seating/);
});

test("only this game's connected rows are read", () => {
  // One results directory holds many sessions and one log can hold several
  // games; a check that mixed two graphs would compare neither.
  const csv = [
    `"game_id","t","event","player_a","player_b"`,
    `"g1","1","connected","p0","p1"`,
    `"g2","1","connected","p0","p1"`,
    `"g1","2","disconnected","p0","p1"`,
  ].join("\n");
  assert.equal(structuralEdges(csv, "g1", ["p0", "p1"]).length, 1);
});
