/**
 * Who can read the realised network?
 *
 * `withNetwork` records the seed and the edge list on the GAME scope so a
 * finished run is reproducible from stored data. But this module's own rule
 * (docs/PLATFORM-NOTES.md §4b) is: before writing anything to a scope, ask who
 * is linked to it — and every participant is linked to the game.
 *
 * So this measures what participants actually receive. The answer decides
 * whether the package's claim needs qualifying: "sees only their neighbours'
 * STATE" is a different promise from "cannot work out the network".
 *
 * Deliberately written to record the truth either way rather than to pass.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import { GAME_KEYS } from "../../src/shared/keys.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

test("MEASUREMENT: can a participant read the topology off the game scope?", async () => {
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id }),
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

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

      // What one ordinary participant can read from their own client state.
      const client = modeOf(participants[0]!).game.getValue()!;
      const network = client.get(GAME_KEYS.NETWORK);
      const seed = client.get(GAME_KEYS.SEED);

      const readable = network !== undefined;
      console.log(
        `\n  participant-readable topology : ${readable ? "YES" : "no"}` +
          `\n  participant-readable seed     : ${seed !== undefined ? "YES" : "no"}` +
          `\n  value: ${JSON.stringify(network)}\n`
      );

      // The assertion records the measured answer so a future change to WHERE
      // the network is stored fails here loudly and has to be thought about,
      // rather than silently changing what participants can see.
      assert.equal(
        readable,
        true,
        "measured 2026-08-15: the edge list IS delivered to participants"
      );
      assert.equal(typeof seed, "number", "and so is the seed");

      // The point that matters: structure being visible must NOT mean state is.
      // This is the guarantee the package actually makes, and it still holds.
      const myID = modeOf(participants[0]!).player.getValue()!.id;
      const myNeighbours = new Set(
        (modeOf(participants[0]!).nbhd.getValue()!.neighbors as { id: string }[]).map(
          (n) => n.id
        )
      );
      assert.equal(myNeighbours.size, 2, "still exactly 2 of the other 3");
      assert.ok(!myNeighbours.has(myID), "and not themselves");
    }
  );
});
