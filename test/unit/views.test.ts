/**
 * Views: flattening captured deliveries, and the sink that captures them.
 *
 * The conversion is pure, so it tests without a server — the same discipline as
 * the rest of export.ts, and for the same reason: the code an analyst runs
 * offline months later is the code tested here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toCSV, viewRows } from "../../src/admin/export.js";
import { makeViewSink } from "../../src/admin/views.js";
import type { ViewRecord } from "../../src/shared/keys.js";

const RECORDS: ViewRecord[] = [
  {
    gameID: "g1",
    viewer: "a",
    seq: 1,
    at: 1000,
    view: [
      { id: "b", choice: "cooperate" },
      { id: "c", choice: "defect" },
    ],
  },
  {
    gameID: "g1",
    viewer: "b",
    seq: 1,
    at: 1000,
    view: [{ id: "a", choice: "cooperate" }],
  },
];

test("one row per viewer per neighbour per delivery", () => {
  const rows = viewRows(RECORDS);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => `${r.viewer}->${r.neighbour_id}:${r["choice"]}`),
    ["a->b:cooperate", "a->c:defect", "b->a:cooperate"]
  );
  assert.ok(rows.every((r) => r.game_id === "g1" && r.seq === 1 && r.t === 1000));
});

test("neighbour_index is positional, so a projection without an id still locates itself", () => {
  // `project: (n) => ({ choice: n.get("choice") })` is legal — id is a
  // convention, not a requirement — and the row must still say which of the
  // viewer's neighbours it was.
  const rows = viewRows([
    { gameID: "g", viewer: "a", seq: 2, at: 5, view: [{ choice: "x" }, { choice: "y" }] },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.neighbour_index, r.neighbour_id, r["choice"]]),
    [
      [0, "", "x"],
      [1, "", "y"],
    ]
  );
});

test("a bare projected value gets a column instead of being dropped", () => {
  // `project: (n) => n.id` returns a string, not an object. Exporting nothing
  // for a legal projection is the kind of gap discovered during analysis.
  const rows = viewRows([{ gameID: "g", viewer: "a", seq: 1, at: 1, view: ["b", "c"] }]);
  assert.deepEqual(
    rows.map((r) => r["value"]),
    ["b", "c"]
  );
});

test("nested values are JSON in their cell, not silently flattened or lost", () => {
  const rows = viewRows([
    { gameID: "g", viewer: "a", seq: 1, at: 1, view: [{ id: "b", pos: { x: 1, y: 2 } }] },
  ]);
  assert.equal(rows[0]!["pos"], '{"x":1,"y":2}');
});

test("undefined and booleans survive the trip to a cell", () => {
  // `neighbour.get("choice")` is undefined for any attribute not yet set, which
  // is normal in round one and must not become the string "undefined".
  const rows = viewRows([
    { gameID: "g", viewer: "a", seq: 1, at: 1, view: [{ id: "b", choice: undefined, on: true }] },
  ]);
  assert.equal(rows[0]!["choice"], "");
  assert.equal(rows[0]!["on"], "true");
});

test("an empty view contributes no rows, and an empty log no table", () => {
  assert.deepEqual(viewRows([{ gameID: "g", viewer: "a", seq: 1, at: 1, view: [] }]), []);
  assert.deepEqual(viewRows([]), []);
});

test("CSV headers are the union of all rows, not just the first", () => {
  // The bug this guards: an optional field absent from record 1 was dropped from
  // the whole export, silently. Uniform edge rows never exposed it; author-
  // defined view columns do.
  const csv = toCSV([
    { game_id: "g", viewer: "a" },
    { game_id: "g", viewer: "b", late: "arrived" },
  ]);
  assert.equal(csv, '"game_id","viewer","late"\n"g","a",""\n"g","b","arrived"');
});

test("the sink hands every record to onView", () => {
  const seen: ViewRecord[] = [];
  const sink = makeViewSink({ onView: (r) => seen.push(r) })!;
  assert.ok(sink, "a configured sink is created");
  for (const r of RECORDS) sink.record(r);
  assert.deepEqual(seen, RECORDS);
});

test("no config means no sink, so the publish path pays nothing", () => {
  assert.equal(makeViewSink(undefined), undefined);
  assert.equal(makeViewSink({}), undefined);
});

test("a throwing onView does not take the publish down with it", () => {
  // The study matters more than its telemetry: a sink that throws must not
  // abort a publish that is mid-flight to every participant.
  const sink = makeViewSink({
    onView: () => {
      throw new Error("sink is on fire");
    },
  })!;
  const err = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => sink.record(RECORDS[0]!));
  } finally {
    console.error = err;
  }
});

test("the file sink writes NDJSON that parses back to what went in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views-"));
  const file = path.join(dir, "views.ndjson");
  try {
    const sink = makeViewSink({ file })!;
    for (const r of RECORDS) sink.record(r);
    // Buffered by design: nothing is on disk until a flush, which is the trade
    // that keeps a syscall out of the publish path.
    assert.equal(fs.readFileSync(file, "utf8"), "", "buffered until flushed");
    sink.close();

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), RECORDS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a full batch flushes without waiting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views-"));
  const file = path.join(dir, "views.ndjson");
  try {
    const sink = makeViewSink({ file, batch: 2 })!;
    sink.record(RECORDS[0]!);
    assert.equal(fs.readFileSync(file, "utf8"), "", "one record, batch of two");
    sink.record(RECORDS[1]!);
    assert.equal(
      fs.readFileSync(file, "utf8").trim().split("\n").length,
      2,
      "the second record fills the batch and writes both"
    );
    sink.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file is appended, so a restart does not erase the study so far", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views-"));
  const file = path.join(dir, "views.ndjson");
  try {
    const first = makeViewSink({ file })!;
    first.record(RECORDS[0]!);
    first.close();

    const second = makeViewSink({ file })!;
    second.record(RECORDS[1]!);
    second.close();

    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
