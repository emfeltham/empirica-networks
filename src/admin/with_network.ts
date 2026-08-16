import { TajribaEvent } from "@empirica/core/admin";
import { warn } from "@empirica/core/console";
import {
  NBHD_KEYS,
  NBHD_KIND,
  NETWORK_KEYS,
  OUTBOX_KEY,
  stateKey,
  type ChatMessage,
  type EdgeEvent,
  type ViewRecord,
} from "../shared/keys.js";
import { adjacency, fromEdgeList, ring, type Edge } from "../topology/index.js";
import { checkDegrees, checkViewBytes, type EnvelopeLimits } from "./envelope.js";
import { graphMetrics, historyFrames, type GameSnapshot, type NodeSnapshot } from "./inspect.js";
import { projectionBytes, validateProjection } from "./projection.js";
import {
  adoptChannel,
  pendingChannelsMessage,
  provisionChannels,
  readChannels,
  releaseChannels,
} from "./provision.js";
import { recordReads, unwatchedKeys, unwatchedKeysMessage } from "./reads.js";
import { hashSeed, makeRng, type Rng } from "./seed.js";
import { makeViewSink, type ViewsConfig } from "./views.js";

/**
 * withNetwork: wires network projection into an Empirica experiment.
 *
 * Publishing goes through `scope.set()` on a participant's private channel,
 * because `EventContext` has no `setAttributes` — the only write path available
 * inside a listener is a modelled scope (docs/PLATFORM-NOTES.md §5). That is
 * also why the `nbhd` kind must be registered by the consumer: without it we
 * have nothing to call `.set()` on.
 *
 * The runloop coalesces every `set()` made during one callback into a single
 * `setAttributes` RPC (admin/runloop.ts:199-226), so publishing to n
 * participants costs one round trip, not n.
 */

/** Read-only view of one participant's private, self-written state. */
export interface StateReader {
  get<T = unknown>(key: string): T | undefined;
}

export interface ProjectContext {
  game: any;
  /** Index of the viewer in the topology. */
  viewerIndex: number;
  /** Index of the neighbour in the topology. */
  neighbourIndex: number;
  /**
   * A player's PRIVATE state — what they wrote to their own channel.
   *
   * Use this, not `player.get(...)`, for anything that must stay within the
   * neighbourhood. A player attribute is broadcast to every participant, so
   * projecting one restricts nothing; only values written to a private channel
   * are actually neighbour-limited.
   */
  stateOf(player: any): StateReader;
}

export interface NetworkConfig {
  /**
   * Build the network at game start. Receives a seeded rng so the realisation
   * is reproducible from the seed recorded on the game scope.
   */
  topology?: (args: { game: any; playerCount: number; rng: Rng }) => Edge[];
  /**
   * What ONE participant may learn about ONE neighbour.
   *
   * Pure, and the only channel through which data reaches a client. There is
   * deliberately no way for an author to choose where this is written: the
   * obvious alternative (writing to the player scope) is broadcast to everyone
   * and looks like it works.
   */
  project?: (neighbour: any, viewer: any, ctx: ProjectContext) => unknown;
  /** Explicit seed. Defaults to one derived from the game id. */
  seed?: number;
  /**
   * Limits on what may be published. Enforced by default; see `./envelope.ts`
   * for what each number rests on.
   */
  envelope?: EnvelopeLimits;
  /**
   * Player attribute keys that feed `project()`.
   *
   * A change to any of them republishes the views that can see it. Empirica has
   * no wildcard attribute listener, so this list cannot be inferred — but
   * `project()` runs against a recording proxy, so anything it reads that is
   * missing here is reported rather than silently going stale.
   *
   * Leave it empty for a static network whose projection never changes.
   */
  watch?: string[];
  /**
   * Neighbour-scoped chat.
   *
   * Off by default: it costs a listener and per-channel storage, and most
   * designs do not want it. `true` uses the defaults below.
   *
   * A message written by a participant to their own channel is fanned out by the
   * server to whoever is their neighbour AT THAT MOMENT. There is no separate
   * privacy path — it is the same channel, a different key — which is the same
   * reason `project()` is the only route for state.
   */
  chat?: boolean | ChatConfig;
  /**
   * Record what each participant was actually shown.
   *
   * Off by default, and opt-in rather than always-on for one reason: views are
   * published `ephemeral`, so this is the only part of the system that leaves no
   * durable trace, and keeping it is a storage cost a study should choose
   * knowingly. See `./views.ts`.
   *
   * Worth turning on when `project()` does anything beyond passing values
   * through — bucketing, adding noise, keying off `stateOf()` — because then the
   * delivered view is not recoverable from the edge log and the attribute export
   * afterwards. Also the audit trail for the neighbour-limited claim on a real
   * study's own data, rather than on this package's tests.
   */
  views?: ViewsConfig;
}

export interface ChatConfig {
  /**
   * Messages retained per participant. Default 200.
   *
   * Capped because the channel is server memory and wire payload: an
   * uncapped log grows for the life of the game and is re-sent whenever the
   * attribute changes. Raise it if your design needs a full transcript, and
   * note that the transcript is also in the recipient's stored attributes
   * regardless.
   */
  history?: number;
}

const defaultTopology = ({ playerCount, rng }: { playerCount: number; rng: Rng }) =>
  playerCount >= 3 ? ring(playerCount, { rng }) : [];

const defaultProject = (neighbour: any) => ({ id: neighbour.id });

/** Per-game network state, server-side only. */
interface NetworkState {
  /** Mutable: rewiring replaces this in place. */
  edges: Edge[];
  adj: number[][];
  /** player id in topology order */
  order: string[];
  seed: number;
}

/**
 * What this instance is currently holding in memory.
 *
 * Exposed because the alternative way to check that a finished game was released
 * is to watch a heap graph and squint, which is neither a test nor an answer.
 * `npm run soak` prints these alongside RSS.
 */
export interface NetworkStats {
  /** Games being tracked. Should be the number currently RUNNING, not started. */
  games: number;
  /** Channel ids indexed, summed across tracked games. */
  channels: number;
  /** Materialised channel scope objects held. */
  channelScopes: number;
  /** Cached serialised views, one per channel published to. */
  cachedViews: number;
}

export interface NetworkHandle {
  /** Recompute and republish every participant's view. */
  publishAll(): boolean;
  /** Live counts of everything held per game or per channel. */
  stats(): NetworkStats;
  /** Ids of the games currently networked by this process. */
  games(): string[];
  /**
   * Everything known about one game's network, as plain data.
   *
   * Returns `undefined` for a game this process is not networking — which is
   * the honest answer for a game that has ended, was never started, or was lost
   * to a restart (U2). It is deliberately NOT an empty snapshot: an observer
   * cannot tell an empty graph from a missing one, and this package's
   * characteristic failure is exactly that confusion.
   *
   * READ ONLY, and safe to call from anywhere — a timer, an HTTP handler, a
   * REPL. Writes are the thing that only count inside a callback
   * (docs/PLATFORM-NOTES.md §15); nothing here writes.
   */
  inspect(gameID: string): GameSnapshot | undefined;
}

export function withNetwork(collector: any, config: NetworkConfig = {}): NetworkHandle {
  const topology = config.topology ?? defaultTopology;
  const project = config.project ?? defaultProject;

  const watch = config.watch ?? [];
  const chatEnabled = Boolean(config.chat);
  const chatHistory =
    (typeof config.chat === "object" ? config.chat.history : undefined) ?? 200;
  /** playerID -> highest outbox seq already relayed, so a republish cannot duplicate. */
  const lastOutbox = new Map<string, number>();
  const viewSink = makeViewSink(config.views);

  const networks = new Map<string, NetworkState>();
  /** nbhd scope id -> the modelled scope object we can call .set() on. */
  const channelScopes = new Map<string, any>();
  /** games waiting for their channel scopes to materialise before first publish */
  const awaitingPublish = new Set<string>();
  /** games networked by a previous process, waiting for their channels to arrive */
  const recovering = new Set<string>();
  /** gameID -> (topology index -> playerID), rebuilt from the channels themselves */
  const recoveredOrder = new Map<string, Map<number, string>>();
  const games = new Map<string, any>();
  const seqByGame = new Map<string, number>();
  /** nbhd scope id -> last published view, serialised. Suppresses no-op writes. */
  const lastPublished = new Map<string, string>();
  /** Keys already warned about, so the hot path warns once rather than per publish. */
  const reportedMissing = new Set<string>();
  /**
   * Games known to be over.
   *
   * Ids only. This is the one thing deliberately NOT released, because it is
   * what stops a finished game's channels being re-adopted when the kind
   * subscription replays them. A string id per game is a few dozen bytes
   * against one Scope object per participant, so the trade is heavily
   * favourable — but it IS unbounded in the number of games a process runs,
   * which is stated here rather than left to be discovered.
   */
  const endedGames = new Set<string>();
  /**
   * Edge-mutation log per game, in memory and authoritative.
   *
   * NOT read back from the batch attribute on each append. Doing that is a
   * read-modify-write against a value the server also echoes, and two mutations
   * in quick succession can interleave so that the second reads a stale copy and
   * overwrites the first — losing an event silently, which for a rewiring study
   * corrupts the independent variable. Measured as a 1-in-6 flake before this
   * was made the source of truth. The attribute is a projection of this, not the
   * other way round.
   */
  const historyByGame = new Map<string, EdgeEvent[]>();

  /**
   * Subscribe the admin to channel scopes.
   *
   * Load-bearing specifically for reading what PARTICIPANTS write. Attribute
   * listeners subscribe nothing on their own: `subscribeAttribute(kind, key)`
   * merely dispatches over attributes the admin already holds. Creation-time
   * attributes arrive inside the `addScopes` response, which is why the OWNER
   * listener below fires and why publishing worked for a long time without
   * this — but a participant's later write is never delivered, and the listener
   * waiting for it simply never runs. Measured 2026-08-15;
   * docs/PLATFORM-NOTES.md §12.
   */
  collector.on("start", (ctx: any) => {
    ctx.scopeSub({ kinds: [NBHD_KIND] });
  });

  /**
   * Capture channel scope objects as they materialise.
   *
   * The owner attribute is immutable and set at creation, so this fires exactly
   * once per channel.
   */
  collector.on(NBHD_KIND, NBHD_KEYS.OWNER, (_ctx: any, payload: any) => {
    const scope = payload?.[NBHD_KIND];
    if (!scope?.id) return;
    channelScopes.set(scope.id, scope);

    // Re-adopt the channel rather than let provisioning create a second one.
    // On a normal start this simply re-records what we already know; after a
    // restart it is the whole recovery, because these attributes are the only
    // surviving copy of the index.
    const gameID = scope.get(NBHD_KEYS.GAME_ID);
    const playerID = scope.get(NBHD_KEYS.PLAYER_ID);
    if (typeof gameID === "string" && typeof playerID === "string") {
      // Channels outlive their game — Tajriba cannot delete scopes, so every
      // channel a batch ever created is still there and is replayed to any
      // process that subscribes to the kind. Adopting them all means a fresh
      // process loads every historical channel into memory before doing any
      // work, growing with the number of games the batch has ever run.
      //
      // Measured by `npm run soak` arm B: channelScopes climbed 8, 16, 24, 32
      // across sequential games while `games` stayed 0.
      if (endedGames.has(gameID)) {
        channelScopes.delete(scope.id);
        return;
      }
      adoptChannel(gameID, playerID, scope.id);
      const idx = scope.get(NBHD_KEYS.INDEX);
      if (typeof idx === "number" && idx >= 0) {
        const seats = recoveredOrder.get(gameID) ?? new Map<number, string>();
        seats.set(idx, playerID);
        recoveredOrder.set(gameID, seats);
      }
      const game = games.get(gameID);
      if (game && recovering.has(gameID)) tryRecover(game);
    }

    for (const gameID of [...awaitingPublish]) {
      const game = games.get(gameID);
      if (game && publishAll(game)) awaitingPublish.delete(gameID);
    }
  });

  /**
   * Release everything held for a game once it is over.
   *
   * Nine structures are keyed by game or by channel scope, and until this
   * existed none of them was ever dropped — including one Empirica `Scope`
   * object per participant per game. A server running a study of many
   * sequential games accumulated all of it for the life of the process.
   *
   * A game ends by `game.set("status", …)`; `hasEnded` covers `ended`,
   * `terminated` and `failed`, so a game that fails is released like any other.
   */
  collector.on("game", "status", (_ctx: any, { game }: any) => {
    if (!game?.hasEnded) return;
    releaseGame(game);
  });

  function releaseGame(game: any): void {
    endedGames.add(game.id);
    // Before anything else: a game ending is the last moment its records are
    // certainly still wanted, and the buffer would otherwise sit until the next
    // game filled it or the process exited.
    viewSink?.flush();
    gameNetworks.delete(game.id);
    historyByGame.delete(game.id);

    // Read the channel map BEFORE clearing it: the per-scope maps are keyed by
    // channel scope id, not by game, so this is the only way to find them.
    for (const scopeID of Object.values(readChannels(game))) {
      channelScopes.delete(scopeID);
      lastPublished.delete(scopeID);
    }
    releaseChannels(game.id);

    networks.delete(game.id);
    games.delete(game.id);
    seqByGame.delete(game.id);
    recoveredOrder.delete(game.id);
    awaitingPublish.delete(game.id);
    recovering.delete(game.id);
  }

  collector.on("game", "start", async (ctx: any, { game }: any) => {
    if (!game.get("start")) return;

    // A finished game must not be re-networked. This listener re-fires for
    // already-started games on restart (see below), and without this guard a
    // restarted process would recover and republish games that are over —
    // reviving state it had correctly released.
    //
    // `releaseGame` rather than a bare return: a fresh process has already
    // adopted this game's channels from the kind subscription, which replays
    // every channel a batch ever created regardless of whether its game is
    // over. Without this, restarting mid-batch loads every historical channel
    // and keeps it.
    if (game.hasEnded) {
      releaseGame(game);
      return;
    }

    games.set(game.id, game);

    // Already networked by a previous process.
    //
    // This listener re-fires on restart, because attribute listeners replay
    // attributes the admin already holds (PLATFORM-NOTES §12) and `start` is one
    // of them. Taking the normal path here is what made a restart destructive:
    // the topology got re-derived from `game.players` order — which is not
    // stable — so everyone was silently moved to a different node, and
    // provisioning, seeing an empty index, created a SECOND channel per
    // participant that the client never looked at.
    if (readSeed(game) !== undefined) {
      recovering.add(game.id);
      tryRecover(game);
      return;
    }

    const players = game.players ?? [];
    const seed = config.seed ?? hashSeed(String(game.id));
    const rng = makeRng(seed);
    const edges = topology({ game, playerCount: players.length, rng });
    const adj = adjacency(players.length, edges);

    // Before provisioning and before anything is recorded: an out-of-envelope
    // topology should fail while the experiment is still abandonable, not after
    // participants have been committed to a game that will run badly.
    checkDegrees(adj, config.envelope, warn);

    // Recorded so the exact realisation is reconstructible from stored data —
    // on the BATCH, because the game scope is delivered to every participant and
    // this is the seating plan of the network they are inside (PLATFORM-NOTES
    // §4c). Suffixed by game id since one batch holds many games.
    const batch = game.batch;
    if (!batch) {
      throw new Error(
        `empirica-networks: game ${game.id} has no batch, so the realised network cannot ` +
          `be recorded. Without it the run is not reproducible and cannot survive a restart.`
      );
    }
    batch.set(NETWORK_KEYS.seed(game.id), seed);
    batch.set(NETWORK_KEYS.network(game.id), edges);


    const order: string[] = players.map((p: any) => p.id);
    networks.set(game.id, { edges, adj, order, seed });
    // The initial graph goes into the log as a `start` event, so the log alone
    // describes the whole run. Without it, `edges.csv` would begin mid-story:
    // every tie present at game start would be missing, and a study that never
    // rewires would export an empty history.
    const startEvent: EdgeEvent = {
      op: "start",
      added: edges.map(([i, j]) => [order[i]!, order[j]!] as [string, string]),
      removed: [],
      size: edges.length,
      at: Date.now(),
    };
    historyByGame.set(game.id, [startEvent]);
    batch.set(NETWORK_KEYS.history(game.id), [startEvent]);

    gameNetworks.set(game.id, makeGameNetwork(game));

    const { pending } = await provisionChannels(ctx, game, (playerID) =>
      order.indexOf(playerID)
    );
    // A player with no participantID gets no channel, and `publish` refuses to
    // send a partial view — so one unprovisioned player blocks EVERY view in
    // the game, not just their own. That is the right call (a partial publish
    // leaves participants stale with no signal), but it must not be silent.
    if (pending.length > 0) warn(pendingChannelsMessage(pending, players.length));

    // Channel scopes arrive asynchronously via the listener above; if they are
    // not all present yet, publish once they are.
    if (!publishAll(game)) awaitingPublish.add(game.id);
  });

  /**
   * Republish when a watched attribute changes.
   *
   * One listener per key, registered here at setup, because Empirica dispatches
   * attribute listeners by `kind-key` and has no wildcard. A change to player P
   * republishes P's neighbours (they see P) and P itself (a projection may read
   * the viewer's own state). The byte-identical check in `publish` makes the
   * over-reach free on the wire.
   */
  for (const key of watch) {
    // (a) the player scope — public, broadcast to everyone by Classic.
    collector.on("player", key, (_ctx: any, props: any) => {
      const player = props?.player;
      if (player?.id) republishAround(player.id);
    });

    // (b) the participant's own private channel — the neighbour-limited path.
    //
    // One `watch` list covers both deliberately. Which scope a key lives on is
    // the author's choice and can change; making them remember two lists would
    // turn a moved key into silently frozen neighbourhoods. Registering a
    // listener for a key nobody uses costs nothing.
    collector.on(NBHD_KIND, stateKey(key), (_ctx: any, props: any) => {
      const scope = props?.[NBHD_KIND];
      const playerID = scope?.get?.(NBHD_KEYS.PLAYER_ID);
      if (typeof playerID === "string") republishAround(playerID);
    });
  }

  /**
   * Fan a message out to the sender's CURRENT neighbours.
   *
   * Registered only when chat is enabled. Reads the sender's own channel and
   * writes to each recipient's, so a participant never writes to anyone else's
   * scope — which matters because nothing would stop them if they tried
   * (PLATFORM-NOTES §4a), and building on that would be building on a bug.
   */
  if (chatEnabled) {
    collector.on(NBHD_KIND, stateKey(OUTBOX_KEY), (_ctx: any, props: any) => {
      const scope = props?.[NBHD_KIND];
      const from = scope?.get?.(NBHD_KEYS.PLAYER_ID);
      const gameID = scope?.get?.(NBHD_KEYS.GAME_ID);
      if (typeof from !== "string" || typeof gameID !== "string") return;

      const outbox = scope.get(stateKey(OUTBOX_KEY)) as
        | { seq?: number; text?: string; at?: number }
        | undefined;
      if (!outbox || typeof outbox.text !== "string" || typeof outbox.seq !== "number") return;

      // Attribute listeners can fire again for a value already handled — on
      // replay after a restart, for instance. Without this the same message is
      // delivered twice and the transcript misdescribes the conversation.
      if ((lastOutbox.get(from) ?? -1) >= outbox.seq) return;
      lastOutbox.set(from, outbox.seq);

      const state = networks.get(gameID);
      const game = games.get(gameID);
      if (!state || !game) return;
      const i = state.order.indexOf(from);
      if (i === -1) return;

      const message: ChatMessage = {
        from,
        text: outbox.text,
        seq: outbox.seq,
        at: typeof outbox.at === "number" ? outbox.at : Date.now(),
      };

      // The sender is included: a chat that does not show you your own message
      // needs the client to merge two sources, and merging is where ordering
      // bugs live.
      const channels = readChannels(game);
      const recipients = [i, ...(state.adj[i] ?? [])];
      for (const j of recipients) {
        const playerID = state.order[j];
        const target = playerID ? channelScopes.get(channels[playerID] ?? "") : undefined;
        if (!target) continue;
        const log = (target.get(NBHD_KEYS.CHAT) ?? []) as ChatMessage[];
        target.set(NBHD_KEYS.CHAT, [...log, message].slice(-chatHistory));
      }
    });
  }

  /**
   * Republish to a reconnecting participant.
   *
   * NOT LOAD-BEARING TODAY, and that is measured rather than assumed: with this
   * handler disabled, `test/e2e/publisher.test.ts` "a reconnecting participant
   * gets its view back" still passes. Tajriba replays current attribute values
   * to a returning participant even though views are written `ephemeral`
   * (docs/PLATFORM-NOTES.md §10).
   *
   * Kept anyway, because that replay is undocumented behaviour we found by
   * experiment, not a guarantee. If it ever stops, every reconnecting
   * participant silently goes blank — the exact class of failure this package
   * keeps running into. Fifteen lines and one no-op publish per connect is a
   * cheap hedge against it.
   *
   * The cache entry is dropped first so the byte-identical check cannot conclude
   * there is nothing to send: the server's copy would still be current even in
   * the case where the client had lost it.
   */
  collector.on(TajribaEvent.ParticipantConnect, async (ctx: any, props: any) => {
    const participantID = props?.participant?.id;
    if (!participantID) return;

    for (const [gameID, game] of games) {
      const state = networks.get(gameID);
      if (!state) continue;

      const players: any[] = game.players ?? [];
      const player = players.find((p) => p.participantID === participantID);
      if (!player) continue;

      // A player who had no participantID when the game started was reported as
      // `pending` and has no channel at all. Connecting is the moment that
      // becomes fixable, and it is the only moment: provisioning otherwise runs
      // once, at game start. `provisionChannels` is idempotent and provisions
      // only who is missing, so this costs one no-op call per connect.
      //
      // Whether Classic can actually produce such a player is unclear — it sets
      // `participantID` from an immutable attribute in its own `player`
      // listener, so players in `game.players` normally have one. This is a net
      // under a path we could not construct, not a fix for an observed failure.
      if (!readChannels(game)[player.id]) {
        await provisionChannels(ctx, game);
        if (!publishAll(game)) awaitingPublish.add(gameID);
        continue;
      }

      const scopeID = readChannels(game)[player.id];
      if (scopeID) lastPublished.delete(scopeID);
      publish(game, new Set([player.id]));
    }
  });

  /**
   * Publish participants' views.
   *
   * `only` limits which participants are recomputed. Passing undefined means
   * everyone, which is what game start and manual republishes want.
   *
   * Returns false if any channel scope has not materialised yet, having
   * published nothing — a partial publish would leave some participants with a
   * stale view and no signal that they are stale.
   */
  function publish(game: any, only?: Set<string>): boolean {
    const state = networks.get(game.id);
    if (!state) return false;

    const channels = readChannels(game);
    const players: any[] = game.players ?? [];
    const byID = new Map(players.map((p) => [p.id, p]));

    const targets: { scope: any; view: unknown[]; json: string; viewer: string }[] = [];
    const sizes: { bytes: number; label: string }[] = [];
    const readKeys = new Set<string>();

    for (const [i, playerID] of state.order.entries()) {
      const scopeID = channels[playerID];
      if (!scopeID) return false;
      const scope = channelScopes.get(scopeID);
      if (!scope) return false;

      const viewer = byID.get(playerID);
      if (!viewer) return false;

      // Completeness is still checked for everyone — a channel that has not
      // materialised must block the publish whether or not it is in `only`.
      if (only && !only.has(playerID)) continue;

      const neighbours: unknown[] = [];
      for (const j of state.adj[i] ?? []) {
        const neighbourID = state.order[j];
        const neighbour = neighbourID ? byID.get(neighbourID) : undefined;
        if (!neighbour) continue;

        const label = `${playerID}'s view of ${neighbourID}`;
        let view: unknown;
        try {
          // Recording proxies: whatever project() reads here is what the view
          // depends on, and therefore what has to be watched for it to stay
          // live. Both arguments are wrapped — a projection can key off the
          // viewer's own state as easily as the neighbour's.
          view = project(
            recordReads(neighbour, readKeys),
            recordReads(viewer, readKeys),
            {
              game,
              viewerIndex: i,
              neighbourIndex: j,
              stateOf: (player: any) => makeStateReader(player, channels, readKeys),
            }
          );
        } catch (e) {
          // Name the pair. An author's project() throwing otherwise surfaces as
          // a bare stack inside the game-start listener.
          const err = new Error(
            `empirica-networks: project() threw while building ${label}: ` +
              `${e instanceof Error ? e.message : String(e)}`
          );
          // Assigned rather than passed to the constructor: the two-argument
          // form is ES2022 and this package targets ES2020.
          (err as Error & { cause?: unknown }).cause = e;
          throw err;
        }
        if (view === undefined) continue;

        // Validate BEFORE anything is written. A publish is one batched RPC, so
        // throwing here means nothing is sent — no participant gets a partial or
        // unsafe view.
        validateProjection(view, label);
        sizes.push({ bytes: projectionBytes(view), label });
        neighbours.push(view);
      }

      // Skip participants whose view is byte-identical to what they already
      // have. Without this, one player changing one attribute rewrites every
      // neighbour's whole neighbourhood on the wire, and the client sees a
      // change event for a value that did not change.
      const json = JSON.stringify(neighbours);
      if (lastPublished.get(scopeID) === json) continue;

      targets.push({ scope, view: neighbours, json, viewer: playerID });
    }

    reportUnwatchedKeys(readKeys);

    if (targets.length === 0) return true;

    checkViewBytes(sizes, config.envelope, warn);

    const seq = (seqByGame.get(game.id) ?? 0) + 1;
    seqByGame.set(game.id, seq);

    // All sets happen inside this callback, so the runloop flushes them as one
    // batched setAttributes.
    const at = Date.now();
    for (const { scope, view, json, viewer } of targets) {
      scope.set(NBHD_KEYS.NEIGHBORS, view, { ephemeral: true });
      // Monotonic counter, used client-side to detect the silent dones-wiring
      // failure where scopes materialise but every .get() returns undefined.
      scope.set(NBHD_KEYS.SEQ, seq, { ephemeral: true });
      lastPublished.set(scope.id, json);
      // Recorded here rather than per-neighbour above, so the log holds one
      // entry per DELIVERY. Participants skipped by the byte-identical check
      // never reach this loop and correctly produce no record: they were not
      // sent anything.
      //
      // Both writes are part of one batched RPC, so "recorded" and "sent" stand
      // or fall together — with the caveat that a failure of that RPC would
      // leave records for views nobody received. There is no callback to hang
      // the confirmation off, so this is stated rather than handled.
      viewSink?.record({ gameID: game.id, viewer, seq, at, view } satisfies ViewRecord);
    }
    return true;
  }

  /** Publish everyone. Kept as the name the rest of the module already uses. */
  function publishAll(game: any): boolean {
    return publish(game);
  }

  /**
   * Rebuild a game's network state from what is stored, after a restart.
   *
   * Everything needed is durable, but in two different places, and both are
   * required: the game scope has the edge list, and each channel carries its
   * owner's seat number. The edge list alone is index pairs — it describes the
   * shape without saying who sits where, which is precisely how a restart used
   * to reassign people while looking like it had worked.
   *
   * Called on every channel arrival because channels stream in from the
   * subscription with no completion signal. Idempotent, and gives up quietly
   * until the last seat is filled.
   */
  function tryRecover(game: any): boolean {
    if (networks.has(game.id)) return true;

    const players: any[] = game.players ?? [];
    const seats = recoveredOrder.get(game.id);
    if (!seats || seats.size < players.length) return false;

    const order: string[] = [];
    for (let i = 0; i < players.length; i++) {
      const playerID = seats.get(i);
      // A gap means a channel is missing or predates the seat attribute. Refuse
      // rather than close the gap by guessing: guessing produces a plausible
      // network in which the wrong people are neighbours, and the run looks
      // normal for the rest of its life.
      if (!playerID) return false;
      order.push(playerID);
    }

    const edges = readNetwork(game);
    if (!edges) {
      warn(
        `empirica-networks: game ${game.id} was networked by a previous process but ` +
          `has no recorded edge list, so it cannot be recovered. Participants will not ` +
          `receive further updates.`
      );
      recovering.delete(game.id);
      return false;
    }

    const seed = readSeed(game);
    networks.set(game.id, {
      edges,
      adj: adjacency(order.length, edges),
      order,
      seed: typeof seed === "number" ? seed : 0,
    });
    recovering.delete(game.id);
    // Reload the log a previous process wrote, so `history()` is complete
    // across a restart rather than starting again from empty.
    const stored = game.batch?.get(NETWORK_KEYS.history(game.id));
    historyByGame.set(game.id, Array.isArray(stored) ? (stored as EdgeEvent[]).slice() : []);
    gameNetworks.set(game.id, makeGameNetwork(game));

    // Views are ephemeral, so a real process restart takes Tajriba's copy with
    // it. `lastPublished` is empty in a fresh process anyway, so this publishes
    // rather than concluding nothing changed.
    if (!publishAll(game)) awaitingPublish.add(game.id);
    return true;
  }

  /**
   * Read a player's private state off their own channel.
   *
   * Reads are recorded into the same set as player-attribute reads, so a key
   * missing from `watch` is reported the same way whichever scope it lives on.
   */
  function makeStateReader(
    player: any,
    channels: Record<string, string>,
    readKeys: Set<string>
  ): StateReader {
    const scopeID = player?.id ? channels[player.id] : undefined;
    const scope = scopeID ? channelScopes.get(scopeID) : undefined;
    return {
      get<T = unknown>(key: string): T | undefined {
        if (typeof key === "string") readKeys.add(key);
        // No channel yet is normal: a player provisioned this tick has none.
        // Undefined is the same answer as "written but unset", which is what a
        // projection should already handle.
        return scope ? (scope.get(stateKey(key)) as T | undefined) : undefined;
      },
    };
  }

  /**
   * Build the live rewiring handle for a game.
   *
   * Each mutation publishes synchronously to the participants it affects. That
   * looks wasteful next to §4's "republish once at the end of the callback",
   * and is not: the runloop coalesces every `set()` made during one callback
   * into a single `setAttributes` RPC, so ten mutations still cost one round
   * trip. Deferring our own flush to a microtask — the obvious way to batch —
   * moves the writes OUTSIDE the callback the runloop is processing, and they
   * are then never sent at all.
   */
  function makeGameNetwork(game: any): GameNetwork {
    const gameID = game.id;
    const dirty = new Set<string>();
    let flushQueued = false;

    const state = () => {
      const s = networks.get(gameID);
      if (!s) throw new Error(`empirica-networks: game ${gameID} is no longer networked`);
      return s;
    };

    const indexOf = (playerID: string): number => {
      const i = state().order.indexOf(playerID);
      if (i === -1) {
        throw new Error(
          `empirica-networks: player ${playerID} is not in game ${gameID}'s network`
        );
      }
      return i;
    };

    const scheduleFlush = () => {
      if (flushQueued) return;
      flushQueued = true;
      flushQueued = false;
      if (dirty.size === 0) return;
      const targets = new Set(dirty);
      dirty.clear();
      const g = games.get(gameID);
      if (g) publish(g, targets);
    };

    /** Recompute adjacency, persist, log, and mark the affected participants. */
    const commit = (s: NetworkState, event: EdgeEvent, affected: string[]) => {
      s.adj = adjacency(s.order.length, s.edges);
      checkDegrees(s.adj, config.envelope, warn);

      // Not `if (batch)`. A mutation that cannot be recorded must fail loudly:
      // silently skipping leaves the live graph and the stored one disagreeing,
      // so analysis would describe a network that was never shown to anyone and
      // a restart would recover the graph as it stood before the mutation.
      const batch = game.batch;
      if (!batch) {
        throw new Error(
          `empirica-networks: game ${gameID} has no batch, so this mutation cannot be ` +
            `recorded. Refusing to apply it rather than let the live network and the ` +
            `stored one diverge.`
        );
      }
      batch.set(NETWORK_KEYS.network(gameID), s.edges);
      const log = historyByGame.get(gameID) ?? [];
      log.push(event);
      historyByGame.set(gameID, log);
      batch.set(NETWORK_KEYS.history(gameID), [...log]);

      for (const id of affected) dirty.add(id);
      scheduleFlush();
    };

    return {
      neighbors(playerID) {
        const s = state();
        return (s.adj[indexOf(playerID)] ?? []).map((j) => s.order[j]!);
      },
      degree(playerID) {
        return (state().adj[indexOf(playerID)] ?? []).length;
      },
      hasEdge(a, b) {
        return state().adj[indexOf(a)]?.includes(indexOf(b)) ?? false;
      },
      edges() {
        const s = state();
        return s.edges.map(([i, j]) => [s.order[i]!, s.order[j]!] as [string, string]);
      },
      addEdge(a, b) {
        const s = state();
        const i = indexOf(a);
        const j = indexOf(b);
        if (i === j) throw new Error(`empirica-networks: cannot connect ${a} to itself`);
        if (s.adj[i]?.includes(j)) return false;
        s.edges = [...s.edges, i < j ? [i, j] : [j, i]];
        commit(
          s,
          { op: "add", a, b, added: [[a, b]], removed: [], size: s.edges.length, at: Date.now() },
          [a, b]
        );
        return true;
      },
      removeEdge(a, b) {
        const s = state();
        const i = indexOf(a);
        const j = indexOf(b);
        if (!s.adj[i]?.includes(j)) return false;
        s.edges = s.edges.filter(([x, y]) => !((x === i && y === j) || (x === j && y === i)));
        commit(
          s,
          { op: "remove", a, b, added: [], removed: [[a, b]], size: s.edges.length, at: Date.now() },
          [a, b]
        );
        return true;
      },
      rewire(next) {
        const s = state();
        // Everyone whose neighbourhood could differ: the union of before and
        // after. Anything narrower leaves a participant holding a tie that no
        // longer exists, which is worse than an extra publish.
        const affected = new Set<string>(s.order);
        const before = new Set(s.edges.map(([x, y]) => `${x}-${y}`));
        s.edges = fromEdgeList(
          s.order.length,
          next.map(([a, b]) => [indexOf(a), indexOf(b)] as Edge)
        );
        const after = new Set(s.edges.map(([x, y]) => `${x}-${y}`));
        const name = (k: string): [string, string] => {
          const [x, y] = k.split("-").map(Number);
          return [s.order[x!]!, s.order[y!]!];
        };
        commit(
          s,
          {
            op: "rewire",
            added: [...after].filter((k) => !before.has(k)).map(name),
            removed: [...before].filter((k) => !after.has(k)).map(name),
            size: s.edges.length,
            at: Date.now(),
          },
          [...affected]
        );
      },
      publish() {
        const g = games.get(gameID);
        return g ? publishAll(g) : false;
      },
      publishFor(playerID) {
        indexOf(playerID);
        republishAround(playerID);
        return true;
      },
      history() {
        return (historyByGame.get(gameID) ?? []).slice();
      },
    };
  }

  /** Mark a player and everyone who can see them as needing a republish. */
  function republishAround(playerID: string): void {
    for (const [gameID, game] of games) {
      const state = networks.get(gameID);
      if (!state) continue;
      const i = state.order.indexOf(playerID);
      if (i === -1) continue;

      const dirty = new Set<string>([playerID]);
      for (const j of state.adj[i] ?? []) {
        const id = state.order[j];
        if (id) dirty.add(id);
      }
      publish(game, dirty);
      return;
    }
  }

  /**
   * Warn once per process about projection keys nobody is watching.
   *
   * Once, not once per publish: this fires on a hot path, and a message repeated
   * thousands of times is a message nobody reads.
   */
  function reportUnwatchedKeys(readKeys: Set<string>): void {
    const missing = unwatchedKeys(readKeys, watch).filter((k) => !reportedMissing.has(k));
    if (missing.length === 0) return;
    for (const k of missing) reportedMissing.add(k);
    warn(unwatchedKeysMessage(missing, watch));
  }

  /**
   * Assemble one game's snapshot from live state, as plain data.
   *
   * Every value crossing this boundary is a number, string, array or plain
   * object. No `Scope` is returned, and that is load-bearing rather than
   * stylistic: a scope carries `.set()`, so handing one to an observer hands it
   * the publisher's write path (see ./inspect.ts).
   */
  function inspect(gameID: string): GameSnapshot | undefined {
    const state = networks.get(gameID);
    const game = games.get(gameID);
    if (!state || !game) return undefined;

    const channels = readChannels(game);
    const players: any[] = game.players ?? [];
    const byID = new Map(players.map((p) => [p.id, p]));
    const pendingChannels: string[] = [];

    const nodes: NodeSnapshot[] = state.order.map((playerID, i) => {
      const scopeID = channels[playerID];
      const channelScope = scopeID ? channelScopes.get(scopeID) : undefined;
      if (!channelScope) pendingChannels.push(playerID);

      const player = byID.get(playerID);
      const attrs: Record<string, unknown> = {};
      const privateState: Record<string, unknown> = {};
      for (const key of watch) {
        // Both halves, because which scope a key lives on is the author's
        // choice and the `watch` list deliberately covers both (see the
        // listener registration above). An operator looking at a stalled study
        // should not have to know which one the author picked.
        if (player) attrs[key] = player.get(key);
        // Reading the private channel is the whole reason this depends on U3:
        // `withNetwork`'s explicit `ctx.scopeSub({ kinds: ["nbhd"] })` is what
        // makes a participant's own writes reach this process at all. Without
        // it these are all `undefined` and nothing errors
        // (docs/PLATFORM-NOTES.md §12). `test/e2e/monitor.test.ts` asserts a
        // participant-written value arrives here, so a regression is loud.
        if (channelScope) privateState[key] = channelScope.get(stateKey(key));
      }

      const neighbours = [...(state.adj[i] ?? [])];
      return {
        index: i,
        playerID,
        degree: neighbours.length,
        neighbours,
        channel: Boolean(channelScope),
        attrs,
        state: privateState,
      };
    });

    return {
      gameID,
      batchID: game.batch?.id,
      n: state.order.length,
      edges: state.edges.map(([i, j]) => [i, j] as Edge),
      order: [...state.order],
      seed: state.seed,
      seq: seqByGame.get(gameID) ?? 0,
      nodes,
      metrics: graphMetrics(state.order.length, state.edges),
      history: historyFrames(gameID, historyByGame.get(gameID) ?? [], state.order),
      pendingChannels,
      awaitingPublish: awaitingPublish.has(gameID),
      watch: [...watch],
    };
  }

  return {
    publishAll: () => (games.size ? [...games.values()].every(publishAll) : false),
    stats: () => ({
      games: games.size,
      channels: [...games.values()].reduce(
        (sum, game) => sum + Object.keys(readChannels(game)).length,
        0
      ),
      channelScopes: channelScopes.size,
      cachedViews: lastPublished.size,
    }),
    games: () => [...games.keys()],
    inspect,
  };
}

/**
 * Live handle on one game's network, for rewiring during play.
 *
 * MUTATE ONLY FROM INSIDE A LISTENER:
 *
 *     Empirica.onStageStart(({ stage }) => {
 *       network(stage.currentGame).addEdge(a, b);   // correct
 *     });
 *
 * The runloop flushes the `set()` calls made while it is processing a callback.
 * A mutation driven from anywhere else — a timer, an HTTP handler, test code —
 * updates the server's own state correctly and then reaches NOBODY, with no
 * error. Measured while building `test/e2e/rewiring.test.ts`, which was first
 * written the obvious way and had every client assertion time out while the
 * server-side ones passed.
 *
 * Reads (`neighbors`, `degree`, `hasEdge`, `edges`, `history`) are safe
 * anywhere; only writes depend on the callback.
 *
 * Everything takes and returns PLAYER IDS, never topology indices. Indices are
 * an internal representation; an author holds player objects, and asking them to
 * translate is how off-by-one errors get written into experiment code.
 */
export interface GameNetwork {
  /** Player ids this player can currently see. */
  neighbors(playerID: string): string[];
  degree(playerID: string): number;
  hasEdge(a: string, b: string): boolean;
  /** Every current tie, as player id pairs. */
  edges(): Array<[string, string]>;
  /** Add a tie. Returns false if it already existed. */
  addEdge(a: string, b: string): boolean;
  /** Drop a tie. Returns false if it was not there. */
  removeEdge(a: string, b: string): boolean;
  /** Replace the whole edge list. */
  rewire(edges: Array<[string, string]>): void;
  /** Force a republish of everyone now, rather than waiting for the flush. */
  publish(): boolean;
  /** Force a republish of one participant and those who can see them. */
  publishFor(playerID: string): boolean;
  /** Every mutation since game start, oldest first. */
  history(): EdgeEvent[];
}

/**
 * Game id -> live handle. Module-level for the same reason `channelStore` is:
 * `network(game)` is imported directly by experiment code, which has no access
 * to the closure `withNetwork` built.
 */
const gameNetworks = new Map<string, GameNetwork>();

/**
 * Handle on a running game's network.
 *
 * Throws rather than returning undefined for an unknown game: every call site
 * is experiment code about to mutate the graph, and silently doing nothing to a
 * network is precisely the failure mode this package keeps designing against.
 */
export function network(game: any): GameNetwork {
  const handle = game?.id ? gameNetworks.get(game.id) : undefined;
  if (!handle) {
    throw new Error(
      `empirica-networks: no network for game ${game?.id ?? "(no id)"}. ` +
        `Either the game has not started yet, it has ended, or withNetwork() was never ` +
        `called on this collector.`
    );
  }
  return handle;
}

/**
 * Read the realised edge list for a game.
 *
 * Recorded on the BATCH scope, not the game scope, so participants cannot read
 * it (PLATFORM-NOTES §4c). Use this rather than reaching for the attribute: the
 * location is a privacy decision and may move again.
 *
 * Returns `undefined` when nothing was recorded, which is NOT the same as `[]`:
 * `topology.empty()` is a legitimate control condition, so an empty edge list is
 * a real answer. Conflating them left the recovery guard unfireable.
 */
export function readNetwork(game: any): Edge[] | undefined {
  const raw = game?.batch?.get(NETWORK_KEYS.network(game.id));
  return Array.isArray(raw) ? (raw as Edge[]) : undefined;
}

/** Read the seed the game's topology was generated from. */
export function readSeed(game: any): number | undefined {
  const raw = game?.batch?.get(NETWORK_KEYS.seed(game.id));
  return typeof raw === "number" ? raw : undefined;
}
