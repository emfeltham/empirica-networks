/**
 * The walking skeleton: the whole design, end to end.
 *
 * Server builds a ring, provisions a private channel per participant, projects
 * each participant's neighbour slice, and publishes. Client runs the composed
 * mode and reads its slice through `nbhd`.
 *
 * The assertion that matters is not "it works" but "participant i sees exactly
 * its neighbours" — on a ring of 4, each participant has 2 neighbours and
 * exactly 1 non-neighbour, so a projection that quietly sends everyone
 * everything cannot pass.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import { GAME_KEYS } from "../../src/shared/keys.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

test("ring of 4: each participant receives exactly its two neighbours", async () => {
  let gameRef: any;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      // Identify neighbours by a value only they carry, so we can tell exactly
      // whose slice arrived where.
      project: (neighbour: any) => ({
        id: neighbour.id,
        tag: neighbour.get("tag"),
      }),
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p) => (p.mode as EmpiricaNetworkContext).player.getValue()?.get("gameID")),
        { label: "gameID assigned" }
      );
      // Tag each player so projected slices are attributable.
      for (const [i, p] of participants.entries()) {
        const player = (p.mode as EmpiricaNetworkContext).player.getValue()!;
        player.set("tag", `tag-${i}`);
        player.set("introDone", true);
      }

      await waitFor(
        () => participants.every((p) => Boolean((p.mode as EmpiricaNetworkContext).game.getValue())),
        { label: "game visible" }
      );

      // Every participant receives a populated neighbourhood.
      await waitFor(
        () =>
          participants.every((p) => {
            const nbhd = (p.mode as EmpiricaNetworkContext).nbhd.getValue();
            return Boolean(nbhd) && nbhd!.neighbors.length > 0;
          }),
        { label: "all participants received a neighbourhood", timeoutMs: 30_000 }
      );

      const edges = (gameRef.get(GAME_KEYS.NETWORK) ?? []) as [number, number][];
      const seed = gameRef.get(GAME_KEYS.SEED);
      assert.ok(typeof seed === "number", "seed recorded on the game scope");
      assert.equal(edges.length, N, `a ring of ${N} has ${N} edges, got ${edges.length}`);

      // Rebuild expected adjacency from the RECORDED edge list, so this checks
      // the published projection against the stored network rather than against
      // a second copy of the same assumption.
      const playerIDs = gameRef.players.map((p: any) => p.id);
      const expected = new Map<string, Set<string>>(playerIDs.map((id: string) => [id, new Set<string>()]));
      for (const [a, b] of edges) {
        expected.get(playerIDs[a]!)!.add(playerIDs[b]!);
        expected.get(playerIDs[b]!)!.add(playerIDs[a]!);
      }

      for (const p of participants) {
        const mode = p.mode as EmpiricaNetworkContext;
        const playerID = mode.player.getValue()!.id;
        const nbhd = mode.nbhd.getValue()!;

        assert.equal(
          nbhd.ownerParticipantID,
          p.id,
          "participant received its OWN channel, not someone else's"
        );
        assert.ok(typeof nbhd.seq === "number", "publish counter is readable (dones wiring is live)");

        const got = new Set((nbhd.neighbors as any[]).map((v) => v.id));
        const want = expected.get(playerID)!;

        assert.equal(got.size, 2, `ring degree is 2, participant saw ${got.size}`);
        assert.deepEqual([...got].sort(), [...want].sort(), "sees exactly its own neighbours");

        // And the non-neighbour is genuinely absent.
        const nonNeighbours = playerIDs.filter((id: string) => id !== playerID && !want.has(id));
        assert.equal(nonNeighbours.length, 1, "ring of 4 leaves exactly one non-neighbour");
        for (const other of nonNeighbours) {
          assert.ok(!got.has(other), `non-neighbour ${other} must not appear`);
        }
      }
    }
  );
});

test("the recorded seed reproduces the same network", async () => {
  // Reproducibility is the reason seeding exists: a stored seed must reconstruct
  // the exact graph participants saw.
  const run = async (): Promise<{ seed: number; edges: unknown }> => {
    resetChannels();
    let gameRef: any;

    const listeners = (_: any) => {
      gameInit(1, 1, 3_600_000)(_);
      withNetwork(_, {
        seed: 4242,
        topology: ({ playerCount, rng }) => ring(playerCount, { rng }),
      });
      _.on("game", "start", (_ctx: any, { game }: any) => {
        if (game.get("start")) gameRef = game;
      });
    };

    let recorded: { seed: number; edges: unknown } | undefined;

    await withScenario(
      { n: 3, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
      async ({ admin, participants }) => {
        const batch = await createBatch(admin, batchConfig(3, 1));
        await batch.running();
        await waitFor(
          () => participants.every((p) => (p.mode as EmpiricaNetworkContext).player.getValue()?.get("gameID")),
          { label: "gameID" }
        );
        for (const p of participants) {
          (p.mode as EmpiricaNetworkContext).player.getValue()!.set("introDone", true);
        }
        // Condition-based: wait until withNetwork has actually recorded both
        // values, rather than sleeping and hoping.
        await waitFor(
          () => Boolean(gameRef) && typeof gameRef.get(GAME_KEYS.SEED) === "number" && Boolean(gameRef.get(GAME_KEYS.NETWORK)),
          { label: "network recorded on the game scope" }
        );
        recorded = {
          seed: gameRef.get(GAME_KEYS.SEED) as number,
          edges: gameRef.get(GAME_KEYS.NETWORK),
        };
      }
    );

    assert.ok(recorded, "run recorded a network");
    return recorded!;
  };

  const first = await run();
  const second = await run();

  assert.equal(first.seed, 4242);
  assert.equal(second.seed, 4242);
  assert.deepEqual(first.edges, second.edges, "same seed produced the same edge list");
});
