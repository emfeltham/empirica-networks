/**
 * The missing write ACL, demonstrated through the DOCUMENTED client API.
 *
 * `test/e2e/participant_write.test.ts` already shows that Empirica has no write
 * access control, but it does so through `provider.setAttributes`, which a
 * maintainer could fairly call "not the supported surface".
 *
 * This closes that gap. `useGame().players` (here `mode.players`) is ordinary
 * public client API, every entry is a full `Player` scope with `.set()`, and a
 * participant's browser is a place they control completely. So this is not an
 * exploit in any interesting sense — it is the published API doing exactly what
 * it says, in a direction nobody intended.
 *
 * Written to be quotable in an upstream report: one participant calls
 * `otherPlayer.set(...)`, and the victim receives it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classicKinds } from "@empirica/core/admin/classic";
import { EmpiricaClassic } from "@empirica/core/player/classic";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/harness/harness.js";

const N = 2;
const SENTINEL = "WRITTEN-BY-SOMEONE-ELSE";

test("a participant can write to another participant's player scope via the public API", async () => {
  await withScenario(
    {
      n: N,
      kinds: classicKinds,
      listeners: gameInit(1, 1, 3_600_000),
      modeFunc: EmpiricaClassic as any,
    },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p: any) => p.mode.player.getValue()?.get("gameID")),
        { label: "gameID assigned" }
      );
      for (const p of participants as any[]) p.mode.player.getValue().set("introDone", true);
      await waitFor(() => participants.every((p: any) => Boolean(p.mode.game.getValue())), {
        label: "game visible",
      });
      await waitFor(
        () => participants.every((p: any) => (p.mode.players.getValue() ?? []).length === N),
        { label: "each participant can see both players", timeoutMs: 30_000 }
      );

      const attacker: any = participants[0];
      const victim: any = participants[1];
      const victimID = victim.mode.player.getValue().id as string;

      // Everything below is public API. No ids were leaked and nothing private
      // was used: `players` is how an experiment renders other participants, and
      // every entry is a Player scope with the same `.set()` used on one's own.
      const others = (attacker.mode.players.getValue() as any[]).filter(
        (pl) => pl.id !== attacker.mode.player.getValue().id
      );
      assert.equal(others.length, 1, "the attacker can enumerate the other player");
      assert.equal(others[0].id, victimID, "and it is the victim's own player scope");

      others[0].set("hackedByAnotherParticipant", SENTINEL);

      // The victim's OWN view of themselves now carries a value they never wrote.
      await waitFor(
        () => victim.mode.player.getValue()?.get("hackedByAnotherParticipant") === SENTINEL,
        { label: "the victim's player scope accepted a write from someone else", timeoutMs: 30_000 }
      );

      assert.equal(
        victim.mode.player.getValue().get("hackedByAnotherParticipant"),
        SENTINEL,
        "characterization: Empirica accepts a participant's write to another's player scope"
      );

      console.log("\n=== no write ACL ===");
      console.log("  attacker called otherPlayer.set() using only public client API");
      console.log(`  victim's own player scope now reports: ${SENTINEL}`);
      console.log("  -> server-side code cannot trust the provenance of any player attribute\n");
    }
  );
});
