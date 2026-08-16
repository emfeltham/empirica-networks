/**
 * Which scopes can a participant actually read?
 *
 * §4b of PLATFORM-NOTES lists the ones Classic cross-links to every participant
 * (`game`, `player`, `round`, `stage`, `playerGame`) and gives the rule: before
 * writing anything to a scope, ask who is linked to it.
 *
 * What that list does NOT say is whether anything is left over — somewhere the
 * server can record data durably without handing it to every browser. That
 * decides whether §4c (the topology and seed are participant-readable) is
 * fixable or merely documentable, so it is worth measuring rather than assuming.
 *
 * Sentinels are matched against the RAW wire, below the mode, so a delivery
 * through a channel nobody enumerated still counts as delivered.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";

const N = 3;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

const SENTINELS = {
  batch: "SENTINEL-ON-BATCH-9f2a",
  game: "SENTINEL-ON-GAME-4c71",
} as const;

test("MEASUREMENT: is the batch scope hidden from participants?", async () => {
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    // Write one sentinel to each candidate scope, at the moment each exists.
    _.on("batch", (_ctx: any, { batch }: any) => {
      batch.set("nbhdProbe", SENTINELS.batch);
    });
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) game.set("nbhdProbe", SENTINELS.game);
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      /**
       * Capture every frame each participant receives, below the mode.
       *
       * Opened BEFORE the batch exists, unlike `topology_visibility`, and it has to
       * be: the batch sentinel is written by the `_.on("batch", …)` listener above,
       * which fires the moment `createBatch` lands. A subscription opened after that
       * could miss the very frame this test exists to look for, and the absence
       * would then mean nothing.
       *
       * That is also the shape that correlates with O8's stall — an extra
       * `changes()` subscription opened while Classic is registering participants,
       * measured at 2 failures in 25 runs of `topology_visibility` before it was
       * moved. Here the timing is part of the claim, so it stays, and the 90 s
       * headroom below is what pays for it.
       */
      const frames = participants.map(() => [] as string[]);
      const subs = participants.map((p, i) =>
        p.wireStream().subscribe((change: unknown) => {
          frames[i]!.push(JSON.stringify(change));
        })
      );

      try {
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        // Longer than the default, because roughly 1 run in 3 this stalls
        // in-suite while passing 6/6 alone, even with e2e running serially.
        //
        // The headroom was originally justified by this test being the heaviest
        // in the suite — it opens an extra wire subscription per participant on
        // top of the mode's own. That explanation was rejected when
        // `topology_visibility` stalled on the same wait, apparently doing nothing
        // of the kind — but `topology_visibility` DID open one extra subscription
        // before the batch, so the rejection was itself wrong, and the pattern is
        // back under suspicion (`ISSUES.md` O8, 2026-08-16). It is not established:
        // more headroom has never once been observed to help, because a stalled
        // scenario stays stalled for 90 s as readily as for 30. Kept because
        // removing it proves nothing either.
        await waitFor(
          () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
          { label: "gameID assigned", timeoutMs: 90_000 }
        );
        for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
        await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
          label: "game visible",
        });

        // The game sentinel is the control: it MUST arrive, or a clean result
        // for the batch would just mean nothing was being delivered at all.
        await waitFor(
          () => frames.every((f) => f.join("").includes(SENTINELS.game)),
          { label: "the game-scope control reached every participant", timeoutMs: 90_000 }
        );

        // Give the batch sentinel a fair chance to show up late.
        await new Promise((r) => setTimeout(r, 2_000));

        const batchLeaks = frames.filter((f) => f.join("").includes(SENTINELS.batch)).length;
        const gameLeaks = frames.filter((f) => f.join("").includes(SENTINELS.game)).length;

        console.log(
          `\n  game-scope sentinel  reached : ${gameLeaks}/${N} participants (control, must be ${N})` +
            `\n  batch-scope sentinel reached : ${batchLeaks}/${N} participants\n`
        );

        assert.equal(gameLeaks, N, "control: the game scope really is broadcast");
        assert.equal(
          batchLeaks,
          0,
          "measured 2026-08-15: the batch scope is NOT delivered to participants"
        );
      } finally {
        for (const s of subs) s.unsubscribe?.();
      }
    }
  );
});
