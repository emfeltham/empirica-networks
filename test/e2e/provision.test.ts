/**
 * Provisioning against a real Tajriba.
 *
 * The unit tests pin the batching, idempotency and owner-mapping logic against
 * fakes. This proves the fakes describe reality: that scopes are really created,
 * really linked 1:1, and that each participant receives its own channel and
 * nobody else's.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EmpiricaClassic } from "@empirica/core/player/classic";
import { networkKinds } from "../../src/admin/kinds.js";
import { provisionChannels, readChannels, type ProvisionResult } from "../../src/admin/provision.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type Participant,
} from "../../src/harness/harness.js";

const N = 3;

function recordWire(p: Participant<unknown>): string[] {
  const seen: string[] = [];
  p.wireStream().subscribe({
    next: (msg: unknown) => {
      try {
        seen.push(JSON.stringify(msg));
      } catch {
        /* ignore unserialisable frames */
      }
    },
  });
  return seen;
}

test("provisions real channels, linked 1:1, each visible only to its owner", async () => {
  const results: ProvisionResult[] = [];
  let gameRef: any;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "tick", async (ctx: any, { game }: any) => {
      if (game.get("tick") !== "provision") return;
      gameRef = game;
      // Called twice deliberately: idempotency must hold against the real
      // backend, not just the fake. Tajriba cannot unlink, so a double-provision
      // bug would permanently accumulate links.
      results.push(await provisionChannels(ctx, game));
      results.push(await provisionChannels(ctx, game));
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaClassic as any },
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

      // Record wires BEFORE provisioning, so we observe the channels arriving.
      const wires = participants.map(recordWire);
      await new Promise((r) => setTimeout(r, 200));

      const gameID = (participants[0] as any).mode.player.getValue().get("gameID") as string;
      await admin.taj.setAttribute({
        key: "tick",
        val: JSON.stringify("provision"),
        nodeID: gameID,
      });
      await waitFor(() => results.length === 2, { label: "both provision calls returned" });
      await new Promise((r) => setTimeout(r, 1500));

      const [first, second] = results as [ProvisionResult, ProvisionResult];

      assert.equal(first.created.length, N, "first call provisions every player");
      assert.equal(second.created.length, 0, "second call provisions nobody");
      assert.deepEqual(second.channels, first.channels, "channel map is stable");
      assert.deepEqual(readChannels(gameRef), first.channels, "index readable server-side");

      const scopeIDs = Object.values(first.channels);
      assert.equal(new Set(scopeIDs).size, N, "every player got a distinct channel");

      // The property that matters: participant i sees its own channel id on the
      // wire, and no other participant's.
      for (const [i, p] of participants.entries()) {
        const playerID = (p as any).mode.player.getValue().id as string;
        const mine = first.channels[playerID]!;
        const theirs = scopeIDs.filter((id) => id !== mine);

        const wire = wires[i]!.join("\n");
        assert.ok(wire.includes(mine), `participant ${i} received its own channel ${mine}`);
        for (const other of theirs) {
          assert.ok(
            !wire.includes(other),
            `participant ${i} must not see channel ${other}`
          );
        }
      }
    }
  );
});

test("the channel index is never exposed on the game scope", async () => {
  // Companion to the unit-level regression test, against a real backend: no
  // participant may learn another participant's channel id.
  let result: ProvisionResult | undefined;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "tick", async (ctx: any, { game }: any) => {
      if (game.get("tick") !== "provision" || result) return;
      result = await provisionChannels(ctx, game);
    });
  };

  await withScenario(
    { n: 2, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaClassic as any },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(2, 1));
      await batch.running();
      await waitFor(() => participants.every((p: any) => p.mode.player.getValue()?.get("gameID")), { label: "gameID" });
      for (const p of participants as any[]) p.mode.player.getValue().set("introDone", true);
      await waitFor(() => participants.every((p: any) => Boolean(p.mode.game.getValue())), { label: "game" });

      const wires = participants.map(recordWire);
      const gameID = (participants[0] as any).mode.player.getValue().get("gameID") as string;
      await admin.taj.setAttribute({ key: "tick", val: JSON.stringify("provision"), nodeID: gameID });
      await waitFor(() => Boolean(result), { label: "provisioned" });
      await new Promise((r) => setTimeout(r, 1500));

      for (const [i, p] of participants.entries()) {
        const playerID = (p as any).mode.player.getValue().id as string;
        const others = Object.entries(result!.channels)
          .filter(([pid]) => pid !== playerID)
          .map(([, scopeID]) => scopeID);
        const wire = wires[i]!.join("\n");
        for (const other of others) {
          assert.ok(!wire.includes(other), `participant ${i} must not learn channel ${other}`);
        }
      }
    }
  );
});
