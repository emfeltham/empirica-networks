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
  snapshotRows,
  toCSV,
} from "../../src/admin/export.js";
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
