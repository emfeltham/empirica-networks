/**
 * Reproduction for ISSUES.md U7 / PLATFORM-NOTES §16: at scale, game start
 * corrupts the websocket stream and participants never reach the game.
 *
 *   CEILING_N=200 node scripts/ceiling.mjs                 # with this package
 *   CEILING_N=125 CEILING_PLAIN=1 node scripts/ceiling.mjs # stock Classic only
 *
 * The second form is the one that matters for the report: with `CEILING_PLAIN=1`
 * no `withNetwork` is registered at all, so a failure there is Empirica's and
 * nothing of ours is in the picture. It is how "the sharded bench dies at n=200"
 * was separated from "n=200 does not work", which are very different claims —
 * the first would have been ours to fix.
 *
 * Deliberately single-process and deliberately minimal: the smaller the
 * reproduction, the harder it is to wave away.
 */
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ringLattice } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const N = Number(process.env.CEILING_N ?? 200);
/** With PLAIN=1, no withNetwork at all: stock Classic, same size, same harness. */
const PLAIN = process.env.CEILING_PLAIN === "1";

async function main(): Promise<void> {
  resetChannels();
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    if (PLAIN) return;
    withNetwork(_, {
      topology: ({ playerCount }: any) => ringLattice(playerCount, 4),
      project: (neighbour: any) => ({ id: neighbour.id, tick: neighbour.get("tick") }),
      watch: ["tick"],
      envelope: { maxDegree: 16, onExceed: "throw" },
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork, waveSize: 25 },
    async ({ admin, participants }) => {
      const t0 = performance.now();
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      console.log(`  n=${N}: batch running at ${(performance.now() - t0).toFixed(0)}ms`);

      await waitFor(
        () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
        { label: "gameID assigned", timeoutMs: 300_000 }
      );
      console.log(`  n=${N}: gameID assigned at ${(performance.now() - t0).toFixed(0)}ms`);

      for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
      if (PLAIN) {
        // The stock equivalent of "everyone is in and playing": the game scope
        // and the stage have reached every participant.
        await waitFor(
          () => participants.every((p) => Boolean(modeOf(p).stage.getValue())),
          { label: "stage visible", timeoutMs: 300_000 }
        );
        console.log(`  n=${N} PLAIN: stage visible at ${(performance.now() - t0).toFixed(0)}ms`);
        return;
      }
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 300_000,
      });
      console.log(`  n=${N}: first publish at ${(performance.now() - t0).toFixed(0)}ms`);
    }
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`  n=${N} FAILED:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
