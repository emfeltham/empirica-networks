/**
 * An abrupt TCP drop — the impolite disconnect.
 *
 * `participant.stop()` closes the websocket properly, so both ends agree the
 * session ended. Dropped wifi, a closed laptop or a NAT timeout does not: the
 * socket stops mid-stream and the server finds out late, from a timeout.
 *
 * The paths differ, and the difference matters here. Views are `ephemeral` and
 * republished on ParticipantConnect, so the dangerous case is a return the
 * server does not recognise as a return — the participant would come back to a
 * blank neighbourhood, which on screen is indistinguishable from still loading.
 *
 * The drop is produced with a TCP relay (`src/harness/tcp_cut.ts`) rather than by
 * reaching into `@empirica/tajriba` for the socket, so this depends on no
 * internals.
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
  connectParticipant,
  createBatch,
  gameInit,
  uniqueNS,
  waitFor,
  withScenario,
} from "../../src/harness/harness.js";
import { tcpCut } from "../../src/harness/tcp_cut.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

function viewOf(p: { mode: unknown }): Record<string, unknown> {
  const neighbours = (modeOf(p).nbhd.getValue()?.neighbors ?? []) as {
    id: string;
    choice?: unknown;
  }[];
  return Object.fromEntries(neighbours.map((n) => [n.id, n.choice]));
}

const listeners = (_: any) => {
  gameInit(1, 1, 3_600_000)(_);
  withNetwork(_, {
    topology: ({ playerCount }) => ring(playerCount),
    project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
    watch: ["choice"],
  });
};

test("a participant whose connection is cut without a close frame comes back whole", async () => {
  // Three connect normally; the fourth goes through a relay we can sever.
  await withScenario(
    { n: N - 1, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const cut = await tcpCut(server.port);
      let dropped: Awaited<ReturnType<typeof connectParticipant>> | undefined;

      try {
        dropped = await connectParticipant(
          { url: cut.url },
          uniqueNS(),
          EmpiricaNetwork
        );
        const all = [...participants, dropped];

        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();

        await waitFor(() => all.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
          label: "gameID assigned",
        });
        for (const p of all) modeOf(p).player.getValue()!.set("introDone", true);
        await waitFor(() => all.every((p) => modeOf(p).nbhd.getValue()?.published), {
          label: "first publish",
          timeoutMs: 30_000,
        });

        const droppedID = modeOf(dropped).player.getValue()!.id;
        const neighboursBefore = Object.keys(viewOf(dropped)).sort();
        assert.equal(neighboursBefore.length, 2, "the relayed participant is on the ring");

        assert.ok(cut.live() > 0, "the relay is actually carrying the connection");

        // --- the drop ---------------------------------------------------
        // destroy(), not a close frame: the server is given no notice.
        const severed = cut.cut();
        assert.ok(severed > 0, "at least one live connection was severed");
        assert.equal(cut.live(), 0, "the participant really is disconnected, not just noisy");

        // The client's own retry brings it back through the relay, which is
        // still listening — the same shape as wifi returning.
        await waitFor(() => cut.live() > 0, {
          label: "the participant reconnected on its own",
          timeoutMs: 30_000,
        });

        await waitFor(() => Boolean(modeOf(dropped!).nbhd.getValue()?.published), {
          label: "the returning participant has a neighbourhood again",
          timeoutMs: 30_000,
        });

        assert.deepEqual(
          Object.keys(viewOf(dropped)).sort(),
          neighboursBefore,
          "and the SAME neighbours — an abrupt drop must not reseat anyone"
        );

        // A restored view that never changes again is the failure a snapshot
        // check cannot see, so drive a real update through it.
        const watcher = participants.find((p) =>
          neighboursBefore.includes(modeOf(p).player.getValue()!.id)
        )!;
        assert.ok(watcher, "one of its neighbours is a normally-connected participant");

        modeOf(watcher).player.getValue()!.set("choice", "AFTER-DROP");
        await waitFor(
          () => viewOf(dropped!)[modeOf(watcher).player.getValue()!.id] === "AFTER-DROP",
          { label: "updates flow to the reconnected participant", timeoutMs: 30_000 }
        );

        // And the reverse direction: what it writes must still reach others.
        modeOf(dropped).player.getValue()!.set("choice", "FROM-DROPPED");
        await waitFor(() => viewOf(watcher)[droppedID] === "FROM-DROPPED", {
          label: "and its own changes still reach its neighbours",
          timeoutMs: 30_000,
        });
      } finally {
        try {
          dropped?.stop();
        } catch {
          /* best effort */
        }
        cut.stop();
      }
    }
  );
});
