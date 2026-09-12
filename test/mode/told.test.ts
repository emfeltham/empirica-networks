/**
 * The server->one-participant private write path, client side.
 *
 * `tell()` is the SECOND path from server to client, added in M5 because
 * `project()` runs only over a viewer's current neighbors and therefore cannot
 * express "show this subject one fact about someone they are not connected to" —
 * which is what a rewiring offer is made of.
 *
 * A second path is exactly the kind of thing that quietly becomes a leak, so the
 * namespacing is asserted here the same way `state.test.ts` asserts the first
 * one: three sets of keys share one scope — the server's own (`neighbors`,
 * `_seq`), the participant's (`state:*`) and the server's per-participant
 * messages (`told:*`) — and any collision between them is a silent bug.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkStateOf } from "../../src/player/state.js";
import { networkToldOf } from "../../src/player/view.js";
import {
  NBHD_KEYS,
  STATE_PREFIX,
  TOLD_PREFIX,
  stateKey,
  toldKey,
} from "../../src/shared/keys.js";
import { attrChange, provisionedChannel, publish } from "./synthetic.js";

test("toldKey namespaces away from the server's keys AND the participant's", () => {
  assert.equal(toldKey("offer"), "told:offer");
  assert.equal(TOLD_PREFIX, "told:");

  // Against the server's own reserved keys.
  for (const reserved of [NBHD_KEYS.NEIGHBORS, NBHD_KEYS.SEQ, NBHD_KEYS.OWNER]) {
    assert.notEqual(toldKey(reserved), reserved, `${reserved} stays out of reach`);
  }

  // And against the participant's namespace, which is the collision that
  // matters: a participant can write anything to their own channel, so if the
  // two prefixes met, `state.set("offer", …)` would overwrite the server's
  // offer and the server would read back the participant's own answer as
  // though it had authored it.
  assert.notEqual(TOLD_PREFIX, STATE_PREFIX);
  assert.notEqual(toldKey("offer"), stateKey("offer"));
});

test("returns undefined with no channel yet", () => {
  assert.equal(networkToldOf(undefined), undefined);
});

test("get() reads a value the server wrote under the told prefix", () => {
  const h = provisionedChannel();
  h.changes.next(
    attrChange("chan-1", toldKey("offer"), { with: "player-9", theirLastAction: "C" }, true)
  );

  const told = networkToldOf(h.mode.nbhd.getValue())!;
  assert.deepEqual(told.get("offer"), { with: "player-9", theirLastAction: "C" });
  assert.equal(told.get("neverWritten"), undefined);
});

test("a bare key is NOT read as a told value", () => {
  // If `networkToldOf` ever read the unprefixed key, the server's `neighbors`
  // and `_seq` would be readable as told values and — worse — a participant
  // could forge one by writing the bare key themselves.
  const h = provisionedChannel();
  h.changes.next(attrChange("chan-1", "offer", "forged", true));

  const told = networkToldOf(h.mode.nbhd.getValue())!;
  assert.equal(told.get("offer"), undefined);
});

test("told, state and the projection coexist on one channel without collision", () => {
  const h = provisionedChannel();
  // All three writers, same scope, same logical key name "action".
  h.changes.next(attrChange("chan-1", stateKey("action"), "D"));
  h.changes.next(attrChange("chan-1", toldKey("action"), "C", true));
  publish(h, [{ id: "n1", action: "C" }], 3);

  const nbhd = h.mode.nbhd.getValue()!;
  assert.equal(networkStateOf(nbhd)!.get("action"), "D", "the participant's own choice");
  assert.equal(networkToldOf(nbhd)!.get("action"), "C", "what the server told them");
  assert.deepEqual(nbhd.neighbors, [{ id: "n1", action: "C" }], "the projection, untouched");
  assert.equal(nbhd.seq, 3);
});

test("told values are visible before the first publish", () => {
  // Load-bearing for Rand 2011's rewiring stage, where the offer IS the
  // stimulus: if a told value only resolved after a projection had arrived, a
  // participant with no neighbors left would never see their offer.
  const h = provisionedChannel();
  h.changes.next(attrChange("chan-1", toldKey("offer"), { with: "player-9" }, true));

  const nbhd = h.mode.nbhd.getValue()!;
  assert.equal(nbhd.published, false, "no projection has arrived");
  assert.deepEqual(networkToldOf(nbhd)!.get("offer"), { with: "player-9" });
});

test("the reader is read-only — there is no set()", () => {
  // Not a permission check: nothing at the wire stops a participant writing
  // anywhere (PLATFORM-NOTES §4a). It is an API that does not invite the
  // mistake, and server code trusting a told value it reads back would be
  // trusting participant input.
  const h = provisionedChannel();
  const told = networkToldOf(h.mode.nbhd.getValue())! as unknown as Record<string, unknown>;
  assert.equal(typeof told["get"], "function");
  assert.equal(told["set"], undefined);
});
