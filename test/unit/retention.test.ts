/**
 * What a long-running process keeps, and what it lets go of — `ISSUES.md` O5.
 *
 * `test/e2e/retention.test.ts` already proves that one finished game releases
 * everything it was holding, against a real server. What it cannot show is the
 * shape that only appears over MANY games: a structure that grows by a little
 * each time. Two of those existed. One was documented and deliberate
 * (`endedGames`); the other was neither, and was not a memory bug at all once
 * looked at.
 *
 * Server-free, against `./fake_admin.ts` — which is where the scaffolding and
 * its limits are documented. A retention claim needs several sequential games,
 * and the e2e tier is the worst place to buy them (`ISSUES.md` O8 measured its
 * headroom at one participant wide).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resetChannels } from "../../src/admin/provision.js";
import {
  ENDED_GAMES_CAP_ENV,
  MAX_ENDED_GAMES,
  endedGamesCap,
  endedGamesEvictedMessage,
  rememberEndedGame,
} from "../../src/admin/retention.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import { NBHD_KIND, OUTBOX_KEY, stateKey } from "../../src/shared/keys.js";
import {
  FakeCollector,
  FakeScope,
  endGame,
  makeCtx,
  makeGame,
  say,
  startGame,
  textsOn,
  type FakeCtx,
} from "./fake_admin.js";

/** A two-player line graph: the smallest topology in which chat has a recipient. */
const PAIR = () => [[0, 1] as [number, number]];

function experiment(): { collector: FakeCollector; ctx: FakeCtx; net: NetworkHandle } {
  const collector = new FakeCollector();
  const net = withNetwork(collector, { topology: PAIR, chat: true });
  return { collector, ctx: makeCtx(), net };
}

test.beforeEach(() => resetChannels());

// --------------------------------------------------------- the pure bound

test("rememberEndedGame forgets the OLDEST id once it is over the cap", () => {
  const ended = new Set<string>();
  assert.equal(rememberEndedGame(ended, "a", 2), undefined);
  assert.equal(rememberEndedGame(ended, "b", 2), undefined);
  assert.equal(rememberEndedGame(ended, "c", 2), "a", "the first one in is the first one out");
  assert.deepEqual([...ended], ["b", "c"]);
});

test("re-ending a game refreshes it rather than leaving it next for eviction", () => {
  // `releaseGame` is reachable twice for one game — from the `game/status`
  // listener and from the `hasEnded` branch of game start, which is the path a
  // restart takes. A game released twice is more recently relevant, not less.
  const ended = new Set<string>(["a", "b"]);
  assert.equal(rememberEndedGame(ended, "a", 2), undefined, "no growth, so no eviction");
  assert.deepEqual([...ended], ["b", "a"]);
  assert.equal(rememberEndedGame(ended, "c", 2), "b");
});

test("the cap falls back rather than becoming NaN on a malformed override", () => {
  const original = process.env[ENDED_GAMES_CAP_ENV];
  try {
    assert.equal(endedGamesCap(), MAX_ENDED_GAMES);
    process.env[ENDED_GAMES_CAP_ENV] = "3";
    assert.equal(endedGamesCap(), 3);
    // A cap of NaN compares false against every size, which would switch
    // eviction off silently — the one outcome a bound must not have.
    for (const bad of ["", "nonsense", "0", "-5"]) {
      process.env[ENDED_GAMES_CAP_ENV] = bad;
      assert.equal(endedGamesCap(), MAX_ENDED_GAMES, `"${bad}" should fall back`);
    }
  } finally {
    if (original === undefined) delete process.env[ENDED_GAMES_CAP_ENV];
    else process.env[ENDED_GAMES_CAP_ENV] = original;
  }
});

test("the eviction warning says what it does and does not cost", () => {
  const msg = endedGamesEvictedMessage(10);
  assert.match(msg, /10 games/);
  // The honest half. A warning that only said "memory is being forgotten" would
  // read as data loss, which this is not.
  assert.match(msg, /transient/);
  assert.match(msg, /Restarting the callbacks process/);
});

// ------------------------------------------------- the bound, as wired up

test("ending games grows the remembered list by one each, and stops at the cap", async () => {
  const original = process.env[ENDED_GAMES_CAP_ENV];
  process.env[ENDED_GAMES_CAP_ENV] = "2";
  const lines: string[] = [];
  const originalLog = console.log;
  // `console.log`, not `console.warn`: `warn()` from `@empirica/core/console`
  // routes every level through `console.log` (PLATFORM-NOTES §18b), so swapping
  // `console.warn` captures nothing.
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const { collector, ctx, net } = experiment();
    const batch = new FakeScope("batch-1");

    for (const id of ["g1", "g2", "g3", "g4"]) {
      await endGame(collector, ctx, makeGame(id, [], batch));
    }

    assert.equal(net.stats().endedGames, 2, "held at the cap rather than growing");
    const warnings = lines.filter((l) => l.includes("games, which is the cap"));
    assert.equal(warnings.length, 1, "said once, not once per eviction");
  } finally {
    console.log = originalLog;
    if (original === undefined) delete process.env[ENDED_GAMES_CAP_ENV];
    else process.env[ENDED_GAMES_CAP_ENV] = original;
  }
});

// ------------------------------------- the release that was being missed

test("a game's chat dedupe state is released with the game", async () => {
  const { collector, ctx, net } = experiment();
  const batch = new FakeScope("batch-1");
  const game = makeGame("g1", ["p1", "p2"], batch);

  const [a, b] = await startGame(collector, ctx, game);
  assert.ok(a && b, "two players, two channels");

  await say(collector, ctx, a, 1, "hello");
  assert.deepEqual(textsOn(b), ["hello"], "the relay ran, so there is state to release");

  // Non-vacuity first, as in the e2e file: asserting zero against something
  // never populated passes just as well when the feature never ran.
  const live = net.stats();
  assert.equal(live.chatSeqs, 1);
  assert.equal(live.games, 1);

  await endGame(collector, ctx, game);

  const after = net.stats();
  assert.deepEqual(
    { ...after, firstChannelMs: undefined },
    {
      games: 0,
      channels: 0,
      channelScopes: 0,
      cachedViews: 0,
      endedGames: 1,
      chatSeqs: 0,
      firstChannelMs: undefined,
      pendingAtStart: 0,
      lateProvisioned: 0,
    },
    "everything released except the id of the game itself, which is deliberate"
  );
  // Masked above rather than dropped from the comparison, so this stays an
  // EXHAUSTIVE record: a new field has to come here and be argued for, which is
  // how `firstChannelMs` arrived. It is a measurement rather than a resource,
  // and it is deliberately NOT released — the kind-registration check it feeds
  // is one-shot per process (`ISSUES.md` O15), so clearing it per game would
  // make the figure describe the most recent game instead of the coldest one.
  assert.equal(typeof after.firstChannelMs, "number", "the measurement outlives the game");
  // `pendingAtStart` and `lateProvisioned` arrived the same way and stay for the
  // same kind of reason. They count occurrences, not held objects, and the
  // question they answer is "has this PROCESS ever seen the O4 path" — which a
  // per-game reset would erase exactly when it finally mattered. Zero here is
  // the ordinary case and is also the evidence.
});

test("a participant who chatted in one game is heard in the next", async () => {
  // The reason the release above is a correctness fix and not only a memory one.
  //
  // Classic reuses a participant's player scope across sequential games, so the
  // server's high-water mark persists under the same key — while the client
  // derives its sequence number from the outbox attribute on its own channel
  // (`src/player/chat.ts`), which is a NEW channel each game and therefore
  // restarts at 1. With the stale mark in place the relay's duplicate guard
  // reads `2 >= 1` and drops the message, silently, and the transcript records
  // a conversation that did not happen.
  const { collector, ctx, net } = experiment();
  const batch = new FakeScope("batch-1");

  const first = makeGame("g1", ["p1", "p2"], batch);
  const [a1] = await startGame(collector, ctx, first);
  await say(collector, ctx, a1!, 1, "first game, first message");
  await say(collector, ctx, a1!, 2, "first game, second message");
  await endGame(collector, ctx, first);

  // Same player ids, a fresh game, and the client's counter back at 1.
  const second = makeGame("g2", ["p1", "p2"], batch);
  const [a2, b2] = await startGame(collector, ctx, second);
  await say(collector, ctx, a2!, 1, "second game, first message");

  assert.deepEqual(
    textsOn(b2!),
    ["second game, first message"],
    "the first message of the second game must not be swallowed as a duplicate"
  );
  assert.equal(net.stats().chatSeqs, 1, "and the new game's own mark is being kept");
});

test("the duplicate guard still works WITHIN a game", async () => {
  // The release must not be a license to redeliver. A relay that fires twice for
  // one value — which an attribute listener may do — still has to drop the
  // second, or a transcript double-counts.
  const { collector, ctx } = experiment();
  const batch = new FakeScope("batch-1");
  const game = makeGame("g1", ["p1", "p2"], batch);
  const [a, b] = await startGame(collector, ctx, game);

  await say(collector, ctx, a!, 1, "once");
  await collector.emit(`${NBHD_KIND}/${stateKey(OUTBOX_KEY)}`, { [NBHD_KIND]: a }, ctx);

  assert.deepEqual(textsOn(b!), ["once"], "delivered once despite two dispatches");
});
