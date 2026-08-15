import { NBHD_KEYS, NBHD_KIND } from "../shared/keys.js";

/**
 * Provisioning: one private channel per participant.
 *
 * Three properties this has to get right, each learned the hard way:
 *
 * 1. BATCHED. The spike created scopes with a serial `await` per player — n
 *    round trips at game start. Here it is one `addScopes` and one `addLinks`
 *    regardless of n.
 *
 * 2. IDEMPOTENT. `game.players` is not reliably complete at a single game-start
 *    moment, players get reassigned, and a returning participant may arrive
 *    later. Provisioning is therefore keyed on an immutable owner attribute and
 *    safe to call repeatedly; it provisions only who is missing. This matters
 *    more than usual because Tajriba cannot UNLINK — a re-link bug accumulates
 *    links permanently with no way to clean up.
 *
 * 3. ORDER-INDEPENDENT. Results are mapped back to players by reading the owner
 *    attribute off each returned payload, not by assuming `addScopes` preserves
 *    input order. Nothing documents that it does.
 *
 * 4. THE MAP IS NEVER PARTICIPANT-VISIBLE. It was briefly written to the game
 *    scope, which every participant is linked to — an e2e test caught every
 *    participant receiving every channel id. That is not cosmetic: Empirica has
 *    no write ACL (docs/PLATFORM-NOTES.md §4a), so a channel id is precisely the
 *    capability needed to inject into someone else's private channel. The map
 *    therefore lives in server memory only.
 */

/** Minimal shape we need from a classic admin Player. */
interface PlayerLike {
  id: string;
  participantID?: string | undefined;
  get(key: string): unknown;
  set(key: string, value: unknown, opts?: Record<string, unknown>): void;
}

/** Minimal shape we need from a classic admin Game. */
interface GameLike {
  id: string;
  players: PlayerLike[];
  get(key: string): unknown;
  set(key: string, value: unknown, opts?: Record<string, unknown>): void;
}

/** Minimal shape we need from an EventContext. */
interface CtxLike {
  addScopes(input: unknown[]): Promise<any[]>;
  addLinks(input: unknown[]): Promise<any[]>;
}

/** playerID -> nbhd scope id */
export type ChannelMap = Record<string, string>;

/**
 * Server-side channel index, keyed by game id.
 *
 * Deliberately NOT persisted to any scope: see note 4 above. The cost is that a
 * server restart mid-game loses the index. Recovery is possible — the nbhd
 * scopes carry immutable owner/playerID attributes, so the map can be rebuilt by
 * scanning scopes of our kind — but that is not implemented yet and is tracked
 * as a known gap rather than silently assumed to work.
 */
const channelStore = new Map<string, ChannelMap>();

export function readChannels(game: GameLike): ChannelMap {
  return { ...(channelStore.get(game.id) ?? {}) };
}

/** Test seam: forget everything known about a game's channels. */
export function resetChannels(gameID?: string): void {
  if (gameID === undefined) channelStore.clear();
  else channelStore.delete(gameID);
}

/**
 * Re-adopt a channel that already exists, after the index was lost.
 *
 * The alternative — letting `provisionChannels` see an empty index and create a
 * fresh channel — is not a slower path to the same place. It permanently
 * doubles up: Tajriba cannot unlink, so the participant ends up linked to two
 * channels, the client picks one and the server writes the other, and the view
 * freezes with nothing logged anywhere. Measured in `test/e2e/restart.test.ts`.
 */
export function adoptChannel(gameID: string, playerID: string, scopeID: string): void {
  const channels = channelStore.get(gameID) ?? {};
  channels[playerID] = scopeID;
  channelStore.set(gameID, channels);
}

/** Pull the owner/player attributes back out of an AddScopePayload. */
function payloadAttrs(payload: any): Record<string, string> {
  const out: Record<string, string> = {};
  const edges = payload?.attributes?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node?.key) continue;
    try {
      out[node.key] = JSON.parse(node.val);
    } catch {
      out[node.key] = node.val;
    }
  }
  return out;
}

export interface ProvisionResult {
  /** Full map after provisioning, including channels that already existed. */
  channels: ChannelMap;
  /** Players provisioned by THIS call. Empty when everything already existed. */
  created: string[];
  /** Players skipped because they have no participantID yet. */
  pending: string[];
}

/**
 * Explain a pending player, loudly.
 *
 * Worth a message rather than a silent skip because the consequence is not
 * proportional to the cause: `publish` refuses to send a partial view, so ONE
 * unprovisioned player leaves EVERY participant in the game with no
 * neighbourhood. On the client that is indistinguishable from still loading,
 * which is this package's characteristic failure mode and the reason for the
 * `_seq` self-check in the mode.
 */
export function pendingChannelsMessage(pending: string[], playerCount: number): string {
  const ids = pending.map((id) => `"${id}"`).join(", ");
  return (
    `empirica-networks: ${pending.length} of ${playerCount} players have no participantID ` +
    `and were given no private channel: ${ids}.\n` +
    `  Until they connect, NO participant in this game receives a neighbourhood — a partial\n` +
    `  publish would leave the rest stale with no signal, so publishing waits for everyone.\n` +
    `  Provisioning is retried when a participant connects. If these players never connect,\n` +
    `  the game will stay blank; end the game or restart the batch.`
  );
}

/**
 * Ensure every player in `game` has a private channel. Safe to call repeatedly.
 */
export async function provisionChannels(
  ctx: CtxLike,
  game: GameLike,
  /**
   * Position of each player in the topology. Written onto the channel so the
   * index-to-person mapping survives a restart; see NBHD_KEYS.INDEX.
   */
  indexOf?: (playerID: string) => number
): Promise<ProvisionResult> {
  const channels = readChannels(game);
  const created: string[] = [];
  const pending: string[] = [];

  const missing: PlayerLike[] = [];
  for (const player of game.players) {
    if (channels[player.id]) continue;
    // A player without a participantID is not connected yet; there is nobody to
    // link the channel to. Skip rather than create an unlinked orphan we could
    // never attach later (no unlink, so no way to correct a wrong link either).
    if (!player.participantID) {
      pending.push(player.id);
      continue;
    }
    missing.push(player);
  }

  if (missing.length === 0) {
    channelStore.set(game.id, channels);
    return { channels, created, pending };
  }

  const payloads = await ctx.addScopes(
    missing.map((player) => ({
      kind: NBHD_KIND,
      attributes: [
        {
          key: NBHD_KEYS.OWNER,
          val: JSON.stringify(player.participantID),
          immutable: true,
        },
        {
          key: NBHD_KEYS.PLAYER_ID,
          val: JSON.stringify(player.id),
          immutable: true,
        },
        {
          key: NBHD_KEYS.GAME_ID,
          val: JSON.stringify(game.id),
          immutable: true,
        },
        // All three of these exist to make the channel self-describing, so a
        // process that has lost its memory can rebuild the index by reading the
        // channels rather than by re-deriving it and getting a different answer.
        {
          key: NBHD_KEYS.INDEX,
          val: JSON.stringify(indexOf ? indexOf(player.id) : -1),
          immutable: true,
        },
      ],
    }))
  );

  // Map back by attribute, not by index.
  const byParticipant = new Map<string, string>();
  for (const payload of payloads ?? []) {
    const id = payload?.id ?? payload?.scope?.id;
    const attrs = payloadAttrs(payload);
    const owner = attrs[NBHD_KEYS.OWNER];
    if (id && owner) byParticipant.set(owner, id);
  }

  const links: unknown[] = [];
  for (const player of missing) {
    const scopeID = byParticipant.get(player.participantID!);
    if (!scopeID) {
      throw new Error(
        `empirica-networks: addScopes returned no scope carrying ${NBHD_KEYS.OWNER}=` +
          `${player.participantID}. Cannot safely map channels to owners.`
      );
    }
    channels[player.id] = scopeID;
    created.push(player.id);
    // One LinkInput PER PAIR. A single input with both arrays would link the
    // cross product — every participant to every channel — which is exactly the
    // leak this module exists to prevent.
    links.push({ link: true, participantIDs: [player.participantID], nodeIDs: [scopeID] });
  }

  await ctx.addLinks(links);

  channelStore.set(game.id, channels);
  return { channels, created, pending };
}
