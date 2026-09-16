/**
 * Artificial participants, against a real Tajriba.
 *
 * Four claims, and the first two are the ones the whole entry point rests on.
 *
 * 1. A BOT IS A PARTICIPANT. It connects, is assigned, sets `introDone` — which
 *    is what lets a game reach its player count at all — is provisioned a private
 *    channel, reads its neighbors through `project()` and writes through its own
 *    channel. Everything a human does, through the same code, with no server-side
 *    shortcut. If that stopped being true, the bot conditions of an experiment
 *    would be measuring the difference in access rather than the difference in
 *    behavior.
 *
 * 2. PLACEMENT WORKS. `topology({ players })` names the seat each participant
 *    will occupy, so an experiment can put a bot on a hub or on a leaf. This is
 *    the independent variable in Shirado & Christakis (2017), so a package that
 *    could not express it could not reconstruct the paper.
 *
 * 3. A BOT IS VISIBLE AT THE WIRE, AND SO IS EVERY HUMAN. Classic writes
 *    `participantIdentifier` — the raw `?participantKey=` — immutably on the
 *    player scope, and links every participant to every player node. So every
 *    co-player receives it. That is upstream's and it is why
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
import { networkGraphOf, type NetworkGraphInfo } from "../../src/player/view.js";
import { ring, wheel } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  waitFor,
  withScenario,
  type AdminHandle,
  type Participant,
} from "../../src/harness/harness.js";

const HUMANS = 2;
const BOTS = 2;
const N = HUMANS + BOTS;

/**
 * The bot identifiers, held by BOTH processes.
 *
 * In a real study the runner is a separate process and this list is how the
 * server knows which players are bots — see `docs/BOTS.md`. Timestamp-shaped
 * because that is what Empirica's own client generates, so nothing about them
 * says "bot"; the server recognizes them by holding the list, not by reading a
 * pattern, which is the only arrangement that survives claim 3 above.
 */
const BOT_KEYS = ["1755000000001", "1755000000002"];
const isBot = (player: any) => BOT_KEYS.includes(player?.get("participantIdentifier"));

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const stateOf = (p: { mode: unknown }) => networkStateOf(modeOf(p).nbhd.getValue());
const idOf = (p: { mode: unknown }) => modeOf(p).player.getValue()!.id;
const neighborsOf = (p: { mode: unknown }) =>
  (modeOf(p).nbhd.getValue()?.neighbors ?? []) as { id: string; mark?: string }[];

test.beforeEach(() => resetChannels());

/**
 * A star centered on the first bot, when there is one; otherwise on seat 0.
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
 * that the bot receives its neighbors' VALUES through the projection. Recording
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
async function seatEveryone(
  admin: AdminHandle,
  humans: { mode: unknown }[],
  run: BotRun,
  n = N
) {
  const batch = await createBatch(admin, batchConfig(n, 1));
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

/**
 * The scheme check, and the one test in this file that needs no server.
 *
 * `url` is the HTTP endpoint: Tajriba derives the websocket address from it and
 * rejects anything already carrying a websocket scheme by throwing the bare
 * STRING "invalid URL" — no stack, no frame in this package, and the reported
 * stack shows only Node's ESM loader. The docs said `ws://` for a release and
 * the suite never noticed, because every test here passes `server.url`, which is
 * http. So the documented-and-wrong string is asserted directly.
 */
test("a websocket url is rejected with a real Error, not Tajriba's bare string", async () => {
  await assert.rejects(
    () => runBots({ url: "ws://localhost:3000/query", identifiers: BOT_KEYS, policy: {} }),
    (err: unknown) =>
      err instanceof Error &&
      /http:\/\//.test(err.message) &&
      err.message.includes("ws://localhost:3000/query"),
    "ws:// must name the fix"
  );

  // The check runs before identifier validation: a run with both problems should
  // report the one that is otherwise undiagnosable.
  await assert.rejects(
    () => runBots({ url: "wss://example.org/query", identifiers: ["dup", "dup"], policy: {} }),
    (err: unknown) => err instanceof Error && /must start with http/.test(err.message)
  );
});

test("bots play a real game: they seat it, they are placed, and their writes project", async () => {
  const Empirica = new ClassicListenersCollector();
  Empirica.onGameStart(({ game }) => {
    const round = game.addRound({ name: "r" });
    round.addStage({ name: "s", duration: 600 });
  });
  withNetwork(Empirica, {
    topology: starOnFirstBot(),
    project: (neighbor: any, _viewer: any, ctx: any) => ({
      id: neighbor.id,
      mark: ctx.stateOf(neighbor).get("mark"),
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
          const view = neighborsOf(p).map((nb) => nb.id);
          assert.deepEqual(
            view,
            [hubBot],
            "each human is a leaf whose single neighbor is the bot we placed centrally"
          );
        }
        await waitFor(() => (seen.get(BOT_KEYS[0]!) ?? []).length === N - 1, {
          label: "the central bot sees everyone else",
          timeoutMs: 30_000,
        });

        // --- claim 1: a bot reads and writes like a participant -----------
        // The bot's write reached its neighbors through project(), which is the
        // only path there is.
        await waitFor(
          () => participants.every((p) => neighborsOf(p)[0]?.mark === `MARK-${BOT_KEYS[0]}`),
          { label: "the bot's private write reached its neighbors", timeoutMs: 30_000 }
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

test("a co-player's recruitment identifier is on the wire", async () => {
  // The measurement `src/bots/identity.ts` is built around. In a deployed study
  // `participantKey` is the Prolific PID or another recruitment-platform
  // identifier, so this is not
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
          "expected the OTHER HUMAN's recruitment identifier on this participant's wire"
        );
        for (const key of BOT_KEYS) {
          assert.ok(
            wire.includes(key),
            `expected bot identifier ${key} on a human's wire. If this ever fails, the leak has ` +
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

/**
 * A bot at radius 1.5 sees what the humans around it see.
 *
 * The asymmetry `ISSUES.md` O20 named: `BotContext` had four accessors and a
 * browser had five, so at that radius a human could tell which of their
 * connections knew each other and an artificial participant in the same seat
 * could not. That is not cosmetic in the designs bots exist for — Shirado &
 * Christakis seat theirs centrally and vary their noise, and a bot that cannot
 * see what surrounds it is not a control for the people who can.
 *
 * `wheel` at n=4 is the complete graph, so every participant's neighborhood
 * contains a triangle and both halves of the comparison have something to show.
 * That also means this says nothing about neighbor-limiting — `leak.test.ts`
 * and `subgraph.test.ts` make that claim on graphs that have a non-neighbor to
 * withhold. What is asserted here is symmetry between the two kinds of
 * participant, which is the thing that was missing.
 */
test("a bot at radius 1.5 is shown the same structure a human is", async () => {
  const Empirica = new ClassicListenersCollector();
  Empirica.onGameStart(({ game }) => {
    const round = game.addRound({ name: "r" });
    round.addStage({ name: "s", duration: 600 });
  });
  withNetwork(Empirica, {
    topology: ({ playerCount }: any) => wheel(playerCount),
    project: (neighbor: any) => ({ id: neighbor.id }),
    graph: { radius: 1.5 },
  });

  /** What each bot's own `ctx.structure()` reported, most recent wins. */
  const botStructure = new Map<string, NetworkGraphInfo | null | undefined>();
  const policy: BotPolicy<{ id: string }> = {
    onStart(ctx) {
      botStructure.set(ctx.identifier, ctx.structure());
    },
    onView(ctx) {
      botStructure.set(ctx.identifier, ctx.structure());
    },
  };

  await withScenario(
    { n: HUMANS, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const run = await runBots({
        url: server.url,
        identifiers: BOT_KEYS,
        policy,
      });
      try {
        await seatEveryone(admin, participants, run);
        await waitFor(() => [...botStructure.values()].filter(Boolean).length === BOTS, {
          label: "every bot reported a structure",
          timeoutMs: 30_000,
        });

        const beyondStar = (g: NetworkGraphInfo) =>
          g.edges.filter(([a, b]) => a !== 0 && b !== 0).length;

        for (const [identifier, g] of botStructure) {
          assert.ok(g, `${identifier}: a bot at radius 1.5 must be shown a structure`);
          assert.equal(g.radius, 1.5, `${identifier}: and it must say which radius it is`);
          assert.ok(
            beyondStar(g) > 0,
            `${identifier}: was shown only its own star, which is what radius 1 draws`
          );
        }

        // The other half of the comparison. Without it this passes on a run
        // where the humans were shown nothing either, which would be a
        // different bug wearing the same green.
        for (const p of participants) {
          const human = networkGraphOf(modeOf(p).nbhd.getValue());
          assert.ok(human, "a human in the same game must be shown one too");
          assert.equal(human.radius, 1.5);
          assert.ok(beyondStar(human) > 0, "including ties beyond their own star");
          assert.equal(
            human.positions.length,
            (modeOf(p).nbhd.getValue()?.neighbors.length ?? 0) + 1,
            "one position per delivered node, plus their own"
          );
        }
      } finally {
        await run.stop();
      }
    }
  );
});

/**
 * A bot above radius 1.5, where the payload contains people it cannot reach.
 *
 * `docs/BOTS.md` documents the boundary a policy has to mind — `ctx.neighbors()`
 * is distance 1 and only distance 1, while `ctx.structure().edges` can name
 * nodes past the end of it — and nothing exercised a bot that actually receives
 * one. The documentation was ahead of the coverage, which is the wrong way
 * round for a claim about what an artificial participant can see.
 *
 * A ring of 6 rather than the wheel the 1.5 test uses: a wheel has diameter 2,
 * so every radius-2 ball is the whole graph and there is nobody at a distance to
 * be named. On the ring each participant has two neighbors and two people two
 * hops away, and seat 2 is two hops from BOTH seat 0 and seat 4 — which is what
 * lets this check that two bots give the same person different names.
 */
const WIDE_KEYS = ["1755000000101", "1755000000102", "1755000000103"];
const WIDE_HUMANS = 3;
const WIDE_N = WIDE_HUMANS + WIDE_KEYS.length;

test("a bot at radius 2 is shown the people it cannot reach, and names them privately", async () => {
  const Empirica = new ClassicListenersCollector();
  Empirica.onGameStart(({ game }) => {
    const round = game.addRound({ name: "r" });
    round.addStage({ name: "s", duration: 600 });
  });
  withNetwork(Empirica, {
    topology: ({ playerCount }: any) => ring(playerCount),
    project: (neighbor: any) => ({ id: neighbor.id }),
    graph: { radius: 2 },
  });

  const seen = new Map<string, { structure: NetworkGraphInfo | null | undefined; neighbors: number }>();
  // Captured in BOTH hooks, as the radius 1.5 test does and for the reason that
  // one does not spell out: on a static graph there is exactly one publish, the
  // byte-identical check suppresses everything after it, and a policy that only
  // listens for `onView` therefore never hears anything. `onStart` is where the
  // structure actually arrives.
  const record = (ctx: {
    identifier: string;
    structure: () => NetworkGraphInfo | null | undefined;
    neighbors: () => unknown[] | undefined;
  }) =>
    seen.set(ctx.identifier, {
      structure: ctx.structure(),
      // Read in the same tick as the structure, because the claim below is that
      // the two disagree on their node sets BY DESIGN.
      neighbors: (ctx.neighbors() ?? []).length,
    });

  const policy: BotPolicy<{ id: string }> = {
    onStart: record,
    onView: record,
  };

  await withScenario(
    { n: WIDE_HUMANS, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
    async ({ server, admin, participants }) => {
      const run = await runBots({ url: server.url, identifiers: WIDE_KEYS, policy });
      try {
        await seatEveryone(admin, participants, run, WIDE_N);
        await waitFor(
          () => [...seen.values()].filter((v) => v.structure).length === WIDE_KEYS.length,
          { label: "every bot reported a structure", timeoutMs: 30_000 }
        );

        const humanIDs = new Set(
          participants.map((p) => modeOf(p).nbhd.getValue()!.playerID as string)
        );
        const refsByViewer = new Map<string, Set<string>>();

        for (const [identifier, { structure, neighbors }] of seen) {
          assert.ok(structure, `${identifier}: a bot at radius 2 must be shown a structure`);
          assert.equal(structure.radius, 2);

          const far = structure.far ?? [];
          assert.equal(far.length, 2, `${identifier}: a ring puts two people two hops away`);
          assert.ok(far.every((f) => f.d === 2));

          // THE BOUNDARY `docs/BOTS.md` warns a policy about. The structure names
          // more nodes than `neighbors()` has entries, on purpose: a policy that
          // indexes one by the other walks off the end, and it is the same
          // boundary a human in that seat sees rather than an inconsistency.
          assert.equal(neighbors, 2, `${identifier}: neighbors() is distance 1 only`);
          assert.equal(
            structure.positions.length,
            neighbors + far.length + 1,
            `${identifier}: the picture is larger than the neighbor list, which is the point`
          );

          // A bot gets a name, not an identity — the same rule a browser is held
          // to. A bot is a participant process and there is no server-side back
          // door; this is the assertion that says so at this radius.
          for (const f of far) {
            assert.ok(!humanIDs.has(f.ref), `${identifier} was handed a real player id`);
            assert.match(f.ref, /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/);
          }
          refsByViewer.set(identifier, new Set(far.map((f) => f.ref)));
        }

        // No two bots share a name for anybody. On a ring of 6 each person is two
        // hops from two others, so some person IS seen by two of these viewers —
        // and they must still have nothing in common to compare.
        const all = [...refsByViewer.entries()];
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const shared = [...all[i]![1]].filter((r) => all[j]![1].has(r));
            assert.deepEqual(
              shared,
              [],
              `${all[i]![0]} and ${all[j]![0]} share a name, so they could align their screens`
            );
          }
        }

        // And the other half: a human in the same game is shown the same shape.
        // Without this the test passes on a run where nobody was shown anything,
        // which is a different bug wearing the same green.
        for (const p of participants) {
          const human = networkGraphOf(modeOf(p).nbhd.getValue());
          assert.ok(human, "a human in the same game must be shown one too");
          assert.equal(human.radius, 2);
          assert.equal((human.far ?? []).length, 2, "the same two people, by the same rule");
        }
      } finally {
        await run.stop();
      }
    }
  );
});
