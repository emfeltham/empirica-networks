import assert from "node:assert/strict";
import test from "node:test";
import { validateProjection } from "../../src/admin/projection.js";
import { recordReads, unwatchedKeys, unwatchedKeysMessage } from "../../src/admin/reads.js";

/** Stands in for an admin Player: accessor, methods, and internal state. */
class FakeScope {
  _deleted = false;
  constructor(
    private readonly _id: string,
    private readonly attrs: Record<string, unknown>
  ) {}
  get id(): string {
    return this._id;
  }
  get participantID(): string {
    return `participant-of-${this._id}`;
  }
  get(key: string): unknown {
    return this.attrs[key];
  }
  getAttribute(key: string): unknown {
    return { key, value: this.attrs[key] };
  }
  /** A method that reads through `this` — must not pollute the recorded set. */
  summary(): string {
    return `${this._id}:${String(this.get("choice"))}`;
  }
}

test("records every key project() reads", () => {
  const seen = new Set<string>();
  const p = recordReads(new FakeScope("p1", { choice: "A", score: 3 }), seen);

  p.get("choice");
  p.get("score");
  p.get("neverSet");

  assert.deepEqual([...seen].sort(), ["choice", "neverSet", "score"]);
});

test("returns the same values as the unwrapped scope", () => {
  const raw = new FakeScope("p1", { choice: "A", score: 3 });
  const p = recordReads(raw, new Set());

  assert.equal(p.get("choice"), "A");
  assert.equal(p.get("score"), 3);
  assert.equal(p.get("missing"), undefined);
});

test("accessors still resolve — this is the fragile part of proxying", () => {
  // `id` and `participantID` are getters reading private-ish state. Passing the
  // proxy as the receiver would break them; the receiver is the target instead.
  const p = recordReads(new FakeScope("p1", {}), new Set());

  assert.equal(p.id, "p1");
  assert.equal(p.participantID, "participant-of-p1");
  assert.equal(p._deleted, false);
});

test("a method reading through `this` does not pollute the recorded keys", () => {
  // The list is meant to describe what project() depends on. If internal reads
  // counted, watch lists would grow with keys the author never asked for and the
  // omission warning would lose its meaning.
  const seen = new Set<string>();
  const p = recordReads(new FakeScope("p1", { choice: "A" }), seen);

  assert.equal(p.summary(), "p1:A");
  assert.equal(seen.size, 0, "summary()'s internal get() was not recorded");
});

test("the proxy still looks like a scope, so returning it is still refused", () => {
  // Task 8's guarantee has to survive Task 9. If the proxy stopped looking like
  // a scope, `project: (n) => n` would start passing validation and leak the
  // global attribute store.
  const p = recordReads(new FakeScope("p1", { choice: "A" }), new Set());
  assert.throws(() => validateProjection(p), /Empirica scope/);
});

test("ignores non-string keys rather than recording garbage", () => {
  const seen = new Set<string>();
  const p = recordReads(new FakeScope("p1", {}), seen) as unknown as {
    get(k: unknown): unknown;
  };
  p.get(undefined);
  p.get(7);
  assert.equal(seen.size, 0);
});

test("unwatchedKeys reports the difference, sorted", () => {
  assert.deepEqual(unwatchedKeys(new Set(["b", "a", "c"]), ["b"]), ["a", "c"]);
  assert.deepEqual(unwatchedKeys(new Set(["a"]), ["a"]), []);
  assert.deepEqual(unwatchedKeys(new Set(), ["a"]), []);
});

test("the omission message quotes a ready-to-paste watch list", () => {
  // A warning that states a problem without the fix gets skimmed past.
  const msg = unwatchedKeysMessage(["score"], ["choice"]);

  assert.match(msg, /"score"/);
  assert.match(msg, /will NOT see them change/);
  assert.match(msg, /watch: \["choice", "score"\]/, "merges existing and missing");
  assert.match(msg, /safe to ignore/, "says when it is not a problem");
});
