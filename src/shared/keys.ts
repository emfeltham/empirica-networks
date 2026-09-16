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
  /**
   * How much of the network participants were SHOWN, per game.
   *
   * The edge list and seed record the graph a study ran on; this records what it
   * let people see of it, which is a different fact and a manipulation in its
   * own right. Without it a finished dataset cannot say whether participants
   * were shown a star or the ties among their own connections, and those are two
   * experiments (see `NetworkConfig.graph`).
   *
   * Written at EVERY radius, including the default. Recording only the non-default
   * one would make an absent key mean either "this study drew a star" or "this
   * record predates the key", and `readRadius` could not tell them apart — the
   * same conflation `readNetwork` documents as having made a recovery guard
   * unfireable.
   */
  radius: (gameID: string) => `networkRadius:${gameID}`,
  /**
   * How much of the network EACH participant was shown, by player id.
   *
   * The complete record, and the one whose absence has a single cause. `radius`
   * above answers only when there is a single answer — a study where some
   * participants see further than others has no such value — so this is written
   * at every setting, including the uniform default, for exactly the reason
   * `radius` gives for writing itself at every radius. An absent `networkRadii`
   * means "this record predates the key" and nothing else.
   *
   * Keyed by PLAYER ID, not by seat. The edge list is index pairs and needs the
   * seating plan to interpret, but that plan lives on each participant's own
   * channel (`NBHD_KEYS.INDEX`) and never on the batch — so a seat-indexed
   * vector here would be a record that the scope holding it cannot read. Ids
   * are also what `ViewRecord` and every exported CSV already use.
   *
   * Visibility is ASYMMETRIC once these differ: A at 2 and B at 1, two hops
   * apart, means A was shown B and B was not shown A. Every rule keys on the
   * VIEWER's entry.
   */
  radii: (gameID: string) => `networkRadii:${gameID}`,
  /**
   * Append-only log of every change to how far somebody can see.
   *
   * The same relation to `radii` that `history` has to `network`: one says what
   * the setting IS, this says how it got there. For a study where widening
   * somebody's vision partway through is the manipulation, the sequence is the
   * independent variable, and a snapshot overwritten as radii change would
   * destroy the thing being measured.
   *
   * One `start` event for a study that never changes anybody's, which is what
   * the common case costs. The `start` entry carries the whole opening
   * assignment, so the log alone describes the run — the same property
   * `EdgeEvent`'s own `start` exists for.
   */
  radiusHistory: (gameID: string) => `networkRadiusHistory:${gameID}`,
  /**
   * The secret that names distant people to each viewer, per game.
   *
   * Only meaningful above radius 1, where a participant is shown nodes that have
   * no entry in their neighbor array and therefore no positional name. See
   * `src/admin/pseudonym.ts` for why the names are keyed rather than derived.
   *
   * On the BATCH scope for the same reason the edge list is: it is the one
   * durable scope measured not to reach participants, and a key participants
   * hold is not a key. Recorded rather than held in memory for exactly one
   * reason — so a restart keeps every name it had. It is NOT the analyst's way
   * back to identities: the server records that mapping directly in
   * `ViewRecord.far`, because `src/admin/export.ts` may not import `node:crypto`
   * and re-hashing offline is therefore not available to it.
   *
   * A study that would rather the names be unrecoverable can decline to record
   * it and lose only restart stability.
   */
  viewKey: (gameID: string) => `networkViewKey:${gameID}`,
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
/**
 * One change to how far somebody can see, as recorded in the radius log.
 *
 * Self-contained, for the reason `EdgeEvent` is: `after` carries the whole
 * assignment following the event, so a reader can answer "who could see how far
 * at this moment" from any single entry rather than by replaying from the start
 * and hoping nothing was dropped. It is O(n) where an edge list is O(n²), so the
 * snapshot is affordable here in a way it would not be there.
 */
export interface RadiusEvent {
  /** `start` is the opening assignment, so the log alone describes the run. */
  op: "start" | "set";
  /** Who changed. Absent on `start`, which is about everybody. */
  player?: string;
  /** What they could see before. Absent on `start`. */
  from?: number | "whole";
  /** What they can see now. Absent on `start`. */
  to?: number | "whole";
  /** Everybody's radius after this event, by player id. */
  after: Record<string, number | "whole">;
  /**
   * The publish counter at the moment this was recorded.
   *
   * What makes the log joinable to `ViewRecord.seq` without reasoning about
   * clocks: a view published at `seq` was built under every radius event whose
   * own `seq` is lower. Wall-clock times from one process inside one
   * millisecond cannot be ordered, and two of these can easily land there.
   */
  seq: number;
  /** Wall clock, ms. */
  at: number;
}

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
  /**
   * The publish counter when this was recorded.
   *
   * What lets an auditor order a tie change against a DELIVERY without reasoning
   * about clocks: a view published at `seq` was built on every edge event whose
   * own `seq` is lower. Two events from one process inside one millisecond
   * cannot be ordered by time, and a rewire followed immediately by the publish
   * it triggers lands there by construction.
   *
   * Optional because a record written before this field existed has none, and
   * `auditViews` falls back to the wall clock for those — reporting how many
   * deliveries it could not place, rather than guessing.
   */
  seq?: number;
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
/**
 * The local structure delivered alongside a view, at radius 1.5.
 *
 * Declared here rather than imported from `src/admin/graph_payload.ts` because
 * `src/admin/export.ts` may hold type-only imports and no value imports at all
 * (`test/unit/export_isolation.test.ts`), and `keys.ts` is already its single
 * one. Reaching for the admin module would drag a force-directed layout onto
 * the offline analysis subpath.
 *
 * `edges` are pairs of LOCAL indices into the delivered view: `0` is the viewer,
 * `1..d` are `view[0..d-1]` in order. `positions` is index-aligned with those.
 */
export interface ViewGraph {
  /**
   * How far this viewer was actually shown, as a finite number.
   *
   * Finite even when the study asked for `"whole"`, because `networkGraphOf`
   * rejects a non-finite radius as malformed and a sentinel on the wire would
   * have to be translated by every consumer anyway. For `"whole"` this is the
   * depth the viewer's own component actually reached, which is the honest
   * answer to "how far did I see" — and `whole` below carries the intent that
   * produced it, which no number can.
   */
  radius: number;
  /** Set only when the study asked for the entire network. */
  whole?: true;
  edges: Array<[number, number]>;
  positions: Array<{ x: number; y: number }>;
  /**
   * The people in the picture who are NOT in the delivered view.
   *
   * Absent at radius 1 and 1.5, where every visible node is a neighbor and the
   * positional scheme names all of them — so a payload from those radii is
   * byte-identical to one written before this field existed.
   *
   * Above that, local index `1 + view.length + k` names `far[k]`. The local
   * index space is therefore: `0` the viewer, then the delivered view in order,
   * then these. Extending rather than renumbering is what keeps every existing
   * consumer correct.
   */
  far?: FarNode[];
}

/**
 * One person a viewer can see but is not connected to.
 *
 * `ref` is what this viewer calls them, and it is all they get: a name that is
 * stable for this pair, uncorrelated with what any other viewer calls the same
 * person, and derived from neither a seat nor a player id
 * (`src/admin/pseudonym.ts`).
 *
 * `view` is absent unless the study configured a projection at distance. The
 * default is structure only — a wider radius discloses topology, and making it
 * disclose attributes as well should be a second decision rather than a side
 * effect of a larger number.
 */
export interface FarNode {
  ref: string;
  /** Hops from the viewer. Always >= 2. */
  d: number;
  view?: unknown;
}

export interface ViewRecord {
  gameID: string;
  /** Player id of the viewer — the participant this was delivered to. */
  viewer: string;
  /** Publish counter for the game, the same value the client sees as `_seq`. */
  seq: number;
  at: number;
  /** Exactly what `project()` produced, in the order the topology gave it. */
  view: unknown[];
  /**
   * The ties among this viewer's own neighbors, and where everything was drawn.
   *
   * Absent at the default radius, where none is sent — so a radius 1 run writes
   * byte-identical NDJSON to one written before this field existed.
   *
   * POSITIONS ARE KEPT, not just the edge set, and that is the less obvious
   * half. The edges are the disclosure and could be argued to be the whole
   * audit; the positions are what makes the record satisfy the criterion
   * `NetworkConfig.views` states for capture being worth it at all — that the
   * delivered view "is not recoverable from the edge log afterwards". They are
   * warm-started, so they depend on the history of the session rather than on
   * the final graph, and are therefore not a function of anything else stored.
   * Drop them and the screen a participant saw is gone for good.
   *
   * A SIBLING of `view`, never an entry inside it. `auditViews` in
   * `src/verify/audit.ts` walks `view` and reports any entry without a string
   * `id` as a leak, so folding the structure in would make every radius 1.5 run
   * fail its own audit.
   */
  graph?: ViewGraph;
  /**
   * Who the refs in `graph.far` actually were. SERVER-SIDE ONLY.
   *
   * Never delivered — `graph` is byte-for-byte what went on the wire, and this
   * sits beside it as the server's key to its own payload. Without it a captured
   * run above radius 1 records that a participant was shown four anonymous nodes
   * and loses which four, which would make the structure unjoinable to anything.
   *
   * Recorded here rather than resolved offline because `src/admin/export.ts` may
   * not import `node:crypto` (`test/unit/export_isolation.test.ts`), so an
   * analyst cannot re-derive a ref even holding the key. The server already
   * knows the answer at publish time; writing it down is cheaper and does not
   * put a secret on the analysis path.
   *
   * Absent whenever `graph.far` is.
   */
  far?: Array<{ ref: string; id: string; hop: number }>;
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
