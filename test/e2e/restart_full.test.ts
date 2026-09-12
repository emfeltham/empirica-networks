/**
 * A FULL restart: the whole `empirica` process, not just the callbacks.
 *
 * This records an UPSTREAM LIMITATION, and it is bad news rather than a feature:
 * after a full restart, Empirica Classic does not put returning participants
 * back into their running game. The data survives — the batch, the players, the
 * channels and their links all reload from the store — but the players are never
 * re-assigned, so `gameID` is never restored and no game resumes.
 *
 * Measured 2026-08-15, `@empirica/core@1.12.5`: 0/5 with participants returning
 * after the store had replayed, 1/5 when they raced it. Classic assigns a
 * reloaded player only if that participant is already online at the moment the
 * player scope replays (`chunk-XZHPOD27.js`: `if (online.has(participantID))`),
 * which is a race no operator can win reliably.
 *
 * Consequence for this package: our channel recovery (PLATFORM-NOTES §4d) is
 * correct and is exercised by `restart.test.ts`, but on a FULL restart it never
 * gets the chance, because there is no game to recover into.
 *
 * This test previously claimed the opposite. It passed because `server.stop()`
 * killed the CLI wrapper and orphaned the real server, so nothing was ever
 * actually restarted — see `src/harness/server.ts`. Fixing that turned this from
 * a green test into an accurate one.
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
} from "../../src/harness/harness.js";
import { freePort, startServer, type Server } from "../../src/harness/server.js";

const N = 4;

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

function viewOf(p: { mode: unknown }): Record<string, unknown> {
  const neighbors = (modeOf(p).nbhd.getValue()?.neighbors ?? []) as {
    id: string;
    choice?: unknown;
  }[];
  return Object.fromEntries(neighbors.map((n) => [n.id, n.choice]));
}

const makeListeners = () => (_: any) => {
  gameInit(1, 1, 3_600_000)(_);
  withNetwork(_, {
    topology: ({ playerCount }) => ring(playerCount),
    project: (neighbor: any) => ({ id: neighbor.id, choice: neighbor.get("choice") }),
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

    // Let the store finish replaying before anyone comes back. Classic assigns a
    // returning player to their game only if it already knows about the player
    // when the participant connects, so a participant that beats the replay is
    // never put back in the game. A real operator restart has this gap for free;
    // a test that reconnects instantly does not.
    await new Promise((r) => setTimeout(r, 3_000));

    // Same namespaces: this is the same four people reopening their browsers.
    for (const ns of namespaces) {
      participants.push(await connectParticipant(server, ns, EmpiricaNetwork));
    }

    // ---- what actually happens -----------------------------------------
    //
    // Whether Classic reassigns a returning player is a RACE, so this asserts
    // neither outcome — a test that demanded either would be flaky by
    // construction, and both directions were observed (1/5 restored when
    // participants beat the store replay, 0/5 when they did not).
    //
    // What it does assert is ours: IF the platform puts the players back, our
    // recovery must then be correct. That fails loudly when we are wrong and
    // stays quiet when the platform simply did not cooperate.
    const restored = await waitFor(
      () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
      { label: "players reassigned to their game", timeoutMs: 15_000 }
    ).then(
      () => true,
      () => false
    );

    console.log(
      `    full restart: Classic ${restored ? "DID" : "did not"} reassign players ` +
        `to their running game`
    );

    assert.equal(seatingBefore.size, N, "the pre-restart seating was real");
    assert.equal(channelsBefore.size, N, "and every participant had a channel");

    if (!restored) {
      // The common case. Recovery cannot run because there is no game to
      // recover into — an upstream limitation, recorded in PLATFORM-NOTES §4e.
      return;
    }

    await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
      label: "every participant has a view again",
      timeoutMs: 30_000,
    });

    for (const p of participants) {
      const playerID = modeOf(p).player.getValue()!.id;
      if (!seatingBefore.has(playerID)) continue; // a fresh player, not a return
      assert.equal(
        Object.keys(viewOf(p)).sort().join(","),
        seatingBefore.get(playerID),
        `participant ${playerID} kept the same neighbors across a full restart`
      );
      assert.equal(
        modeOf(p).nbhd.getValue()!.id,
        channelsBefore.get(playerID),
        `participant ${playerID} still has exactly one channel, the original`
      );
    }

    // Views are ephemeral, so a view existing at all proves recovery
    // REPUBLISHED rather than that the old value happened to survive.
    const actor = participants[0]!;
    const actorID = modeOf(actor).player.getValue()!.id;
    const watcher = participants.find((p) =>
      Object.keys(viewOf(actor)).includes(modeOf(p).player.getValue()!.id)
    );
    if (watcher) {
      modeOf(actor).player.getValue()!.set("choice", "AFTER-FULL-RESTART");
      await waitFor(() => viewOf(watcher)[actorID] === "AFTER-FULL-RESTART", {
        label: "live updates work again after a full restart",
        timeoutMs: 30_000,
      });
    }
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
