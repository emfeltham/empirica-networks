/**
 * Artificial participants, against a real Tajriba.
 *
 * Four claims, and the first two are the ones the whole entry point rests on.
 *
 * 1. A BOT IS A PARTICIPANT. It connects, is assigned, sets `introDone` — which
 *    is what lets a game reach its player count at all — is provisioned a private
 *    channel, reads its neighbours through `project()` and writes through its own
 *    channel. Everything a human does, through the same code, with no server-side
 *    shortcut. If that stopped being true, the bot conditions of an experiment
 *    would be measuring the difference in access rather than the difference in
 *    behaviour.
 *
 * 2. PLACEMENT WORKS. `topology({ players })` names the seat each participant
 *    will occupy, so an experiment can put a bot on a hub or on a leaf. This is
 *    the independent variable in Shirado & Christakis (2017), so a package that
 *    could not express it could not reconstruct the paper.
 *
 * 3. A BOT IS VISIBLE AT THE WIRE, AND SO IS EVERY HUMAN. Classic writes
 *    `participantIdentifier` — the raw `?participantKey=` — immutably on the
 *    player scope, and links every participant to every player node. So every
 *    co-player receives it. That is upstream's (`ISSUES.md` U10) and it is why
 *    `src/bots/identity.ts` exists: there is no naming scheme a bot can hide
 *    behind. Asserted here rather than described, because the whole bot API is
 *    shaped around it.
 *
 * 4. A GAME ENDING ENDS THE BOTS. `onEnd` fires once, the tick stops, and the
 *    phase settles on `ended` — the runner following a game rather than assuming
 *    the process exists for one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";

import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { runBots, type BotPolicy, type BotRun } from "../../src/bots/index.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkStateOf } from "../../src/player/state.js";
import {
  batchConfig,
  createBatch,
  waitFor,
  withScenario,
  type AdminHandle,
  type Participant,
} from "../../src/verify/harness.js";

const HUMANS = 2;
const BOTS = 2;
const N = HUMANS + BOTS;

/**
 * The bot identifiers, held by BOTH processes.
 *
 * In a real study the runner is a separate process and this list is how the
 * server knows which players are bots — see `docs/BOTS.md`. Timestamp-shaped
 * because that is what Empirica's own client generates, so nothing about them
 * says "bot"; the server recognises them by holding the list, not by reading a
 * pattern, which is the only arrangement that survives claim 3 above.
 */
const BOT_KEYS = ["1755000000001", "1755000000002"];
const isBot = (player: any) => BOT_KEYS.includes(player?.get("participantIdentifier"));

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const stateOf = (p: { mode: unknown }) => networkStateOf(modeOf(p).nbhd.getValue());
const idOf = (p: { mode: unknown }) => modeOf(p).player.getValue()!.id;
const neighboursOf = (p: { mode: unknown }) =>
  (modeOf(p).nbhd.getValue()?.neighbors ?? []) as { id: string; mark?: string }[];

test.beforeEach(() => resetChannels());

/**
 * A star centred on the first bot, when there is one; otherwise on seat 0.
 *
 * A star rather than something realistic because it makes placement decidable
 * from one number: the hub has degree n-1 and every leaf has degree 1, so
 * "did the bot land where we put it" is answerable without reconstructing the
 * graph, and a placement that silently did nothing cannot look like a pass.
 */
function starOnFirstBot() {
  return ({ players, playerCount }: { players: any[]; playerCount: number }) => {
    const hub = Math.max(0, players.findIndex(isBot));
    return [...Array(playerCount).keys()]
      .filter((i) => i !== hub)
      .map((i) => [hub, i] as [number, number]);
  };
}

/**
 * A policy that writes one distinctive value and then reports what it can see.
 *
 * `seen` records `id=mark` rather than bare ids, because the interesting claim is
 * that the bot receives its neighbours' VALUES through the projection. Recording
 * only ids gave a test whose second wait re-asserted its first one and passed
 * without waiting for anything — and, because it returned before the humans'
 * writes had landed, left a mutation in flight through teardown.
 */
function markingPolicy(seen: Map<string, string[]>): BotPolicy<{ id: string; mark?: string }> {
  const record = (ctx: any) => {
    const ids = (ctx.neighbors() ?? []).map((nb: any) => `${nb.id}=${nb.mark ?? ""}`);
    seen.set(ctx.identifier, ids);
  };
  return {
    onStart(ctx) {
      // Written to the bot's OWN private channel, exactly as a human writes it.
      ctx.state()!.set("mark", `MARK-${ctx.identifier}`);
      record(ctx);
    },
    onView(ctx) {
      record(ctx);
    },
  };
}

/** Humans get through the intro; bots do it themselves. */
async function seatEveryone(admin: AdminHandle, humans: { mode: unknown }[], run: BotRun) {
  const batch = await createBatch(admin, batchConfig(N, 1));
  await batch.running();
  await waitFor(() => humans.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "humans assigned",
    timeoutMs: 30_000,
  });
  for (const p of humans) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => run.phases().every((ph) => ph === "playing"), {
    label: `bots playing (phases: ${run.phases().join(", ")})`,
    timeoutMs: 60_000,
  });
  await waitFor(() => humans.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "humans have a view",
    timeoutMs: 30_000,
  });
}

test("bots play a real game: they seat it, they are placed, and their writes project", async () => {
  const Empirica = new ClassicListenersCollector();
  Empirica.onGameStart(({ game }) => {
    const round = game.addRound({ name: "r" });
    round.addStage({ name: "s", duration: 600 });
  });
  withNetwork(Empirica, {
    topology: starOnFirstBot(),
    project: (neighbour: any, _viewer: any, ctx: any) => ({
      id: neighbour.id,
      mark: ctx.stateOf(neighbour).get("mark"),
    }),
    watch: ["mark"],
  });

  await withScenario(
    { n: HUMANS, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const seen = new Map<string, string[]>();
      const logs: Record<string, unknown>[] = [];
      const run = await runBots({
        url: server.url,
        identifiers: BOT_KEYS,
        policy: markingPolicy(seen),
        log: (r) => logs.push(r),
      });

      try {
        // The game cannot reach its player count without the bots: two humans
        // for a four-player treatment. If the bots did not set `introDone` this
        // wait would simply never return, which is the failure the whole
        // lifecycle machine exists to make legible.
        await seatEveryone(admin, participants, run);

        const botPlayerIDs = run.playerIDs();
        assert.equal(botPlayerIDs.filter(Boolean).length, BOTS, "every bot has a player id");

        // --- claim 2: placement -------------------------------------------
        // A bot is the hub, so it sees all three others and each human sees
        // exactly one node — the bot.
        const hubBot = botPlayerIDs[0]!;
        for (const p of participants) {
          const view = neighboursOf(p).map((nb) => nb.id);
          assert.deepEqual(
            view,
            [hubBot],
            "each human is a leaf whose single neighbour is the bot we placed centrally"
          );
        }
        await waitFor(() => (seen.get(BOT_KEYS[0]!) ?? []).length === N - 1, {
          label: "the central bot sees everyone else",
          timeoutMs: 30_000,
        });

        // --- claim 1: a bot reads and writes like a participant -----------
        // The bot's write reached its neighbours through project(), which is the
        // only path there is.
        await waitFor(
          () => participants.every((p) => neighboursOf(p)[0]?.mark === `MARK-${BOT_KEYS[0]}`),
          { label: "the bot's private write reached its neighbours", timeoutMs: 30_000 }
        );

        // And the reverse: a human's write reaches the bot, read through the
        // bot's own channel rather than handed to it server-side. Every human's
        // value, by name — a bot that saw one of two would pass a count check.
        for (const p of participants) stateOf(p)!.set("mark", `HUMAN-${idOf(p)}`);
        const wanted = participants.map((p) => `${idOf(p)}=HUMAN-${idOf(p)}`).sort();
        await waitFor(
          () => {
            const got = (seen.get(BOT_KEYS[0]!) ?? []).filter((s) => s.includes("=HUMAN-")).sort();
            return got.length === HUMANS && got.every((s, i) => s === wanted[i]);
          },
          {
            label: "every human's private write reached the central bot",
            timeoutMs: 30_000,
          }
        );

        // The runner's log is the bot half of a study's record: it says which
        // player id each bot was, which is what an analysis needs to exclude them.
        const starts = logs.filter((r) => r["type"] === "gameStart");
        assert.equal(starts.length, BOTS, "one gameStart per bot");
        assert.equal(
          starts.find((r) => r["identifier"] === BOT_KEYS[0])?.["degree"],
          N - 1,
          "the log records the central bot's degree"
        );
      } finally {
        await run.stop();
      }
    }
  );
});

test("a co-player's recruitment identifier is on the wire — U10", async () => {
  // The measurement `src/bots/identity.ts` is built around. In a deployed study
  // `participantKey` is the Prolific PID or the MTurk worker ID, so this is not
  // only about bots: co-players learn each other's recruitment identity.
  const Empirica = new ClassicListenersCollector();
  Empirica.onGameStart(({ game }) => {
    const round = game.addRound({ name: "r" });
    round.addStage({ name: "s", duration: 600 });
  });
  withNetwork(Empirica, { topology: starOnFirstBot(), project: (nb: any) => ({ id: nb.id }) });

  await withScenario(
    {
      n: HUMANS,
      kinds: networkKinds,
      recordWire: true,
      listeners: Empirica,
      modeFunc: EmpiricaNetwork,
    },
    async ({ server, admin, participants }) => {
      const run = await runBots({
        url: server.url,
        identifiers: BOT_KEYS,
        policy: {},
        log: () => {},
      });

      try {
        await seatEveryone(admin, participants, run);
        await new Promise((r) => setTimeout(r, 1500));

        const frames: string[] = [];
        (participants[0] as Participant<unknown>).wireStream().subscribe((c: unknown) => {
          frames.push(JSON.stringify(c));
        });
        await new Promise((r) => setTimeout(r, 500));
        const wire = frames.join("");

        // Non-vacuity first: this participant's own identifier is there, so the
        // search below is a search and not an empty buffer.
        assert.ok(
          wire.includes(participants[0]!.ns),
          "this participant's own identifier is not on its wire, so the checks below are blind"
        );

        assert.ok(
          wire.includes(participants[1]!.ns),
          "expected the OTHER HUMAN's recruitment identifier on this participant's wire (U10)"
        );
        for (const key of BOT_KEYS) {
          assert.ok(
            wire.includes(key),
            `expected bot identifier ${key} on a human's wire. If this ever fails, U10 has ` +
              `been fixed upstream and docs/BOTS.md's whole premise should be re-measured.`
          );
        }
        assert.ok(
          wire.includes("participantIdentifier"),
          "the identifiers arrive under Classic's own key"
        );
      } finally {
        await run.stop();
      }
    }
  );
});

test("a bot follows its game ending: onEnd fires once and the phase settles", async () => {
  const Empirica = new ClassicListenersCollector();
  let stageRef: any;
  Empirica.onGameStart(({ game }) => {
    const round = game.addRound({ name: "r" });
    round.addStage({ name: "s", duration: 600 });
  });
  Empirica.onStageStart(({ stage }) => {
    stageRef = stage;
  });
  // A game-scope attribute the test can set from the admin side, so the game ends
  // on demand rather than after a real stage duration. `stage.end` is a write, so
  // it has to happen inside a callback (PLATFORM-NOTES §15) — hence the listener.
  Empirica.on("game", "finish", (_ctx: any, { game }: any) => {
    if (game.get("finish")) stageRef?.end("ended", "test asked for it");
  });
  withNetwork(Empirica, { topology: starOnFirstBot(), project: (nb: any) => ({ id: nb.id }) });

  await withScenario(
    { n: HUMANS, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const ends: string[] = [];
      const ticks = new Map<string, number>();
      const logs: Record<string, unknown>[] = [];
      const run = await runBots({
        url: server.url,
        identifiers: BOT_KEYS,
        policy: {
          tickMs: 100,
          onTick(ctx) {
            ticks.set(ctx.identifier, (ticks.get(ctx.identifier) ?? 0) + 1);
          },
          onEnd(ctx) {
            ends.push(ctx.identifier);
          },
        },
        log: (r) => logs.push(r),
      });

      try {
        await seatEveryone(admin, participants, run);
        // The tick is what a noisy agent runs on, so a tick that never fires is
        // a bot that never acts. Prove it is running before ending the game.
        await waitFor(() => [...ticks.values()].every((n) => n > 1) && ticks.size === BOTS, {
          label: "every bot's tick is running",
          timeoutMs: 15_000,
        });

        const gameID = modeOf(participants[0]!).player.getValue()!.get("gameID") as string;
        await admin.taj.setAttribute({
          key: "finish",
          val: JSON.stringify(true),
          nodeID: gameID,
        });

        await waitFor(() => run.phases().every((p) => p === "ended"), {
          label: `bots see the game end (phases: ${run.phases().join(", ")})`,
          timeoutMs: 30_000,
        });
        assert.deepEqual([...ends].sort(), [...BOT_KEYS].sort(), "onEnd fired once per bot");

        // The tick stops with the game. A tick that outlived its game would keep
        // a policy writing into a scope nobody is attached to, forever.
        const after = new Map(ticks);
        await new Promise((r) => setTimeout(r, 800));
        assert.deepEqual([...ticks], [...after], "no tick fired after the game ended");

        assert.equal(logs.filter((r) => r["type"] === "gameEnd").length, BOTS);
      } finally {
        await run.stop();
      }
    }
  );
});
