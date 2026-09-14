/**
 * Export: does the recorded history describe the run faithfully?
 *
 * Pure functions over an event log, so this needs no server and runs in
 * milliseconds. That is the point of keeping them free of Empirica types — the
 * same code an analyst runs offline over a stored export is the code tested
 * here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  edgeRows,
  historyIsConsistent,
  parseNdjson,
  positionRows,
  snapshotRows,
  structureRows,
  toCSV,
  viewRows,
} from "../../src/admin/export.js";
import type { ViewRecord } from "../../src/shared/keys.js";
import type { EdgeEvent } from "../../src/shared/keys.js";

/** A ring of three, then one tie dropped and another added. */
const HISTORY: EdgeEvent[] = [
  {
    op: "start",
    added: [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ],
    removed: [],
    size: 3,
    at: 1000,
  },
  { op: "remove", a: "a", b: "b", added: [], removed: [["a", "b"]], size: 2, at: 2000 },
  { op: "add", a: "a", b: "d", added: [["a", "d"]], removed: [], size: 3, at: 3000 },
];

test("the initial graph is exported, not just later changes", () => {
  // A study that never rewires must still export its network. Before `start`
  // was recorded as an event, this file would have been empty for exactly the
  // designs that are most common.
  const rows = edgeRows("game-1", [HISTORY[0]!]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.event === "connected"));
  assert.ok(rows.every((r) => r.t === 1000));
  assert.ok(rows.every((r) => r.game_id === "game-1"));
});

test("edge rows are the connected/disconnected sequence, in order", () => {
  const rows = edgeRows("g", HISTORY);
  assert.deepEqual(
    rows.map((r) => `${r.t}:${r.event}:${r.player_a}-${r.player_b}`),
    [
      "1000:connected:a-b",
      "1000:connected:b-c",
      "1000:connected:c-a",
      "2000:disconnected:a-b",
      "3000:connected:a-d",
    ]
  );
});

test("within one event, departures are listed before arrivals", () => {
  // A rewire that swaps a tie reads as "lost b, gained c". Emitting the add
  // first would make a reader scanning for "when did a lose b" look past it.
  const rewire: EdgeEvent = {
    op: "rewire",
    added: [["a", "c"]],
    removed: [["a", "b"]],
    size: 1,
    at: 5000,
  };
  assert.deepEqual(
    edgeRows("g", [rewire]).map((r) => r.event),
    ["disconnected", "connected"]
  );
});

test("snapshots are replayed from the events, so they cannot disagree with them", () => {
  const snaps = snapshotRows("g", HISTORY);
  assert.deepEqual(
    snaps.map((s) => s.size),
    [3, 2, 3]
  );
  // Note c-a becomes a|c: pairs are canonicalised, which is what makes a tie
  // one string regardless of which way round the event recorded it.
  assert.equal(snaps[0]!.edges, "a|b a|c b|c", "canonical pairs, sorted");
  assert.equal(snaps[1]!.edges, "a|c b|c", "after the drop");
  assert.equal(snaps[2]!.edges, "a|c a|d b|c", "after the add");
});

test("snapshot pairs are canonical, so the same tie is one string either way round", () => {
  const flipped: EdgeEvent[] = [
    { op: "start", added: [["b", "a"]], removed: [], size: 1, at: 1 },
    { op: "remove", added: [], removed: [["a", "b"]], size: 0, at: 2 },
  ];
  const snaps = snapshotRows("g", flipped);
  assert.equal(snaps[0]!.edges, "a|b");
  assert.equal(snaps[1]!.size, 0, "removal matched despite the reversed order");
});

test("consistency check catches a log whose events do not add up", () => {
  assert.equal(historyIsConsistent(HISTORY), true);

  const broken: EdgeEvent[] = [
    { op: "start", added: [["a", "b"]], removed: [], size: 1, at: 1 },
    // Claims two edges, but only ever added one.
    { op: "add", a: "a", b: "c", added: [], removed: [], size: 2, at: 2 },
  ];
  assert.equal(
    historyIsConsistent(broken),
    false,
    "a size that disagrees with the replay must be caught, not trusted"
  );
});

test("toCSV quotes every field and escapes embedded quotes", () => {
  const csv = toCSV([{ a: 'say "hi"', b: 1 }]);
  assert.equal(csv, '"a","b"\n"say ""hi""","1"');
});

test("toCSV on no rows is empty rather than a bare header", () => {
  assert.equal(toCSV([]), "");
});

test("an empty history exports nothing rather than throwing", () => {
  assert.deepEqual(edgeRows("g", []), []);
  assert.deepEqual(snapshotRows("g", []), []);
  assert.equal(historyIsConsistent([]), true);
});

/**
 * `parseNdjson` — reading a run log back, including one a kill cut in half.
 *
 * Both examples' `recover.mjs` had hand-rolled this loop, which is what M6 §2.1
 * moved into the package. It takes TEXT rather than a path on purpose: everything
 * on the `empirica-networks/export` subpath has to load from plain Node with no
 * build step, and `test/unit/export_isolation.test.ts` enforces that by refusing
 * this file any runtime import at all — `node:fs` included.
 */
test("parseNdjson returns the records and reports nothing dropped", () => {
  const { records, dropped } = parseNdjson<{ type: string }>(
    '{"type":"start"}\n{"type":"round"}\n'
  );
  assert.deepEqual(records, [{ type: "start" }, { type: "round" }]);
  assert.equal(dropped, 0, "a log ending in a newline is a normal log");
});

test("a truncated final line is dropped and COUNTED", () => {
  // The case this exists for: a hard kill cuts the last record mid-write. A
  // recovery that quietly dropped it would be indistinguishable from a session
  // that ran one round fewer, which is a wrong number rather than a missing one.
  const { records, dropped } = parseNdjson('{"type":"round","n":1}\n{"type":"rou');
  assert.equal(records.length, 1);
  assert.equal(dropped, 1);
});

test("blank lines are not counted as damage", () => {
  // Otherwise every clean run would report a truncated log, and a count that is
  // always non-zero is a count nobody reads.
  const { records, dropped } = parseNdjson('\n{"a":1}\n\n   \n{"a":2}\n\n');
  assert.equal(records.length, 2);
  assert.equal(dropped, 0);
});

test("a hole in the middle does not cost the records after it", () => {
  // A partial write mid-file should not turn one bad line into a lost session.
  const { records, dropped } = parseNdjson('{"a":1}\nnot json\n{"a":3}');
  assert.deepEqual(records, [{ a: 1 }, { a: 3 }]);
  assert.equal(dropped, 1);
});

test("an empty log parses to nothing rather than throwing", () => {
  assert.deepEqual(parseNdjson(""), { records: [], dropped: 0 });
});

// ------------------------------------------ the radius 1.5 structure builders
//
// The join these two exist to make possible is the only thing worth testing
// here, and it is entirely about INDICES: the payload names nodes by position
// in the delivery, and a builder that resolved those positions off by one would
// produce a well-formed table describing ties between the wrong people.

const DELIVERY: ViewRecord = {
  gameID: "g1",
  viewer: "me",
  seq: 3,
  at: 1000,
  view: [{ id: "a" }, { id: "b" }, { id: "c" }],
  graph: {
    radius: 1.5,
    edges: [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
    ],
    positions: [
      { x: 300, y: 300 },
      { x: 100, y: 120 },
      { x: 500, y: 140 },
      { x: 300, y: 560 },
    ],
  },
};

test("structureRows resolves local index 0 to the viewer, not to their first neighbor", () => {
  // The off-by-one that would look completely normal. Local 0 is the VIEWER;
  // `view[0]` is their first neighbor. Confusing the two renames every node in
  // the table by one position and leaves the shape intact.
  const rows = structureRows([DELIVERY]);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.a_id, r.b_id]),
    [
      ["me", "a"],
      ["me", "b"],
      ["me", "c"],
      ["a", "b"],
    ]
  );
  // Indices are carried as well as ids, so the row still identifies its nodes
  // when the projection has none — and so it joins back to views.csv.
  assert.deepEqual(rows.at(-1), {
    game_id: "g1",
    viewer: "me",
    seq: 3,
    t: 1000,
    a_index: 1,
    b_index: 2,
    a_id: "a",
    b_id: "b",
  });
});

test("the indices join back to viewRows on neighbor_index = index - 1", () => {
  // The documented join. If it ever stops holding, the two tables describe
  // different neighborhoods and nothing says so.
  const views = viewRows([DELIVERY]);
  for (const s of structureRows([DELIVERY])) {
    for (const [index, id] of [
      [s.a_index, s.a_id],
      [s.b_index, s.b_id],
    ] as const) {
      if (index === 0) continue;
      const row = views.find((v) => v.viewer === s.viewer && v.seq === s.seq && v.neighbor_index === index - 1);
      assert.ok(row, `no view row for local index ${index}`);
      assert.equal(row.neighbor_id, id, "the two tables must name the same person");
    }
  }
});

test("positionRows keeps the isolated viewer, whom an edge table would drop", () => {
  // Why this is a second builder rather than x/y columns on the first: a
  // participant with no ties still has a position, and in a rewiring design
  // they are the one worth looking at.
  const alone: ViewRecord = {
    ...DELIVERY,
    view: [],
    graph: { radius: 1.5, edges: [], positions: [{ x: 300, y: 300 }] },
  };
  assert.deepEqual(structureRows([alone]), []);
  assert.deepEqual(positionRows([alone]), [
    { game_id: "g1", viewer: "me", seq: 3, t: 1000, node_index: 0, node_id: "me", x: 300, y: 300 },
  ]);
});

test("a projection with no id still produces usable rows", () => {
  // `viewRows` leaves `neighbor_id` empty for these; so do we, and the indices
  // carry the identity instead. Dropping the rows would silently export nothing
  // for a legal projection.
  const anonymous: ViewRecord = {
    ...DELIVERY,
    view: [{ choice: "A" }, { choice: "B" }, { choice: "C" }],
  };
  const rows = structureRows([anonymous]);
  assert.equal(rows.length, 4, "every tie is still a row");
  assert.equal(rows.at(-1)!.a_id, "", "with no id to resolve");
  assert.deepEqual(rows.at(-1)!.a_index, 1, "and the index doing the work");
  assert.equal(positionRows([anonymous])[1]!.node_id, "");
});

test("a radius 1 delivery produces no structure rows at all", () => {
  const plain: ViewRecord = { gameID: "g1", viewer: "me", seq: 1, at: 1, view: [{ id: "a" }] };
  assert.deepEqual(structureRows([plain]), []);
  assert.deepEqual(positionRows([plain]), []);
  assert.equal(viewRows([plain]).length, 1, "and the existing table is untouched");
});
