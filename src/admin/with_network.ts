import { TajribaEvent } from "@empirica/core/admin";
import { warn } from "@empirica/core/console";
import { GAME_KEYS, NBHD_KEYS, NBHD_KIND, stateKey } from "../shared/keys.js";
import { adjacency, ring, type Edge } from "../topology/index.js";
import { checkDegrees, checkViewBytes, type EnvelopeLimits } from "./envelope.js";
import { projectionBytes, validateProjection } from "./projection.js";
import { pendingChannelsMessage, provisionChannels, readChannels } from "./provision.js";
import { recordReads, unwatchedKeys, unwatchedKeysMessage } from "./reads.js";
import { hashSeed, makeRng, type Rng } from "./seed.js";

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
}

const defaultTopology = ({ playerCount, rng }: { playerCount: number; rng: Rng }) =>
  playerCount >= 3 ? ring(playerCount, { rng }) : [];

const defaultProject = (neighbour: any) => ({ id: neighbour.id });

/** Per-game network state, server-side only. */
interface NetworkState {
  edges: Edge[];
  adj: number[][];
  /** player id in topology order */
  order: string[];
  seed: number;
}

export interface NetworkHandle {
  /** Recompute and republish every participant's view. */
  publishAll(): boolean;
}

export function withNetwork(collector: any, config: NetworkConfig = {}): NetworkHandle {
  const topology = config.topology ?? defaultTopology;
  const project = config.project ?? defaultProject;

  const watch = config.watch ?? [];

  const networks = new Map<string, NetworkState>();
  /** nbhd scope id -> the modelled scope object we can call .set() on. */
  const channelScopes = new Map<string, any>();
  /** games waiting for their channel scopes to materialise before first publish */
  const awaitingPublish = new Set<string>();
  const games = new Map<string, any>();
  const seqByGame = new Map<string, number>();
  /** nbhd scope id -> last published view, serialised. Suppresses no-op writes. */
  const lastPublished = new Map<string, string>();
  /** Keys already warned about, so the hot path warns once rather than per publish. */
  const reportedMissing = new Set<string>();

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
    for (const gameID of [...awaitingPublish]) {
      const game = games.get(gameID);
      if (game && publishAll(game)) awaitingPublish.delete(gameID);
    }
  });

  collector.on("game", "start", async (ctx: any, { game }: any) => {
    if (!game.get("start")) return;

    const players = game.players ?? [];
    const seed = config.seed ?? hashSeed(String(game.id));
    const rng = makeRng(seed);
    const edges = topology({ game, playerCount: players.length, rng });
    const adj = adjacency(players.length, edges);

    // Before provisioning and before anything is recorded: an out-of-envelope
    // topology should fail while the experiment is still abandonable, not after
    // participants have been committed to a game that will run badly.
    checkDegrees(adj, config.envelope, warn);

    // Recorded so the exact realisation is reconstructible from stored data.
    game.set(GAME_KEYS.SEED, seed);
    game.set(GAME_KEYS.NETWORK, edges);

    networks.set(game.id, {
      edges,
      adj,
      order: players.map((p: any) => p.id),
      seed,
    });
    games.set(game.id, game);

    const { pending } = await provisionChannels(ctx, game);
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

    const targets: { scope: any; view: unknown; json: string }[] = [];
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

      targets.push({ scope, view: neighbours, json });
    }

    reportUnwatchedKeys(readKeys);

    if (targets.length === 0) return true;

    checkViewBytes(sizes, config.envelope, warn);

    const seq = (seqByGame.get(game.id) ?? 0) + 1;
    seqByGame.set(game.id, seq);

    // All sets happen inside this callback, so the runloop flushes them as one
    // batched setAttributes.
    for (const { scope, view, json } of targets) {
      scope.set(NBHD_KEYS.NEIGHBORS, view, { ephemeral: true });
      // Monotonic counter, used client-side to detect the silent dones-wiring
      // failure where scopes materialise but every .get() returns undefined.
      scope.set(NBHD_KEYS.SEQ, seq, { ephemeral: true });
      lastPublished.set(scope.id, json);
    }
    return true;
  }

  /** Publish everyone. Kept as the name the rest of the module already uses. */
  function publishAll(game: any): boolean {
    return publish(game);
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

  return { publishAll: () => (games.size ? [...games.values()].every(publishAll) : false) };
}

/** Read the recorded edge list back off a game scope. */
export function readNetwork(game: any): Edge[] {
  const raw = game.get(GAME_KEYS.NETWORK);
  return Array.isArray(raw) ? (raw as Edge[]) : [];
}
