/**
 * Proves the harness itself works before anything is built on it.
 *
 * The bar: boot a real Tajriba, run callbacks against a kind set, connect
 * headless participants on a custom mode, drive a batch to a stage — all
 * through the public @empirica/core API only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EmpiricaClassic } from "@empirica/core/player/classic";
import {
  batchConfig,
  classicKinds,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/harness/harness.js";
import { startServer } from "../../src/harness/server.js";

test("harness boots a server, connects participants, and reaches a stage", async () => {
  const N = 2;

  await withScenario(
    {
      n: N,
      kinds: classicKinds,
      listeners: gameInit(1, 1, 3_600_000),
      modeFunc: EmpiricaClassic as any,
    },
    async ({ admin, participants }) => {
      assert.equal(participants.length, N, "all participants connected");
      for (const p of participants) {
        assert.ok(p.id, "participant has a Tajriba-assigned id");
        assert.ok(p.mode, "mode function produced a context");
      }

      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      // Players are assigned to a game.
      await waitFor(
        () => participants.every((p) => Boolean((p.mode as any).player.getValue()?.get("gameID"))),
        { label: "all participants assigned a gameID", timeoutMs: 30_000 }
      );

      // introDone is what moves a participant out of the intro and into the game.
      for (const p of participants) {
        (p.mode as any).player.getValue().set("introDone", true);
      }

      await waitFor(
        () => participants.every((p) => Boolean((p.mode as any).game.getValue())),
        { label: "game visible to all participants", timeoutMs: 30_000 }
      );
      await waitFor(
        () => participants.every((p) => Boolean((p.mode as any).stage.getValue())),
        { label: "stage visible to all participants", timeoutMs: 30_000 }
      );

      for (const p of participants) {
        assert.ok((p.mode as any).stage.getValue(), "participant reached a stage");
      }
    }
  );
});

test("waitFor rejects with TimeoutError rather than hanging", async () => {
  await assert.rejects(
    () => waitFor(() => false, { label: "never true", timeoutMs: 200 }),
    /timed out after 200ms waiting for: never true/
  );
});

test("stopping a server leaves no orphaned tajriba process", async () => {
  // The `empirica` CLI is a wrapper that execs a versioned binary as its own
  // child. Killing the wrapper orphaned the real server, which kept running and
  // holding its port; 379 of them had accumulated across one session before
  // this was noticed, and the symptom was an unrelated test timing out waiting
  // for a game to start.
  //
  // A leak here is invisible in CI (fresh runner per job) and presents locally
  // as a flake somewhere else entirely, so it needs its own assertion.
  const server = await startServer({ logLevel: "error" });
  const pid = server.proc.pid!;
  assert.ok(pid, "the server has a pid");

  const alive = () => {
    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(), "running before stop, or the check below is vacuous");

  server.stop();

  // SIGKILL is delivered asynchronously; poll rather than assume it has landed.
  const deadline = Date.now() + 10_000;
  while (alive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(alive(), false, "the server process is gone after stop()");

  // And the port it held is free again — the orphan's actual cost.
  const reuse = await startServer({ port: server.port, logLevel: "error" });
  reuse.stop();
});
