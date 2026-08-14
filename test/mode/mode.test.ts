/**
 * Mode tests: the participant mode driven by a SYNTHETIC TajribaProvider.
 *
 * No server, no sockets, milliseconds. These exist to pin the `dones` contract —
 * the protocol by which Attributes and Scopes resolve values. Get it wrong and
 * every Scope still materialises while every `.get()` returns undefined, with no
 * error anywhere. That failure cost hours during the spike and would cost them
 * again the first time upstream changes the provider protocol.
 *
 * If a future @empirica/core release changes how changes map to scopes,
 * attributes or dones, these fail in ~10ms instead of surfacing as an
 * inexplicably empty neighbourhood in an e2e run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Subject } from "rxjs";
import { TajribaProvider } from "@empirica/core/player";
import { EmpiricaNetwork, Nbhd } from "../../src/player/mode.js";
import { NBHD_KEYS, NBHD_KIND } from "../../src/shared/keys.js";

/** Build the ChangePayload shapes TajribaProvider's groupBy expects. */
function scopeChange(id: string, kind: string, done = false) {
  return {
    __typename: "ChangePayload",
    done,
    removed: false,
    change: { __typename: "ScopeChange", id, kind, name: id },
  };
}

let attrSeq = 0;
function attrChange(nodeID: string, key: string, value: unknown, done = false) {
  return {
    __typename: "ChangePayload",
    done,
    removed: false,
    change: {
      __typename: "AttributeChange",
      id: `attr-${++attrSeq}`,
      nodeID,
      deleted: false,
      createdAt: new Date().toISOString(),
      isNew: true,
      index: null,
      vector: false,
      version: 1,
      key,
      val: JSON.stringify(value),
    },
  };
}

function harness(participantID: string) {
  const changes = new Subject<any>();
  const globals = new Subject<any>();
  const sent: unknown[] = [];
  const provider = new TajribaProvider(changes as any, globals as any, async (input) => {
    sent.push(input);
    return {};
  });
  const mode = EmpiricaNetwork(participantID, provider);
  return { changes, mode, sent };
}

test("resolves a channel and its attributes — the dones contract holds", () => {
  const { changes, mode } = harness("participant-1");

  changes.next(scopeChange("chan-1", NBHD_KIND));
  changes.next(attrChange("chan-1", NBHD_KEYS.OWNER, "participant-1"));
  changes.next(attrChange("chan-1", NBHD_KEYS.SEQ, 7));
  changes.next(attrChange("chan-1", NBHD_KEYS.NEIGHBORS, [{ id: "p2" }, { id: "p3" }], true));

  const nbhd = mode.nbhd.getValue();
  assert.ok(nbhd, "channel materialised");
  assert.ok(nbhd instanceof Nbhd, "modelled as our Scope subclass, not a bare Scope");

  // The load-bearing assertions: values are READABLE. A broken dones wiring
  // still passes the two above and fails these.
  assert.equal(nbhd!.ownerParticipantID, "participant-1");
  assert.equal(nbhd!.seq, 7);
  assert.deepEqual(nbhd!.neighbors, [{ id: "p2" }, { id: "p3" }]);
});

test("selects its OWN channel when a stale one is also present", () => {
  // The spike selected index 0 of whatever arrived. A stale channel surviving a
  // rewire or reconnect would then hand this participant someone else's view —
  // silently, and looking entirely healthy.
  const { changes, mode } = harness("participant-1");

  changes.next(scopeChange("chan-other", NBHD_KIND));
  changes.next(attrChange("chan-other", NBHD_KEYS.OWNER, "participant-2"));
  changes.next(attrChange("chan-other", NBHD_KEYS.NEIGHBORS, [{ id: "THEIRS" }], true));

  changes.next(scopeChange("chan-mine", NBHD_KIND));
  changes.next(attrChange("chan-mine", NBHD_KEYS.OWNER, "participant-1"));
  changes.next(attrChange("chan-mine", NBHD_KEYS.NEIGHBORS, [{ id: "MINE" }], true));

  const nbhd = mode.nbhd.getValue();
  assert.equal(nbhd!.ownerParticipantID, "participant-1", "selected by owner");
  assert.deepEqual(nbhd!.neighbors, [{ id: "MINE" }]);
});

test("ignores a channel belonging to someone else entirely", () => {
  const { changes, mode } = harness("participant-1");

  changes.next(scopeChange("chan-other", NBHD_KIND));
  changes.next(attrChange("chan-other", NBHD_KEYS.OWNER, "participant-2"));
  changes.next(attrChange("chan-other", NBHD_KEYS.NEIGHBORS, [{ id: "THEIRS" }], true));

  const nbhd = mode.nbhd.getValue();
  // The single-channel fallback may adopt it, but it must never be reported as
  // ours: the owner is the authority.
  if (nbhd) {
    assert.notEqual(
      nbhd.ownerParticipantID,
      "participant-1",
      "must not claim another participant's channel as its own"
    );
  }
});

test("tracks updates to an existing channel", () => {
  const { changes, mode } = harness("participant-1");

  changes.next(scopeChange("chan-1", NBHD_KIND));
  changes.next(attrChange("chan-1", NBHD_KEYS.OWNER, "participant-1"));
  changes.next(attrChange("chan-1", NBHD_KEYS.SEQ, 1, true));
  assert.equal(mode.nbhd.getValue()!.seq, 1);

  changes.next(attrChange("chan-1", NBHD_KEYS.SEQ, 2));
  changes.next(attrChange("chan-1", NBHD_KEYS.NEIGHBORS, [{ id: "new" }], true));

  assert.equal(mode.nbhd.getValue()!.seq, 2, "later publishes are visible");
  assert.deepEqual(mode.nbhd.getValue()!.neighbors, [{ id: "new" }]);
});

test("neighbors defaults to an empty array before the first publish", () => {
  const { changes, mode } = harness("participant-1");

  changes.next(scopeChange("chan-1", NBHD_KIND));
  changes.next(attrChange("chan-1", NBHD_KEYS.OWNER, "participant-1", true));

  const nbhd = mode.nbhd.getValue();
  assert.ok(nbhd, "channel exists before any publish");
  assert.deepEqual(nbhd!.neighbors, [], "empty, not undefined — callers can map over it");
  assert.equal(nbhd!.seq, undefined, "no publish has happened yet");
});

test("is a superset of EmpiricaClassic — existing hooks keep working", () => {
  // Composition, not reimplementation: every classic key must survive the merge.
  // A removal upstream would silently strip one, so EmpiricaNetwork throws; this
  // asserts the healthy case.
  const { mode } = harness("participant-1");
  for (const key of ["game", "player", "players", "round", "stage", "globals"]) {
    assert.ok(key in mode, `classic key "${key}" is present`);
  }
  assert.ok("nbhd" in mode, "plus our addition");
});

test("does not confuse other scope kinds for a channel", () => {
  const { changes, mode } = harness("participant-1");

  changes.next(scopeChange("game-1", "game"));
  changes.next(attrChange("game-1", "someKey", "someValue", true));

  assert.equal(mode.nbhd.getValue(), undefined, "a game scope is not a neighbourhood");
});
