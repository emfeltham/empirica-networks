/**
 * The hook derivations, tested against REAL Nbhd instances.
 *
 * These live in the mode tier rather than unit because the inputs are genuine
 * scopes produced by @empirica/core's Attributes/Scopes machinery, not
 * hand-rolled objects. A fake with a `.get()` would pass even if the attribute
 * keys were wrong.
 *
 * This is where the substance of `useNeighbors`/`useNetworkSelf` is covered:
 * the hooks themselves are delegation, and cannot be rendered against a
 * synthetic mode using public API alone (docs/PLATFORM-NOTES.md §8).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Subject } from "rxjs";
import { TajribaProvider } from "@empirica/core/player";
import { EmpiricaClassic } from "@empirica/core/player/classic";
import {
  assertNetworkMode,
  neighborsOf,
  networkSelfOf,
  NetworkModeNotInstalledError,
} from "../../src/player/view.js";
import { harness, provisionedChannel, publish } from "./synthetic.js";

test("neighborsOf: undefined with no channel at all", () => {
  assert.equal(neighborsOf(undefined), undefined);
  assert.equal(networkSelfOf(undefined), undefined);
});

test("neighborsOf: undefined before the first publish, NOT an empty array", () => {
  // The distinction this whole design turns on. A provisioned-but-unpublished
  // channel means "not known yet"; reporting it as [] renders the participant as
  // isolated, which looks completely normal and silently corrupts the data.
  const h = provisionedChannel();
  const nbhd = h.mode.nbhd.getValue();

  assert.ok(nbhd, "the channel exists");
  assert.equal(nbhd!.published, false);
  assert.equal(neighborsOf(nbhd), undefined, "not ready is undefined, not empty");
});

test("neighborsOf: an empty published view IS an empty array", () => {
  // The other side of the same coin: a genuinely isolated node must be
  // reportable as such, and distinguishable from loading.
  const h = provisionedChannel();
  publish(h, []);
  const nbhd = h.mode.nbhd.getValue();

  assert.equal(nbhd!.published, true);
  assert.deepEqual(neighborsOf(nbhd), [], "isolated is [], and it is not undefined");
});

test("neighborsOf: returns the projected views verbatim", () => {
  const h = provisionedChannel();
  const views = [
    { id: "p2", choice: "A" },
    { id: "p3", choice: "B" },
  ];
  publish(h, views);

  assert.deepEqual(neighborsOf(h.mode.nbhd.getValue()), views);
});

test("networkSelfOf: playerID is readable BEFORE the first publish", () => {
  // playerID is written immutably at provisioning, so identity is available
  // earlier than the view. Components that only need "who am I" should not have
  // to wait for a publish.
  const h = provisionedChannel("participant-1", "player-7");
  const self = networkSelfOf(h.mode.nbhd.getValue());

  assert.equal(self!.playerID, "player-7");
  assert.equal(self!.degree, undefined, "degree is unknown, not 0");
  assert.equal(self!.seq, undefined);
});

test("networkSelfOf: degree and seq after a publish", () => {
  const h = provisionedChannel("participant-1", "player-7");
  publish(h, [{ id: "a" }, { id: "b" }, { id: "c" }], 4);
  const self = networkSelfOf(h.mode.nbhd.getValue());

  assert.equal(self!.playerID, "player-7");
  assert.equal(self!.degree, 3);
  assert.equal(self!.seq, 4);
});

test("networkSelfOf: degree 0 is reported as 0 once published", () => {
  const h = provisionedChannel();
  publish(h, []);
  assert.equal(networkSelfOf(h.mode.nbhd.getValue())!.degree, 0);
});

test("assertNetworkMode: rejects a REAL EmpiricaClassic mode", () => {
  // Built from upstream rather than from a stand-in `{}`, so this asserts the
  // actual thing consumers hit when they forget modeFunc — and it fails if
  // upstream ever starts exposing a `nbhd` key of its own.
  const changes = new Subject<any>();
  const provider = new TajribaProvider(changes as any, new Subject<any>() as any, async () => ({}));
  const classic = EmpiricaClassic("participant-1", provider);

  assert.ok(!("nbhd" in classic), "precondition: classic has no nbhd key");
  assert.throws(() => assertNetworkMode(classic), NetworkModeNotInstalledError);
  assert.throws(() => assertNetworkMode(classic), /modeFunc/, "the message names the fix");
});

test("assertNetworkMode: accepts the network mode, and undefined", () => {
  assert.doesNotThrow(() => assertNetworkMode(harness("participant-1").mode));
  // Pre-connection, on every first paint. Not an error.
  assert.doesNotThrow(() => assertNetworkMode(undefined));
});

test("derivations track republishes", () => {
  const h = provisionedChannel();
  publish(h, [{ id: "a" }], 1);
  assert.equal(networkSelfOf(h.mode.nbhd.getValue())!.degree, 1);

  publish(h, [{ id: "a" }, { id: "b" }], 2);
  assert.deepEqual(neighborsOf(h.mode.nbhd.getValue()), [{ id: "a" }, { id: "b" }]);
  assert.equal(networkSelfOf(h.mode.nbhd.getValue())!.seq, 2);
});
