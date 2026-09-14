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
  /** The projected neighbor views. */
  NEIGHBORS: "neighbors",
  /**
   * Messages delivered to this participant, server-written.
   *
   * On the RECIPIENT's channel, not carried inside `neighbors`. Two reasons,
   * both load-bearing. It keeps chat out of the per-neighbor view, so message
   * volume never counts against `maxViewBytes`. And it answers §7.4's open
   * question structurally rather than by policy: when a tie is dropped, what was
   * already delivered simply stays where it is, and nothing new arrives.
   */
  CHAT: "chat",
  /**
   * The local structure of this participant's own neighborhood, at radius 1.5.
   *
   * `{ radius, edges, positions }`, where the edges are pairs of LOCAL indices
   * into the array under NEIGHBORS: 0 is the viewer, 1..d are their neighbors in
   * order. Server-side indices are a seating plan and never appear here
   * (docs/PLATFORM-NOTES.md §4b).
   *
   * ABSENT ENTIRELY at the default radius, where the client draws a star from
   * NEIGHBORS alone and no extra byte is sent. Present means a study opted into
   * showing participants the ties among their own neighbors, which is a genuine
   * widening of what they are told — so `radius` is carried inside it rather
   * than inferred, and the client can tell "this study is radius 1" from "the
   * structure has not arrived".
   *
   * Written in the SAME batched publish as NEIGHBORS, and the byte-identical
   * suppression covers both together. It has to: a tie forming between two of
   * your neighbors changes this and leaves your neighbor list untouched, so a
   * suppression keyed on NEIGHBORS alone would freeze the structure while every
   * other part of the screen kept updating.
   */
  GRAPH: "graph",
  /** Monotonic publish counter. Drives the dones-wiring self-check. */
  SEQ: "_seq",
} as const;

/**
 * Attribute keys the module writes to record a realized network.
 *
 * These live on the **batch** scope, not the game scope, and are therefore
 * suffixed with the game id. The batch is the only durable scope measured NOT to
 * be delivered to participants (`test/e2e/scope_visibility.test.ts`), which is
 * what lets the realized network be both reproducible from storage and hidden
 * from the people inside it.
 *
 * On the game scope — where these started — every participant received the full
 * edge list and the seed, because Classic links every participant to the game.
 * State stayed neighbor-limited, but the *structure* did not, and for a design
 * where the topology is the manipulation that is a confound rather than a
 * nicety. See docs/PLATFORM-NOTES.md §4c.
 */
export const NETWORK_KEYS = {
  /** Serialized edge list, per game. The network as it stands NOW. */
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
 * channel — §4a, §4b), and the realized network (§4c). Kept as a named, empty
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

/**
 * Namespace for values the SERVER writes to ONE participant's channel.
 *
 * The counterpart to `STATE_PREFIX`, and a separate namespace rather than the
 * same one for a reason that is not tidiness: a participant can write anything
 * to their own channel — it is the one scope they can certainly write to (§4a) —
 * so a shared namespace would let `state.set("offer", …)` overwrite a value the
 * server authored, with no way for the server to tell. Separated, that collision
 * is impossible and each side's keys mean exactly one thing.
 *
 * Added in M5 for a gap the first four milestones never surfaced: `project()`
 * runs only over a viewer's CURRENT neighbors, so there was no way for the
 * server to tell one participant one fact about a NON-neighbor. That is exactly
 * what Rand, Arbesman & Christakis (2011) do in their rewiring round — a subject
 * offered the chance to form a new tie is shown that person's last action, and by
 * definition they are not yet a neighbor.
 *
 * This does NOT weaken the module's guarantee, and the distinction is worth being
 * precise about rather than reassuring about. Values written here are authored by
 * the experiment's own server code, are delivered to exactly one participant's
 * own channel, and are validated by the same `validateProjection` as a view.
 * `project()` remains the only path by which **one participant's data reaches
 * another**. What was previously conflated is "the server tells you something"
 * with "you learn about someone else" — two different acts, and only the second
 * is what the projection exists to control.
 */
export const TOLD_PREFIX = "told:";

/** Attribute key on an nbhd scope for one server-authored private value. */
export function toldKey(key: string): string {
  return `${TOLD_PREFIX}${key}`;
}

/**
 * Reserved state key: a participant's outgoing message slot.
 *
 * Chat needs a participant to SEND, and a participant can only write to their
 * own channel — writing into a neighbor's would need the absence of write
 * access control (PLATFORM-NOTES §4a), which is a bug to design against, not a
 * mechanism to build on. So they write here and the server fans out.
 *
 * Reserved: `state.set("_outbox", …)` collides with chat. Named with a leading
 * underscore to make that unlikely and documented so it is not a surprise.
 */
export const OUTBOX_KEY = "_outbox";

/**
 * One view, as actually delivered to one participant.
 *
 * The only record of what a participant was told. Views are published
 * `ephemeral`, deliberately — persisting them would grow the store on every
 * tick (docs/PLATFORM-NOTES.md §9) — so unlike edges, attributes, the seed and
 * chat, nothing durable holds them. Capture is opt-in for that reason: it is a
 * cost you choose, not one you pay by default.
 *
 * A record is written per DELIVERY, not per tick. Views are republished only
 * when they change (the byte-identical check in `publish`), so the log says what
 * arrived and when, rather than resampling a value nobody was re-sent. That is
 * also the difference between this and a reconstruction from the edge log and
 * the attribute export: those give what someone COULD have known.
 */
export interface ViewRecord {
  gameID: string;
  /** Player id of the viewer — the participant this was delivered to. */
  viewer: string;
  /** Publish counter for the game, the same value the client sees as `_seq`. */
  seq: number;
  at: number;
  /** Exactly what `project()` produced, in the order the topology gave it. */
  view: unknown[];
}

/** One chat message as delivered to a recipient. */
export interface ChatMessage {
  /** Player id of the sender. */
  from: string;
  text: string;
  /** Sender-local counter, used to drop duplicate relays. */
  seq: number;
  at: number;
}

export type NbhdKey = (typeof NBHD_KEYS)[keyof typeof NBHD_KEYS];
export type GameKey = (typeof GAME_KEYS)[keyof typeof GAME_KEYS];
