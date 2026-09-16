/**
 * Whole-network vision, and what it costs.
 *
 * Its OWN FILE rather than another case in `subgraph.test.ts`, and that is not
 * organisation. Added there, it roughly doubled that file's runtime and took a
 * neighbouring test from 0 failures in 8 runs to 3 in 18 — a clean 20-second
 * timeout on a value that should arrive in milliseconds. `docs/TESTING.md`
 * documents the mechanism ("the rate of intermittent failure tracks the weight
 * of the whole run") and the diagnosis was the experiment it implies: removing
 * this test while leaving the code it exercises in place returned that file to
 * 0 in 10, so the weight was the cause and the feature was not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import {
  EmpiricaNetwork,
  type EmpiricaNetworkContext,
} from "../../src/player/mode.js";
import { networkGraphOf } from "../../src/player/view.js";
import { fromEdgeList } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/harness/harness.js";

const N = 5;

/** The fixture `subgraph.test.ts` uses: a hub with a triangle under it, plus an isolate. */
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
];

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

function makeListeners() {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: () => fromEdgeList(N, EDGES),
      project: (neighbor: any) => ({ id: neighbor.id }),
      graph: { radius: "whole" },
    });
  };
}

async function play(participants: { mode: unknown }[]): Promise<void> {
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

/**
 * Whole-network vision.
 *
 * The widest setting, and the one whose cost is not in bytes. Every viewer's
 * ball is the same graph, so a naive implementation lays the same picture out
 * once per participant — measured on this machine at 4.9 ms each, or 245 ms of
 * one event loop for a single republish at n=50.
 *
 * The observable consequence of sharing is exact and worth asserting rather than
 * timing: if the layout is computed once, every viewer's drawing places a given
 * PERSON at the same coordinates, because `fitToBox` is a function of the node
 * set and every viewer has the same one. Laid out per viewer they would differ,
 * since each viewer numbers the graph from themselves and the force layout runs
 * over that numbering.
 */
test('radius "whole": everybody sees everybody, drawn once', async () => {
  await withScenario(
    {
      n: N,
      kinds: networkKinds,
      listeners: makeListeners(),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await play(participants);

      /** Where this viewer's drawing puts each person, by player id. */
      const placements = new Map<string, Map<string, string>>();

      for (const p of participants) {
        const nbhd = modeOf(p).nbhd.getValue()!;
        const me = nbhd.playerID!;
        const neighbors = (nbhd.neighbors as { id: string }[]).map((x) => x.id);
        const structure = networkGraphOf(nbhd);
        if (neighbors.length === 0) {
          // An isolate at any radius is drawn alone, and that is a legitimate
          // picture rather than a missing one.
          assert.ok(!structure || (structure.far ?? []).length === 0);
          continue;
        }
        assert.ok(structure, `${me} must have been given their whole component`);
        assert.ok(structure.whole, "and the payload says that is what it is");

        const far = structure.far ?? [];
        const seen = 1 + neighbors.length + far.length;
        // Everybody they can REACH. The fixture leaves seat 4 with no ties at
        // all, so the connected four see each other and the isolate sees only
        // themselves — `"whole"` is no depth limit, not a bypass of the graph.
        assert.equal(
          seen,
          neighbors.length === 0 ? 1 : N - 1,
          `${me} sees ${seen}, which is not their whole component`
        );
        // The wire still carries a finite number: `networkGraphOf` rejects a
        // non-finite radius, and the honest finite answer is how far this
        // viewer's own component actually reached.
        assert.ok(Number.isFinite(structure.radius));

        const byPerson = new Map<string, string>();
        for (const [k, pos] of structure.positions.entries()) {
          const who = k === 0 ? me : k <= neighbors.length ? neighbors[k - 1]! : `far:${far[k - 1 - neighbors.length]!.ref}`;
          byPerson.set(who, `${pos.x},${pos.y}`);
        }
        placements.set(me, byPerson);
      }

      // Everybody agrees about where the people they can both NAME are drawn.
      // Distant people are named per viewer, so only the ids can be compared —
      // which is the naming scheme working rather than a gap in the check.
      const viewers = [...placements.keys()];
      const first = placements.get(viewers[0]!)!;
      let compared = 0;
      for (const other of viewers.slice(1)) {
        for (const [who, at] of placements.get(other)!) {
          const mine = first.get(who);
          if (mine === undefined) continue;
          compared++;
          assert.equal(
            at,
            mine,
            `${who} is drawn at ${at} for one viewer and ${mine} for another — the same ` +
              `picture was laid out twice`
          );
        }
      }
      assert.ok(compared > 0, "nothing was comparable, so this proves nothing");
    }
  );
});

