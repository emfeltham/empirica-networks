/**
 * Reproducibility: can the realised network be rebuilt from stored data?
 *
 * For a network experiment the graph participants were actually placed in is
 * often the independent variable. Breadboard generated it with an unseeded RNG,
 * so a finished run recorded the generator and its parameters but not the graph
 * — an analysis gap, not a nicety.
 *
 * The claim here is stronger than "the generators are deterministic" (that is
 * `test/unit/topology.test.ts`). It is that the seed written to the game scope,
 * read back from storage, regenerates the network that participants were
 * ACTUALLY given. Three things have to agree: the recorded seed, the recorded
 * edge list, and the neighbourhoods that reached the clients. Any one of them
 * drifting makes the stored data misdescribe the run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { makeRng } from "../../src/admin/seed.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { adjacency, ring, type Edge } from "../../src/topology/index.js";
import { GAME_KEYS } from "../../src/shared/keys.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const N = 6;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

function canonical(edges: Edge[]): string {
  return edges
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(",");
}

test("the recorded seed regenerates the network participants were given", async () => {
  let gameRef: any;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    withNetwork(_, {
      // Seeded: no explicit `seed` in config, so withNetwork derives one from
      // the game id and records it. That derivation is part of what is claimed.
      topology: ({ playerCount, rng }) => ring(playerCount, { rng }),
      project: (neighbour: any) => ({ id: neighbour.id }),
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
        { label: "gameID assigned" }
      );
      for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
      await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
        label: "game visible",
      });
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "every participant received a view",
        timeoutMs: 30_000,
      });

      // --- what storage says ---
      const seed = gameRef.get(GAME_KEYS.SEED) as number;
      const recorded = (gameRef.get(GAME_KEYS.NETWORK) ?? []) as Edge[];
      assert.equal(typeof seed, "number", "a seed is recorded");
      assert.equal(recorded.length, N, "a ring of N has N edges");

      // --- rebuild from the seed alone ---
      const rebuilt = ring(N, { rng: makeRng(seed) });
      assert.equal(
        canonical(rebuilt),
        canonical(recorded),
        "the seed alone regenerates the recorded edge list"
      );

      // --- and check both against what participants actually received ---
      // This is the assertion that catches the interesting failure: the server
      // could record one graph and publish a different one, and every test that
      // only compares storage to storage would pass.
      const playerIDs: string[] = gameRef.players.map((p: any) => p.id);
      const adj = adjacency(N, rebuilt);

      for (const p of participants) {
        const playerID = modeOf(p).player.getValue()!.id;
        const idx = playerIDs.indexOf(playerID);
        assert.notEqual(idx, -1, "participant is in the game");

        const expected = new Set((adj[idx] ?? []).map((j) => playerIDs[j]!));
        const actual = new Set(
          (modeOf(p).nbhd.getValue()!.neighbors as { id: string }[]).map((n) => n.id)
        );

        assert.deepEqual(
          [...actual].sort(),
          [...expected].sort(),
          `participant ${idx}'s delivered neighbours match the graph rebuilt from the seed`
        );
      }
    }
  );
});

test("an explicit seed pins the network across separate runs", async () => {
  // Same seed, two independent servers and games: the structural realisation
  // must be identical. This is what makes a condition replicable across
  // sessions rather than only within one.
  const SEED = 123456;

  async function run(): Promise<Edge[]> {
    let gameRef: any;
    const listeners = (_: any) => {
      gameInit(1, 1, 3_600_000)(_);
      _.on("game", "start", (_ctx: any, { game }: any) => {
        if (game.get("start")) gameRef = game;
      });
      withNetwork(_, {
        seed: SEED,
        topology: ({ playerCount, rng }) => ring(playerCount, { rng }),
        project: (neighbour: any) => ({ id: neighbour.id }),
      });
    };

    let edges: Edge[] = [];
    await withScenario(
      { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
      async ({ admin, participants }) => {
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        await waitFor(
          () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
          { label: "gameID assigned" }
        );
        for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
        await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
          label: "game visible",
        });
        await waitFor(() => Boolean(gameRef?.get(GAME_KEYS.NETWORK)), {
          label: "network recorded",
          timeoutMs: 30_000,
        });
        edges = (gameRef.get(GAME_KEYS.NETWORK) ?? []) as Edge[];
      }
    );
    return edges;
  }

  resetChannels();
  const first = await run();
  resetChannels();
  const second = await run();

  assert.equal(first.length, N);
  assert.equal(
    canonical(first),
    canonical(second),
    "the same explicit seed produces the same network in a fresh game on a fresh server"
  );
});
