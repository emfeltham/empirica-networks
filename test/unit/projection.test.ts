import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectionError,
  projectionBytes,
  validateProjection,
} from "../../src/admin/projection.js";

test("accepts the shapes a real projection actually has", () => {
  for (const ok of [
    { id: "p1", choice: "A", score: 3, ready: true },
    { id: "p1", choice: null },
    { id: "p1", history: ["A", "B"], meta: { round: 2 } },
    { id: "p1", at: new Date("2026-01-01") }, // JSON gives an ISO string
    [],
    "a string",
    0,
    false,
  ]) {
    assert.doesNotThrow(() => validateProjection(ok), `rejected ${JSON.stringify(ok)}`);
  }
});

test("accepts undefined fields — an unset attribute is normal", () => {
  // neighbour.get("choice") returns undefined for anything not set yet, which
  // is the state of every experiment's first round. A stricter check would fire
  // on healthy runs, and a check that fires on healthy runs gets disabled.
  assert.doesNotThrow(() => validateProjection({ id: "p1", choice: undefined }));
  assert.doesNotThrow(() => validateProjection(undefined));
});

test("REJECTS an Empirica scope — the leak this module exists to prevent", () => {
  // Structural detection: `get` + `getAttribute` + `id`. A scope holds the
  // global attribute store, so publishing one ships every participant's
  // attributes to this client.
  const scopeLike = {
    id: "player-1",
    get: () => "x",
    getAttribute: () => ({}),
    set: () => {},
    attributes: { everything: "in the experiment" },
  };

  assert.throws(() => validateProjection(scopeLike), ProjectionError);
  assert.throws(() => validateProjection(scopeLike), /Empirica scope/);
  assert.throws(() => validateProjection(scopeLike), /leak this module exists to prevent/);
});

test("rejects a scope nested anywhere, and names where", () => {
  const scopeLike = { id: "p", get: () => 1, getAttribute: () => ({}) };

  assert.throws(() => validateProjection({ me: scopeLike }), /at me\b/);
  assert.throws(() => validateProjection({ a: { b: [scopeLike] } }), /at a\.b\[0\]/);
});

test("does not mistake ordinary objects for scopes", () => {
  // `get` alone is on Map, URLSearchParams, Headers, and plenty of plain
  // objects. Over-eager detection here would block legitimate projections.
  assert.doesNotThrow(() => validateProjection({ id: "p1", get: undefined }));
  assert.doesNotThrow(() => validateProjection({ id: "p1", value: 1 }));
  assert.doesNotThrow(() =>
    validateProjection({ id: "p1", nested: { get: "not a function" } })
  );
});

test("rejects a cycle, with a message naming the projection", () => {
  const cyclic: Record<string, unknown> = { id: "p1" };
  cyclic["self"] = cyclic;

  assert.throws(() => validateProjection(cyclic), ProjectionError);
  assert.throws(() => validateProjection(cyclic), /cycle/);
});

test("allows the same object in two sibling fields", () => {
  // A shared reference is not a cycle. Tracking `seen` without removing on the
  // way back up would reject this, and it is entirely legitimate.
  const shared = { round: 1 };
  assert.doesNotThrow(() => validateProjection({ a: shared, b: shared }));
});

test("rejects values JSON silently drops or refuses", () => {
  assert.throws(() => validateProjection({ f: () => 1 }), /function/);
  assert.throws(() => validateProjection({ n: 10n }), /BigInt/);
  assert.throws(() => validateProjection({ s: Symbol("x") }), /Symbol/);
  assert.throws(() => validateProjection({ m: new Map([["a", 1]]) }), /Map/);
  assert.throws(() => validateProjection({ s: new Set([1]) }), /Set/);
});

test("rejects non-finite numbers, which JSON turns into null", () => {
  assert.throws(() => validateProjection({ score: NaN }), /NaN/);
  assert.throws(() => validateProjection({ score: Infinity }), /Infinity/);
});

test("every message is prefixed and actionable", () => {
  try {
    validateProjection({ f: () => 1 });
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /^empirica-networks: /);
    assert.equal((e as Error).name, "ProjectionError");
  }
});

test("projectionBytes measures the wire size", () => {
  assert.equal(projectionBytes({ id: "p1" }), Buffer.byteLength('{"id":"p1"}'));
  assert.equal(projectionBytes(null), 4);
  assert.equal(projectionBytes(undefined), 4, "coalesced to null, not a crash");
  // Multi-byte characters count as bytes, not characters — the limit is on the
  // wire, and a projection of names could easily be non-ASCII.
  assert.equal(projectionBytes("é"), Buffer.byteLength('"é"'));
  assert.equal(projectionBytes(() => 1), 0, "unserialisable, but does not throw");
});
