/**
 * The Shirado 2017 reconstruction's design rules, checked against the paper.
 *
 * The rules here are small, and one of them is the end condition of the whole
 * experiment — so it gets the most attention. A solution detector that fires early
 * records a time to solution for a problem nobody solved, which is the
 * silent-SUCCESS version of this codebase's characteristic failure and is harder
 * to notice than a crash.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeRng } from "../../src/admin/seed.js";
import { barabasiAlbert, degrees, maxDegree } from "../../src/topology/index.js";
import {
  ATTACHMENT,
  COLORS,
  NODES,
  TIME_LIMIT_SECONDS,
  changeRows,
  conflictCount,
  conflictEdges,
  conflictFreeColors,
  exportFiles,
  fromLog,
  isSolved,
  localConflicts,
  sessionRows,
  // @ts-expect-error - plain JS example module, deliberately untyped
} from "../../examples/shirado2017/server/src/design.js";
import { edgeRows, parseNdjson, toCSV } from "../../src/admin/export.js";
import type { EdgeEvent } from "../../src/shared/keys.js";

/** A colour lookup from an array, with `undefined` for "has not chosen". */
const from = (colors: Array<string | undefined>) => (i: number) => colors[i];

test("the paper's parameters are what the paper says", () => {
  assert.deepEqual(COLORS, ["green", "orange", "purple"], "three colours, named in the paper");
  assert.equal(COLORS.length, 3, "the chromatic number of the graphs used");
  assert.equal(NODES, 20, "networks of 20 nodes");
  assert.equal(ATTACHMENT, 2, "new nodes each with two links");
  assert.equal(TIME_LIMIT_SECONDS, 300, "5 minutes");
});

test("conflictEdges: only same-coloured pairs, and only when both have chosen", () => {
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
  ];
  // 0=green 1=green 2=orange 3=undefined
  const colorAt = from(["green", "green", "orange", undefined]);

  assert.deepEqual(conflictEdges(edges, colorAt), [[0, 1]], "only the matching pair");
  assert.equal(conflictCount(edges, colorAt), 1);

  // An unchosen node is in conflict with NOBODY. Counting it would make a session
  // look unsolved because somebody had not loaded their browser yet.
  assert.equal(conflictCount([[2, 3]], colorAt), 0, "orange vs unchosen is not a conflict");
  assert.equal(
    conflictCount([[3, 3]], from([undefined, undefined, undefined, undefined])),
    0,
    "two unchosen nodes are not a conflict either"
  );
});

test("conflictCount counts EDGES, not nodes", () => {
  // A star whose centre and all three leaves are green: 3 conflicting edges, 4
  // conflicted people. Counting nodes would report 4 and make the cost function
  // disagree with the paper's, which is the number of conflicts.
  const star = [
    [0, 1],
    [0, 2],
    [0, 3],
  ];
  assert.equal(conflictCount(star, from(["green", "green", "green", "green"])), 3);
});

test("isSolved requires zero conflicts AND everybody having chosen", () => {
  const path3 = [
    [0, 1],
    [1, 2],
  ];

  assert.equal(
    isSolved(3, path3, from(["green", "orange", "green"])),
    true,
    "a proper colouring is solved"
  );
  assert.equal(
    isSolved(3, path3, from(["green", "green", "orange"])),
    false,
    "a conflict is not solved"
  );

  // THE one that matters. Zero conflicts among a partly-coloured network is not a
  // solution: accepting it would end the session early and record a time to
  // solution for a problem nobody solved.
  assert.equal(
    conflictCount(path3, from(["green", undefined, "orange"])),
    0,
    "there are genuinely no conflicts in this state"
  );
  assert.equal(
    isSolved(3, path3, from(["green", undefined, "orange"])),
    false,
    "...and it is still not solved, because node 1 has not chosen"
  );

  // An isolated node still has to choose.
  assert.equal(isSolved(2, [], from(["green", undefined])), false);
  assert.equal(isSolved(2, [], from(["green", "green"])), true, "no edge, no conflict");
});

test("localConflicts: what a participant can work out for themselves", () => {
  assert.equal(localConflicts(["green", "orange", "green"], "green"), 2);
  assert.equal(localConflicts(["green", "orange"], "purple"), 0);
  // Before choosing, a participant is in no conflict — and must not be told they
  // are, since they have not acted yet.
  assert.equal(localConflicts(["green", "green"], undefined), 0);
  assert.equal(localConflicts([], "green"), 0, "an isolated node conflicts with nobody");
});

test("conflictFreeColors: derived only from what the participant can already see", () => {
  assert.deepEqual(conflictFreeColors(["green"]), ["orange", "purple"]);
  assert.deepEqual(conflictFreeColors(["green", "orange"]), ["purple"]);
  // The locally-unresolvable state: every colour is taken by a neighbour, so this
  // participant cannot fix their own conflict and somebody else must move first.
  // The paper marks exactly this case in Fig. 1a, and an empty list is the honest
  // answer rather than a fallback suggestion.
  assert.deepEqual(conflictFreeColors(["green", "orange", "purple"]), []);
  assert.deepEqual(conflictFreeColors([]), COLORS, "no neighbours: anything goes");
  assert.deepEqual(
    conflictFreeColors([undefined, "green"]),
    ["orange", "purple"],
    "a neighbour who has not chosen blocks nothing"
  );
});

test("barabasiAlbert(20, 2) is inside the package's default envelope", () => {
  // The Rand port has to raise `maxDegree`; this one must not need to. Asserted
  // rather than assumed, because a hub-forming generator is exactly the kind of
  // thing that would quietly exceed it — and `withNetwork` throws at game start if
  // it does, which would take the experiment down mid-session for participants.
  for (let seed = 1; seed <= 50; seed++) {
    const edges = barabasiAlbert(NODES, ATTACHMENT, { rng: makeRng(seed) });
    const d = maxDegree(NODES, edges);
    assert.ok(d <= 16, `seed ${seed} produced degree ${d}, outside the default envelope`);
    // Non-vacuity: hubs really do form, so the bound above is not trivially met by
    // a regular graph.
    assert.ok(d >= ATTACHMENT, `seed ${seed} produced degree ${d}`);
  }

  // And it is connected by construction, which matters because an isolated node
  // could never be in conflict and the session would be solvable without them.
  const edges = barabasiAlbert(NODES, ATTACHMENT, { rng: makeRng(7) });
  assert.ok(
    degrees(NODES, edges).every((d: number) => d > 0),
    "preferential attachment leaves nobody isolated"
  );
});

test("changeRows: durations, not wall clocks, and the hidden cost function", () => {
  const rows = changeRows("game-1", [
    { tMs: 1200, playerID: "p1", topologyIndex: 0, degree: 4, color: "green", conflictsAfter: 3 },
    { tMs: 4800, playerID: "p2", topologyIndex: 1, degree: 2, color: "orange", conflictsAfter: 2 },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].t_ms, 1200, "milliseconds since the stage started");
  assert.equal(rows[0].game_id, "game-1", "joins onto edges.csv");
  // The global conflict count, which participants never saw and which cannot be
  // reconstructed from the colours alone without the graph at that instant.
  assert.equal(rows[0].conflicts_after, 3);
  assert.equal(rows[1].conflicts_after, 2);

  const header = toCSV(rows as Record<string, string | number>[]).split("\n")[0]!;
  assert.deepEqual(
    header.split(",").map((c) => c.replace(/^"|"$/g, "")),
    ["game_id", "t_ms", "player_id", "topology_index", "degree", "color", "conflicts_after"],
    "the column contract with an analyst"
  );
});

test("sessionRows: an unsolved session is censored, not recorded as 300s", () => {
  const solved = sessionRows("g1", {
    n: 20,
    edges: 37,
    solved: true,
    tSolutionMs: 143_700,
    changes: 52,
    maxDegree: 8,
  });
  assert.equal(solved[0].solved, 1);
  assert.equal(solved[0].t_solution_ms, 143_700);

  // The paper censors at 300 s. Writing the limit as though it were an observation
  // is how a censored value silently becomes a measurement — and a survival
  // analysis over such a column reports a median that never happened.
  const unsolved = sessionRows("g2", {
    n: 20,
    edges: 37,
    solved: false,
    tSolutionMs: 300_000,
    changes: 91,
    maxDegree: 8,
  });
  assert.equal(unsolved[0].solved, 0);
  assert.equal(unsolved[0].t_solution_ms, "", "empty, so it reads as NA rather than 300000");
});

test("exportFiles: every analysis file, named and populated", () => {
  // Same reasoning as the Rand port's equivalent: `onGameEnded` only fires when a
  // game ends naturally, so the content is asserted here rather than left to the
  // subset of runs that happen to reach it.
  const files = exportFiles(
    "game-1",
    { n: 20, edges: 37, solved: true, tSolutionMs: 143_700, changes: 2, maxDegree: 8 },
    [
      { tMs: 100, playerID: "p1", topologyIndex: 0, degree: 4, color: "green", conflictsAfter: 3 },
      { tMs: 900, playerID: "p2", topologyIndex: 1, degree: 2, color: "orange", conflictsAfter: 0 },
    ],
    "EDGES_CSV_PLACEHOLDER",
    toCSV
  );

  assert.deepEqual(
    Object.keys(files).sort(),
    ["changes.csv", "edges.csv", "session.csv"],
    "the filenames are the contract with an analyst, and with this example's README"
  );
  assert.equal(files["edges.csv"], "EDGES_CSV_PLACEHOLDER", "the package's export, untouched");

  const session = files["session.csv"]!.trim().split("\n");
  assert.equal(session.length, 2, "one session row");
  assert.match(session[1]!, /143700/, "the solution time is in it");

  const changes = files["changes.csv"]!.trim().split("\n");
  assert.equal(changes.length, 3, `expected header + 2 rows, got ${changes.length}`);
  // The global conflict count is in the FILE and was never on any wire — the
  // pairing that makes this design's data worth having. Quoted, because `toCSV`
  // quotes every value; the header assertions above strip quotes explicitly and
  // this one originally forgot to.
  assert.match(changes[1]!, /,"3"$/, "conflicts_after is the last column");
});

/**
 * The graph the session ran on, as `withNetwork` records it: one `start` event
 * whose `added` pairs are the edge list, keyed on the moment it was created.
 *
 * `at` is part of what makes recovery byte-identical — `edgeRows` puts it in every
 * row's `t` column — and it is exactly what a reconstruction from `snapshot.edges`
 * could not have recovered.
 */
const START_EVENT: EdgeEvent = {
  at: 1_700_000_000_000,
  op: "start",
  added: [
    ["p1", "p2"],
    ["p1", "p3"],
    ["p2", "p3"],
  ],
  removed: [],
  // Typed as `EdgeEvent` rather than left inferred, so this test fixture cannot
  // drift from the record `withNetwork` actually writes — which is the only reason
  // the recovered CSV can be expected to match the live one byte for byte.
  size: 3,
};

test("fromLog: recovering a killed session produces the SAME tables as a clean finish", () => {
  // This experiment's dependent variable IS the change log, so a session that died
  // at four of its five minutes used to produce nothing at all. The run log closes
  // that, but only if what it recovers is the same data — asserted byte-for-byte.
  const changes = [
    { type: "change", tMs: 100, playerID: "p1", topologyIndex: 0, degree: 4, color: "green", conflictsAfter: 3 },
    { type: "change", tMs: 900, playerID: "p2", topologyIndex: 1, degree: 2, color: "orange", conflictsAfter: 1 },
  ];

  // A session that was still running when it died: graph logged, two changes, no
  // `solved` record.
  const recovered = fromLog([
    { type: "graph", n: 20, edges: 37, maxDegree: 8, events: [START_EVENT] },
    ...changes,
  ]);

  assert.equal(recovered.changes.length, 2);
  assert.equal(recovered.session.n, 20);
  assert.equal(recovered.session.edges, 37);
  assert.equal(recovered.session.maxDegree, 8);

  // THE assertion about honesty: an interrupted session is not solved, and its
  // solution time is EMPTY. Writing 300000 — or the elapsed time — would turn "we
  // stopped watching" into an observation, and a survival analysis over that column
  // reports a median that never happened.
  assert.equal(recovered.session.solved, false);
  const files = exportFiles(
    "g1",
    recovered.session,
    recovered.changes,
    // Through the package's `edgeRows` over the RECOVERED events, which is what
    // `recover.mjs` does. Passing a placeholder to both sides — which this test did
    // until M6 Tier 4 — makes the `edges.csv` comparison below pass by construction,
    // and that is precisely how an empty recovered `edges.csv` survived a test
    // named "the SAME tables as a clean finish".
    toCSV(edgeRows("g1", recovered.history)),
    toCSV
  );
  assert.match(files["session.csv"]!, /"0",""/, "solved=0 and an empty t_solution_ms");

  // And a recovered changes.csv is byte-identical to a live one.
  const live = exportFiles(
    "g1",
    { n: 20, edges: 37, solved: false, tSolutionMs: "", changes: 2, maxDegree: 8 },
    changes,
    toCSV(edgeRows("g1", [START_EVENT])),
    toCSV
  );
  assert.equal(files["changes.csv"], live["changes.csv"]);
  assert.equal(files["session.csv"], live["session.csv"]);
  assert.equal(files["edges.csv"], live["edges.csv"]);

  // Non-vacuity, because the assertion above compares two calls to the same
  // function: the recovered file has to contain the actual graph.
  const edges = files["edges.csv"]!.trim().split("\n");
  assert.equal(edges.length, 4, `expected header + 3 edges, got ${edges.length}`);
  assert.match(edges[1]!, /"1700000000000"/, "the event's own timestamp, not a new one");
  assert.match(edges[1]!, /"connected"/);
});

test("fromLog: a log written before the graph was logged still recovers everything else", () => {
  // Every `run.ndjson` written before M6 Tier 4 has a `graph` record with no
  // `events`. Recovery of those logs must not crash, and must not claim an edge
  // list it does not have — `recover.mjs` prints a warning for exactly this case.
  const recovered = fromLog([
    { type: "graph", n: 20, edges: 37, maxDegree: 8 },
    { type: "change", tMs: 10, playerID: "p1", topologyIndex: 0, degree: 4, color: "green", conflictsAfter: 0 },
  ]);

  assert.deepEqual(recovered.history, [], "no events logged means no events recovered");
  assert.equal(recovered.changes.length, 1, "the rest of the session is unaffected");
  assert.equal(recovered.session.n, 20);
  assert.equal(toCSV(edgeRows("g1", recovered.history)), "", "an empty edges.csv, not a fabricated one");
});

test("fromLog: the graph's edge events survive the round trip through NDJSON", () => {
  // The events go to disk as JSON and come back parsed, so the round trip is part of
  // the claim. A tuple that arrived as a string, or an `at` that arrived as one,
  // would produce an `edges.csv` that looks right and sorts wrong.
  const line = JSON.stringify({
    gameID: "g1",
    at: 1,
    type: "graph",
    n: 3,
    edges: 3,
    maxDegree: 2,
    events: [START_EVENT],
  });
  const { records, dropped } = parseNdjson(line + "\n");
  assert.equal(dropped, 0);

  const recovered = fromLog(records);
  assert.deepEqual(recovered.history, [START_EVENT], "structurally identical after JSON");
  assert.equal(
    toCSV(edgeRows("g1", recovered.history)),
    toCSV(edgeRows("g1", [START_EVENT])),
    "and therefore byte-identical through the package's export"
  );
});

test("fromLog: a session that DID solve recovers its solution time", () => {
  // Non-vacuity for the test above: `solved` is genuinely read from the log rather
  // than hardcoded false, so the empty `t_solution_ms` there means something.
  const recovered = fromLog([
    { type: "graph", n: 20, edges: 37, maxDegree: 8 },
    { type: "change", tMs: 10, playerID: "p1", topologyIndex: 0, degree: 4, color: "green", conflictsAfter: 0 },
    { type: "solved", tSolutionMs: 143_700 },
  ]);
  assert.equal(recovered.session.solved, true);
  assert.equal(recovered.session.tSolutionMs, 143_700);
  const files = exportFiles("g1", recovered.session, recovered.changes, "E", toCSV);
  assert.match(files["session.csv"]!, /"143700"/);
});
