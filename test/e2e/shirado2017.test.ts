/**
 * The Shirado 2017 reconstruction, run for real.
 *
 * Imports `examples/shirado2017/server/src/callbacks.js` UNMODIFIED against a real
 * Tajriba. `test/unit/shirado2017.test.ts` covers the design's rules; this covers
 * the wiring.
 *
 * TWO claims, and they are different in kind from the Rand port's.
 *
 * 1. A NON-NEIGHBOUR'S COLOUR NEVER ARRIVES. In most designs a locality leak makes
 *    the data wrong. Here it makes the task trivial — the dependent variable is
 *    time to solution, so a leak drives the measurement toward zero while every
 *    screen still looks correct. There is no version of this experiment that
 *    survives the leak, which is why it is asserted at the wire.
 *
 * 2. THE GLOBAL CONFLICT COUNT NEVER ARRIVES. A participant who knew whether the
 *    NETWORK was solved would know when to stop trying, and not knowing is the
 *    coordination problem being measured. The server computes it every time anyone
 *    moves; nothing may publish it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { network } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkStateOf } from "../../src/player/state.js";
import {
  batchConfig,
  createBatch,
  waitFor,
  withScenario,
  type AdminHandle,
  type Participant,
} from "../../src/verify/harness.js";
import { Empirica, net } from "../../examples/shirado2017/server/src/callbacks.js";
import {
  COLORS,
  conflictCount,
  isSolved,
  // @ts-expect-error - plain JS example module, deliberately untyped
} from "../../examples/shirado2017/server/src/design.js";

/**
 * Eight, not the paper's twenty.
 *
 * The parameters are asserted at n=20 in the unit tier. Here the requirement is
 * only that the graph be big enough to HAVE non-neighbours: Barabási–Albert with
 * m=2 at n=8 gives 13 edges out of 28 possible pairs, so every participant has
 * several non-neighbours and the leak assertions have something to be about.
 */
const N = 8;

test.beforeEach(() => resetChannels());

/** The experiment writes CSVs to `./data` at game end; see the Rand 2011 test. */
test.after(() => fs.rmSync("data", { recursive: true, force: true }));

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const stateOf = (p: { mode: unknown }) => networkStateOf(modeOf(p).nbhd.getValue());
const idOf = (p: { mode: unknown }) => modeOf(p).player.getValue()!.id;

interface NeighbourView {
  id: string;
  color?: string;
}

const neighboursOf = (p: { mode: unknown }): NeighbourView[] =>
  (modeOf(p).nbhd.getValue()?.neighbors ?? []) as NeighbourView[];

const gameOf = (p: { mode: unknown }): { id: string } => {
  const id = modeOf(p).player.getValue()?.get("gameID");
  if (typeof id !== "string") throw new Error("this participant has no game yet");
  return { id };
};

async function start(admin: AdminHandle, participants: { mode: unknown }[]): Promise<void> {
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

test("a non-neighbour's colour never arrives, and a neighbour's does", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants);

      // Subscribed AFTER assignment: these are extra wire subscriptions per
      // participant and opening them during Classic's O(n²) assignment work starves
      // it (`ISSUES.md` O8). Nothing has been coloured yet, so nothing worth seeing
      // has gone past.
      const wires = participants.map((p) => {
        const frames: string[] = [];
        (p as Participant<unknown>).wireStream().subscribe((c: unknown) => {
          frames.push(JSON.stringify(c).replace(/\\/g, ""));
        });
        return frames;
      });

      /**
       * The adjacency, snapshotted BEFORE anybody is coloured.
       *
       * Not read live afterwards, because the sentinels below END THE SESSION: they
       * are distinct per participant, so they are a proper colouring, the server
       * detects the solved state and the game is released — after which `network()`
       * throws. Cost one confusing failure to find, and it is a neat demonstration
       * that the solution detector works.
       */
      const connected = new Set<string>();
      const graph = network(gameOf(participants[0]!));
      for (const [a, b] of graph.edges()) connected.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      const isEdge = (a: string, b: string) =>
        connected.has(a < b ? `${a}|${b}` : `${b}|${a}`);
      const neighbourIDs = new Map(
        participants.map((p) => [idOf(p), graph.neighbors(idOf(p)).slice().sort()])
      );

      // Give everybody a DISTINCT marker in place of a colour. Real colours are
      // three values shared by eight people, so "I can see their colour" and "I
      // guessed" would be the same observation; a per-participant sentinel makes the
      // wire search decisive. The projection carries whatever `color` holds, so a
      // sentinel travels exactly the same path a colour does.
      const sentinels = participants.map((_, i) => `SEKRIT-colour-${i}-4f9a2b`);
      for (const [i, p] of participants.entries()) stateOf(p)!.set("color", sentinels[i]!);

      await waitFor(
        () =>
          participants.every((p) =>
            neighboursOf(p).every((nb) => nb.color !== undefined)
          ),
        { label: "every neighbour view carries a colour", timeoutMs: 30_000 }
      );
      // Let a stray delivery have its chance before concluding none came.
      await new Promise((r) => setTimeout(r, 1500));

      let leakChecks = 0;
      let neighbourChecks = 0;
      for (const [i, viewer] of participants.entries()) {
        const bytes = wires[i]!.join("");
        for (const [j, other] of participants.entries()) {
          if (i === j) continue;
          if (isEdge(idOf(viewer), idOf(other))) {
            // Non-vacuity, per pair: a neighbour's sentinel IS on this wire, so the
            // absences below are exclusion rather than a search that never matches.
            assert.ok(
              bytes.includes(sentinels[j]!),
              `a neighbour's colour is missing from participant ${i}'s wire`
            );
            neighbourChecks++;
          } else {
            assert.ok(
              !bytes.includes(sentinels[j]!),
              `LEAK: participant ${i} received non-neighbour ${j}'s colour. ` +
                `This design's dependent variable is time to solution, so this does ` +
                `not corrupt the data — it makes the task trivial.`
            );
            leakChecks++;
          }
        }
      }
      assert.ok(leakChecks > 0, "the graph is complete, so there was no leak to detect");
      assert.ok(neighbourChecks > 0, "nobody had a neighbour, so the detector is unproven");

      // And the neighbour list matches the graph exactly — not a subset of it, which
      // would be a silent under-delivery that looks like a sparse network.
      for (const p of participants) {
        const seen = neighboursOf(p).map((nb) => nb.id).sort();
        assert.deepEqual(seen, neighbourIDs.get(idOf(p)), "the view IS the neighbourhood");
      }
    }
  );
});

test("the global conflict count is computed and never published", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants);

      const wires = participants.map((p) => {
        const frames: string[] = [];
        (p as Participant<unknown>).wireStream().subscribe((c: unknown) => {
          frames.push(JSON.stringify(c).replace(/\\/g, ""));
        });
        return frames;
      });

      const gameID = gameOf(participants[0]!).id;
      const graph = network(gameOf(participants[0]!));

      // Everyone the same colour: the worst case, so the conflict count equals the
      // edge count and is as large and as findable as it can be.
      for (const p of participants) stateOf(p)!.set("color", COLORS[0]);

      await waitFor(
        () => {
          const snapshot = net.inspect(gameID);
          return Boolean(
            snapshot && snapshot.nodes.every((node) => node.state["color"] !== undefined)
          );
        },
        { label: "every colour reached the server", timeoutMs: 30_000 }
      );

      const snapshot = net.inspect(gameID)!;
      const colorAt = (i: number) => snapshot.nodes[i]?.state["color"];
      const conflicts = conflictCount(snapshot.edges, colorAt);

      // The server really does know it — otherwise the absence below proves nothing.
      assert.equal(
        conflicts,
        graph.edges().length,
        "with one colour for everyone, every edge is a conflict"
      );
      assert.ok(conflicts > 1, `only ${conflicts} conflicts, which is too few to search for`);
      assert.equal(
        isSolved(snapshot.n, snapshot.edges, colorAt),
        false,
        "one colour for everyone is not a solution"
      );

      await new Promise((r) => setTimeout(r, 1500));

      // Nothing carrying it may reach a participant, in any shape: as an attribute
      // of its own, or as a field inside one.
      for (const [i, frames] of wires.entries()) {
        const bytes = frames.join("");
        for (const needle of [
          '"key":"conflicts"',
          '"conflicts":',
          '"conflictsAfter":',
          '"key":"solution"',
        ]) {
          assert.ok(
            !bytes.includes(needle),
            `LEAK: participant ${i}'s wire carries ${needle} — the global cost ` +
              `function. Knowing it tells a participant when to stop trying, which ` +
              `is the coordination problem this design measures.`
          );
        }
      }

      // Non-vacuity: this participant's wire is a live stream carrying real
      // attribute keys, so the absences above are exclusion and not an empty buffer.
      assert.ok(
        wires[0]!.join("").includes('"key":"state:color"'),
        "the wire carries no attribute keys at all, so the search above is blind"
      );
    }
  );
});

test("a proper colouring ends the session, and an improper one does not", async () => {
  // The end condition, which is also the dependent variable. Two failure modes, and
  // the first is worse: a detector that fires early records a time to solution for a
  // problem nobody solved. A detector that never fires just wastes five minutes.
  await withScenario(
    { n: N, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await start(admin, participants);

      const gameID = gameOf(participants[0]!).id;
      const graph = network(gameOf(participants[0]!));
      const snapshot = net.inspect(gameID)!;
      const order = snapshot.order;

      const stageEnded = () =>
        participants.some((p) => {
          const stage = modeOf(p).stage.getValue();
          return !stage || Boolean(modeOf(p).player.getValue()?.get("exitStatus"));
        });

      // Step 1: everyone the same colour. Not a solution, and the session must NOT
      // end. Asserted before the solving step, because a detector that fires on any
      // change would otherwise be indistinguishable from a correct one.
      for (const p of participants) stateOf(p)!.set("color", COLORS[0]);
      await waitFor(
        () => {
          const s = net.inspect(gameID);
          return Boolean(s && s.nodes.every((node) => node.state["color"] !== undefined));
        },
        { label: "every colour reached the server", timeoutMs: 30_000 }
      );
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(stageEnded(), false, "an improper colouring must not end the session");

      /**
       * Step 2: colour it properly, in DEGENERACY order.
       *
       * Three colours suffice because Barabási–Albert with m=2 is 2-degenerate —
       * every node arrived with exactly two edges to already-present nodes — but
       * that guarantee only holds if vertices are coloured in an order where each
       * has at most two already-coloured neighbours. Greedy in topology-index order
       * does NOT give that, and this test failed on exactly that mistake ("no colour
       * available for node 6"): the package's index is a seat assignment, not the
       * construction order.
       *
       * So: repeatedly remove a lowest-degree vertex, then colour in reverse removal
       * order. Each vertex then has at most two coloured neighbours when its turn
       * comes, and three colours are always enough.
       */
      const adj = new Map<number, Set<number>>();
      for (let i = 0; i < order.length; i++) adj.set(i, new Set());
      for (const [a, b] of snapshot.edges) {
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
      }
      const removalOrder: number[] = [];
      const remaining = new Map([...adj].map(([k, v]) => [k, new Set(v)]));
      while (remaining.size > 0) {
        let pickIdx = -1;
        let best = Infinity;
        for (const [v, nbrs] of remaining) {
          if (nbrs.size < best) {
            best = nbrs.size;
            pickIdx = v;
          }
        }
        assert.ok(
          best <= 2,
          `minimum degree ${best} in the remaining graph: not 2-degenerate, so three ` +
            `colours are not guaranteed`
        );
        removalOrder.push(pickIdx);
        for (const nbr of remaining.get(pickIdx)!) remaining.get(nbr)?.delete(pickIdx);
        remaining.delete(pickIdx);
      }

      const colorByIndex = new Array<string>(order.length);
      for (const v of [...removalOrder].reverse()) {
        const taken = new Set([...adj.get(v)!].map((u) => colorByIndex[u]).filter(Boolean));
        const pick = COLORS.find((c: string) => !taken.has(c));
        assert.ok(pick, `no colour available for node ${v}; the graph needs more than 3`);
        colorByIndex[v] = pick;
      }

      // Sanity-check the colouring BEFORE asking the server to agree with it. If it
      // were improper, a session that failed to end would look like a broken
      // detector when the fault was in this test.
      const properLocally = snapshot.edges.every(
        ([a, b]) => colorByIndex[a] !== colorByIndex[b]
      );
      assert.ok(properLocally, "the greedy colouring this test computed is proper");

      const byID = new Map(participants.map((p) => [idOf(p), p]));
      for (const [i, playerID] of order.entries()) {
        stateOf(byID.get(playerID)!)!.set("color", colorByIndex[i]!);
      }

      await waitFor(() => stageEnded(), {
        label: "the session ended once the network was properly coloured",
        timeoutMs: 60_000,
      });
    }
  );
});
