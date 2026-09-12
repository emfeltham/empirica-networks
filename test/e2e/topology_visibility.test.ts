/**
 * The realized network must not reach the people inside it.
 *
 * `withNetwork` records the seed and edge list so a finished run is
 * reproducible from stored data. That record started on the GAME scope, which
 * broke this module's own rule (§4b: before writing anything to a scope, ask who
 * is linked to it) — every participant is linked to the game, and measurement
 * confirmed every participant received the full edge list AND the seed.
 *
 * State was never the issue. The seating plan was: for a design where the
 * topology is the manipulation, handing it to the browser is a confound.
 * It now lives on the batch scope, the only durable scope measured not to be
 * delivered to participants (`scope_visibility.test.ts`).
 *
 * This test is the lock on that. It checks the participant's own scope AND the
 * raw wire, so moving the data back — or renaming the key and forgetting why —
 * fails here rather than quietly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/harness/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

test("a participant cannot read the realized topology or its seed", async () => {
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id }),
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      /**
       * Capture the wire below the mode: a scope-level check alone would miss the
       * data arriving under a name the client never surfaces.
       *
       * Opened AFTER the batch is running, and that position is load-bearing. This
       * subscription used to be the first thing the test did, and that is the shape
       * M5 already found and fixed in `rand2011`: an extra `changes()` subscription
       * opened while Classic is registering participants correlates with a
       * participant never getting a player scope at all, and then nothing is ever
       * assigned (`ISSUES.md` O8). Measured here: this file failed 2 of 25 runs
       * alone, on a swept idle machine, with the subscription first.
       *
       * Nothing is lost by waiting. The claim is about the edge list, the network
       * does not exist until the game starts, and the game cannot start before
       * assignment — so no frame that could carry a topology has been sent yet.
       * `scope_visibility` is the case where this is NOT true, and it says so.
       */
      const frames: string[] = [];
      const sub = participants[0]!.wireStream().subscribe((c: unknown) => {
        frames.push(JSON.stringify(c));
      });

      await waitFor(
        () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
        { label: "gameID assigned" }
      );
      for (const p of participants) {
        modeOf(p).player.getValue()!.set("introDone", true);
      }
      await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
        label: "game visible",
      });
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "published",
        timeoutMs: 30_000,
      });

      // Scan the participant's WHOLE client-side game scope, not just the keys
      // we currently use. Asserting `get(ourKey) === undefined` would pass just
      // as well if the key had merely been renamed, so this looks for the edge
      // list's actual shape anywhere in what the participant received.
      const client = modeOf(participants[0]!).game.getValue()!;
      const edgesJSON = JSON.stringify(ring(N));
      const visible: string[] = [];
      for (const key of ["network", "networkSeed", "nbhd", "topology"]) {
        const v = client.get(key);
        if (v !== undefined) visible.push(`${key}=${JSON.stringify(v)}`);
      }

      // Match the serialized edge list with and without its outer brackets, so
      // a copy nested inside a larger payload is still caught.
      const wire = frames.join("");
      const topologyOnWire =
        wire.includes(edgesJSON) || wire.includes(edgesJSON.slice(1, -1));

      console.log(
        `\n  network keys on the participant's game scope : ${visible.length ? visible.join(", ") : "none"}` +
          `\n  edge list anywhere on the wire               : ${topologyOnWire ? "YES" : "no"}\n`
      );

      // Was YES for both until 2026-08-15, when the record moved to the batch
      // scope — the only durable scope measured NOT to be delivered to
      // participants (`scope_visibility.test.ts`). State was never the issue;
      // the seating plan of the network was.
      assert.deepEqual(visible, [], "no network data on the participant's game scope");
      assert.equal(
        topologyOnWire,
        false,
        "the realized edge list must not reach a participant by any route"
      );

      // The point that matters: structure being visible must NOT mean state is.
      // This is the guarantee the package actually makes, and it still holds.
      const myID = modeOf(participants[0]!).player.getValue()!.id;
      const myNeighbors = new Set(
        (modeOf(participants[0]!).nbhd.getValue()!.neighbors as { id: string }[]).map(
          (n) => n.id
        )
      );
      assert.equal(myNeighbors.size, 2, "still exactly 2 of the other 3");
      assert.ok(!myNeighbors.has(myID), "and not themselves");

      sub.unsubscribe?.();
    }
  );
});
