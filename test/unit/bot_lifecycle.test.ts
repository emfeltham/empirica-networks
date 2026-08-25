/**
 * The bot lifecycle, which is the part that fails silently.
 *
 * A headless participant that never plays throws nothing, logs nothing and
 * times nothing out. It sits there while the study waits for a game that will
 * never reach its player count, and every cause looks identical from outside.
 * So the decision is a pure function and it is tested exhaustively here rather
 * than inferred from a game that did or did not start.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_ACTS_IN,
  botPhase,
  stallMessage,
  stallReason,
  type BotObservation,
  type BotPhase,
} from "../../src/bots/lifecycle.js";

/** A bot mid-game: every flag set, nothing ended. Vary one field per case. */
const playing: BotObservation = {
  hasPlayer: true,
  gameID: "g1",
  introDone: true,
  published: true,
  ended: false,
  exitStatus: undefined,
};

const obs = (over: Partial<BotObservation> = {}): BotObservation => ({ ...playing, ...over });

test("each phase is reached by removing exactly one thing", () => {
  assert.equal(botPhase(playing), "playing");
  assert.equal(botPhase(obs({ published: false })), "starting");
  assert.equal(botPhase(obs({ published: false, introDone: false })), "intro");
  assert.equal(botPhase(obs({ published: false, introDone: false, gameID: undefined })), "waiting");
  assert.equal(botPhase(obs({ hasPlayer: false, gameID: undefined, introDone: false, published: false })), "connecting");
});

test("`ended` wins over every other signal, and that ordering is the point", () => {
  // A finished player still has a player scope, a gameID, introDone and a
  // published channel — so any other check order reports it as `playing` and the
  // policy keeps writing into a game nobody is in.
  assert.equal(botPhase(obs({ ended: true })), "ended");
  assert.equal(botPhase(obs({ exitStatus: "finished" })), "ended");
  assert.equal(botPhase(obs({ exitStatus: "timeout" })), "ended");
});

test("a falsy-but-present exitStatus still ends the bot", () => {
  // `exitStatus` is compared against undefined, not truthiness. An empty string
  // or a 0 is a status Classic wrote, and treating it as "no status" would leave
  // a bot playing after its study ended — the silent case again.
  assert.equal(botPhase(obs({ exitStatus: "" })), "ended");
  assert.equal(botPhase(obs({ exitStatus: 0 })), "ended");
  assert.equal(botPhase(obs({ exitStatus: null })), "ended");
});

test("a bot that has not connected is `connecting` regardless of stale flags", () => {
  // Cannot happen through the runner, but it is the ordering guard: `hasPlayer`
  // is checked before anything read OFF the player.
  assert.equal(botPhase(obs({ hasPlayer: false })), "connecting");
});

test("intro is the only phase in which the bot itself must act", () => {
  const phases: BotPhase[] = ["connecting", "waiting", "intro", "starting", "playing", "ended"];
  const acting = phases.filter((p) => BOT_ACTS_IN.has(p));
  assert.deepEqual(acting, ["intro"]);
});

test("every phase a bot can be stuck in explains where to look", () => {
  // Only the transient phases. `playing` and `ended` are where a bot is supposed
  // to sit, so their one-liners are correct as one-liners — asserting a length
  // on those would be asserting the wrong thing.
  const stallable: BotPhase[] = ["connecting", "waiting", "intro", "starting"];
  for (const phase of stallable) {
    const reason = stallReason(phase);
    assert.ok(reason.length > 60, `${phase}: reason is too short to send anyone anywhere`);
    assert.ok(
      /check|see|remember|so /i.test(reason),
      `${phase}: reason restates the phase instead of naming what to check`
    );
  }
  // And the two quiet ones still answer, rather than returning "".
  assert.ok(stallReason("playing").length > 0);
  assert.ok(stallReason("ended").length > 0);
});

test("the waiting reason names the trap that actually causes it", () => {
  // Recruiting `playerCount` humans alongside `botCount` bots is the mistake this
  // package can predict, because the treatment's count includes the bots. A bot
  // stuck in `waiting` while the lobby looks full is exactly that, and the
  // message has to say so or the reader looks at the network code instead.
  assert.match(stallReason("waiting"), /playerCount - botCount/);
});

test("stall messages are silent in the two phases a bot is supposed to sit in", () => {
  assert.equal(stallMessage("k1", "playing", 10 * 60_000), undefined);
  assert.equal(stallMessage("k1", "ended", 10 * 60_000), undefined);
});

test("a stall message names the bot, the phase, the duration and whose move it is", () => {
  const msg = stallMessage("k1", "intro", 45_000)!;
  assert.ok(msg.includes("k1"), "names the bot");
  assert.ok(msg.includes('"intro"'), "names the phase");
  assert.ok(msg.includes("45s"), "names the duration");
  assert.ok(msg.includes("the bot's move"), "says the bot is what is stuck");

  const server = stallMessage("k1", "starting", 45_000)!;
  assert.ok(server.includes("waiting on the server"), "distinguishes waiting from stuck");
});
