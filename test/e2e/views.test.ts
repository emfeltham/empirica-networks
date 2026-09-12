/**
 * View capture, against a real server.
 *
 * The unit tests prove the conversion; this proves the thing that cannot be
 * unit tested — that a record describes what a participant ACTUALLY received.
 * A capture log that quietly diverged from the wire would be worse than none,
 * because it would be trusted during analysis, months later, with nothing left
 * to check it against.
 *
 * So the assertions compare records against the client's own resolved view, not
 * against what the server intended to send.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { viewRows } from "../../src/admin/export.js";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import type { ViewRecord } from "../../src/shared/keys.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type AdminHandle,
} from "../../src/harness/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const seenBy = (p: { mode: unknown }) =>
  (modeOf(p).nbhd.getValue()?.neighbors ?? []) as { id: string; choice?: unknown }[];

/**
 * `ping` is watched but never read by `project()`.
 *
 * That is the only way to provoke a republish whose views are all unchanged:
 * setting `choice` to the value it already holds may not dispatch at all, and a
 * test that passes because nothing happened proves nothing.
 */
function makeListeners(views: { onView?: (r: ViewRecord) => void; file?: string; batch?: number }) {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }: any) => ring(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id, choice: neighbor.get("choice") }),
      watch: ["choice", "ping"],
      views,
    });
  };
}

async function running(admin: AdminHandle, participants: { mode: unknown }[]): Promise<void> {
  const batch = await createBatch(admin, batchConfig(N, 1));
  await batch.running();
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

test("a record matches what the participant's own client resolved", async () => {
  const records: ViewRecord[] = [];
  await withScenario(
    {
      n: N,
      kinds: networkKinds,
      listeners: makeListeners({ onView: (r) => records.push(r) }),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      await running(admin, participants);

      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;
      const watcher = participants.find((p) => seenBy(p).some((v) => v.id === actorID))!;
      const watcherID = modeOf(watcher).player.getValue()!.id;

      modeOf(actor).player.getValue()!.set("choice", "cooperate");
      await waitFor(
        () => seenBy(watcher).some((v) => v.id === actorID && v.choice === "cooperate"),
        { label: "the change reached a neighbor", timeoutMs: 30_000 }
      );
      // Let any straggling publish land, so "the last record" really is the last.
      await new Promise((r) => setTimeout(r, 1_000));

      const mine = records.filter((r) => r.viewer === watcherID);
      assert.ok(mine.length > 0, "the viewer was recorded at all");

      // Compared through JSON, which is the comparison that means something: a
      // projected `undefined` (an attribute nobody has set yet, normal in round
      // one) exists on the server object and does not cross the wire. The
      // recorded value is what the file will hold, so that is what must match.
      const onTheWire = JSON.parse(JSON.stringify(mine[mine.length - 1]!.view));
      assert.deepEqual(
        onTheWire,
        seenBy(watcher),
        "the recorded view is what the client resolved, field for field"
      );

      // Non-vacuity: without this, two empty things agreeing would pass.
      assert.ok(
        JSON.stringify(records).includes("cooperate"),
        "the captured log carries the projected value"
      );
    }
  );
});

test("a change that alters no view produces no records", async () => {
  // Capture hangs off the write loop, so a participant who is not written to is
  // not recorded. If it recorded intent rather than delivery, the log would
  // claim people were told things that never reached them.
  //
  // What this test does NOT establish: that the publisher actually ran for
  // `ping`. If Empirica dispatched nothing, the assertion below would pass for
  // the wrong reason. The byte-identical skip itself is proven separately, in
  // publisher.test.ts ("an unchanged view is not republished"); this is a check
  // on capture following delivery, and is stated at that strength rather than
  // dressed up as a test of the skip.
  const records: ViewRecord[] = [];
  await withScenario(
    {
      n: N,
      kinds: networkKinds,
      listeners: makeListeners({ onView: (r) => records.push(r) }),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      await running(admin, participants);
      await waitFor(() => records.length >= N, { label: "everyone recorded once" });
      await new Promise((r) => setTimeout(r, 1_000));

      // `ping` is watched, so this really does run the publisher; `project()`
      // never reads it, so every view it computes is identical to the last.
      const before = records.length;
      modeOf(participants[0]!).player.getValue()!.set("ping", 1);
      await new Promise((r) => setTimeout(r, 2_000));
      assert.equal(records.length, before, "a republish that changes nothing records nothing");

      // And the detector works: a change that IS visible does produce records.
      modeOf(participants[0]!).player.getValue()!.set("choice", "defect");
      await waitFor(() => records.length > before, {
        label: "a visible change is recorded",
        timeoutMs: 30_000,
      });
    }
  );
});

test("the file sink produces NDJSON that converts to view rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views-e2e-"));
  const file = path.join(dir, "views.ndjson");
  try {
    await withScenario(
      {
        n: N,
        kinds: networkKinds,
        listeners: makeListeners({ file, batch: 1 }),
        modeFunc: EmpiricaNetwork,
      },
      async ({ admin, participants }) => {
        await running(admin, participants);
        modeOf(participants[0]!).player.getValue()!.set("choice", "cooperate");
        await waitFor(() => fs.readFileSync(file, "utf8").includes("cooperate"), {
          label: "the change reached the file",
          timeoutMs: 30_000,
        });
      }
    );

    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ViewRecord);
    assert.ok(records.length >= N, "every participant's first view is on disk");

    const rows = viewRows(records);
    // On a ring of four every viewer has exactly two neighbors, so every
    // delivery flattens to exactly two rows.
    assert.equal(rows.length, records.length * 2, "one row per neighbor per delivery");
    assert.ok(
      rows.every((r) => r.neighbor_id !== ""),
      "each row names the neighbor it describes"
    );
    assert.ok(
      rows.some((r) => r["choice"] === "cooperate"),
      "the projected value survives the round trip through NDJSON"
    );

    // The privacy claim, checked against the capture rather than against a
    // test fixture: on a ring, nobody's log ever mentions a non-neighbor.
    const viewers = new Set(rows.map((r) => r.viewer));
    for (const v of viewers) {
      const seen = new Set(rows.filter((r) => r.viewer === v).map((r) => r.neighbor_id));
      assert.equal(seen.size, 2, `${v} only ever saw two people`);
      assert.ok(!seen.has(v), "and never themselves");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
