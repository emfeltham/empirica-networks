/**
 * Envelope and projection guards, against a real server.
 *
 * The unit tests prove the checkers are correct in isolation. What they cannot
 * prove is that they are actually WIRED IN — that `checkDegrees` runs before
 * provisioning and that `validateProjection` sees a genuine admin `Player`
 * rather than the hand-built object a unit test hands it.
 *
 * That second point is the one that matters most: scope detection is
 * structural, so it must be confirmed against the real class. A duck-type that
 * happens not to match the actual `Player` would pass every unit test and let
 * the leak through in production.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { validateProjection } from "../../src/admin/projection.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { complete, ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

/**
 * Get every participant into a running game.
 *
 * `introDone` is not optional: Classic holds the game at the intro step until
 * every player sets it, so without this the game never starts and `withNetwork`
 * never fires — which reads exactly like a broken feature.
 */
async function startGame(participants: { mode: unknown }[]): Promise<void> {
  const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
    label: "game visible",
  });
}

test("a REAL admin Player is detected as a scope and refused", async () => {
  // The load-bearing test for src/admin/projection.ts. Everything else about
  // scope detection is asserted against a stand-in.
  let captured: unknown;
  let thrown: Error | undefined;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => {
        captured = neighbour;
        try {
          // Exactly what an author would write if they thought project() was a
          // filter rather than a serialiser.
          validateProjection(neighbour, "probe");
        } catch (e) {
          thrown = e as Error;
        }
        return { id: neighbour.id };
      },
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);
      await waitFor(() => captured !== undefined, { label: "project() called" });
    }
  );

  assert.ok(captured, "project() received a neighbour");
  assert.ok(
    thrown,
    "a real admin Player must be refused — if this fails, scope detection has " +
      "drifted from the actual class and the guard is decorative"
  );
  assert.match(thrown!.message, /Empirica scope/);

  // And confirm the reason the refusal matters: the object really does carry a
  // reference to the shared attribute store.
  assert.ok(
    "attributes" in (captured as Record<string, unknown>),
    "a Player holds the global attribute store, which is why publishing it leaks"
  );
});

test("an over-dense topology is refused BEFORE any channel is provisioned", async () => {
  // Ordering is the point: failing after provisioning would leave links that
  // Tajriba cannot remove.
  let started = 0;
  let projected = 0;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => {
        started++;
        return complete(playerCount); // degree n-1
      },
      project: (neighbour: any) => {
        projected++;
        return { id: neighbour.id };
      },
      envelope: { maxDegree: 2 },
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);
      await waitFor(() => started > 0, { label: "topology built" });

      // The listener threw, so nothing was published. Give the run a moment to
      // publish if it were going to, then assert absence.
      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(projected, 0, "project() must not run for a refused topology");
      for (const p of participants) {
        const nbhd = (p.mode as EmpiricaNetworkContext).nbhd.getValue();
        assert.ok(
          !nbhd?.published,
          "no participant may receive a view from an out-of-envelope game"
        );
      }
    }
  );
});

test('envelope onExceed:"warn" lets a dense topology through', async () => {
  // The escape hatch has to actually work, or people will fork the package.
  const warnings: string[] = [];
  let published = false;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => complete(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id }),
      envelope: { maxDegree: 2, onExceed: "warn" },
    });
  };

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await withScenario(
      { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
      async ({ admin, participants }) => {
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        await startGame(participants);
        await waitFor(
          () =>
            participants.every(
              (p) => (p.mode as EmpiricaNetworkContext).nbhd.getValue()?.published
            ),
          { label: "views published despite the dense topology", timeoutMs: 30_000 }
        );
        published = true;

        // n=4 complete: every participant sees the other 3.
        for (const p of participants) {
          const nbhd = (p.mode as EmpiricaNetworkContext).nbhd.getValue();
          assert.equal(nbhd!.neighbors.length, N - 1);
        }
      }
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(published, "the warn path published");
});
