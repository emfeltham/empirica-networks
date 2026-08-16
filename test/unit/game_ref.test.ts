/**
 * The one argument convention (`docs/M6-HARDENING.md` §3.1).
 *
 * `network(game)` took a game object and read only `.id` off it; `net.inspect(id)`
 * took the id. Writing `test/e2e/rand2011.test.ts` I passed an id to `network()`
 * and got `no network for game (no id)` — a correct message for a confusing
 * signature — and worked around it with an `{ id }` wrapper that happened to be
 * enough. Both forms are now accepted everywhere, normalised in one place.
 *
 * The interesting cases are the rejections, because `gameIDOf` sits in front of
 * every lookup: anything it lets through as a plausible id becomes a `Map.get`
 * with a nonsense key, which returns `undefined` and reads as "no such game".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gameIDOf, network, withNetwork } from "../../src/admin/with_network.js";

/** Enough of a collector for `withNetwork` to attach to. Nothing dispatches. */
class FakeCollector {
  readonly attributeListeners: unknown[] = [];
  on(): void {}
}

test("both forms of a game reference resolve to the same id", () => {
  assert.equal(gameIDOf("game-1"), "game-1");
  assert.equal(gameIDOf({ id: "game-1" }), "game-1");
  // A real Empirica game scope has more on it than `id`; only `id` is read, which
  // is what lets a test pass a bare `{ id }` and a listener pass `stage.currentGame`.
  assert.equal(gameIDOf({ id: "game-1", players: [], batch: {} } as any), "game-1");
});

test("anything that is not an id resolves to undefined, not to a lookup key", () => {
  // Each of these would otherwise become `games.get(<nonsense>)` — `undefined`,
  // indistinguishable from "that game has ended". The whole point of a normaliser
  // is that the one place it happens is the place that can refuse.
  assert.equal(gameIDOf(undefined), undefined);
  assert.equal(gameIDOf(""), undefined, "an empty string is not an id");
  assert.equal(gameIDOf({}), undefined, "an object with no id");
  assert.equal(gameIDOf({ id: undefined }), undefined);
  assert.equal(gameIDOf({ id: 42 } as any), undefined, "a number is not an id");
  assert.equal(gameIDOf({ id: "" }), undefined);
  assert.equal(gameIDOf(null as any), undefined);
});

test("network() accepts either form and names what it got when it cannot", () => {
  // No game is networked here, so both throw — but the MESSAGE is the test: an id
  // that simply is not running reads differently from a value that was never a
  // game reference at all, and before M6 both produced `(no id)`.
  assert.throws(() => network("no-such-game"), /no network for game no-such-game/);
  assert.throws(() => network({ id: "no-such-game" }), /no network for game no-such-game/);

  assert.throws(
    () => network({} as any),
    (e: Error) => {
      assert.match(e.message, /\(no id\)/);
      assert.match(e.message, /Pass a game scope or its id string/);
      return true;
    }
  );
});

test("stateOf accepts either form, and the key check still runs first", () => {
  const net = withNetwork(new FakeCollector(), { read: ["answers"] });

  // Same error either way: the reference resolved fine, the game is not running.
  for (const ref of ["g1", { id: "g1" }] as const) {
    assert.throws(() => net.stateOf(ref, "p1", "answers"), /is not networked by this process/);
  }

  // And an unresolvable reference does not get to skip the key check — the guard
  // order asserted in `test/unit/state_of.test.ts` has to survive the new
  // normalisation, or a typo starts being reported as a missing game again.
  assert.throws(() => net.stateOf({} as any, "p1", "typo"), /neither `watch` nor `read`/);
});

test("inspect() answers undefined for an unresolvable reference, never throws", () => {
  const net = withNetwork(new FakeCollector(), {});

  // Deliberately unlike `stateOf`. `inspect` is the monitor's read path and is
  // called from timers and HTTP handlers; throwing there takes the observer down
  // at the moment something is going wrong. `undefined` is also its honest answer
  // for a game that has ended (see the interface).
  assert.equal(net.inspect("no-such-game"), undefined);
  assert.equal(net.inspect({} as any), undefined);
  assert.equal(net.inspect(undefined as any), undefined);
});

test("activeGames is empty and correctly shaped before anything runs", () => {
  const net = withNetwork(new FakeCollector(), {});
  assert.deepEqual(net.activeGames(), []);
  // The rename is the fix for §3.2: `games()` invited "the current game", which it
  // never was. Asserting the old name is gone keeps a re-export from quietly
  // restoring it.
  assert.equal((net as unknown as { games?: unknown }).games, undefined);
});
