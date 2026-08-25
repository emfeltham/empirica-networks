/**
 * `net.log` — the stamping and the three refusals.
 *
 * The writer itself is `test/unit/sink.test.ts`'s. What is tested here is the
 * handle method: what it adds to a record, and what it refuses to do quietly.
 * Every one of the throws is a case that would otherwise end as a study which
 * looks like it logged and did not, which is the whole reason the facility exists
 * (`docs/M6-HARDENING.md` §2.1).
 *
 * Against a collector that records registrations and dispatches nothing, since
 * none of this touches game state — deliberately, and that is one of the
 * assertions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withNetwork } from "../../src/admin/with_network.js";
import type { LogRecord } from "../../src/admin/sink.js";

class FakeCollector {
  on(): void {
    /* nothing dispatches here */
  }
}

function recorder(): { records: LogRecord[]; onRecord: (r: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, onRecord: (r) => records.push(r) };
}

test("the package stamps gameID and at, and the author's fields go beside them", () => {
  const { records, onRecord } = recorder();
  const net = withNetwork(new FakeCollector(), { log: { onRecord } });

  const before = Date.now();
  net.log("game-1", { type: "round", round: 3 });

  assert.equal(records.length, 1);
  const r = records[0]!;
  // The stamp is what makes ONE file per study work: a batch of concurrent games
  // interleaves in the log and is separated by gameID offline.
  assert.equal(r.gameID, "game-1");
  assert.equal(r["type"], "round");
  assert.equal(r["round"], 3);
  assert.ok(r.at >= before && r.at <= Date.now(), `at ${r.at} is not the moment it was logged`);
});

test("a game scope works as well as an id, like everything else that takes a game", () => {
  // The M6 §3.1 convention. `net.log(stage.currentGame, …)` is what a listener
  // has to hand, and having to write `.id` at one call site out of five is how
  // `no network for game (no id)` used to happen.
  const { records, onRecord } = recorder();
  const net = withNetwork(new FakeCollector(), { log: { onRecord } });
  net.log({ id: "game-2" }, { type: "start" });
  assert.equal(records[0]!.gameID, "game-2");
});

test("a record carrying its own `at` keeps it", () => {
  // Spread order, and it is a decision: a design whose event time is not the
  // moment it reached the log (a client timestamp, a replayed event) should be
  // able to say so, and silently overwriting it would be the package lying about
  // the author's data.
  const { records, onRecord } = recorder();
  const net = withNetwork(new FakeCollector(), { log: { onRecord } });
  net.log("g", { type: "change", at: 42 });
  assert.equal(records[0]!.at, 42);
});

test("logging a game this process is not networking is fine", () => {
  // Not a mistake, and not the same call as `stateOf`. This writes to the
  // filesystem rather than reading game state, and a log call that started
  // throwing because a game had just ended would lose exactly the records written
  // while something was going wrong.
  const { records, onRecord } = recorder();
  const net = withNetwork(new FakeCollector(), { log: { onRecord } });
  assert.doesNotThrow(() => net.log("never-started", { type: "note" }));
  assert.equal(records.length, 1);
});

test("logging with no log configured throws, naming the field to add", () => {
  const net = withNetwork(new FakeCollector(), {});
  assert.throws(
    () => net.log("g", { type: "round" }),
    (e: Error) => {
      // The silent version of this is a study that ran, recorded nothing, and
      // said nothing — which is the failure the run log exists to prevent, so
      // producing it here would be the worst possible default.
      assert.match(e.message, /no run log is configured/);
      // Ready to paste, like `unlistedKeyMessage`.
      assert.match(e.message, /log: \{ file: "data\/run\.ndjson" \}/);
      return true;
    }
  );
});

test("an unresolvable game throws rather than logging under a made-up id", () => {
  const { onRecord } = recorder();
  const net = withNetwork(new FakeCollector(), { log: { onRecord } });
  for (const bad of [undefined, null, "", {}, { id: 42 }]) {
    assert.throws(
      () => net.log(bad as never, { type: "x" }),
      /needs a game scope or its id string/,
      `${JSON.stringify(bad)} was accepted`
    );
  }
});

test("a record that is not a plain object throws", () => {
  // An array or a string would produce a line that parses and then breaks every
  // `record.type` switch downstream — including `fromLog` in both examples.
  const { onRecord } = recorder();
  const net = withNetwork(new FakeCollector(), { log: { onRecord } });
  for (const bad of [null, "round", 3, [1, 2]]) {
    assert.throws(
      () => net.log("g", bad as never),
      /takes a plain object/,
      `${JSON.stringify(bad)} was accepted`
    );
  }
});
