/**
 * The shipped example, run for real.
 *
 * An example that does not work is worse than no example: it is the first thing
 * a researcher copies, and a broken one costs them an afternoon before they
 * suspect the sample rather than themselves. Examples also rot quietly — they
 * are documentation, so nothing fails when the API moves underneath them.
 *
 * This imports `examples/minimal/server/src/callbacks.js` UNMODIFIED and runs
 * it against a real Tajriba, so the example is covered by the same suite as the
 * library. If a future change breaks it, this goes red.
 *
 * Scope: the server half. The client half (App.jsx, Game.jsx) cannot be
 * exercised headlessly — see docs/PLATFORM-NOTES.md §8 — but it IS compiled by
 * `npm run build` in examples/minimal/client, which catches import and JSX
 * errors, and by `npm run test:browser`, which drives it in real Chromium.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkStateOf } from "../../src/player/state.js";
import {
  batchConfig,
  createBatch,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";
// The example's own callbacks, exactly as a user would have them.
import { Empirica } from "../../examples/minimal/server/src/callbacks.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

interface NeighbourView {
  id: string;
  name?: string;
  color?: string;
}

function neighboursOf(p: { mode: unknown }): NeighbourView[] {
  return (modeOf(p).nbhd.getValue()?.neighbors ?? []) as NeighbourView[];
}

test("the example's callbacks run, and each participant sees exactly 2 of 3", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
        { label: "gameID assigned" }
      );

      // What the example's Introduction screen does on submit.
      for (const [i, p] of participants.entries()) {
        const player = modeOf(p).player.getValue()!;
        player.set("name", `player-${i}`);
        player.set("introDone", true);
      }

      await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
        label: "game visible",
      });
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "every participant received a neighbourhood",
        timeoutMs: 30_000,
      });

      for (const p of participants) {
        assert.equal(
          neighboursOf(p).length,
          2,
          "a ring of 4 gives everyone 2 neighbours and 1 non-neighbour"
        );
      }

      // The projection's shape is part of the example's contract with Game.jsx,
      // which renders n.name and n.color.
      await waitFor(
        () => participants.every((p) => neighboursOf(p).every((n) => Boolean(n.name))),
        { label: "names propagated", timeoutMs: 30_000 }
      );
      for (const p of participants) {
        for (const n of neighboursOf(p)) {
          assert.ok(n.id, "projection carries id");
          assert.match(n.name!, /^player-\d$/, "projection carries name");
          assert.equal(n.color, undefined, "nobody has chosen a colour yet");
        }
      }
    }
  );
});

test("the example's `watch` list actually keeps colours live", async () => {
  // The example declares watch: ["name", "color"]. If a future edit drops
  // "color" from that list, Game.jsx would render neighbours whose swatches
  // never update — with nothing failing anywhere.
  await withScenario(
    { n: N, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await waitFor(
        () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
        { label: "gameID assigned" }
      );
      for (const [i, p] of participants.entries()) {
        const player = modeOf(p).player.getValue()!;
        player.set("name", `player-${i}`);
        player.set("introDone", true);
      }
      await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
        label: "game visible",
      });
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;
      // Written the way the example's Game.jsx writes it: to the participant's
      // OWN channel, not the player scope. Using player.set here would leave
      // the value where the example's project() no longer looks.
      networkStateOf(modeOf(actor).nbhd.getValue())!.set("color", "violet");

      await waitFor(
        () =>
          participants.some((p) =>
            neighboursOf(p).some((n) => n.id === actorID && n.color === "violet")
          ),
        { label: "the colour reached a neighbour", timeoutMs: 30_000 }
      );

      // And only the neighbours: the non-neighbour must not have the actor at
      // all, let alone their colour.
      let saw = 0;
      for (const p of participants) {
        if (modeOf(p).player.getValue()!.id === actorID) continue;
        const entry = neighboursOf(p).find((n) => n.id === actorID);
        if (entry) {
          assert.equal(entry.color, "violet");
          saw++;
        }
      }
      assert.equal(saw, 2, "exactly the two ring neighbours, not everyone");
    }
  );
});
