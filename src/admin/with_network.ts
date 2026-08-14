import { GAME_KEYS, NBHD_KEYS, NBHD_KIND } from "../shared/keys.js";
import { adjacency, ring, type Edge } from "../topology/index.js";
import { provisionChannels, readChannels } from "./provision.js";
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

export interface ProjectContext {
  game: any;
  /** Index of the viewer in the topology. */
  viewerIndex: number;
  /** Index of the neighbour in the topology. */
  neighbourIndex: number;
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

  const networks = new Map<string, NetworkState>();
  /** nbhd scope id -> the modelled scope object we can call .set() on. */
  const channelScopes = new Map<string, any>();
  /** games waiting for their channel scopes to materialise before first publish */
  const awaitingPublish = new Set<string>();
  const games = new Map<string, any>();
  const seqByGame = new Map<string, number>();

  /**
   * Capture channel scope objects as they materialise.
   *
   * Registering a listener on our kind is also what subscribes the admin to it;
   * without a subscription the scopes never load and there is nothing to write
   * to. The owner attribute is immutable and set at creation, so this fires
   * exactly once per channel.
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

    // Recorded so the exact realisation is reconstructible from stored data.
    game.set(GAME_KEYS.SEED, seed);
    game.set(GAME_KEYS.NETWORK, edges);

    networks.set(game.id, {
      edges,
      adj: adjacency(players.length, edges),
      order: players.map((p: any) => p.id),
      seed,
    });
    games.set(game.id, game);

    await provisionChannels(ctx, game);

    // Channel scopes arrive asynchronously via the listener above; if they are
    // not all present yet, publish once they are.
    if (!publishAll(game)) awaitingPublish.add(game.id);
  });

  /**
   * Publish every participant's view. Returns false if any channel scope has
   * not materialised yet, having published nothing — partial publishes would
   * leave some participants with a stale view and no signal that they are stale.
   */
  function publishAll(game: any): boolean {
    const state = networks.get(game.id);
    if (!state) return false;

    const channels = readChannels(game);
    const players: any[] = game.players ?? [];
    const byID = new Map(players.map((p) => [p.id, p]));

    const targets: { scope: any; view: unknown }[] = [];
    for (const [i, playerID] of state.order.entries()) {
      const scopeID = channels[playerID];
      if (!scopeID) return false;
      const scope = channelScopes.get(scopeID);
      if (!scope) return false;

      const viewer = byID.get(playerID);
      if (!viewer) return false;

      const neighbours = (state.adj[i] ?? [])
        .map((j) => {
          const neighbourID = state.order[j];
          const neighbour = neighbourID ? byID.get(neighbourID) : undefined;
          if (!neighbour) return undefined;
          return project(neighbour, viewer, {
            game,
            viewerIndex: i,
            neighbourIndex: j,
          });
        })
        .filter((v) => v !== undefined);

      targets.push({ scope, view: neighbours });
    }

    const seq = (seqByGame.get(game.id) ?? 0) + 1;
    seqByGame.set(game.id, seq);

    // All sets happen inside this callback, so the runloop flushes them as one
    // batched setAttributes.
    for (const { scope, view } of targets) {
      scope.set(NBHD_KEYS.NEIGHBORS, view, { ephemeral: true });
      // Monotonic counter, used client-side to detect the silent dones-wiring
      // failure where scopes materialise but every .get() returns undefined.
      scope.set(NBHD_KEYS.SEQ, seq, { ephemeral: true });
    }
    return true;
  }

  return { publishAll: () => (games.size ? [...games.values()].every(publishAll) : false) };
}

/** Read the recorded edge list back off a game scope. */
export function readNetwork(game: any): Edge[] {
  const raw = game.get(GAME_KEYS.NETWORK);
  return Array.isArray(raw) ? (raw as Edge[]) : [];
}
