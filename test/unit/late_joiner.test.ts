/**
 * The late-joiner provisioning net — `ISSUES.md` O4.
 *
 * A player with no `participantID` at game start gets no channel, and `publish`
 * refuses partial views, so ONE such player leaves EVERY participant in the game
 * with an empty neighbourhood. `withNetwork` re-provisions on
 * `ParticipantConnect` to repair that.
 *
 * O4 recorded this as "a net under a path we could not construct", and the code
 * said so honestly rather than implying it fixed an observed bug. Two things
 * changed that, both on 2026-08-16.
 *
 * **The path is not exotic.** Read off `@empirica/core@1.12.5`
 * `dist/admin-classic.cjs`: `game.players` is
 * `scopesByKindMatching("player", "gameID", this.id)` (:4488) — a filter over an
 * ATTRIBUTE — while `player.participantID` is a FIELD assigned inside
 * `_.on("player", …)` (:5475). Membership of `game.players` and the presence of
 * the field are therefore produced by two different mechanisms and cannot be
 * assumed in step. That does not establish that Classic *does* produce it, and
 * this file does not claim so — see `docs/PLATFORM-NOTES.md` §20.
 *
 * **The net was itself broken.** Found by writing the first test below. The
 * repair path called `provisionChannels(ctx, game)` with no `indexOf`, so the
 * channel it created carried `topologyIndex: -1`; the seat recorder in the OWNER
 * listener takes `idx >= 0` only, so that participant's seat was never recorded
 * and `tryRecover` would refuse the whole game after a restart — permanently,
 * and for a reason no message connects back to a late join. A net that leaves
 * the game unrecoverable is worse than no net, because it looks like it worked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readChannels, resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import { NBHD_KEYS } from "../../src/shared/keys.js";
import {
  FakeCollector,
  FakeScope,
  connectParticipant,
  makeCtx,
  makeGame,
  startGame,
  viewOn,
  type FakeCtx,
} from "./fake_admin.js";

/** A triangle: every participant has two neighbours, so nobody's view is empty. */
const TRIANGLE = () => [
  [0, 1],
  [1, 2],
  [0, 2],
] as Array<[number, number]>;

function experiment(): { collector: FakeCollector; ctx: FakeCtx; net: NetworkHandle } {
  const collector = new FakeCollector();
  const net = withNetwork(collector, { topology: TRIANGLE });
  return { collector, ctx: makeCtx(), net };
}

test.beforeEach(() => resetChannels());

test("one player with no participantID blocks EVERY view, not just their own", async () => {
  const { collector, ctx, net } = experiment();
  const game = makeGame("g1", ["p1", "p2", { id: "p3", participantID: undefined }], new FakeScope("b"));

  const channels = await startGame(collector, ctx, game);

  assert.equal(channels.length, 2, "only the two connected players are provisioned");
  // The disproportion is the whole reason this is worth a net. It is also why
  // `pendingChannelsMessage` exists and says so.
  for (const scope of channels) {
    assert.equal(viewOn(scope), undefined, "a connected player is stalled by an absent third");
  }
  assert.equal(net.stats().games, 1, "the game is tracked, it is just not publishing");
});

test("connecting repairs the channel and unblocks everyone", async () => {
  const { collector, ctx } = experiment();
  const p3 = { id: "p3", participantID: undefined as string | undefined };
  const game = makeGame("g1", ["p1", "p2", p3], new FakeScope("b"));
  const early = await startGame(collector, ctx, game);

  // Classic's `player` listener has now run for p3, so the field is set. This is
  // the moment the net exists for: provisioning otherwise runs once, at start.
  game.players[2]!.participantID = "participant-p3";
  const repaired = await connectParticipant(collector, ctx, "participant-p3");

  assert.equal(repaired.length, 1, "exactly the missing channel, and no duplicate for anyone else");
  assert.equal(Object.keys(readChannels(game as any)).length, 3);
  for (const scope of [...early, ...repaired]) {
    assert.deepEqual(
      (viewOn(scope) ?? []).length,
      2,
      "every participant now has both neighbours, including the two who were waiting"
    );
  }
});

test("the repaired channel carries the player's REAL seat, not -1", async () => {
  // The defect this file found. A channel is self-describing so that a process
  // which has lost its memory can rebuild the seating plan by reading channels
  // rather than re-deriving it and getting a different answer — and `-1` is not
  // a seat. The OWNER listener records seats only for `idx >= 0`, so a `-1`
  // leaves a gap, and `tryRecover` refuses a game with a gap rather than
  // guessing who sits where.
  //
  // Nothing about the running game looks wrong when this happens. It costs the
  // game its recoverability, and only at the next restart.
  const { collector, ctx } = experiment();
  const p3 = { id: "p3", participantID: undefined as string | undefined };
  const game = makeGame("g1", ["p1", "p2", p3], new FakeScope("b"));
  await startGame(collector, ctx, game);

  game.players[2]!.participantID = "participant-p3";
  const [repaired] = await connectParticipant(collector, ctx, "participant-p3");

  assert.equal(repaired!.get(NBHD_KEYS.PLAYER_ID), "p3");
  assert.equal(
    repaired!.get(NBHD_KEYS.INDEX),
    2,
    "seat 2, from the order fixed at game start — a -1 here is silently unrecoverable"
  );
});

test("a connect for a participant who already has a channel creates nothing", async () => {
  // The net has to be free on the path everyone actually takes: one idempotent
  // no-op call per connect, no second channel. Tajriba cannot unlink, so a
  // duplicate channel is permanent — the client picks one and the server writes
  // the other, and the view freezes with nothing logged (`test/e2e/restart.test.ts`).
  const { collector, ctx } = experiment();
  const game = makeGame("g1", ["p1", "p2", "p3"], new FakeScope("b"));
  const channels = await startGame(collector, ctx, game);
  assert.equal(channels.length, 3);

  const extra = await connectParticipant(collector, ctx, "participant-p2");

  assert.equal(extra.length, 0, "no new channel");
  assert.equal(Object.keys(readChannels(game as any)).length, 3, "and the index is unchanged");
});
