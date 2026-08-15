/**
 * What survives a callbacks restart?
 *
 * `withNetwork` keeps three things in server memory: the channel index
 * (`provision.ts`, deliberately — PLATFORM-NOTES §4b), the per-game network
 * state, and the materialised channel scopes. A production `empirica` process
 * holds the server and the callbacks together, so any restart, crash or deploy
 * mid-study drops all three while the study is running.
 *
 * `provision.ts` already records this as a known gap. This measures what the gap
 * actually IS, which is not obvious: views are written `ephemeral`, so they sit
 * in Tajriba's memory rather than in the callbacks' — a restart may leave every
 * participant's view intact and merely stop it ever updating again. A frozen
 * network looks exactly like a quiet one.
 *
 * Restarting the callbacks against a still-running Tajriba is the sharper half
 * of the scenario: scopes and links survive, only our in-memory maps are lost.
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
  startCallbacks,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

/** playerID -> choice, as this participant currently sees it. */
function viewOf(p: { mode: unknown }): Record<string, unknown> {
  const neighbours = (modeOf(p).nbhd.getValue()?.neighbors ?? []) as {
    id: string;
    choice?: unknown;
  }[];
  return Object.fromEntries(neighbours.map((n) => [n.id, n.choice]));
}

const makeListeners = () => (_: any) => {
  gameInit(1, 1, 3_600_000)(_);
  withNetwork(_, {
    topology: ({ playerCount }) => ring(playerCount),
    project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
    watch: ["choice"],
  });
};

test("the network keeps updating after the callbacks process restarts", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners(), modeFunc: EmpiricaNetwork },
    async ({ server, admin, callbacks, participants }) => {
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

      // Pick an actor and one of its REAL neighbours — ring position does not
      // follow harness connection order, so choosing by index picks a
      // non-neighbour about half the time.
      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;
      const neighbourIDs = Object.keys(viewOf(actor));
      assert.equal(neighbourIDs.length, 2, "a ring of 4 gives the actor two neighbours");
      const watcher = participants.find((p) =>
        neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      )!;
      assert.ok(watcher, "one of the actor's neighbours is connected");

      modeOf(actor).player.getValue()!.set("choice", "BEFORE");
      await waitFor(() => viewOf(watcher)[actorID] === "BEFORE", {
        label: "the pre-restart value propagated",
        timeoutMs: 30_000,
      });

      // Snapshot the whole seating plan, not just the actor's: a restart that
      // preserved one participant's neighbours while moving everyone else would
      // otherwise pass.
      const seatingBefore = new Map(
        participants.map((p) => [
          modeOf(p).player.getValue()!.id,
          Object.keys(viewOf(p)).sort().join(","),
        ])
      );
      const channelsBefore = new Map(
        participants.map((p) => [
          modeOf(p).player.getValue()!.id,
          modeOf(p).nbhd.getValue()!.id,
        ])
      );

      // --- the restart ---------------------------------------------------
      // Everything withNetwork holds in memory is dropped here. Tajriba keeps
      // running, so scopes, links and ephemeral attributes all survive.
      await callbacks.stop();
      // `makeListeners()` builds a fresh withNetwork closure, so its per-game
      // maps start empty on their own. The channel index does NOT: it lives at
      // module scope in provision.ts and would survive here, because this
      // "restart" shares one Node process. A real restart is a new process, so
      // dropping it explicitly is what makes this test faithful rather than
      // accidentally easier than production.
      resetChannels();
      const restarted = await startCallbacks(server, networkKinds, makeListeners());

      try {
        // A view that merely persists is not enough: it would persist just as
        // well if publishing were dead. The test is whether a NEW change still
        // reaches the people who can see it.
        modeOf(actor).player.getValue()!.set("choice", "AFTER");

        await waitFor(() => viewOf(watcher)[actorID] === "AFTER", {
          label: "a change made after the restart still reaches neighbours",
          timeoutMs: 30_000,
        });

        // The topology has to be the SAME one, not a fresh realisation. The seed
        // is stable, so the graph SHAPE always survives; what did not survive
        // was the assignment of people to nodes, rebuilt from `game.players`
        // order. Everyone stayed on a ring and simply had different neighbours
        // for the rest of the study, with nothing logged.
        for (const p of participants) {
          const playerID = modeOf(p).player.getValue()!.id;
          assert.equal(
            Object.keys(viewOf(p)).sort().join(","),
            seatingBefore.get(playerID),
            `participant ${playerID} kept the same neighbours across the restart`
          );
        }

        // And no participant acquired a second channel. Tajriba cannot unlink,
        // so a duplicate is permanent: the client keeps reading the channel it
        // first selected while the server writes the new one, and the view
        // freezes with nothing reporting it.
        for (const p of participants) {
          const playerID = modeOf(p).player.getValue()!.id;
          assert.equal(
            modeOf(p).nbhd.getValue()!.id,
            channelsBefore.get(playerID),
            `participant ${playerID} still has exactly one channel, the original`
          );
        }
      } finally {
        await restarted.stop();
      }
    }
  );
});
