/**
 * The publisher: are views LIVE?
 *
 * Until now `publishAll` ran only at game start, so a projection was a snapshot.
 * That is the difference between a demo and a usable tool — a network experiment
 * where neighbours never update cannot run.
 *
 * The assertions here are deliberately about the participant's own view of the
 * world, read through the client mode, rather than about server-side
 * bookkeeping. Server state can be perfectly consistent while nothing reaches
 * anybody.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mockLogging, stopMockLogging } from "@empirica/core/console";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  connectParticipant,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

async function startGame(participants: { mode: unknown }[]): Promise<void> {
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
    label: "game visible",
  });
}

/** Neighbour views as {id: choice}, for readable assertions. */
function viewOf(p: { mode: unknown }): Record<string, unknown> {
  const neighbors = (modeOf(p).nbhd.getValue()?.neighbors ?? []) as {
    id: string;
    choice: unknown;
  }[];
  return Object.fromEntries(neighbors.map((n) => [n.id, n.choice]));
}

test("a watched attribute change reaches neighbours", async () => {
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
      watch: ["choice"],
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);

      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      // Nobody has chosen yet.
      for (const p of participants) {
        assert.ok(
          Object.values(viewOf(p)).every((v) => v === undefined),
          "no choices before anyone sets one"
        );
      }

      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;
      modeOf(actor).player.getValue()!.set("choice", "CHOSE-X");

      // Someone must SEE it — this is the whole point of the task.
      await waitFor(
        () => participants.some((p) => viewOf(p)[actorID] === "CHOSE-X"),
        { label: "the change propagated to a neighbour", timeoutMs: 30_000 }
      );

      // And exactly the right people see it: on a ring of 4 the actor has 2
      // neighbours and 1 non-neighbour. A publisher that broadcasts would pass
      // the assertion above and fail this one.
      let sawIt = 0;
      for (const p of participants) {
        const id = modeOf(p).player.getValue()!.id;
        if (id === actorID) continue;
        if (viewOf(p)[actorID] === "CHOSE-X") sawIt++;
        else assert.ok(!(actorID in viewOf(p)), "a non-neighbour must not see the actor at all");
      }
      assert.equal(sawIt, 2, "exactly the two ring neighbours received the update");
    }
  );
});

test("an UNWATCHED attribute is reported rather than silently going stale", async () => {
  // The failure this guards against: forget a key, neighbours never see it
  // change, the run completes and the data is quietly wrong.
  //
  // Captured through Empirica's own logging mock rather than by stubbing
  // console.warn — its `warn` writes via console.LOG, so a console.warn stub
  // silently captures nothing and the test passes for the wrong reason.
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({
        id: neighbour.id,
        choice: neighbour.get("choice"),
        score: neighbour.get("score"), // read, but not watched
      }),
      watch: ["choice"],
    });
  };

  const mock = mockLogging();
  let warnings: string[] = [];
  try {
    await withScenario(
      { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
      async ({ admin, participants }) => {
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        await startGame(participants);
        await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
          label: "first publish",
          timeoutMs: 30_000,
        });
      }
    );
    warnings = mock.logs.map((l) => l.args.flat(2).join(" "));
  } finally {
    stopMockLogging();
  }

  const reported = warnings.filter((w) => w.includes("not in `watch`"));
  assert.ok(reported.length > 0, "the omission must be reported");
  assert.match(reported[0]!, /"score"/, "names the offending key");
  assert.match(reported[0]!, /watch: \["choice", "score"\]/, "gives the corrected list");
  assert.equal(reported.length, 1, "reported once, not once per publish");
});

test("an unchanged view is not republished", async () => {
  // A watched key changing on one player must not rewrite everyone's whole
  // neighbourhood: clients would see change events for values that did not
  // change, and egress would be O(n) per keystroke.
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
      watch: ["choice"],
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;

      // The participant that can see nobody relevant: find one that is NOT a
      // neighbour of the actor.
      const bystander = participants.find(
        (p) => modeOf(p).player.getValue()!.id !== actorID && !(actorID in viewOf(p))
      );
      assert.ok(bystander, "a ring of 4 has a non-neighbour");

      const before = modeOf(bystander!).nbhd.getValue()!.seq;
      modeOf(actor).player.getValue()!.set("choice", "CHOSE-Y");

      await waitFor(() => participants.some((p) => viewOf(p)[actorID] === "CHOSE-Y"), {
        label: "change propagated",
        timeoutMs: 30_000,
      });
      await new Promise((r) => setTimeout(r, 1000));

      assert.equal(
        modeOf(bystander!).nbhd.getValue()!.seq,
        before,
        "a participant whose view did not change received no write"
      );
    }
  );
});

test("setting the same value again publishes nothing", async () => {
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
      watch: ["choice"],
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;
      modeOf(actor).player.getValue()!.set("choice", "SAME");

      await waitFor(() => participants.some((p) => viewOf(p)[actorID] === "SAME"), {
        label: "first change propagated",
        timeoutMs: 30_000,
      });
      await new Promise((r) => setTimeout(r, 500));

      const neighbour = participants.find((p) => viewOf(p)[actorID] === "SAME")!;
      const before = modeOf(neighbour).nbhd.getValue()!.seq;

      modeOf(actor).player.getValue()!.set("choice", "SAME");
      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(
        modeOf(neighbour).nbhd.getValue()!.seq,
        before,
        "an identical view is not rewritten"
      );
    }
  );
});

test("a participant away for many publishes returns current, not stale", async () => {
  // "Long absence" in the sense that matters here: not wall-clock time, but how
  // much the world moved while they were gone. Tajriba keeps ephemeral
  // attributes in server memory and syncs CURRENT state on resubscribe, so what
  // is at risk is not the last value but the intermediate ones — a returning
  // participant must not be handed a replay, or a view assembled from a
  // half-applied sequence.
  //
  // Wall-clock length is deliberately not tested: it would mean sleeping for
  // minutes to prove nothing, and no timeout in this path is time-based.
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
      watch: ["choice"],
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      const leaver = participants[0]!;
      const neighbourIDs = Object.keys(viewOf(leaver));
      const other = participants.find((p) =>
        neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      )!;
      const otherID = modeOf(other).player.getValue()!.id;
      const ns = leaver.ns;

      leaver.stop();
      await new Promise((r) => setTimeout(r, 500));

      // Thirty publishes while they are away, each one a real change.
      for (let i = 0; i < 30; i++) {
        modeOf(other).player.getValue()!.set("choice", `v${i}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      await waitFor(
        () =>
          participants
            .filter((p) => p !== leaver)
            .some((p) => viewOf(p)[otherID] === "v29"),
        { label: "the last of the missed publishes landed", timeoutMs: 30_000 }
      );

      const returned = await connectParticipant(server, ns, EmpiricaNetwork);
      try {
        await waitFor(() => Boolean(modeOf(returned).nbhd.getValue()?.published), {
          label: "the long-absent participant received a view",
          timeoutMs: 30_000,
        });

        assert.equal(
          viewOf(returned)[otherID],
          "v29",
          "returns to the CURRENT value, not the one it left on and not a replay"
        );
        assert.deepEqual(
          Object.keys(viewOf(returned)).sort(),
          neighbourIDs.sort(),
          "and to the same neighbours"
        );

        // Still live afterwards, not a final snapshot.
        modeOf(other).player.getValue()!.set("choice", "AFTER-RETURN");
        await waitFor(() => viewOf(returned)[otherID] === "AFTER-RETURN", {
          label: "updates still flow after a long absence",
          timeoutMs: 30_000,
        });
      } finally {
        returned.stop();
      }
    }
  );
});

test("a reconnecting participant gets its view back", async () => {
  // What this actually pins down: ephemeral views SURVIVE a reconnect. Tajriba
  // replays current attribute values to a returning participant, so a reloading
  // participant is not left blank.
  //
  // Measured, not assumed — and the measurement went the other way from the
  // design. This test passes with the ParticipantConnect handler disabled, so
  // that handler is a hedge against undocumented behaviour changing rather than
  // the thing making this work. If Tajriba ever stops replaying, this test
  // keeps passing (the handler takes over) and PLATFORM-NOTES §10 goes stale —
  // which is why the handler is kept rather than deleted as dead code.
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
      watch: ["choice"],
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: "first publish",
        timeoutMs: 30_000,
      });

      // Give the returning participant something to come back to.
      //
      // The neighbour is derived from the leaver's actual view, NOT assumed to
      // be participants[1]: harness connection order does not have to match
      // position on the ring, so picking by index picks a non-neighbour roughly
      // half the time. That is what it did — this test passed alone and failed
      // in the full suite, looking exactly like a timing flake.
      const leaver = participants[0]!;
      const leaverID = modeOf(leaver).player.getValue()!.id;
      const neighbourIDs = Object.keys(viewOf(leaver));
      assert.equal(neighbourIDs.length, 2, "a ring of 4 gives the leaver two neighbours");

      const other = participants.find((p) =>
        neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      );
      assert.ok(other, "one of the leaver's neighbours is a connected participant");
      const otherID = modeOf(other!).player.getValue()!.id;
      assert.notEqual(otherID, leaverID);

      modeOf(other!).player.getValue()!.set("choice", "PERSISTED");

      await waitFor(() => viewOf(leaver)[otherID] === "PERSISTED", {
        label: "leaver saw the value before dropping",
        timeoutMs: 30_000,
      });

      const ns = leaver.ns;
      leaver.stop();
      await new Promise((r) => setTimeout(r, 1000));

      // Same ns: Tajriba treats this as the same participant returning.
      const returned = await connectParticipant(server, ns, EmpiricaNetwork);
      try {
        await waitFor(() => Boolean(modeOf(returned).nbhd.getValue()?.published), {
          label: "returning participant received a view",
          timeoutMs: 30_000,
        });

        assert.equal(
          viewOf(returned)[otherID],
          "PERSISTED",
          "the restored view carries current state, not a blank or stale one"
        );
        assert.equal(
          modeOf(returned).nbhd.getValue()!.ownerParticipantID,
          returned.id,
          "and it is still their OWN channel"
        );
      } finally {
        returned.stop();
      }
    }
  );
});
