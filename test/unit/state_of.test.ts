/**
 * `watch` / `read` and the loud read path (`ISSUES.md` O11).
 *
 * The bug being fixed is a READ that returns `undefined`, so what is worth
 * testing is the ordering and reachability of the throws — a guard that
 * short-circuits into the wrong branch would still throw, and would still hide
 * the case it was written for.
 *
 * The value-returning path needs a real game and lives in `test/e2e`. Everything
 * here runs against a collector that records registrations and does nothing else,
 * because `stateOf`'s checks all happen before it touches any game state, and
 * that is precisely the property under test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unlistedKeyMessage } from "../../src/admin/reads.js";
import { withNetwork } from "../../src/admin/with_network.js";

/** Records what `withNetwork` subscribes to. No dispatch: nothing here fires. */
class FakeCollector {
  readonly registrations: string[] = [];
  on(...args: unknown[]): void {
    args.pop(); // the callback
    this.registrations.push(args.map((a) => String(a)).join("/"));
  }
}

test("a `read` key is registered exactly like a `watch` key", () => {
  const c = new FakeCollector();
  withNetwork(c, { watch: ["action"], read: ["rewireAnswers"] });

  // The union is the whole mechanism: misfiling a key between the two fields
  // must not change what the server sees, or the split would be a new way to be
  // silently wrong instead of a fix for one.
  for (const key of ["action", "rewireAnswers"]) {
    assert.ok(
      c.registrations.includes(`player/${key}`),
      `no player-scope listener for ${key}`
    );
    assert.ok(
      c.registrations.includes(`nbhd/state:${key}`),
      `no private-channel listener for ${key}`
    );
  }
});

test("a key in neither list is refused, and both fields are named", () => {
  const net = withNetwork(new FakeCollector(), { watch: ["action"] });

  assert.throws(
    () => net.stateOf("game-1", "player-1", "rewireAnswers"),
    (e: Error) => {
      // Named, so the reader knows the choice exists and which one they want.
      assert.match(e.message, /`watch`/);
      assert.match(e.message, /`read`/);
      // Ready to paste. A message that describes the problem without giving the
      // line to write gets skimmed past.
      assert.match(e.message, /read: \["rewireAnswers"\]/);
      // And it says what was declared, since "I did declare it" is the first
      // thing the reader will think.
      assert.match(e.message, /Declared: "action"/);
      return true;
    }
  );
});

test("an undeclared key is refused BEFORE the game is looked up", () => {
  const net = withNetwork(new FakeCollector(), { watch: ["action"] });

  // Ordering, not politeness. No game exists here, so both guards would fire;
  // if the game check ran first, the author of a typo would be told their game
  // had ended and would go looking in entirely the wrong place.
  assert.throws(
    () => net.stateOf("no-such-game", "player-1", "typo"),
    /neither `watch` nor `read`/
  );
});

test("a declared key on an unnetworked game says so, rather than returning undefined", () => {
  const net = withNetwork(new FakeCollector(), { read: ["answers"] });

  // The case that made this whole accessor necessary: `inspect()` returns
  // `undefined` for a game this process is not networking, which reads as "no
  // data" and is indistinguishable from "no answer submitted".
  assert.throws(
    () => net.stateOf("no-such-game", "player-1", "answers"),
    /is not networked by this process/
  );
});

test("an empty key is refused", () => {
  const net = withNetwork(new FakeCollector(), { watch: ["action"] });
  assert.throws(() => net.stateOf("game-1", "player-1", ""), /non-empty string key/);
  // Same for a non-string arriving from untyped experiment code.
  assert.throws(
    () => (net.stateOf as (...a: unknown[]) => unknown)("game-1", "player-1", undefined),
    /non-empty string key/
  );
});

test("unlistedKeyMessage keeps existing `read` entries in the suggested line", () => {
  // The suggestion has to be the WHOLE field, not just the missing key: an
  // author who pastes it must not silently drop the keys already declared.
  const msg = unlistedKeyMessage("c", ["a"], ["b"]);
  assert.match(msg, /read: \["b", "c"\]/);
  assert.match(msg, /Declared: "a", "b"/);
});

test("with nothing declared, the message says so rather than showing an empty list", () => {
  const msg = unlistedKeyMessage("answers", [], []);
  assert.match(msg, /Declared: \(none\)/);
  assert.match(msg, /read: \["answers"\]/);
});
