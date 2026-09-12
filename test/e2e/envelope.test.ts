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
} from "../../src/harness/harness.js";

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
      project: (neighbor: any) => {
        captured = neighbor;
        try {
          // Exactly what an author would write if they thought project() was a
          // filter rather than a serializer.
          validateProjection(neighbor, "probe");
        } catch (e) {
          thrown = e as Error;
        }
        return { id: neighbor.id };
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

  assert.ok(captured, "project() received a neighbor");
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
      project: (neighbor: any) => {
        projected++;
        return { id: neighbor.id };
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
  //
  // This asserts the PUBLISH, not the warning. It used to swap `console.warn`
  // into an array it then never looked at; that has been removed rather than
  // left as a pattern to copy, because `warn()` from `@empirica/core/console`
  // routes every level through `console.log` (measured 2026-08-16), so the
  // capture collected nothing and would have silently passed any assertion of
  // absence. `test/e2e/duplicate_listeners.test.ts` has the capture that works.
  let published = false;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => complete(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id }),
      envelope: { maxDegree: 2, onExceed: "warn" },
    });
  };

  {
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
  }

  assert.ok(published, "the warn path published");
});

test("the aggregate neighborhood limit is wired into publish, per participant", async () => {
  /**
   * The only test that proves `publish()` labels each view with its VIEWER.
   *
   * `checkNeighborhoodBytes` sums per participant, and it can only do that if
   * `publish()` threads `viewer` into the size list it hands over. That threading
   * is one word, and deleting it makes the aggregate check find nothing to group
   * by and pass — verified by doing exactly that, with every unit test staying
   * green. So the wiring gets an e2e arm.
   *
   * **Asserted through `onExceed: "warn"` rather than by waiting for a publish
   * NOT to happen.** The first version of this test threw on the breach and then
   * waited 8 seconds to confirm silence, plus a second scenario to show the same
   * views publish under a higher limit — 8.5 s and two servers to assert an
   * absence. Warning instead makes it a positive assertion: the publish happens
   * (so the scenario demonstrably works), and the message carries the exact
   * per-viewer total, which is a sharper claim about the wiring than "nothing
   * came out". 0.3 s and one server. `ISSUES.md` O8 is the reason to care.
   *
   * The limit is set low rather than the views made large, so this stays at n=4.
   * Three views of ~1 KiB each are individually far inside `maxViewBytes` and
   * together over a 2 KiB neighborhood limit — exactly the shape the limit exists
   * for: degree x view size, invisible to both a
   * per-view limit and a per-node degree limit.
   */
  const PAD = "x".repeat(1000);
  const lines: string[] = [];

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => complete(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id, pad: PAD }),
      envelope: { maxNeighborhoodBytes: 2048, onExceed: "warn" },
    });
  };

  // `console.log`, not `console.warn`: `warn()` from `@empirica/core/console`
  // routes every level through `console.log`, and a multi-line message arrives as
  // one call per line (`docs/PLATFORM-NOTES.md` §17b).
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
    originalLog(...args);
  };
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
          { label: "views published under the warn path", timeoutMs: 30_000 }
        );
      }
    );
  } finally {
    console.log = originalLog;
  }

  const text = lines.join("\n");
  assert.match(
    text,
    /would receive more than 2048 bytes in one publish/,
    "the aggregate limit never fired: publish() is not labeling views with a viewer"
  );
  // Per participant, and across all three of their neighbors — which is the part
  // that can only be true if the grouping key survived the trip.
  assert.match(text, /across 3 neighbors/);
  // Non-vacuity for the capture, and for the arm as a whole: the publish really
  // happened (the waitFor above returned), so this is the limit reporting on real
  // traffic rather than a scenario that failed to start.
  assert.ok(lines.length > 0, "nothing was logged at all, so the capture is broken");
});
