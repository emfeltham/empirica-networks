/**
 * A synthetic TajribaProvider: real `Attributes`/`Scopes`/`Steps`, real `Nbhd`
 * instances, no server and no sockets.
 *
 * Shared by every mode-tier test so there is one place where the wire format is
 * described. If upstream changes the shape of a ChangePayload, exactly one file
 * needs editing and every mode test fails at once rather than a subset passing
 * for the wrong reason.
 */
import { Subject } from "rxjs";
import { TajribaProvider } from "@empirica/core/player";
import { EmpiricaNetwork, type Nbhd } from "../../src/player/mode.js";
import { NBHD_KEYS, NBHD_KIND } from "../../src/shared/keys.js";

/** Build the ChangePayload shapes TajribaProvider's groupBy expects. */
export function scopeChange(id: string, kind: string, done = false) {
  return {
    __typename: "ChangePayload",
    done,
    removed: false,
    change: { __typename: "ScopeChange", id, kind, name: id },
  };
}

let attrSeq = 0;
export function attrChange(nodeID: string, key: string, value: unknown, done = false) {
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

export function harness(participantID: string) {
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

/**
 * A provisioned-but-unpublished channel: the state between `provisionChannels`
 * creating the scope and the first `publishAll`. Real, and the state in which a
 * naive hook reports the participant as isolated.
 */
export function provisionedChannel(participantID = "participant-1", playerID = "player-1") {
  const h = harness(participantID);
  h.changes.next(scopeChange("chan-1", NBHD_KIND));
  h.changes.next(attrChange("chan-1", NBHD_KEYS.OWNER, participantID));
  h.changes.next(attrChange("chan-1", NBHD_KEYS.PLAYER_ID, playerID, true));
  return h;
}

/**
 * Publish a view to the channel created by `provisionedChannel`.
 *
 * `graph` is what radius 1.5 adds, and it is written in the SAME batch as the
 * neighbor list here because that is what the server does — the two arriving
 * apart would draw ties between the wrong people for as long as the skew lasted.
 * Pass `undefined` for the default radius, where the key is absent entirely.
 */
export function publish(
  h: { changes: Subject<any> },
  neighbors: unknown[],
  seq = 1,
  graph?: unknown
): void {
  h.changes.next(attrChange("chan-1", NBHD_KEYS.SEQ, seq));
  if (graph !== undefined) h.changes.next(attrChange("chan-1", NBHD_KEYS.GRAPH, graph));
  h.changes.next(attrChange("chan-1", NBHD_KEYS.NEIGHBORS, neighbors, true));
}

export type { Nbhd };
