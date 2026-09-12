/**
 * `network(game).tell()` — the server telling ONE participant one thing.
 *
 * This is the second path from server to client. A second path is where a leak
 * gets in, so the
 * central test asserts at the WIRE and specifically about the person the value is
 * ABOUT: a rewiring offer names a non-neighbour, and if that non-neighbour learns
 * they were named, the reconstruction has deviated from the design it cites.
 *
 * The non-vacuity arm matters as much as the leak arm here. `tell()` writes to a
 * channel scope, and "nobody received it" is exactly what a silently dropped
 * write looks like — the characteristic failure of this codebase. So every
 * absence below sits next to a presence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { network, withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkToldOf } from "../../src/player/view.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type AdminHandle,
  type Participant,
} from "../../src/harness/harness.js";

const N = 4;
/** Game attribute used to drive a server-side action from inside a listener. */
const CMD = "tellCmd";

/**
 * The sentinel, held here rather than passed through the command.
 *
 * This test first drove `tell` by putting the secret INSIDE the game attribute,
 * and the leak assertion fired immediately — correctly, and on the test's own
 * driving mechanism rather than on `tell()`. The game scope is delivered to every
 * participant (PLATFORM-NOTES §4b), so anything written there is on every
 * participant's wire before `tell` is even called.
 *
 * Worth keeping the story: it is the same mistake the package's own design went
 * through (§4c moved the realised topology off the game scope for this reason),
 * and it is the reason the command below carries only ids, which are public
 * anyway, and never the value under test. The callbacks are defined in this file,
 * so a module constant reaches the server without crossing a scope at all.
 */
const SECRET = "SEKRIT-told-4b71ac";

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const toldOf = (p: { mode: unknown }) => networkToldOf(modeOf(p).nbhd.getValue());

/** What the last `tell` attempt threw, if it threw. */
let lastError: string | undefined;

function makeListeners(capture: (game: any) => void) {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) capture(game);
    });
    // Driven through a game attribute so the call happens inside a real
    // callback. Writes only count inside one (PLATFORM-NOTES §15), and calling
    // tell() from the test process directly would update nothing and reach
    // nobody — which is the mistake this indirection exists to avoid making.
    _.on("game", CMD, (_ctx: any, { game }: any) => {
      const cmd = game.get(CMD) as
        | { to: string; key: string; value?: unknown; probe?: string; about?: string }
        | undefined;
      if (!cmd) return;
      lastError = undefined;
      // Invalid values are named rather than sent. The command travels as JSON,
      // and JSON is exactly what mangles them: `NaN` arrives as `null`, a cycle
      // cannot be stringified at all, and a scope would arrive as a plain
      // object. So they are constructed here, on the server, where a real
      // author's mistake would also be made.
      let value = cmd.value;
      // The sentinel case: built here so the secret never travels through the
      // game scope, which every participant reads. `about` is a player id, which
      // Classic broadcasts anyway.
      if (cmd.probe === "secretOffer") {
        value = { with: cmd.about, theirLastAction: SECRET };
      }
      if (cmd.probe === "nan") value = { score: NaN };
      if (cmd.probe === "scope") value = game;
      if (cmd.probe === "cycle") {
        const cyclic: Record<string, unknown> = {};
        cyclic["self"] = cyclic;
        value = cyclic;
      }
      try {
        network(game).tell(cmd.to, cmd.key, value);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    });
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id }),
    });
  };
}

async function running(admin: AdminHandle, participants: { mode: unknown }[]): Promise<void> {
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

/** Ask the server to run one `tell` and wait for it to have been attempted. */
async function tell(
  admin: AdminHandle,
  game: any,
  cmd: { to: string; key: string; value?: unknown; probe?: string; about?: string }
): Promise<void> {
  await admin.taj.setAttribute({
    key: CMD,
    // The nonce makes each command a distinct value: Empirica does not dispatch
    // an attribute listener for a write identical to the current value, so two
    // identical tells in one test would silently become one.
    val: JSON.stringify({ ...cmd, nonce: `${Date.now()}-${Math.random()}` }),
    nodeID: game.id,
  });
}

test("a told value reaches its target and NOBODY else — including the person it is about", async () => {
  let gameRef: any;
  await withScenario(
    {
      n: N,
      kinds: networkKinds, recordWire: true,
      listeners: makeListeners((g) => (gameRef = g)),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      // Record every frame each participant receives, below the mode, before
      // anything is told.
      //
      // Free, and safe to do this early — `wireStream()` shares the mode's own
      // subscription rather than opening a second one (`src/harness/compat.ts`).
      // Until 2026-08-16 it opened another, and doing that for four participants
      // before `running()` doubled the wire traffic the server carried through
      // Classic's O(n²) game-start burst: this file failed **4/12** on `gameID
      // assigned`. Moving the capture below `running()` fixed the symptom; sharing
      // the subscription removed the cause, so the capture is back where it belongs
      // and now covers game start too (`ISSUES.md` O8).
      const wires = participants.map((p) => {
        const frames: string[] = [];
        (p as Participant<unknown>).wireStream().subscribe((c: unknown) => {
          frames.push(JSON.stringify(c));
        });
        return frames;
      });

      await running(admin, participants);

      // Build the exact shape Rand 2011's rewiring round needs: the decider is
      // told about a NON-neighbour, which is precisely what project() cannot
      // express and therefore what tell() exists for.
      const decider = participants[0]!;
      const deciderID = modeOf(decider).player.getValue()!.id;
      const neighbourIDs = (
        (modeOf(decider).nbhd.getValue()!.neighbors ?? []) as { id: string }[]
      ).map((n) => n.id);
      assert.equal(neighbourIDs.length, 2, "a ring of 4 gives the decider two neighbours");

      const subject = participants.find(
        (p) =>
          modeOf(p).player.getValue()!.id !== deciderID &&
          !neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      )!;
      const subjectID = modeOf(subject).player.getValue()!.id;
      assert.ok(subject, "a ring of 4 has exactly one non-neighbour");

      await tell(admin, gameRef, {
        to: deciderID,
        key: "offer",
        probe: "secretOffer",
        about: subjectID,
      });

      await waitFor(
        () => (toldOf(decider)?.get("offer") as { theirLastAction?: string } | undefined)
          ?.theirLastAction === SECRET,
        { label: "the decider received the offer", timeoutMs: 30_000 }
      );

      // Let a stray delivery have its chance before concluding none came.
      await new Promise((r) => setTimeout(r, 1500));

      for (const p of participants) {
        if (modeOf(p).player.getValue()!.id === deciderID) continue;
        assert.equal(
          toldOf(p)?.get("offer"),
          undefined,
          "only the target has the told value"
        );
      }

      const deciderIndex = participants.indexOf(decider);
      for (const [i, frames] of wires.entries()) {
        if (i === deciderIndex) continue;
        assert.ok(
          !frames.join("").includes(SECRET),
          `LEAK: a told value appeared in participant ${i}'s raw wire traffic`
        );
      }

      // Non-vacuity, both halves. The detector works...
      assert.ok(
        wires[deciderIndex]!.join("").includes(SECRET),
        "the target's wire must contain it, or this test cannot detect a leak at all"
      );
      // ...and the subject of the offer is a participant whose wire we really
      // are watching, so their silence above is evidence rather than an artefact
      // of subscribing to the wrong stream.
      const subjectIndex = participants.indexOf(subject);
      assert.ok(
        wires[subjectIndex]!.join("").includes(subjectID),
        "the subject's own wire carries their own player id, so it is a live stream"
      );
    }
  );
});

test("a told value is not readable as participant state, and vice versa", async () => {
  // The two namespaces share one scope. If they ever met, a participant could
  // forge what the server told them by writing the same key — and server code
  // reading it back would trust participant input.
  let gameRef: any;
  await withScenario(
    {
      n: N,
      kinds: networkKinds, recordWire: true,
      listeners: makeListeners((g) => (gameRef = g)),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      await running(admin, participants);

      const p = participants[0]!;
      const playerID = modeOf(p).player.getValue()!.id;
      const state = modeOf(p).nbhd.getValue()!;

      // The participant writes their own "action"; the server tells them a
      // different "action".
      state.set("state:action", "mine");
      await tell(admin, gameRef, { to: playerID, key: "action", value: "theirs" });

      await waitFor(() => toldOf(p)?.get("action") === "theirs", {
        label: "the told value arrived",
        timeoutMs: 30_000,
      });

      assert.equal(state.get("state:action"), "mine", "the participant's own value survives");
      assert.equal(toldOf(p)!.get("action"), "theirs", "the server's value is separate");
    }
  );
});

test("tell() runs every check project() runs, plus its own", async () => {
  // The point of routing `tell` through `validateProjection` is that the second
  // path to a client cannot be the lax one. Each probe below is a mistake an
  // author would actually make; the scope one is the mistake that would leak
  // every attribute of every participant.
  let gameRef: any;
  await withScenario(
    {
      n: N,
      kinds: networkKinds, recordWire: true,
      listeners: makeListeners((g) => (gameRef = g)),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      await running(admin, participants);
      const playerID = modeOf(participants[0]!).player.getValue()!.id;

      const cases: Array<
        [string, { to: string; key: string; value?: unknown; probe?: string }, RegExp]
      > = [
        // A player who is not in this game's network at all.
        ["unknown player", { to: "player-does-not-exist", key: "offer", value: 1 }, /is not in game/],
        ["empty key", { to: playerID, key: "", value: 1 }, /non-empty string key/],
        // THE one that matters: a scope carries the global attribute store.
        ["a scope", { to: playerID, key: "offer", probe: "scope" }, /Empirica scope/],
        ["a cycle", { to: playerID, key: "offer", probe: "cycle" }, /cycle/],
        // NaN survives JSON.stringify as `null`, so it is the probe that would
        // silently change meaning rather than crash.
        ["NaN", { to: playerID, key: "offer", probe: "nan" }, /NaN/],
      ];

      for (const [name, cmd, expected] of cases) {
        lastError = undefined;
        await tell(admin, gameRef, cmd);
        await waitFor(() => lastError !== undefined && expected.test(lastError), {
          label: `tell() rejected ${name}`,
          timeoutMs: 30_000,
        });
        assert.match(lastError!, expected, `${name}: ${lastError}`);
      }

      // Non-vacuity: after all those refusals, a VALID tell still works. Without
      // this, a `tell` that threw unconditionally would pass every case above.
      lastError = undefined;
      await tell(admin, gameRef, { to: playerID, key: "offer", value: { ok: true } });
      await waitFor(
        () => toldOf(participants[0]!)?.get("offer") !== undefined,
        { label: "a valid tell still gets through", timeoutMs: 30_000 }
      );
      assert.equal(lastError, undefined, "the valid case threw nothing");
      assert.deepEqual(toldOf(participants[0]!)!.get("offer"), { ok: true });
    }
  );
});
