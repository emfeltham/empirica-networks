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
  farRows,
  historyIsConsistent,
  parseNdjson,
  positionRows,
  radiusRows,
  snapshotRows,
  structureRows,
  toCSV,
  viewRows,
} from "../../src/admin/export.js";
import type { ViewRecord } from "../../src/shared/keys.js";
import type { EdgeEvent, RadiusEvent } from "../../src/shared/keys.js";

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
    radius: 1.5,
    a_index: 1,
    b_index: 2,
    a_id: "a",
    b_id: "b",
    // Both ends are the viewer's own neighbors, which at this radius is the
    // only thing they can be. The column earns its place above 1.5, where a row
    // with `a_hop: 2` is a different relationship in the same table.
    a_hop: 1,
    b_hop: 1,
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
    {
      game_id: "g1",
      viewer: "me",
      seq: 3,
      t: 1000,
      radius: 1.5,
      node_index: 0,
      node_id: "me",
      node_hop: 0,
      // The viewer is named by their id, so they have no private name for
      // themselves — and neither does anybody they are connected to.
      node_ref: "",
      x: 300,
      y: 300,
    },
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

// --------------------------------------------------- the tables added late
//
// `farRows` and `radiusRows` shipped with no test of their own — `farRows` only
// through `examples/minimal/recover.mjs`, which is a worked example and not a
// check, and `radiusRows` through nothing at all. Both are on the offline path a
// researcher publishes from.

const FAR_DELIVERY: ViewRecord = {
  gameID: "g1",
  viewer: "me",
  seq: 3,
  at: 1000,
  view: [{ id: "a" }, { id: "b" }],
  graph: {
    radius: 2,
    edges: [
      [0, 1],
      [1, 3],
    ],
    positions: [
      { x: 300, y: 300 },
      { x: 300, y: 100 },
      { x: 450, y: 400 },
      { x: 100, y: 500 },
    ],
    far: [{ ref: "k3m9x2pq", d: 2, view: { mood: "calm" } }],
  },
  far: [{ ref: "k3m9x2pq", id: "z", hop: 2 }],
};

test("farRows: one row per distant person, with the ref AND who it was", () => {
  const rows = farRows([FAR_DELIVERY]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    game_id: "g1",
    viewer: "me",
    seq: 3,
    t: 1000,
    radius: 2,
    // Local index 3: the viewer, two neighbors, then this.
    node_index: 3,
    ref: "k3m9x2pq",
    id: "z",
    hop: 2,
    // Whatever `projectFar` returned, flattened like a view row's fields.
    mood: "calm",
  });
});

test("farRows: a study that projected nothing at distance still records the disclosure", () => {
  const structureOnly: ViewRecord = {
    ...FAR_DELIVERY,
    graph: { ...FAR_DELIVERY.graph!, far: [{ ref: "k3m9x2pq", d: 2 }] },
  };
  const rows = farRows([structureOnly]);
  assert.equal(rows.length, 1, "seeing somebody at all is the fact most designs manipulate");
  assert.equal(rows[0]!["mood"], undefined);
  assert.equal(rows[0]!["hop"], 2);
});

test("farRows: below radius 2 there is nobody to have a row", () => {
  const near: ViewRecord = {
    ...FAR_DELIVERY,
    graph: { radius: 1.5, edges: [[0, 1]], positions: [] },
    far: undefined,
  };
  assert.deepEqual(farRows([near]), []);
});

test("farRows: a projected field may not overwrite an identity column", () => {
  // An author's `projectFar` returning `{ id: … }` is refused at publish time,
  // but this builder also reads captures written by other builds and must not
  // let one clobber the column an analyst joins on.
  const hostile: ViewRecord = {
    ...FAR_DELIVERY,
    graph: {
      ...FAR_DELIVERY.graph!,
      far: [{ ref: "k3m9x2pq", d: 2, view: { id: "someone-else", hop: 99 } }],
    },
  };
  const row = farRows([hostile])[0]!;
  assert.equal(row["id"], "z", "the recorded identity wins");
  assert.equal(row["hop"], 2, "and so does the recorded distance");
});

const RADIUS_LOG: RadiusEvent[] = [
  { op: "start", after: { a: 1, b: 1 }, seq: 0, at: 100 },
  { op: "set", player: "a", from: 1, to: 2, after: { a: 2, b: 1 }, seq: 4, at: 200 },
  { op: "set", player: "a", from: 2, to: "whole", after: { a: "whole", b: 1 }, seq: 9, at: 300 },
];

test("radiusRows: the start event expands to one row per participant", () => {
  const rows = radiusRows("g1", RADIUS_LOG);
  assert.equal(rows.length, 4, "two opening rows, then two changes");
  assert.deepEqual(
    rows.slice(0, 2).map((r) => `${r.event}:${r.player}:${r.radius_to}`),
    ["start:a:1", "start:b:1"]
  );
  // Without the expansion, a study that never changed anybody's radius would
  // export a table that says nothing about anybody — and that is most studies.
  assert.equal(rows[0]!.radius_from, "", "nothing preceded the opening assignment");
});

test("radiusRows: a change carries both ends, and seq is what orders it", () => {
  const rows = radiusRows("g1", RADIUS_LOG);
  const change = rows.find((r) => r.event === "set")!;
  assert.equal(change.player, "a");
  assert.equal(change.radius_from, "1");
  assert.equal(change.radius_to, "2");
  assert.equal(change.seq, 4, "the publish counter, not the clock");
});

test('radiusRows: "whole" survives as a value rather than becoming a number', () => {
  const rows = radiusRows("g1", RADIUS_LOG);
  assert.equal(rows.at(-1)!.radius_to, "whole");
  // Every column in this module is `string | number`, so a value that is neither
  // has to be stringified — and stringifying is also what keeps it from being
  // read back as a number by something that assumes one.
  assert.equal(typeof rows.at(-1)!.radius_to, "string");
});

test("radiusRows: a study that never changed anybody still exports its assignment", () => {
  const rows = radiusRows("g1", [RADIUS_LOG[0]!]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.event === "start"));
});
