/**
 * The bot runner: N headless participants, each running a policy.
 *
 * A bot is a real participant. It opens a real Tajriba session, runs the real
 * `EmpiricaNetwork` mode, reads its neighbors out of a real private channel and
 * writes with the same `state.set()` a browser uses. There is no server-side
 * shortcut anywhere in this file, and that is the point rather than a
 * restriction — see the note at the top of `./policy.ts`.
 *
 * Built on `../harness/compat.ts` deliberately, not on a second copy of the same
 * three calls. That file is the one place every contract with `@empirica/core`
 * lives, so a version bump that breaks a bot breaks it in the same place it
 * breaks the harness, and gets fixed once.
 *
 * NOTE: this module imports `@empirica/core/admin` (for `TajribaConnection`) and
 * therefore cannot be loaded from bare Node ESM — `docs/PLATFORM-NOTES.md` §3a.
 * It ships as a bundled CJS artifact for exactly that reason; see `tsup.config.ts`
 * and `docs/BOTS.md`.
 */
import { TajribaConnection } from "@empirica/core/admin";
import { hashSeed, makeRng, type Rng } from "../admin/seed.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../player/mode.js";
import { networkStateOf } from "../player/state.js";
import { networkSelfOf, networkToldOf } from "../player/view.js";
import { makeSharedProvider, openParticipantSession } from "../harness/compat.js";
import { waitForValue } from "../shared/wait.js";
import { assertIdentifiers, botMarkerWarning } from "./identity.js";
import { botPhase, stallMessage, type BotObservation, type BotPhase } from "./lifecycle.js";
import type { BotContext, BotPolicy } from "./policy.js";

export interface BotRunOptions<T = unknown> {
  /**
   * Tajriba endpoint, e.g. `http://localhost:3000/query`.
   *
   * The HTTP address, not the websocket one: Tajriba derives `ws://`/`wss://`
   * from it itself, and rejects a url that already carries a websocket scheme.
   */
  url: string;
  /**
   * One identifier per bot. The list IS the count.
   *
   * Required rather than defaulted to `n`, because the identifiers are a design
   * decision with a privacy consequence and the server usually needs the same
   * list — see `./identity.ts`. `botIdentifiers(n)` generates development-shaped
   * ones when that is genuinely all you need.
   */
  identifiers: string[];
  policy: BotPolicy<T>;
  /**
   * Seed for the per-bot random streams. Default 1.
   *
   * Fixed rather than time-derived on purpose: a default that changed every run
   * would make bot behavior irreproducible by default, which is the failure the
   * topology seed exists to prevent, one layer up.
   */
  seed?: number;
  /**
   * Where log records go. Default: one JSON line per record on stdout.
   *
   * Records carry `at`, `identifier` and `type`; anything a policy passes to
   * `ctx.log()` is merged in. Point it at a file stream to get the bot half of a
   * study's run log.
   */
  log?: (record: Record<string, unknown>) => void;
  /**
   * How often the lifecycle is re-read, in ms. Default 250.
   *
   * POLLED, and not because nobody thought of subscribing. The mode's
   * `BehaviorSubject`s carry scope objects whose attributes are mutated in place,
   * so `player.get("gameID")` changing does not push a new value to any
   * subscriber — this is the same property that makes every e2e test in this
   * repository use `waitFor` rather than a subscription. A handful of `.get()`s
   * four times a second per bot is not a measurable cost next to the game.
   *
   * The POLICY is not polled. `onView` is driven by the server's publish counter,
   * so a bot wakes when its view actually changed.
   */
  pollMs?: number;
  /**
   * Warn when a bot has sat in one non-playing phase this long, in ms. Default 30_000.
   *
   * Once per (bot, phase), not once per poll. The alternative to warning is what
   * this cost three debugging sessions to learn: a bot that never plays is
   * completely silent, and the study just never starts.
   */
  stallMs?: number;
}

/** A running fleet. */
export interface BotRun {
  /** The identifiers actually in use, in bot order. The server needs these. */
  readonly identifiers: readonly string[];
  /** Player id per bot, once assigned — the id space `project()` works in. */
  playerIDs(): (string | undefined)[];
  /** Current phase per bot. The first thing to look at when a study will not start. */
  phases(): BotPhase[];
  /** Disconnect every bot. Safe to call twice. */
  stop(): Promise<void>;
}

/** One bot's mutable state. Everything here is per-participant and per-game. */
interface BotState<T> {
  identifier: string;
  index: number;
  mode: EmpiricaNetworkContext;
  rng: Rng;
  stop: () => void;
  /** The game this bot is currently considered to be in. */
  gameID: string | undefined;
  /** Has `onStart` fired for `gameID`? */
  started: boolean;
  /** Last `_seq` the policy was shown, so `onView` fires on change and not on tick. */
  lastSeq: number | undefined;
  /** `Date.now()` of the first publish in this game. */
  publishedAt: number | undefined;
  phase: BotPhase;
  phaseSince: number;
  stallWarned: boolean;
  tick: ReturnType<typeof setInterval> | undefined;
}

/**
 * Connect the bots and start playing. Resolves once every bot has a session.
 *
 * Resolving at connect rather than at game end is what lets one fleet play a
 * whole batch: Classic reassigns a participant to a new game when the old one
 * ends, and the runner follows that — `onEnd` then `onStart` — rather than
 * treating the first game as the process's reason to exist. A study of thirty
 * sessions starts the runner once.
 */
export async function runBots<T = unknown>(opts: BotRunOptions<T>): Promise<BotRun> {
  const { url, identifiers, policy } = opts;
  // Checked here, and first, because this is the one bad argument that produces
  // no usable diagnosis downstream. Tajriba accepts only an HTTP address and
  // derives the websocket one from it; anything else makes it `throw "invalid
  // URL"` — a bare string, so it carries no stack, and the report shows only
  // Node's ESM loader with no frame in this package or the caller's.
  if (!/^https?:\/\//.test(url)) {
    throw new Error(
      `empirica-networks: url must start with http:// or https:// (got ${JSON.stringify(url)}). ` +
        "Tajriba derives the websocket address itself, so pass the HTTP endpoint: " +
        "http://localhost:3000/query."
    );
  }
  assertIdentifiers(identifiers);
  if (policy.onTick && !(typeof policy.tickMs === "number" && policy.tickMs > 0)) {
    throw new Error(
      "empirica-networks: a policy with onTick must set tickMs. Without it the tick " +
        "would never fire and a time-driven bot would simply never act, which is the " +
        "one failure mode that produces no error at all."
    );
  }

  const seed = opts.seed ?? 1;
  const pollMs = opts.pollMs ?? 250;
  const stallMs = opts.stallMs ?? 30_000;
  const emit =
    opts.log ??
    ((record: Record<string, unknown>) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(record));
    });
  const log = (identifier: string, record: Record<string, unknown>) =>
    emit({ at: Date.now(), identifier, ...record });

  const marker = botMarkerWarning(identifiers);
  if (marker) {
    // eslint-disable-next-line no-console
    console.warn(marker);
    emit({ at: Date.now(), type: "warning", warning: marker });
  }

  const bots: BotState<T>[] = [];
  for (const [index, identifier] of identifiers.entries()) {
    const conn = new TajribaConnection(url);
    await waitForValue(conn.connected, true, `bot ${identifier} socket connect`);
    await waitForValue(conn.connecting, false, `bot ${identifier} connect settle`);
    const part = await openParticipantSession(conn, identifier);
    // `record: false`: a bot never reads its own wire, and retaining every frame
    // for a five-minute session times three bots is a leak with no reader.
    const { provider } = makeSharedProvider(conn, part);
    const mode = EmpiricaNetwork(part.id, provider);

    bots.push({
      identifier,
      index,
      mode,
      // Seeded from the identifier, not the index: reusing the same identifiers
      // replays the same behavior even if the fleet is started in a different
      // order, and two studies with different bot counts do not silently share
      // bot 0's stream.
      rng: makeRng(hashSeed(identifier, seed)),
      stop: () => {
        try {
          part.stop?.();
        } catch {
          /* already gone */
        }
        conn.stop();
      },
      gameID: undefined,
      started: false,
      lastSeq: undefined,
      publishedAt: undefined,
      phase: "connecting",
      phaseSince: Date.now(),
      stallWarned: false,
      tick: undefined,
    });
    log(identifier, { type: "connect", participantID: part.id });
  }

  // ---------------------------------------------------------------- context

  const contextFor = (bot: BotState<T>): BotContext<T> => {
    const nbhd = () => bot.mode.nbhd.getValue();
    return {
      identifier: bot.identifier,
      index: bot.index,
      playerID: bot.mode.player.getValue()?.id,
      gameID: bot.gameID,
      neighbors: () => {
        const n = nbhd();
        return n && n.published ? (n.neighbors as T[]) : undefined;
      },
      self: () => networkSelfOf(nbhd()),
      state: () => networkStateOf(nbhd()),
      told: () => networkToldOf(nbhd()),
      elapsedMs: () => (bot.publishedAt === undefined ? 0 : Date.now() - bot.publishedAt),
      rng: bot.rng,
      log: (record) => log(bot.identifier, { gameID: bot.gameID, ...record }),
      submit: () => {
        const stage = bot.mode.player.getValue()?.stage;
        if (!stage) {
          log(bot.identifier, {
            type: "warning",
            warning: "submit() with no current stage; ignored",
          });
          return;
        }
        stage.set("submit", true);
      },
    };
  };

  /**
   * Run one hook.
   *
   * Swallowing the throw is the same call `withNetwork` makes for
   * `onPrivateState` and for the same reason: one bot's policy failing must not
   * take the fleet down, because a fleet one bot short leaves the game one
   * player short of its count and it never starts. Logged with the stack, so it
   * is swallowed rather than hidden.
   */
  const fire = (bot: BotState<T>, hook: keyof BotPolicy, ctx: BotContext<T>) => {
    const fn = policy[hook];
    if (typeof fn !== "function") return;
    try {
      (fn as (c: BotContext<T>) => void)(ctx);
    } catch (e) {
      log(bot.identifier, {
        type: "policyError",
        hook,
        gameID: bot.gameID,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  };

  // ---------------------------------------------------------------- lifecycle

  const endGame = (bot: BotState<T>) => {
    if (bot.tick !== undefined) {
      clearInterval(bot.tick);
      bot.tick = undefined;
    }
    if (bot.started) {
      fire(bot, "onEnd", contextFor(bot));
      log(bot.identifier, { type: "gameEnd", gameID: bot.gameID });
    }
    bot.started = false;
    bot.lastSeq = undefined;
    bot.publishedAt = undefined;
  };

  const observe = (bot: BotState<T>): BotObservation => {
    const player = bot.mode.player.getValue();
    const nbhd = bot.mode.nbhd.getValue();
    const gameID = player?.get("gameID");
    return {
      hasPlayer: Boolean(player),
      gameID: typeof gameID === "string" ? gameID : undefined,
      introDone: Boolean(player?.get("introDone")),
      published: Boolean(nbhd?.published),
      ended: Boolean(player?.get("ended")),
      exitStatus: player?.get("exitStatus"),
    };
  };

  const step = (bot: BotState<T>) => {
    const obs = observe(bot);
    const phase = botPhase(obs);

    if (phase !== bot.phase) {
      log(bot.identifier, { type: "phase", from: bot.phase, to: phase, gameID: obs.gameID });
      bot.phase = phase;
      bot.phaseSince = Date.now();
      bot.stallWarned = false;
    } else if (!bot.stallWarned) {
      const msg = stallMessage(bot.identifier, phase, Date.now() - bot.phaseSince);
      if (msg && Date.now() - bot.phaseSince >= stallMs) {
        bot.stallWarned = true;
        // eslint-disable-next-line no-console
        console.warn(msg);
        log(bot.identifier, { type: "stall", phase, message: msg });
      }
    }

    // A new assignment, or the loss of one. Both end whatever game was running:
    // Classic clears `gameID` when it unassigns a player it did not seat, and
    // reassigns to a new game when a batch has more than one.
    if (obs.gameID !== bot.gameID) {
      endGame(bot);
      bot.gameID = obs.gameID;
      if (obs.gameID !== undefined) log(bot.identifier, { type: "assigned", gameID: obs.gameID });
    }

    if (phase === "ended") {
      endGame(bot);
      return;
    }

    // The bot's one player-scope write, and the only one it ever makes.
    // `introDone` is what every human's client writes at the end of the intro
    // steps; without it the game never reaches its player count.
    if (phase === "intro") {
      bot.mode.player.getValue()?.set("introDone", true);
      return;
    }

    if (phase !== "playing") return;

    const nbhd = bot.mode.nbhd.getValue();
    const seq = nbhd?.seq;

    if (!bot.started) {
      bot.started = true;
      bot.publishedAt = Date.now();
      bot.lastSeq = seq;
      const ctx = contextFor(bot);
      log(bot.identifier, {
        type: "gameStart",
        gameID: bot.gameID,
        playerID: ctx.playerID,
        degree: ctx.self()?.degree,
      });
      fire(bot, "onStart", ctx);
      if (policy.onTick && policy.tickMs) {
        bot.tick = setInterval(() => fire(bot, "onTick", contextFor(bot)), policy.tickMs);
        // A tick that keeps a finished process alive is a hang, not a bot.
        bot.tick.unref?.();
      }
      // `onStart` and `onView` both firing on the first publish would run an
      // opening move twice. The first view is `onStart`'s.
      return;
    }

    if (seq !== bot.lastSeq) {
      bot.lastSeq = seq;
      fire(bot, "onView", contextFor(bot));
    }
  };

  const poll = setInterval(() => {
    for (const bot of bots) {
      try {
        step(bot);
      } catch (e) {
        log(bot.identifier, {
          type: "runnerError",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }, pollMs);
  poll.unref?.();

  let stopped = false;
  return {
    identifiers: [...identifiers],
    playerIDs: () => bots.map((b) => b.mode.player.getValue()?.id),
    phases: () => bots.map((b) => b.phase),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      for (const bot of bots) {
        if (bot.tick !== undefined) clearInterval(bot.tick);
        try {
          bot.stop();
        } catch {
          /* best effort */
        }
      }
      log("-", { type: "stopped", bots: bots.length });
    },
  };
}
