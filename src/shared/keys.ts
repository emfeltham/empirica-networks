/**
 * Every scope kind and attribute key the module uses, in one place.
 *
 * The spike scattered these string literals across five files ("nbhd" alone
 * appeared in four), which is how the `player`-vs-`nbhd` distinction — the
 * entire privacy guarantee — became easy to get wrong by typo. Centralised so
 * that a rename is a compile error rather than a silent leak.
 */

/** Scope kind for a participant's private view channel. */
export const NBHD_KIND = "nbhd" as const;

/**
 * Attribute keys on an `nbhd` scope.
 *
 * OWNER is immutable and written at scope creation. It is how the client
 * selects its own scope; the spike selected by "first one delivered", which
 * breaks as soon as a stale scope survives a rewire or reconnect.
 */
export const NBHD_KEYS = {
  /** Participant ID this channel belongs to. Immutable, set at creation. */
  OWNER: "ownerParticipantID",
  /** Player scope id this channel corresponds to. Immutable, set at creation. */
  PLAYER_ID: "playerID",
  /**
   * Game this channel belongs to. Immutable, set at creation.
   *
   * Needed to recover after a restart: channels arrive from the subscription
   * with no indication of which game they belong to, and the server-side index
   * that used to say is exactly what a restart destroyed.
   */
  GAME_ID: "gameID",
  /**
   * This player's position in the topology. Immutable, set at creation.
   *
   * The edge list is index pairs, so without this the mapping from index to
   * person exists only in server memory. Recovering it from `game.players`
   * order instead is what silently REWIRED everyone across a restart — same
   * graph, different people at each node, nothing logged. Measured in
   * `test/e2e/restart.test.ts`.
   *
   * On the channel rather than the game scope on purpose: a participant learns
   * only their own index, which tells them nothing they cannot already see,
   * whereas the game scope would hand everybody the whole seating plan
   * (docs/PLATFORM-NOTES.md §4b, §4c).
   */
  INDEX: "topologyIndex",
  /** The projected neighbour views. */
  NEIGHBORS: "neighbors",
  /** Monotonic publish counter. Drives the dones-wiring self-check. */
  SEQ: "_seq",
} as const;

/** Attribute keys the module writes on the game scope. */
export const GAME_KEYS = {
  /** Serialised edge list. */
  NETWORK: "network",
  /** Seed used to generate the topology, recorded for reproducibility. */
  SEED: "networkSeed",
  // NOTE: there is deliberately no key here for the channel index.
  // It was briefly stored on the game scope, which every participant is linked
  // to, handing every participant every channel id — and with no write ACL
  // (docs/PLATFORM-NOTES.md 4a) an id is the capability needed to write into
  // someone else's private channel. The index lives in server memory only.
} as const;

/**
 * Namespace for state a PARTICIPANT writes to their own channel.
 *
 * This is the answer to the trap that `player.set()` broadcasts: Classic
 * cross-links every participant to every player node, so a value written there
 * is readable by all, and projecting it changes nothing about who can read it.
 * A value written here is delivered only to its owner and the server, and
 * reaches anyone else solely through `project()`.
 *
 * Prefixed rather than raw so a participant cannot overwrite `neighbors` or
 * `_seq`. Their own channel is the one scope they can certainly write to
 * (docs/PLATFORM-NOTES.md §4a), and those two keys belong to the server.
 */
export const STATE_PREFIX = "state:";

/** Attribute key on an nbhd scope for one piece of participant-written state. */
export function stateKey(key: string): string {
  return `${STATE_PREFIX}${key}`;
}

export type NbhdKey = (typeof NBHD_KEYS)[keyof typeof NBHD_KEYS];
export type GameKey = (typeof GAME_KEYS)[keyof typeof GAME_KEYS];
