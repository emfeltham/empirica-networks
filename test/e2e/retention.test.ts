/**
 * Does a finished game let go of its memory?
 *
 * `withNetwork` keeps nine structures keyed by game or by channel scope,
 * including one Empirica `Scope` object per participant per game. Until the
 * game-end listener existed, none of them was ever dropped: a server running a
 * study of many sequential games accumulated all of it for the life of the
 * process, and nothing anywhere said so.
 *
 * This is deliberately NOT a heap-watching test. Heap size is noisy, GC timing
 * is not ours to control, and "memory went down" is a weak claim. The handle
 * reports what it holds, so the assertion is exact.
 *
 * The trap this has to avoid is asserting zero against something that was never
 * populated — a test that only checks "empty after" passes just as well when the
 * feature never ran. So it asserts NON-ZERO while the game is live first, and
 * that half is the one that makes the other half mean anything.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { readChannels, resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
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

test("a finished game releases everything it was holding", async () => {
  let handle: NetworkHandle | undefined;
  let gameRef: any;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    handle = withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id, choice: neighbor.get("choice") }),
      watch: ["choice"],
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
      for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      // Publish something, so the view cache is populated too and not merely
      // allocated — `lastPublished` only gains an entry once a view is written.
      modeOf(participants[0]!).player.getValue()!.set("choice", "held");
      await waitFor(
        () =>
          participants.some((p) =>
            ((modeOf(p).nbhd.getValue()?.neighbors ?? []) as { choice?: string }[]).some(
              (n) => n.choice === "held"
            )
          ),
        { label: "a view was published", timeoutMs: 30_000 }
      );

      // --- while the game is live: everything is held --------------------
      const live = handle!.stats();
      assert.equal(live.games, 1, "the running game is tracked");
      assert.equal(live.channels, N, "one channel per participant");
      assert.equal(live.channelScopes, N, "and one materialised scope each");
      assert.ok(live.cachedViews > 0, "views are cached, so there is something to release");
      assert.ok(gameRef, "the test captured the game");
      assert.notDeepEqual(readChannels(gameRef), {}, "the channel index is populated");

      // --- end it ---------------------------------------------------------
      gameRef.end("ended", "retention test");
      await waitFor(() => handle!.stats().games === 0, {
        label: "the finished game was released",
        timeoutMs: 30_000,
      });

      const after = handle!.stats();
      assert.deepEqual(
        { ...after, firstChannelMs: undefined },
        {
          games: 0,
          channels: 0,
          channelScopes: 0,
          cachedViews: 0,
          // Zero for two reasons at once. This scenario runs at the default
          // radius, where no layout is ever computed; and the map is keyed by
          // SCOPE id, so had one been computed, none of the game-keyed deletes
          // would have reached it — `ISSUES.md` O5's shape exactly.
          // `test/e2e/subgraph.test.ts` is where it is non-zero.
          cachedLayouts: 0,
          // The single exception, and the reason it is asserted as a value
          // rather than omitted: the id of a finished game is kept on purpose,
          // to stop its channels being re-adopted when the kind subscription
          // replays them. Bounded since `ISSUES.md` O5 — the bound and the
          // per-player chat state below are exercised over many sequential
          // games in `test/unit/retention.test.ts`, which needs no server.
          endedGames: 1,
          chatSeqs: 0,
          // Per PROCESS and never reset between games, which is the argument for
          // them being here at zero rather than omitted: they are observations
          // about whether this process ever took the late-provisioning path
          // (`ISSUES.md` O4), not resources a finished game could still hold. A
          // non-zero value in THIS scenario would mean the repair path ran in a
          // run that never needed it.
          pendingAtStart: 0,
          lateProvisioned: 0,
          // Masked in the comparison rather than left out of it, so this stays
          // an EXHAUSTIVE record and a new field has to be argued for here.
          // `firstChannelMs` is a measurement, not a resource, and is kept
          // deliberately: the check it feeds is one-shot per process
          // (`ISSUES.md` O15), so clearing it per game would make the figure
          // describe the most recent game rather than the coldest one.
          firstChannelMs: undefined,
        },
        "nothing is still held for a game that is over"
      );
      assert.equal(
        typeof after.firstChannelMs,
        "number",
        "the one thing that survives on purpose and is not a resource"
      );
      assert.deepEqual(
        readChannels(gameRef),
        {},
        "including the channel index, which nothing else drops"
      );
    }
  );
});
