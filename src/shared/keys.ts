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

/**
 * Attribute keys the module writes to record a realised network.
 *
 * These live on the **batch** scope, not the game scope, and are therefore
 * suffixed with the game id. The batch is the only durable scope measured NOT to
 * be delivered to participants (`test/e2e/scope_visibility.test.ts`), which is
 * what lets the realised network be both reproducible from storage and hidden
 * from the people inside it.
 *
 * On the game scope — where these started — every participant received the full
 * edge list and the seed, because Classic links every participant to the game.
 * State stayed neighbour-limited, but the *structure* did not, and for a design
 * where the topology is the manipulation that is a confound rather than a
 * nicety. See docs/PLATFORM-NOTES.md §4c.
 */
export const NETWORK_KEYS = {
  /** Serialised edge list, per game. The network as it stands NOW. */
  network: (gameID: string) => `network:${gameID}`,
  /** Seed used to generate the topology, per game. Recorded for reproducibility. */
  seed: (gameID: string) => `networkSeed:${gameID}`,
  /**
   * Append-only log of every tie added or dropped after game start.
   *
   * Separate from `network` because they answer different questions and only
   * one of them can be answered by a snapshot. `network` is what the graph is;
   * this is how it got there. For a rewiring study the sequence IS the
   * independent variable, so overwriting a single edge list as ties change
   * would destroy the thing being measured.
   *
   * Empty for a static network, which is the common case, so it costs nothing
   * to carry.
   */
  history: (gameID: string) => `networkHistory:${gameID}`,
} as const;

/**
 * One mutation of the network, as recorded in the history log.
 *
 * `added`/`removed` carry the actual tie changes, including for `start` and
 * `rewire` where there is no single pair. Without them the log records that
 * something happened without recording what, and export has to guess — so every
 * event is self-contained and `edges.csv` is a direct read rather than a
 * reconstruction.
 */
export interface EdgeEvent {
  /** `start` is the initial graph, so the log alone describes the whole run. */
  op: "start" | "add" | "remove" | "rewire";
  /** Player ids, for the single-tie ops. */
  a?: string;
  b?: string;
  /** Ties created by this event. */
  added: Array<[string, string]>;
  /** Ties destroyed by this event. */
  removed: Array<[string, string]>;
  /** Edge count after the mutation, so a snapshot can be sanity-checked. */
  size: number;
  /** Wall clock, ms. */
  at: number;
}

/**
 * Attribute keys the module writes on the game scope.
 *
 * Deliberately empty. Two separate things were kept here and both had to move:
 * the channel index (every participant got every channel id, and with no write
 * ACL that id is the capability needed to write into someone else's private
 * channel — §4a, §4b), and the realised network (§4c). Kept as a named, empty
 * record so the reason survives rather than being rediscovered.
 */
export const GAME_KEYS = {} as const;

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
