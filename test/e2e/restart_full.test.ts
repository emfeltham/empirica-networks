/**
 * A FULL restart: the whole `empirica` process, not just the callbacks.
 *
 * `restart.test.ts` restarts the callbacks against a live Tajriba, which
 * isolates the loss of our in-memory index. Production is harsher: one process
 * holds the server and the callbacks, so a crash, deploy or `^C` takes Tajriba's
 * memory too. Scopes, links and ordinary attributes come back from the store —
 * but views are written `ephemeral`, so THEY DO NOT. Recovery has to republish
 * into an empty store rather than find its own writes still there.
 *
 * That distinction is exactly what the callbacks-only test cannot see, and it is
 * the difference between "recovery works" and "recovery looked like it worked
 * because nothing had actually been lost".
 *
 * Deliberately not built on `withScenario`, which owns the server lifecycle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  connectAdmin,
  connectParticipant,
  createBatch,
  gameInit,
  startCallbacks,
  uniqueNS,
  waitFor,
} from "../../src/verify/harness.js";
import { freePort, startServer, type Server } from "../../src/verify/server.js";

const N = 4;

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

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

test("a full server restart recovers the same network, and republishes lost views", async () => {
  resetChannels();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empirica-networks-restart-"));
  const storeFile = path.join(dir, "tajriba.json");
  const port = await freePort();

  let server: Server | undefined;
  let callbacks: { stop: () => Promise<void> } | undefined;
  let admin: { stop: () => void } | undefined;
  let participants: Awaited<ReturnType<typeof connectParticipant>>[] = [];

  const stopParticipants = () => {
    for (const p of participants) {
      try {
        p.stop();
      } catch {
        /* best effort */
      }
    }
    participants = [];
  };

  try {
    // ---- first boot ---------------------------------------------------
    server = await startServer({ storeFile, port, logLevel: "error" });
    admin = await connectAdmin(server);
    callbacks = await startCallbacks(server, networkKinds, makeListeners());

    const namespaces = Array.from({ length: N }, () => uniqueNS());
    for (const ns of namespaces) {
      participants.push(await connectParticipant(server, ns, EmpiricaNetwork));
    }

    const batch = await createBatch(admin as any, batchConfig(N, 1));
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

    // ---- the restart ---------------------------------------------------
    stopParticipants();
    await callbacks.stop();
    callbacks = undefined;
    admin.stop();
    admin = undefined;
    server.stop();
    server = undefined;

    // A new process knows nothing. Everything that comes back has to come back
    // from the store or from the channels themselves.
    resetChannels();

    server = await startServer({ storeFile, port, logLevel: "error" });
    admin = await connectAdmin(server);
    callbacks = await startCallbacks(server, networkKinds, makeListeners());

    // Same namespaces: this is the same four people reopening their browsers.
    for (const ns of namespaces) {
      participants.push(await connectParticipant(server, ns, EmpiricaNetwork));
    }

    // ---- what has to be true -------------------------------------------
    await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
      label: "every participant has a view again after a full restart",
      timeoutMs: 30_000,
    });

    // Precondition, asserted rather than assumed: this must be the SAME game
    // reloaded from the store. If Tajriba had come up empty, Classic would have
    // built a fresh batch with new player ids and everything below would be
    // comparing a new run against itself — passing while testing nothing.
    assert.deepEqual(
      participants.map((p) => modeOf(p).player.getValue()!.id).sort(),
      [...seatingBefore.keys()].sort(),
      "the store really did persist: same players, not a fresh batch"
    );

    for (const p of participants) {
      const playerID = modeOf(p).player.getValue()!.id;
      assert.equal(
        Object.keys(viewOf(p)).sort().join(","),
        seatingBefore.get(playerID),
        `participant ${playerID} kept the same neighbours across a full restart`
      );
      assert.equal(
        modeOf(p).nbhd.getValue()!.id,
        channelsBefore.get(playerID),
        `participant ${playerID} still has exactly one channel, the original`
      );
    }

    // Views are ephemeral, so the ones from before are genuinely gone. Having a
    // view at all therefore proves recovery REPUBLISHED rather than that the old
    // value happened to survive — which is the whole point of doing this at the
    // process level.
    const actor = participants[0]!;
    const actorID = modeOf(actor).player.getValue()!.id;
    const watcher = participants.find((p) =>
      Object.keys(viewOf(actor)).includes(modeOf(p).player.getValue()!.id)
    )!;
    assert.ok(watcher, "the actor still has a reachable neighbour");

    modeOf(actor).player.getValue()!.set("choice", "AFTER-FULL-RESTART");
    await waitFor(() => viewOf(watcher)[actorID] === "AFTER-FULL-RESTART", {
      label: "live updates work again after a full restart",
      timeoutMs: 30_000,
    });
  } finally {
    stopParticipants();
    try {
      await callbacks?.stop();
    } catch {
      /* best effort */
    }
    try {
      admin?.stop();
    } catch {
      /* best effort */
    }
    server?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
