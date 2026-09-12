/**
 * The Rand 2011 reconstruction, run for real.
 *
 * Imports `examples/rand2011/server/src/callbacks.js` UNMODIFIED against a real
 * Tajriba, so the shipped experiment is covered by this suite rather than left to
 * rot. `test/unit/rand2011.test.ts` covers the design's rules; this covers the
 * wiring, which is where a reconstruction stops being one.
 *
 * The central assertion is NOT that the experiment runs. It is that WEALTH IS NOT
 * IN THE PROJECTION. Adding one field to `project()` would silently convert this
 * into the *visible* condition of Nishi, Shirado, Rand & Christakis (2015),
 * Nature 526:426-429 — a different published experiment whose entire finding is
 * that this field changes behavior and raises inequality. The experiment would
 * still run, the screens would still look right, and the data would be answering
 * someone else's question. So the absence is asserted at the wire, where a
 * comment cannot help.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseNdjson } from "../../src/admin/export.js";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { network } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkStateOf } from "../../src/player/state.js";
import { networkToldOf } from "../../src/player/view.js";
import {
  batchConfig,
  createBatch,
  waitFor,
  withScenario,
  type AdminHandle,
  type Participant,
} from "../../src/harness/harness.js";
// The experiment's own callbacks, exactly as a user would have them.
import { Empirica, net } from "../../examples/rand2011/server/src/callbacks.js";
// ...and its rules, so expectations are derived rather than restated.
// @ts-expect-error - plain JS example module, deliberately untyped
import { COOPERATE, DEFECT, roundPayoff } from "../../examples/rand2011/server/src/design.js";

/**
 * Ten, not the paper's twenty.
 *
 * The design is asserted at the paper's parameters in the unit tier, which is
 * where `k = 0.3 x 190 = 57` is checked. This tier pays for a real server and real
 * participants per test, so it runs the smallest n at which the claims stay
 * distinguishable.
 *
 * Ten and not six, corrected after a failing run rather than reasoned in advance.
 * Six looked sufficient — 15 pairs at 20% density is about 3 edges — but the
 * initial graph is a fresh draw per game and `0.8 ** 15 = 3.5%` of draws have NO
 * edges at all, which is a session where every payoff is 0 and the arithmetic
 * assertions hold vacuously. One run in this file hit it. At n=10 there are 45
 * pairs, expected 9 edges, and an empty draw is `0.8 ** 45`, about 4 in 100,000 —
 * and the non-vacuity assertion below reports the edge count when it does fire, so
 * the next person does not have to rediscover this.
 */
const N = 10;

test.beforeEach(() => resetChannels());

/**
 * The experiment writes its CSVs to `./data` at game end, relative to wherever
 * the server was started — here, the repo root. Removed after the run so a test
 * suite does not leave analysis output lying around; `.gitignore` covers it in
 * case a run is interrupted.
 *
 * Not redirected with the experiment's own `RAND2011_OUT` override, because that
 * is read when `callbacks.js` is loaded and ESM imports are evaluated before any
 * statement in this file — so setting it here would be too late, silently.
 */
test.after(() => fs.rmSync("data", { recursive: true, force: true }));

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const stateOf = (p: { mode: unknown }) => networkStateOf(modeOf(p).nbhd.getValue());
const toldOf = (p: { mode: unknown }) => networkToldOf(modeOf(p).nbhd.getValue());
const idOf = (p: { mode: unknown }) => modeOf(p).player.getValue()!.id;

interface NeighborView {
  id: string;
  action?: string;
}

const neighborsOf = (p: { mode: unknown }): NeighborView[] =>
  (modeOf(p).nbhd.getValue()?.neighbors ?? []) as NeighborView[];

/**
 * The id of the game THIS test is running.
 *
 * From a participant, because that is the one source that is per-test. Two
 * alternatives were tried and rejected:
 *
 *   `net.activeGames()[0]` — `net` is a module-level handle shared by every test
 *   in this file and its per-game state outlives one `withScenario`, so this can
 *   be a previous test's game, or empty.
 *
 *   an extra `Empirica.onGameStart` listener here — measured 2026-08-15: it never
 *   fires. `ClassicListenersCollector.onGameStart` registers through `unique`,
 *   and a second registration for the same (kind, key) does not get its own
 *   callback. Worth recording, because "add another listener from the outside" is
 *   the obvious way to observe a collector you are importing unmodified, and it
 *   silently does nothing.
 *
 * This used to return an `{ id }` wrapper, because `network()` took an object and
 * `inspect()` took an id. Since M6 §3.1 both take either, so the id travels as
 * itself.
 */
const gameOf = (p: { mode: unknown }): string => {
  const id = modeOf(p).player.getValue()?.get("gameID");
  if (typeof id !== "string") throw new Error("this participant has no game yet");
  return id;
};

const stageName = (p: { mode: unknown }): string | undefined => {
  const name = modeOf(p).stage.getValue()?.get("name");
  return typeof name === "string" ? name : undefined;
};

async function start(
  admin: AdminHandle,
  participants: { mode: unknown }[],
  condition: string
): Promise<void> {
  const batch = await createBatch(admin, batchConfig(N, 1, [{ condition }]));
  await batch.running();
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  // What the Introduction screen does on submit.
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

/**
 * Everyone writes their choice, and we wait for the SERVER to hold all of them.
 *
 * Without the wait, `advance` can end the stage before the private writes have
 * reached the server, and `onStageEnded` scores a round in which nobody chose —
 * every participant treated as a defector, every payoff 0, and the assertions
 * below passing on 0 === 0. That is the shape of failure this repo keeps running
 * into, so it is waited for rather than slept through.
 */
async function choose(
  participants: { mode: unknown }[],
  chosen: (p: { mode: unknown }, i: number) => string
): Promise<Map<string, string>> {
  const actions = new Map<string, string>();
  for (const [i, p] of participants.entries()) {
    const action = chosen(p, i);
    actions.set(idOf(p), action);
    stateOf(p)!.set("action", action);
  }
  // Through `stateOf`, the same accessor the experiment scores with. A wait that
  // used `inspect().state` would keep polling happily if the key were undeclared
  // — `undefined` is a legitimate "not yet" — and the test would report a
  // timeout. `stateOf` throws, and `waitFor` puts the last condition error in the
  // timeout message, so a misdeclared key names itself.
  const gameID = gameOf(participants[0]!);
  await waitFor(
    () => {
      const snapshot = net.inspect(gameID);
      if (!snapshot) return false;
      return snapshot.nodes.every(
        (node) => net.stateOf(gameID, node.playerID, "action") !== undefined
      );
    },
    { label: "every choice reached the server", timeoutMs: 30_000 }
  );
  return actions;
}

/** Everyone submits the current stage, and we wait for the next one. */
async function advance(participants: { mode: unknown }[], from: string): Promise<void> {
  await waitFor(() => participants.every((p) => stageName(p) === from), {
    label: `every participant is in the "${from}" stage`,
    timeoutMs: 30_000,
  });
  for (const p of participants) modeOf(p).player.getValue()!.stage!.set("submit", true);
  await waitFor(() => participants.some((p) => stageName(p) !== from), {
    label: `the "${from}" stage ended`,
    timeoutMs: 60_000,
  });
}

test("wealth is NOT in the projection — the one field that would make this Nishi 2015", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants, "fluid");

      /**
       * Every frame each participant receives, recorded below the mode.
       *
       * Subscribed AFTER the game is assigned, and the ordering is deliberate in
       * both directions.
       *
       * Late enough: each of these is an extra wire subscription per participant
       * on top of the mode's own, and opening ten of them while Classic does its
       * O(n²) assignment work made "gameID assigned" time out on EVERY run on an
       * otherwise idle machine — the load end of `ISSUES.md` O8. Measured, not
       * guessed: four consecutive failures before this moved, none after.
       *
       * Still early enough to be valid: the value under test is `wealth`, which
       * does not exist until the round is scored below. Nothing a leak could carry
       * has been written yet, so no frame worth seeing has gone past.
       */
      const wires = participants.map((p) => {
        const frames: string[] = [];
        (p as Participant<unknown>).wireStream().subscribe((c: unknown) => {
          // Backslashes stripped, because an attribute's value crosses the wire as
          // a JSON string INSIDE a JSON frame: a told object arrives as
          // `"val":"{\\"wealth\\":300}"`, so a search for `"wealth":300` finds
          // nothing and the leak check would pass while blind. Found by the
          // non-vacuity arm below, which is why that arm is there.
          frames.push(JSON.stringify(c).replace(/\\/g, ""));
        });
        return frames;
      });

      // Everyone cooperates, so every payoff is non-zero and there is genuinely
      // something for a leak to carry. A round where all payoffs were 0 would
      // make this test pass for the wrong reason.
      await choose(participants, () => COOPERATE);
      await advance(participants, "decide");

      // The server has now scored the round and told each participant their own
      // payoff. Wait for that, so the values exist before we look for them.
      await waitFor(
        () => participants.every((p) => toldOf(p)?.get("score") !== undefined),
        { label: "every participant was told their score", timeoutMs: 30_000 }
      );

      const scores = participants.map(
        (p) => toldOf(p)!.get("score") as { payoff: number; wealth: number }
      );
      for (const s of scores) assert.equal(typeof s.payoff, "number");

      // SOME payoff must be non-zero, not every one. A participant with no
      // connections earns nothing however everyone behaves, and at 20% density a
      // node is isolated with probability 0.8 ** 9 = 13%, so about one node per
      // game — corrected after a run where the stricter version failed on a
      // perfectly healthy session.
      assert.ok(
        scores.some((s) => s.wealth !== 0),
        "every payoff was 0, so there is nothing for the leak check below to find"
      );

      /**
       * Force a republish now that wealth exists.
       *
       * Views are only rebuilt when a watched key changes, so the neighborhoods
       * currently on the clients were built BEFORE any wealth had been computed.
       * Checking their shape at that point would find no `wealth` field whether or
       * not the projection would have added one — the assertion would hold for the
       * wrong reason. Flipping one watched value rebuilds every view that can see
       * it, with wealth in existence.
       */
      const seqOf = (p: { mode: unknown }) => modeOf(p).nbhd.getValue()?.seq ?? 0;
      const maxSeq = () => Math.max(...participants.map(seqOf));
      const seqBefore = maxSeq();
      // Somebody with at least one neighbor, so the flip has somewhere to land.
      const flipper = participants.find((p) => neighborsOf(p).length > 0);
      assert.ok(flipper, "no participant has a neighbor, so no view can be rebuilt");
      stateOf(flipper)!.set("action", DEFECT);
      // The MAXIMUM across participants, not the flipper's own. A flipped action
      // changes the views of the people who can SEE the flipper; the flipper's own
      // view is unchanged, comes out byte-identical, and is suppressed (§7.1) — so
      // their `seq` never advances and waiting on it waits forever. Cost one
      // 30-second timeout to learn.
      await waitFor(() => maxSeq() > seqBefore, {
        label: "views were rebuilt after wealth existed",
        timeoutMs: 30_000,
      });

      // (1) The projection's SHAPE. Whatever a neighbor view contains, `wealth`
      // is not one of its keys — for every participant, for every neighbor.
      for (const p of participants) {
        for (const n of neighborsOf(p)) {
          assert.deepEqual(
            Object.keys(n).sort(),
            ["action", "id"],
            "project() must expose exactly id and action; a third key is a design change"
          );
        }
      }

      // (2) At the WIRE. Someone else's wealth must not be findable in the bytes
      // a participant received, whatever the shape of the object carrying it.
      // Distinct wealth values make this a real search: with all payoffs equal,
      // a participant's own score would match everyone else's and the check
      // could not distinguish own from other.
      /**
       * (3) At the WIRE, and this is the arm that actually catches the realistic
       * mistake.
       *
       * The natural way to leak wealth is not to add a projection field — it is to
       * write `player.set("wealth", …)` while scoring, because that is the obvious
       * place to keep a running total. Classic broadcasts every player scope to
       * every participant, so that one line publishes everyone's wealth to
       * everyone.
       *
       * A player attribute arrives as `"key":"wealth","val":"300"` — key and value
       * in SEPARATE fields — not as `"wealth":300`. An earlier version of this test
       * searched only for the latter, which is the shape a `tell()` object takes,
       * and it passed with `player.set("wealth", …)` added AND projected. Both
       * shapes are checked now, and the non-vacuity arm below is what proved the
       * first one was blind.
       */
      for (const [i, frames] of wires.entries()) {
        const bytes = frames.join("");
        assert.ok(
          !bytes.includes('"key":"wealth"'),
          `LEAK: participant ${i}'s wire carries a broadcast \`wealth\` attribute. ` +
            `Wealth must live on the batch scope, which participants cannot read.`
        );
      }

      // Non-vacuity for that detector: a player attribute IS visible in these
      // frames, so the absence above is exclusion rather than a search that could
      // never match. `introDone` is set by every participant in `start()`.
      let sawPlayerAttr = 0;
      for (const frames of wires) {
        if (frames.join("").includes('"key":"introDone"')) sawPlayerAttr++;
      }
      assert.ok(
        sawPlayerAttr > 0,
        "no player attribute was visible in any wire, so the key-shaped search is blind"
      );

      // And the object-shaped arm, for a leak carried inside a projection or a
      // told value rather than as its own attribute.
      let comparable = 0;
      for (const [i, own] of scores.entries()) {
        for (const [j, other] of scores.entries()) {
          if (i === j) continue;
          // Equal values are indistinguishable from a participant's own, so they
          // are skipped rather than asserted on.
          if (own.wealth === other.wealth) continue;
          comparable++;
          assert.ok(
            !wires[i]!.join("").includes(`"wealth":${other.wealth}`),
            `LEAK: participant ${i}'s wire carries participant ${j}'s wealth`
          );
        }
      }
      // Without this the loop above can be skipped entirely — every wealth equal —
      // and report success having compared nothing.
      assert.ok(comparable > 0, "no two participants had distinguishable wealth to compare");

      // Non-vacuity, the arm that makes the two absences above mean something:
      // a participant's OWN wealth IS on their own wire, so the detector works.
      let sawOwn = 0;
      for (const [i, own] of scores.entries()) {
        if (wires[i]!.join("").includes(`"wealth":${own.wealth}`)) sawOwn++;
      }
      assert.equal(
        sawOwn,
        N,
        "every participant's own wealth must be on their own wire, or this test is blind"
      );
    }
  );
});

test("a non-neighbor's ACTION never reaches a participant, and a neighbor's does", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants, "fixed");

      const graph = network(gameOf(participants[0]!));
      // Find a pair that is NOT connected. At 20% density over 15 pairs there
      // are almost always several; skip rather than assert if this draw is
      // unusually dense, since the point is not to test the generator.
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          if (!graph.hasEdge(idOf(participants[i]!), idOf(participants[j]!))) {
            pairs.push([i, j]);
          }
        }
      }
      assert.ok(pairs.length > 0, "a 20% graph over 6 nodes has unconnected pairs");
      const [a, b] = pairs[0]!;
      const pA = participants[a]!;
      const pB = participants[b]!;

      // A distinguishing pair of choices: if both chose the same thing, "I can
      // see their action" and "I guessed right" would be the same observation.
      stateOf(pA)!.set("action", COOPERATE);
      stateOf(pB)!.set("action", DEFECT);

      // Wait for the projection to carry SOMETHING, so absence is not just
      // earliness. Every connected participant should see a choice.
      await waitFor(
        () =>
          participants.some((p) => neighborsOf(p).some((n) => n.action !== undefined)),
        { label: "actions started propagating", timeoutMs: 30_000 }
      );
      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(
        neighborsOf(pA).find((n) => n.id === idOf(pB)),
        undefined,
        "an unconnected participant is absent from the neighbor list entirely"
      );

      // Non-vacuity: whoever IS connected to b can see b's defection, so the
      // absence above is exclusion rather than nothing having propagated.
      const watchers = participants.filter((p) => graph.hasEdge(idOf(p), idOf(pB)));
      if (watchers.length > 0) {
        await waitFor(
          () =>
            watchers.some((p) =>
              neighborsOf(p).some((n) => n.id === idOf(pB) && n.action === DEFECT)
            ),
          { label: "a connected participant sees the defection", timeoutMs: 30_000 }
        );
      }
    }
  );
});

test("payoffs recorded on the batch match the paper's rule applied to the realized graph", async () => {
  // The experiment's behavior is a claim, so it is asserted rather than
  // described. This recomputes every payoff independently from (a) the realized
  // edge list and (b) the actions each participant wrote, and checks the server
  // agrees — which would fail if degree, neighbor actions, or the cost/benefit
  // arithmetic were wired up wrongly.
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants, "fixed");

      const graph = network(gameOf(participants[0]!));

      // A mix, so cost and benefit both appear and neither term can be dropped
      // from the arithmetic without the expected numbers changing.
      const chosen = await choose(participants, (_p, i) => (i % 2 === 0 ? COOPERATE : DEFECT));

      const edgesBefore = graph.edges();
      await advance(participants, "decide");

      await waitFor(
        () => participants.every((p) => toldOf(p)?.get("score") !== undefined),
        { label: "the round was scored", timeoutMs: 30_000 }
      );

      // Recompute from the graph as it stood during the decision. `fixed` means
      // it did not change, which is also asserted below.
      const neighborsIn = (id: string) =>
        edgesBefore.filter(([x, y]) => x === id || y === id).map(([x, y]) => (x === id ? y : x));

      let checked = 0;
      for (const p of participants) {
        const id = idOf(p);
        const expected = roundPayoff(
          chosen.get(id),
          neighborsIn(id).map((other) => chosen.get(other) ?? DEFECT)
        );
        const told = toldOf(p)!.get("score") as { payoff: number };
        assert.equal(
          told.payoff,
          expected,
          `payoff for …${id.slice(-6)} with degree ${neighborsIn(id).length}`
        );
        checked++;
      }
      assert.equal(checked, N, "every participant's payoff was checked");

      // Non-vacuity for the arithmetic: at least one payoff must be non-zero,
      // or the whole comparison above is 0 === 0. A degree-0 graph would do that.
      const payoffs = participants.map(
        (p) => (toldOf(p)!.get("score") as { payoff: number }).payoff
      );
      assert.ok(
        payoffs.some((v) => v !== 0),
        `every payoff was 0, so this test proved nothing (edges: ${edgesBefore.length})`
      );

      assert.equal(
        graph.edges().length,
        edgesBefore.length,
        "the `fixed` condition must not rewire"
      );
      assert.deepEqual(
        graph.history().filter((e) => e.op !== "start"),
        [],
        "the `fixed` condition records no mutations at all"
      );
    }
  );
});

test("the run log is on disk WHILE the game is still running", async () => {
  /**
   * The property: an experiment that ends early still leaves usable data.
   *
   * The CSVs are written in `onGameEnded`, so a study that is killed, crashes, or
   * is stopped never reaches them — and a crash mid-study is the normal
   * shape of "something went wrong", because a restart cannot resume the game
   * anyway. Measured before this existed: a green run of this file produced ONLY
   * `views.ndjson` and not one CSV.
   *
   * So the assertion is deliberately made at a moment when the game is definitely
   * NOT over, and it reads the file off the filesystem rather than trusting a
   * counter. `test/unit/rand2011.test.ts` then pins that what the log recovers is
   * byte-identical to what a clean finish writes.
   */
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants, "fluid");
      const gameID = gameOf(participants[0]!);
      // One log for the whole study, with every record stamped with its game
      // (M6 §2.1). Before that this was `data/<gameID>/log.ndjson`, hand-rolled
      // in the example.
      const logPath = path.join("data", "run.ndjson");

      await choose(participants, () => COOPERATE);
      await advance(participants, "decide");
      await waitFor(
        () => participants.every((p) => toldOf(p)?.get("score") !== undefined),
        { label: "round 1 was scored", timeoutMs: 30_000 }
      );

      // The game is mid-session: round 1 scored, the rewiring stage in progress,
      // `onGameEnded` nowhere near having run. Confirmed rather than assumed.
      assert.equal(
        fs.existsSync(path.join("data", gameID, "rounds.csv")),
        false,
        "the CSVs must NOT exist yet, or this test is not measuring an early end"
      );

      await waitFor(() => fs.existsSync(logPath), {
        label: "the run log appeared on disk",
        timeoutMs: 30_000,
      });

      // Read back through the package's own parser, and filtered to this game —
      // the same two steps `recover.mjs` takes, so the assertions below are about
      // what an analyst would actually be holding.
      const { records: all, dropped } = parseNdjson<Record<string, any>>(
        fs.readFileSync(logPath, "utf8")
      );
      assert.equal(dropped, 0, "a running server should not be writing unparseable lines");
      const records = all.filter((r) => r["gameID"] === gameID);
      assert.ok(records.length > 0, "no records for this game, so the stamp is not landing");

      assert.ok(
        records.some((r) => r.type === "start" && r.condition === "fluid"),
        "the condition is recorded, so a recovered table knows which arm it was"
      );
      const round1 = records.find((r) => r.type === "round" && r.round === 1);
      assert.ok(round1, `no round record in the log yet: ${JSON.stringify(records.map((r) => r.type))}`);
      assert.equal(round1.rows.length, N, "every participant's row, not a subset");
      for (const row of round1.rows) {
        assert.ok(typeof row.payoff === "number", "payoffs are in the log, not just in memory");
        assert.ok(typeof row.wealth === "number");
      }
      assert.ok(
        records.some((r) => r.type === "history" && (r.events ?? []).length > 0),
        "the edge history is in the log too, so the graph is recoverable without the store"
      );
    }
  );
});

test("the fluid condition offers rewiring decisions about NON-neighbors, privately", async () => {
  // The reason `tell()` exists, asserted. "before choosing to break or form a
  // connection, the deciding subject is informed of the other's action in the
  // preceding round" — and for a FORM offer the other is not a neighbor, so
  // project() cannot deliver it.
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants, "fluid");

      await choose(participants, () => COOPERATE);
      await advance(participants, "decide");

      await waitFor(() => participants.every((p) => stageName(p) === "rewire"), {
        label: "the rewiring stage started",
        timeoutMs: 60_000,
      });
      await waitFor(
        () =>
          participants.some((p) => ((toldOf(p)?.get("offers") ?? []) as unknown[]).length > 0),
        { label: "somebody was offered a rewiring decision", timeoutMs: 30_000 }
      );

      const gameID = gameOf(participants[0]!);
      const graph = network(gameOf(participants[0]!));

      let formOffers = 0;
      let breakOffers = 0;
      for (const p of participants) {
        const offers = (toldOf(p)!.get("offers") ?? []) as Array<{
          with: string;
          exists: boolean;
          theirLastAction: string | null;
        }>;
        for (const offer of offers) {
          assert.notEqual(offer.with, idOf(p), "nobody is offered a tie to themselves");
          assert.equal(
            offer.exists,
            graph.hasEdge(idOf(p), offer.with),
            "an offer that misreports whether the tie exists asks the wrong question"
          );
          assert.equal(
            offer.theirLastAction,
            COOPERATE,
            "the offer carries the other's last action, which is what the design shows"
          );
          // The design withholds structural information: "we do not inform
          // subjects ... how many of their neighbors are connected to the player
          // they are currently evaluating."
          assert.deepEqual(
            Object.keys(offer).sort(),
            ["exists", "theirLastAction", "with"],
            "an offer must not carry degree or any other structural field"
          );
          if (offer.exists) breakOffers++;
          else formOffers++;
        }
      }

      // The load-bearing one: at least one offer must be about someone the
      // decider is NOT connected to, because that is the case `project()`
      // structurally cannot serve and therefore the case that proves `tell()` is
      // doing work here.
      assert.ok(
        formOffers > 0,
        `no form offers were made, so the non-neighbor path was never exercised ` +
          `(break offers: ${breakOffers})`
      );

      // And the offer stays with its decider. Each pair is drawn at most once per
      // round and exactly one of the two is made the decider, so if P was offered
      // a decision about S, then S must NOT have been offered one about P. If
      // both sides saw it, the "other party learns they were named" leak that
      // ruled out the provisional-tie approach would be
      // back, arriving through the API added to avoid it.
      let mirrored = 0;
      for (const p of participants) {
        const offers = (toldOf(p)!.get("offers") ?? []) as Array<{ with: string }>;
        for (const offer of offers) {
          const named = participants.find((q) => idOf(q) === offer.with);
          if (!named) continue;
          const theirs = (toldOf(named)?.get("offers") ?? []) as Array<{ with: string }>;
          if (theirs.some((o) => o.with === idOf(p))) mirrored++;
        }
      }
      assert.equal(
        mirrored,
        0,
        "an offer reached both parties: the person named in a decision learned they were named"
      );
    }
  );
});

test("a rewiring answer actually changes the graph, and is recorded in the history", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants, "fluid");

      await choose(participants, () => COOPERATE);
      await advance(participants, "decide");

      await waitFor(
        () =>
          participants.some((p) => ((toldOf(p)?.get("offers") ?? []) as unknown[]).length > 0),
        { label: "offers delivered", timeoutMs: 60_000 }
      );

      const gameID = gameOf(participants[0]!);
      const before = new Set(
        network(gameID).edges().map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`))
      );

      // Answer YES to everything, so the change is unambiguous.
      let answered = 0;
      for (const p of participants) {
        const offers = (toldOf(p)!.get("offers") ?? []) as Array<{ with: string }>;
        if (offers.length === 0) continue;
        const answers: Record<string, boolean> = {};
        for (const o of offers) answers[o.with] = true;
        stateOf(p)!.set("rewireAnswers", answers);
        answered += offers.length;
      }
      assert.ok(answered > 0, "there was something to answer");

      // The answers must reach the server BEFORE the stage ends, for the same
      // reason `choose` waits: `onStageEnded` reads them out of private state, and
      // an answer still in flight is an answer that was never given.
      const answerers = participants.filter(
        (p) => ((toldOf(p)!.get("offers") ?? []) as unknown[]).length > 0
      );
      // `stateOf`, deliberately: this is the exact read `applyRewireRound` makes,
      // and `rewireAnswers` is the key whose omission from the declaration list
      // silently emptied the answer set and left the fluid condition never
      // rewiring (`ISSUES.md` O11). Remove it from the example's `read` and this
      // wait reports the undeclared key by name instead of timing out on a graph
      // that never changed — which is the whole point of the accessor.
      await waitFor(
        () => answerers.every((p) => net.stateOf(gameID, idOf(p), "rewireAnswers") !== undefined),
        { label: "every answer reached the server", timeoutMs: 30_000 }
      );

      /**
       * Sample the graph continuously, starting BEFORE the stage ends.
       *
       * `onStageEnded("rewire")` applies the rewire AND makes the 0.8 continuation
       * draw, so one run in five the game ends in the same callback — and
       * `releaseGame` drops the in-memory history with it. A check that only looks
       * after `advance` returns is flaky by construction, and not because the
       * experiment is wrong: the stochastic session length is the design.
       *
       * So the last readable state is kept as it goes past, and the durable CSV
       * the game-end handler writes is accepted as the alternative witness. One of
       * the two always exists, and between them they cover both "the mutation
       * happened" and "an analyst can see that it happened".
       */
      let lastEdges = before;
      let mutations: Array<{ op: string }> = [];
      const sampler = setInterval(() => {
        try {
          const g = network(gameID);
          lastEdges = new Set(g.edges().map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
          const seen = g.history().filter((e) => e.op !== "start");
          if (seen.length > mutations.length) mutations = seen;
        } catch {
          // The game ended. Whatever was last read stands.
        }
      }, 10);

      /** The mutation rows in the CSV the experiment writes at game end. */
      const csvMutations = (): string[] => {
        const file = path.join("data", gameID, "edges.csv");
        if (!fs.existsSync(file)) return [];
        return fs
          .readFileSync(file, "utf8")
          .split("\n")
          .slice(1)
          .filter((line) => /"(connected|disconnected)"/.test(line));
      };

      try {
        await advance(participants, "rewire");
        await waitFor(() => mutations.length > 0 || csvMutations().length > 1, {
          label: "the rewire was applied and recorded",
          timeoutMs: 30_000,
        });
      } finally {
        clearInterval(sampler);
      }

      // Recorded: for a rewiring study the sequence IS the independent variable,
      // so a mutation the log missed is data loss rather than a detail. `edges.csv`
      // includes the initial graph, hence `> 1` rather than `> 0` there.
      const rows = csvMutations();
      assert.ok(
        mutations.length > 0 || rows.length > 1,
        `no mutation was recorded in memory or in edges.csv (${rows.length} rows)`
      );

      // Applied: if the in-memory graph was still readable, its edge set really is
      // different. Skipped when the game ended first, in which case the recorded
      // log above is the evidence.
      if (mutations.length > 0) {
        assert.ok(
          lastEdges.size !== before.size || [...lastEdges].some((k) => !before.has(k)),
          `the edge set did not change (before ${before.size}, after ${lastEdges.size})`
        );
      }

      // And the feedback the paper specifies reached somebody.
      const feedbacks = () =>
        participants.map(
          (p) =>
            toldOf(p)?.get("rewireFeedback") as
              | { broken: number; formed: number }
              | undefined
        );
      try {
        await waitFor(
          () => feedbacks().some((fb) => fb !== undefined && fb.broken + fb.formed > 0),
          { label: "somebody was told that others acted on them", timeoutMs: 10_000 }
        );
      } catch (e) {
        throw new Error(
          `feedback never arrived. answered=${answered} mutations=${mutations.length} ` +
            `csvRows=${csvMutations().length} feedbacks=${JSON.stringify(feedbacks())}`
        );
      }
    }
  );
});
