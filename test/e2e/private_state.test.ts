/**
 * The private write path.
 *
 * This closes the gap the browser test exposed: `player.set()` is broadcast to
 * every participant, so projecting a player attribute restricts nothing about
 * who can read it. A value only stays inside the neighbourhood if it is never
 * written to the player scope at all.
 *
 * The assertion here is the strong one, and it is checked at the WIRE rather
 * than through the mode: a non-neighbour's private value must appear nowhere in
 * the bytes a participant received. Unlike the projection test, this is a claim
 * the example could not previously make about its own data.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { network, withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkStateOf } from "../../src/player/state.js";
import { networkToldOf } from "../../src/player/view.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/harness/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const stateOf = (p: { mode: unknown }) => networkStateOf(modeOf(p).nbhd.getValue())!;
const toldOf = (p: { mode: unknown }) => networkToldOf(modeOf(p).nbhd.getValue());

function neighbourEntries(p: { mode: unknown }): { id: string; secret?: string }[] {
  return (modeOf(p).nbhd.getValue()?.neighbors ?? []) as { id: string; secret?: string }[];
}

const listeners = (_: any) => {
  gameInit(1, 1, 3_600_000)(_);
  withNetwork(_, {
    topology: ({ playerCount }) => ring(playerCount),
    // Reads the neighbour's PRIVATE state, never a player attribute.
    project: (neighbour: any, _viewer: any, ctx: any) => ({
      id: neighbour.id,
      secret: ctx.stateOf(neighbour).get("secret"),
    }),
    watch: ["secret"],
  });
};

async function startGame(participants: { mode: unknown }[]): Promise<void> {
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
    label: "game visible",
  });
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

/**
 * The `onPrivateState` hook, and the namespace boundary it must respect.
 *
 * One scenario for both halves, on purpose. The second claim is an ABSENCE — a
 * server-authored `tell` must not arrive as a participant write — and waiting for
 * an absence in its own scenario is the expensive shape that pushed the e2e tier
 * red twice during M6 (`ISSUES.md` O8). Here the absence is checked at a moment
 * that is already pinned by a positive assertion: the told value has demonstrably
 * arrived at the client, so if the hook were going to see it, it would have.
 */
const HOOK_N = 4;
const SERVER_AUTHORED = "SERVER-AUTHORED-NOT-A-PARTICIPANT-WRITE";
const TRIGGER = "TRIGGER-THE-TELL";

test("onPrivateState sees participants' writes, and never the server's own", async () => {
  const events: Array<{ gameID: string; playerID: string; key: string; value: unknown }> = [];

  const hookListeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any, _viewer: any, ctx: any) => ({
        id: neighbour.id,
        secret: ctx.stateOf(neighbour).get("secret"),
      }),
      watch: ["secret"],
      onPrivateState: (event) => {
        events.push(event);
        // The `tell` has to happen inside a callback, and the hook IS inside one
        // — it runs in the attribute listener that delivered the write. That is
        // also what makes this arm possible without a second scenario.
        if (event.value === TRIGGER) {
          // The SAME key name, deliberately. `tell` writes `told:secret` while a
          // participant writes `state:secret`; if those namespaces ever merged,
          // an author's handler would start treating the server's own stimulus as
          // a participant's decision, and every experiment built on this hook
          // would be scoring its own output.
          network(event.gameID).tell(event.playerID, "secret", SERVER_AUTHORED);
        }
      },
    });
  };

  await withScenario(
    { n: HOOK_N, kinds: networkKinds, recordWire: true, listeners: hookListeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(HOOK_N, 1));
      await batch.running();
      await startGame(participants);

      const gameID = modeOf(participants[0]!).player.getValue()!.get("gameID");
      const ids = participants.map((p) => modeOf(p).player.getValue()!.id);

      for (const [i, p] of participants.entries()) stateOf(p).set("secret", `MINE-${i}`);
      await waitFor(() => ids.every((id) => events.some((e) => e.playerID === id)), {
        label: "every participant's write reached the hook",
        timeoutMs: 30_000,
      });

      // Player ids, not topology indices, and the value as written — the whole
      // point of the hook over `Empirica.on(NBHD_KIND, stateKey("secret"), …)`,
      // which hands over a scope and leaves the author to dig both out of it.
      for (const [i, id] of ids.entries()) {
        const seen = events.filter((e) => e.playerID === id);
        assert.ok(seen.length > 0, `no event for ${id}`);
        assert.deepEqual(
          seen.map((e) => [e.key, e.gameID]).at(-1),
          ["secret", gameID],
          "the event names the key and the game"
        );
        assert.equal(seen.at(-1)!.value, `MINE-${i}`, "the value is what the participant wrote");
      }

      // Now the other half. One participant writes the trigger, the hook tells
      // them something under the same key, and the told value demonstrably
      // arrives — which is what makes the absence below a real check rather than
      // a race that has not finished yet.
      stateOf(participants[0]!).set("secret", TRIGGER);
      await waitFor(() => toldOf(participants[0]!)?.get("secret") === SERVER_AUTHORED, {
        label: "the server's told value reached the participant",
        timeoutMs: 30_000,
      });

      assert.ok(
        events.some((e) => e.value === TRIGGER),
        "the trigger write itself reached the hook, so the tell above really ran"
      );
      assert.equal(
        events.filter((e) => e.value === SERVER_AUTHORED).length,
        0,
        "the server's own write came back through the participant-write hook"
      );
    }
  );
});

test("a privately written value reaches neighbours and NO ONE else", async () => {
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);

      // Record every participant's raw wire BEFORE any secret is written, so
      // absence later is meaningful.
      const wires = participants.map((p) => {
        const frames: string[] = [];
        p.wireStream().subscribe({
          next: (m: unknown) => {
            try {
              frames.push(JSON.stringify(m));
            } catch {
              /* unserialisable */
            }
          },
        });
        return frames;
      });

      // Each participant writes a distinctive secret to their OWN channel.
      const secrets = new Map<string, string>();
      for (const [i, p] of participants.entries()) {
        const playerID = modeOf(p).player.getValue()!.id;
        const secret = `PRIVATE-SECRET-${i}-${playerID.slice(-6)}`;
        secrets.set(playerID, secret);
        stateOf(p).set("secret", secret);
      }

      // First: the write must reach the server and come back to its own author.
      // If this fails the problem is the write path, not the projection, and
      // the neighbour wait below would just time out uninformatively.
      await waitFor(
        () => participants.every((p) => typeof stateOf(p).get("secret") === "string"),
        { label: "each participant can read back their own private write", timeoutMs: 30_000 }
      );

      // Everyone's neighbours must actually receive it — otherwise the absence
      // assertions below are vacuous.
      await waitFor(
        () =>
          participants.every((p) =>
            neighbourEntries(p).every((n) => typeof n.secret === "string")
          ),
        { label: "every neighbour's secret arrived", timeoutMs: 30_000 }
      );
      await new Promise((r) => setTimeout(r, 1500));

      let checkedAbsent = 0;
      let checkedPresent = 0;

      for (const [i, p] of participants.entries()) {
        const playerID = modeOf(p).player.getValue()!.id;
        const wire = wires[i]!.join("\n");
        const visibleIDs = new Set(neighbourEntries(p).map((n) => n.id));

        assert.equal(visibleIDs.size, 2, "a ring of 4 gives 2 neighbours");
        assert.ok(wire.length > 0, "frames were captured");

        for (const [otherID, secret] of secrets) {
          if (otherID === playerID) continue;

          if (visibleIDs.has(otherID)) {
            // A neighbour: the secret must be there, or the check is vacuous.
            assert.ok(
              wire.includes(secret),
              `participant ${i} should have received neighbour ${otherID}'s secret`
            );
            checkedPresent++;
          } else {
            // A non-neighbour: the bytes must never have arrived. This is the
            // claim `player.set()` cannot support.
            assert.ok(
              !wire.includes(secret),
              `LEAK: participant ${i} received non-neighbour ${otherID}'s private value`
            );
            checkedAbsent++;
          }
        }
      }

      assert.equal(checkedAbsent, N, "each of the 4 has exactly 1 non-neighbour");
      assert.equal(checkedPresent, N * 2, "each of the 4 has exactly 2 neighbours");
    }
  );
});

test("the same value on the PLAYER scope does leak — which is why this exists", async () => {
  // The contrast that makes the test above meaningful. Identical setup, one
  // difference: the value is written with player.set(). It reaches everyone.
  // If this ever stops leaking, Empirica changed and the private path may no
  // longer be necessary — so this failing is informative, not a disaster.
  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await startGame(participants);

      const wires = participants.map((p) => {
        const frames: string[] = [];
        p.wireStream().subscribe({
          next: (m: unknown) => {
            try {
              frames.push(JSON.stringify(m));
            } catch {
              /* unserialisable */
            }
          },
        });
        return frames;
      });

      const actor = participants[0]!;
      const actorID = modeOf(actor).player.getValue()!.id;
      const broadcast = `PLAYER-SCOPE-VALUE-${actorID.slice(-6)}`;
      modeOf(actor).player.getValue()!.set("shout", broadcast);

      await waitFor(
        () => wires.slice(1).every((frames) => frames.join("\n").includes(broadcast)),
        { label: "the player-scope value reached everyone", timeoutMs: 30_000 }
      );

      // Including the participant who is NOT a neighbour of the actor.
      const nonNeighbour = participants.find((p, i) => {
        if (i === 0) return false;
        return !neighbourEntries(actor).some(
          (n) => n.id === modeOf(p).player.getValue()!.id
        );
      });
      assert.ok(nonNeighbour, "a ring of 4 has a non-neighbour");

      const idx = participants.indexOf(nonNeighbour!);
      assert.ok(
        wires[idx]!.join("\n").includes(broadcast),
        "a player-scope attribute reaches even a non-neighbour — this is the trap"
      );
    }
  );
});
