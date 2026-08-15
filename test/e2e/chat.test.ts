/**
 * Neighbour-scoped chat.
 *
 * The claim is the same one the whole package makes, applied to messages: a
 * non-neighbour does not receive them. So the assertion is at the WIRE, not on
 * a rendered list — "the UI does not show it" is a different and much weaker
 * statement, and the one this package exists to avoid making.
 *
 * §7.4's open question ("does chat history survive a rewire?") is answered
 * structurally rather than by policy: messages land on the RECIPIENT's channel,
 * so dropping a tie stops new messages without erasing what was delivered. The
 * last test pins that down, because it is a research-design property somebody
 * will rely on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { network, withNetwork } from "../../src/admin/with_network.js";
import { neighborChatOf } from "../../src/player/chat.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type AdminHandle,
  type Participant,
} from "../../src/verify/harness.js";

const N = 4;
const CMD = "chatCmd";

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const chatOf = (p: { mode: unknown }) => neighborChatOf(modeOf(p).nbhd.getValue());
const textsOf = (p: { mode: unknown }) => (chatOf(p)?.messages ?? []).map((m) => m.text);

function makeListeners(capture: (game: any) => void) {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) capture(game);
    });
    _.on("game", CMD, (_ctx: any, { game }: any) => {
      const cmd = game.get(CMD) as { a: string; b: string } | undefined;
      if (cmd) network(game).removeEdge(cmd.a, cmd.b);
    });
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id }),
      chat: true,
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

test("a message reaches neighbours and the sender, and nobody else — at the wire", async () => {
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      // Record every frame each participant receives, below the mode, before
      // anything is said.
      const wires = participants.map((p) => {
        const frames: string[] = [];
        (p as Participant<unknown>).wireStream().subscribe((c: unknown) => {
          frames.push(JSON.stringify(c));
        });
        return frames;
      });

      await running(admin, participants);

      const speaker = participants[0]!;
      const speakerID = modeOf(speaker).player.getValue()!.id;
      const neighbourIDs = ((modeOf(speaker).nbhd.getValue()!.neighbors ?? []) as {
        id: string;
      }[]).map((n) => n.id);
      assert.equal(neighbourIDs.length, 2, "a ring of 4 gives the speaker two neighbours");

      const SECRET = "SEKRIT-chat-9c4e1f";
      chatOf(speaker)!.send(SECRET);

      await waitFor(
        () =>
          participants
            .filter((p) => neighbourIDs.includes(modeOf(p).player.getValue()!.id))
            .every((p) => textsOf(p).includes(SECRET)),
        { label: "both neighbours received the message", timeoutMs: 30_000 }
      );

      assert.ok(textsOf(speaker).includes(SECRET), "the sender sees their own message");

      const stranger = participants.find(
        (p) =>
          modeOf(p).player.getValue()!.id !== speakerID &&
          !neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      )!;
      assert.ok(stranger, "a ring of 4 has exactly one non-neighbour");

      // Let a late delivery have its chance before concluding it never came.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(textsOf(stranger).length, 0, "the non-neighbour has no messages");

      const strangerIndex = participants.indexOf(stranger);
      assert.ok(
        !wires[strangerIndex]!.join("").includes(SECRET),
        "LEAK: the message text appeared in a non-neighbour's raw wire traffic"
      );

      // Non-vacuity: the detector works, so the absence above means something.
      const neighbourIndex = participants.findIndex((p) =>
        neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      );
      assert.ok(
        wires[neighbourIndex]!.join("").includes(SECRET),
        "a neighbour's wire must contain it, or this test cannot detect a leak at all"
      );
    }
  );
});

test("sending twice delivers twice, in order, without duplicates", async () => {
  // The relay drops a message whose sequence it has already seen, because an
  // attribute listener can fire again for a value it handled. That guard must
  // not also drop genuinely new messages.
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await running(admin, participants);

      const speaker = participants[0]!;
      const neighbourIDs = ((modeOf(speaker).nbhd.getValue()!.neighbors ?? []) as {
        id: string;
      }[]).map((n) => n.id);
      const listener = participants.find((p) =>
        neighbourIDs.includes(modeOf(p).player.getValue()!.id)
      )!;

      chatOf(speaker)!.send("first");
      await waitFor(() => textsOf(listener).includes("first"), {
        label: "first message",
        timeoutMs: 30_000,
      });
      chatOf(speaker)!.send("second");
      await waitFor(() => textsOf(listener).includes("second"), {
        label: "second message",
        timeoutMs: 30_000,
      });

      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(textsOf(listener), ["first", "second"], "both, once each, in order");

      const seqs = chatOf(listener)!.messages.map((m) => m.seq);
      assert.deepEqual(seqs, [1, 2], "sender-local sequence numbers");
    }
  );
});

test("dropping a tie stops new messages but keeps what was already delivered", async () => {
  // §7.4's open question. Answered structurally: the transcript lives on the
  // recipient's own channel, so nothing has to actively preserve it.
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await running(admin, participants);

      const speaker = participants[0]!;
      const speakerID = modeOf(speaker).player.getValue()!.id;
      const neighbourIDs = ((modeOf(speaker).nbhd.getValue()!.neighbors ?? []) as {
        id: string;
      }[]).map((n) => n.id);
      const leaving = participants.find(
        (p) => modeOf(p).player.getValue()!.id === neighbourIDs[0]
      )!;
      const leavingID = modeOf(leaving).player.getValue()!.id;

      chatOf(speaker)!.send("before the tie was cut");
      await waitFor(() => textsOf(leaving).includes("before the tie was cut"), {
        label: "delivered while still tied",
        timeoutMs: 30_000,
      });

      // Cut the tie, from inside a listener as mutations require.
      await admin.taj.setAttribute({
        key: CMD,
        val: JSON.stringify({ a: speakerID, b: leavingID }),
        nodeID: gameRef.id,
      });
      await waitFor(() => !network(gameRef).hasEdge(speakerID, leavingID), {
        label: "the tie was cut",
        timeoutMs: 30_000,
      });

      chatOf(speaker)!.send("after the tie was cut");

      // The remaining neighbour still gets it — so a silent relay failure would
      // not be mistaken for correct exclusion.
      const stillTied = participants.find(
        (p) => modeOf(p).player.getValue()!.id === neighbourIDs[1]
      )!;
      await waitFor(() => textsOf(stillTied).includes("after the tie was cut"), {
        label: "the remaining neighbour still receives messages",
        timeoutMs: 30_000,
      });

      assert.deepEqual(
        textsOf(leaving),
        ["before the tie was cut"],
        "history survives the rewire; nothing new arrives"
      );
    }
  );
});
