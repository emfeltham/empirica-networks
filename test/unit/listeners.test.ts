/**
 * The duplicate-lifecycle-listener detector (`ISSUES.md` U8).
 *
 * A detector's failure modes are its design, so this tier is mostly about what
 * must NOT fire. Every filter in `duplicateLifecycleListeners` exists to keep
 * some legitimate registration out of the count, and each one gets a test that
 * would fail if it were dropped — because the cost of a false warning here is
 * that people learn to ignore the one message in the package that catches a
 * dead listener.
 *
 * The real `ClassicListenersCollector` is exercised in `test/e2e/duplicate_
 * listeners.test.ts`; the fake below mirrors the shapes measured from
 * `@empirica/core@1.12.5` on 2026-08-16, recorded in `docs/PLATFORM-NOTES.md` §18.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrate,
  callbackShape,
  duplicateLifecycleListeners,
  duplicateListenersMessage,
  type ListenerEntry,
} from "../../src/admin/listeners.js";

/**
 * Empirica's `unique()`, reproduced exactly as far as its SHAPE goes.
 *
 * The detector matches on async-ness, anonymity and arity, so the body is
 * irrelevant and the signature is everything: upstream returns
 * `async (ctx, props) => {…}` and so does this.
 */
const unique = (cb: unknown) => async (ctx: unknown, props: unknown) => {
  await (cb as (a: unknown, b: unknown) => unknown)(ctx, props);
};

/** Mirrors `ListenersCollector`'s registration behaviour, and nothing else. */
class FakeCollector {
  attributeListeners: ListenerEntry[] = [];

  on(kind: string, key: string, callback: unknown): void {
    this.attributeListeners.push({ placement: 1, kind, key, callback });
  }
  /** `unique.before` / `unique.after`, which Classic's own internals use. */
  after(kind: string, key: string, callback: unknown): void {
    this.attributeListeners.push({ placement: 2, kind, key, callback: unique(callback) });
  }
  onGameStart(cb: unknown): void {
    this.attributeListeners.push({
      placement: 1,
      kind: "game",
      key: "start",
      callback: unique(cb),
    });
  }
  onStageEnded(cb: unknown): void {
    this.attributeListeners.push({
      placement: 1,
      kind: "stage",
      key: "ended",
      callback: unique(cb),
    });
  }
}

const CALIBRATION = { shape: 'AsyncFunction/""/2', placement: 1 };

const find = (c: FakeCollector, opts = CALIBRATION) =>
  duplicateLifecycleListeners(c.attributeListeners, opts);

test("callbackShape separates a unique wrapper from what a consumer usually writes", () => {
  assert.equal(callbackShape(unique(() => {})), 'AsyncFunction/""/2');
  assert.equal(callbackShape(function named() {}), 'Function/"named"/0');
  assert.equal(callbackShape((_a: unknown) => {}), 'Function/""/1');
  // The one collision, and it is the residual false positive the message admits
  // to: an anonymous 2-argument async arrow is shaped exactly like a wrapper.
  assert.equal(
    callbackShape(async (_a: unknown, _b: unknown) => {}),
    'AsyncFunction/""/2'
  );
  assert.equal(callbackShape("not a function"), undefined);
});

test("calibrate reads the wrapper's shape off a probe rather than assuming it", () => {
  // The point of calibrating: nothing in the package hardcodes what `unique`
  // produces, so upstream changing it does not silently disable the detector.
  assert.deepEqual(calibrate(new FakeCollector()), CALIBRATION);
});

test("calibrate goes silent on anything it does not recognise", () => {
  // Each of these switches the detector OFF. Reading an @internal field and
  // then guessing at an unfamiliar shape is how a detector starts accusing
  // healthy code.
  assert.equal(calibrate(undefined), undefined, "no collector");
  assert.equal(calibrate({}), undefined, "constructor is not newable as a collector");

  class NoHelper {
    attributeListeners: ListenerEntry[] = [];
  }
  assert.equal(calibrate(new NoHelper()), undefined, "no onStageEnded");

  class NoField {
    onStageEnded(): void {}
  }
  assert.equal(calibrate(new NoField()), undefined, "no attributeListeners");

  class WrongPair {
    attributeListeners: ListenerEntry[] = [];
    onStageEnded(cb: unknown): void {
      this.attributeListeners.push({ placement: 1, kind: "round", key: "x", callback: cb });
    }
  }
  assert.equal(calibrate(new WrongPair()), undefined, "probe landed somewhere unexpected");
});

test("two registrations of the same helper are reported; one is not", () => {
  const one = new FakeCollector();
  one.onStageEnded(() => {});
  assert.deepEqual(find(one), [], "a single registration is the normal case");

  const two = new FakeCollector();
  two.onStageEnded(() => {});
  two.onStageEnded(() => {});
  assert.deepEqual(find(two), [
    { kind: "stage", key: "ended", helper: "onStageEnded", count: 2 },
  ]);
});

test("duplicate PLAIN listeners are not reported — they are legitimate and common", () => {
  // `.on` is not wrapped in `unique`, so both callbacks run. This package
  // registers two listeners per watched key by design, and `examples/shirado2017`
  // adds a third on `nbhd/state:color`. A detector that counted these would fire
  // on its own package.
  const c = new FakeCollector();
  c.on("nbhd", "state:color", async (_a: unknown, _b: unknown) => {});
  c.on("nbhd", "state:color", async (_a: unknown, _b: unknown) => {});
  assert.deepEqual(find(c), [], "not one of the six lifecycle pairs");
});

test("a duplicate on a lifecycle pair with a distinguishable callback is not reported", () => {
  // `.on("stage", "ended", cb)` directly. Not subject to `unique`, so both run —
  // and here the callbacks are named, which proves they cannot be wrappers.
  const c = new FakeCollector();
  c.on("stage", "ended", function scoreRound() {});
  c.on("stage", "ended", function applyRewiring() {});
  assert.deepEqual(find(c), []);
});

test("Classic's own before/after registrations are not reported", () => {
  // Measured 2026-08-16: Classic registers on `game/start` and `game/ended`
  // through `unique.before` / `unique.after` — a different placement from the
  // helpers' `unique.on`, and they run correctly. Whether these share the
  // consumer's collector is a question the placement filter makes moot.
  const c = new FakeCollector();
  c.onGameStart(() => {});
  c.after("game", "start", () => {});
  c.after("game", "start", () => {});
  assert.deepEqual(find(c), []);
});

test("withNetwork's own plain game/start listener is excluded by identity", () => {
  // The false positive that would otherwise have fired on both shipped
  // examples. `withNetwork` registers `.on("game", "start", async (ctx, {game})
  // => …)` on one of the six pairs, so alongside a single correct `onGameStart`
  // it looks exactly like a duplicate.
  //
  // Returned from a factory rather than written as `const ours = async …`,
  // because that difference turns out to matter and is easy to get wrong here:
  // an arrow assigned to a `const` takes the const's NAME, so its shape is
  // `AsyncFunction/"ours"/2` and it never matches a wrapper in the first place.
  // Upstream's `unique()` RETURNS its arrow, which is why that one is anonymous.
  // This mirrors upstream, so the exclusion is what is actually under test.
  const makeOurs = () => async (_ctx: unknown, _props: unknown) => {};
  const ours = makeOurs();
  assert.equal(callbackShape(ours), CALIBRATION.shape, "the collision is real");

  const c = new FakeCollector();
  c.onGameStart(() => {});
  c.on("game", "start", ours);

  assert.deepEqual(
    find(c),
    [{ kind: "game", key: "start", helper: "onGameStart", count: 2 }],
    "without the exclusion this is a false positive — which is why there is one"
  );
  assert.deepEqual(
    duplicateLifecycleListeners(c.attributeListeners, {
      ...CALIBRATION,
      exclude: new Set<unknown>([ours]),
    }),
    []
  );
});

test("every one of the six helpers is checked, and each is named correctly", () => {
  const c = new FakeCollector();
  const pairs: Array<[string, string, string]> = [
    ["game", "start", "onGameStart"],
    ["round", "start", "onRoundStart"],
    ["stage", "start", "onStageStart"],
    ["stage", "ended", "onStageEnded"],
    ["round", "ended", "onRoundEnded"],
    ["game", "ended", "onGameEnded"],
  ];
  for (const [kind, key] of pairs) {
    c.attributeListeners.push({ placement: 1, kind, key, callback: unique(() => {}) });
    c.attributeListeners.push({ placement: 1, kind, key, callback: unique(() => {}) });
  }
  assert.deepEqual(
    find(c),
    pairs.map(([kind, key, helper]) => ({ kind, key, helper, count: 2 }))
  );
});

test("a malformed attributeListeners costs nothing", () => {
  assert.deepEqual(duplicateLifecycleListeners(undefined, CALIBRATION), []);
  assert.deepEqual(duplicateLifecycleListeners({ length: 2 }, CALIBRATION), []);
  assert.deepEqual(
    duplicateLifecycleListeners([null, "x", { kind: "stage" }], CALIBRATION),
    []
  );
});

test("the message names the helper, gives the fix, and admits its false positive", () => {
  const msg = duplicateListenersMessage([
    { kind: "stage", key: "ended", helper: "onStageEnded", count: 2 },
  ]);
  assert.match(msg, /onStageEnded\(\)  registered 2 times/);
  assert.match(msg, /ONLY THE FIRST WILL EVER RUN/);
  // The fix in full, not described. "Dispatch inside one listener" is the sort
  // of instruction that reads as understood and gets implemented as two
  // listeners with an `if` in each.
  assert.match(msg, /Empirica\.onStageEnded\(\(props\) => \{/);
  assert.match(msg, /if \(name === "decide"\)/);
  // And the case where the warning is wrong, in the same breath as the
  // accusation. A detector that hides its own failure mode is asking to be
  // believed on a question it cannot settle.
  assert.match(msg, /this warning is wrong/);
  assert.match(msg, /`Empirica\.on\("stage", "ended", cb\)` directly/);
  assert.match(msg, /ISSUES\.md U8/);
});
