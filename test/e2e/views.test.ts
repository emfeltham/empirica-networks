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
import {
  edgeRows,
  parseNdjson,
  positionRows,
  structureRows,
  toCSV,
  viewRows,
} from "../../src/admin/export.js";
import { auditViews, parseEdgesCsv } from "../../src/verify/audit.js";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring, wheel, type Radius } from "../../src/topology/index.js";
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
function makeListeners(
  views: { onView?: (r: ViewRecord) => void; file?: string; batch?: number },
  opts: { radius?: Radius; topology?: (n: number) => any } = {}
) {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }: any) =>
        opts.topology ? opts.topology(playerCount) : ring(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id, choice: neighbor.get("choice") }),
      watch: ["choice", "ping"],
      graph: { radius: opts.radius ?? 1 },
      views,
    });
  };
}

async function running(
  admin: AdminHandle,
  participants: { mode: unknown }[],
  n = N
): Promise<void> {
  const batch = await createBatch(admin, batchConfig(n, 1));
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


/**
 * At radius 1.5 the record has to carry the structure too.
 *
 * Half of what a participant is delivered at that radius is the subgraph, and it
 * is the half that cannot be reconstructed from the edge log afterwards:
 * positions are warm-started, so they follow the session's history rather than
 * its final graph. A capture that recorded only `project()` output would leave
 * `views.ndjson` describing a study nobody ran — a star, in a session that drew
 * triangles.
 *
 * A WHEEL, not the ring the rest of this file uses: on a ring nobody's two
 * neighbors are tied to each other, so radius 1.5 delivers the same star and
 * this test would pass on an empty structure.
 */
test("at radius 1.5 the record carries the structure the client resolved", async () => {
  const records: ViewRecord[] = [];
  await withScenario(
    {
      n: 6,
      kinds: networkKinds,
      listeners: makeListeners(
        { onView: (r) => records.push(r) },
        { radius: 1.5, topology: (n: number) => wheel(n) }
      ),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      await running(admin, participants, 6);
      await new Promise((r) => setTimeout(r, 1_000));

      // The hub sees every rim tie, so it is the participant with something to
      // record. Picking by degree rather than by index: seating does not follow
      // connection order.
      const hub = participants
        .slice()
        .sort(
          (a, b) =>
            (modeOf(b).nbhd.getValue()?.neighbors.length ?? 0) -
            (modeOf(a).nbhd.getValue()?.neighbors.length ?? 0)
        )[0]!;
      const hubID = modeOf(hub).player.getValue()!.id;

      const mine = records.filter((r) => r.viewer === hubID);
      assert.ok(mine.length > 0, "the hub was recorded at all");
      const last = mine[mine.length - 1]!;

      assert.ok(last.graph, "a radius 1.5 delivery must record its structure");
      assert.deepEqual(
        JSON.parse(JSON.stringify(last.graph)),
        JSON.parse(JSON.stringify(modeOf(hub).nbhd.getValue()!.graph)),
        "the recorded structure is what the client resolved, field for field"
      );

      // Non-vacuity, twice over: the structure must be present AND must contain
      // the thing radius 1.5 exists to deliver. Without the second, a payload of
      // nothing but the star would pass.
      assert.ok(
        last.graph.edges.some(([a, b]) => a !== 0 && b !== 0),
        "the record must contain a tie between two of the hub's neighbors"
      );
      assert.equal(
        last.graph.positions.length,
        last.view.length + 1,
        "one position per delivered node, plus the viewer's own"
      );

      // And the flatteners agree with the record they came from.
      const ties = structureRows(mine);
      assert.equal(
        ties.length,
        mine.reduce((n, r) => n + (r.graph?.edges.length ?? 0), 0),
        "one row per delivered tie"
      );
      assert.ok(
        ties.every((t) => t.a_id !== "" && t.b_id !== ""),
        "every end resolves to a participant, because this projection carries ids"
      );
      assert.equal(
        positionRows(mine).length,
        mine.reduce((n, r) => n + (r.graph?.positions.length ?? 0), 0)
      );
    }
  );
});

/**
 * The whole path a radius 1.5 study's structure takes to a table.
 *
 * Every link in this chain was covered and the chain was not: the builders were
 * tested over hand-built records, the record was tested in memory through the
 * `onView` callback, and the only test that read from disk ran at radius 1 and
 * called `viewRows`. So `structure.csv` and `positions.csv` — two tables
 * `docs/DATA-AND-ANALYSIS.md` documents — were produced by nothing, and
 * `toCSV` had never been applied to either builder anywhere in the repository.
 *
 * `parseNdjson` rather than a hand-rolled `split("\n").map(JSON.parse)`, because
 * that is what an analyst is told to use and what the recovery scripts use.
 */
test("a radius 1.5 run reaches structure.csv and positions.csv through the file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "structure-e2e-"));
  const file = path.join(dir, "views.ndjson");
  try {
    await withScenario(
      {
        n: 6,
        kinds: networkKinds,
        listeners: makeListeners(
          { file, batch: 1 },
          { radius: 1.5, topology: (n: number) => wheel(n) }
        ),
        modeFunc: EmpiricaNetwork,
      },
      async ({ admin, participants }) => {
        await running(admin, participants, 6);
        modeOf(participants[0]!).player.getValue()!.set("choice", "cooperate");
        await waitFor(() => fs.readFileSync(file, "utf8").includes("cooperate"), {
          label: "the change reached the file",
          timeoutMs: 30_000,
        });
      }
    );

    const parsed = parseNdjson<ViewRecord>(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.dropped, 0, "the file is intact");
    assert.ok(parsed.records.length >= 6, "every participant's first view is on disk");
    assert.ok(
      parsed.records.some((r) => r.graph),
      "the structure survived the round trip through the file"
    );

    const ties = structureRows(parsed.records);
    assert.ok(ties.length > 0, "the structure flattened to rows");
    assert.ok(
      ties.some((t) => t.a_index !== 0 && t.b_index !== 0),
      "including at least one tie between two neighbors, which is the point of 1.5"
    );
    assert.ok(
      ties.every((t) => t.radius === 1.5),
      "every row says which radius produced it, without a join"
    );

    // The tables themselves. Nothing produced these before this test existed.
    const structureCsv = toCSV(structureRows(parsed.records));
    const positionsCsv = toCSV(positionRows(parsed.records));
    assert.match(
      structureCsv.split("\n")[0]!,
      /^"game_id","viewer","seq","t","radius","a_index","b_index","a_id","b_id","a_hop","b_hop"$/,
      "structure.csv leads with its canonical columns, in declaration order"
    );
    assert.match(
      positionsCsv.split("\n")[0]!,
      /^"game_id","viewer","seq","t","radius","node_index","node_id","node_hop","node_ref","x","y"$/
    );
    // Anchored at both ends on purpose, so a column added without a thought
    // about the analysts reading these files fails here rather than arriving in
    // somebody's dataset. `toCSV` derives its header from the union of the rows
    // in first-seen order, so the order is a property of the row type's
    // declaration and is worth pinning.
    assert.equal(
      structureCsv.split("\n").length,
      ties.length + 1,
      "one line per tie, plus the header"
    );

    // The join the schema documents: a structure row's non-zero index addresses
    // a view row for the same viewer and delivery.
    const views = viewRows(parsed.records);
    const sample = ties.find((t) => t.b_index !== 0)!;
    assert.ok(
      views.some(
        (v) =>
          v.viewer === sample.viewer &&
          v.seq === sample.seq &&
          v.neighbor_index === sample.b_index - 1
      ),
      "structure.csv joins to views.csv on neighbor_index = index - 1"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The audit, against a real session rather than a fixture.
 *
 * `auditViews` has only ever been exercised on hand-built records in
 * `test/unit/audit.test.ts` — which is where the arms belong, because a
 * fabricated tie has to be injected deliberately and a real run will not produce
 * one. But nothing ever checked that a CORRECT run passes it, and that gap hid a
 * real defect: the audit resolved every local index through the delivered view
 * array, so above radius 1.5 a delivery naming somebody the viewer is not
 * connected to failed its own audit. Every unit fixture agreed with the bug,
 * because every unit fixture was written against the same assumption.
 *
 * So this runs the real publish path at a real radius and requires a PASS, then
 * fabricates a tie into the captured NDJSON and requires a FAIL — the second half
 * being what stops the first from passing vacuously.
 */
test("a real radius 2 session passes its own audit, and a doctored one does not", async () => {
  const records: ViewRecord[] = [];
  let net!: NetworkHandle;
  await withScenario(
    {
      n: 6,
      kinds: networkKinds,
      listeners: (_: any) => {
        gameInit(1, 1, 3_600_000)(_);
        net = withNetwork(_, {
          // A ring: at radius 2 everybody has two people two hops away, which is
          // exactly the case the old audit could not resolve. A ring is also
          // vacuous at 1.5 and ideal at 2, which is the non-monotonicity the
          // refusal rules compute rather than list.
          topology: ({ playerCount }: any) => ring(playerCount),
          project: (neighbor: any) => ({ id: neighbor.id }),
          graph: { radius: 2 },
          views: { onView: (r: ViewRecord) => records.push(r) },
        });
      },
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      await running(admin, participants, 6);

      const gameID = modeOf(participants[0]!).player.getValue()!.get("gameID") as string;
      // `edges.csv` as an analyst would hold it. Built from the realized graph
      // rather than from a hand-written fixture, so the audit is checked against
      // the network these participants were actually seated in — which is the
      // whole point of running this at the e2e tier.
      const snap = net.inspect(gameID)!;
      const csv = toCSV(
        edgeRows(gameID, [
          {
            op: "start",
            added: snap.edges.map(
              ([i, j]) => [snap.order[i]!, snap.order[j]!] as [string, string]
            ),
            removed: [],
            size: snap.edges.length,
            at: Date.now(),
          },
        ])
      );

      const clean = auditViews({
        views: records.map((r) => JSON.stringify(r)).join("\n"),
        edges: parseEdgesCsv(csv),
      });
      assert.ok(clean.pass, `a correct session must pass:\n${clean.failures.join("\n")}`);
      assert.ok(clean.farShown > 0, "nobody was shown anybody beyond their neighbors");
      assert.ok(clean.tiesChecked > 0, "no tie was examined, so containment proved nothing");

      // Now break it, in the one way the arms above exist to catch: claim a tie
      // between two people who are each two hops from the viewer. Both ends are
      // legitimately visible at radius 2, so only the half-step rule separates
      // this from an honest delivery.
      const doctored = records.map((r) => {
        const copy = JSON.parse(JSON.stringify(r)) as ViewRecord;
        const view = (copy.view ?? []).length;
        const far = copy.graph?.far ?? [];
        if (copy.graph && far.length >= 2) {
          copy.graph.edges = [...copy.graph.edges, [1 + view, 2 + view]];
        }
        return JSON.stringify(copy);
      });
      const caught = auditViews({
        views: doctored.join("\n"),
        edges: parseEdgesCsv(csv),
      });
      assert.ok(!caught.pass, "a fabricated fringe tie must not audit clean");
      assert.ok(caught.structureLeaks > 0);
    }
  );
});
