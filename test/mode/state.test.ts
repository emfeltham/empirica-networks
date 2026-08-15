/**
 * The private write path, client side.
 *
 * The namespacing is the load-bearing detail: a participant can write to their
 * own channel, and that channel is also where the server writes `neighbors` and
 * `_seq`. Without the prefix a participant could overwrite their own
 * neighbourhood — or the publish counter the dones self-check depends on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkStateOf } from "../../src/player/state.js";
import { NBHD_KEYS, STATE_PREFIX, stateKey } from "../../src/shared/keys.js";
import { attrChange, provisionedChannel, publish } from "./synthetic.js";

test("stateKey namespaces away from the server's own keys", () => {
  assert.equal(stateKey("color"), "state:color");
  assert.equal(STATE_PREFIX, "state:");

  // The two keys a participant must not be able to clobber.
  for (const reserved of [NBHD_KEYS.NEIGHBORS, NBHD_KEYS.SEQ, NBHD_KEYS.OWNER]) {
    assert.notEqual(stateKey(reserved), reserved, `${reserved} stays out of reach`);
  }
});

test("returns undefined with no channel yet", () => {
  assert.equal(networkStateOf(undefined), undefined);
});

test("set() writes under the prefix, not the bare key", () => {
  const h = provisionedChannel();
  const state = networkStateOf(h.mode.nbhd.getValue())!;

  state.set("color", "violet");

  const sent = JSON.stringify(h.sent);
  assert.match(sent, /state:color/, "written under the namespace");
  assert.match(sent, /violet/);
  assert.ok(
    !/"key":"color"/.test(sent),
    "must not write the bare key, which would sit beside the server's own"
  );
});

test("get() reads back a value written under the prefix", () => {
  const h = provisionedChannel();
  h.changes.next(attrChange("chan-1", stateKey("color"), "amber", true));

  const state = networkStateOf(h.mode.nbhd.getValue())!;
  assert.equal(state.get("color"), "amber");
  assert.equal(state.get("nothingSet"), undefined);
});

test("private state and the server's projection coexist on one channel", () => {
  // Both live on the same scope, which is exactly why the prefix matters.
  const h = provisionedChannel();
  h.changes.next(attrChange("chan-1", stateKey("color"), "blue", true));
  publish(h, [{ id: "n1", color: "red" }], 3);

  const nbhd = h.mode.nbhd.getValue()!;
  const state = networkStateOf(nbhd)!;

  assert.equal(state.get("color"), "blue", "my own private value");
  assert.deepEqual(nbhd.neighbors, [{ id: "n1", color: "red" }], "the server's view");
  assert.equal(nbhd.seq, 3, "and the publish counter is intact");
});
