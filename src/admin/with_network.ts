import { TajribaEvent } from "@empirica/core/admin";
import { warn } from "@empirica/core/console";
import {
  NBHD_KEYS,
  NBHD_KIND,
  NETWORK_KEYS,
  OUTBOX_KEY,
  stateKey,
  toldKey,
  type ChatMessage,
  type EdgeEvent,
  type RadiusEvent,
  type FarNode,
  type ViewRecord,
} from "../shared/keys.js";
import { adjacency, ball, fromEdgeList, ring, type Edge, type Radius } from "../topology/index.js";
import {
  checkDegrees,
  checkVision,
  checkViewBytes,
  type EnvelopeLimits,
  type MeasuredPayload,
} from "./envelope.js";
import { graphMetrics, historyFrames, type GameSnapshot, type NodeSnapshot } from "./inspect.js";
import { calibrate, duplicateLifecycleListeners, duplicateListenersMessage } from "./listeners.js";
import {
  projectionBytes,
  validateNoIdentifiers,
  validateProjection,
} from "./projection.js";
import {
  buildGraphPayload,
  shapeKey,
  type GraphPayload,
  type LayoutCache,
} from "./graph_payload.js";
import {
  registrationNotDetectedMessage,
  registrationRetractionMessage,
  registrationWaitMs,
} from "./registration.js";
import {
  adoptChannel,
  lateProvisionMessage,
  pendingChannelsMessage,
  provisionChannels,
  readChannels,
  releaseChannels,
} from "./provision.js";
import {
  recordReads,
  unlistedKeyMessage,
  unwatchedKeys,
  unwatchedKeysMessage,
} from "./reads.js";
import {
  endedGamesCap,
  endedGamesEvictedMessage,
  rememberEndedGame,
} from "./retention.js";
import { makeViewKey, refFor } from "./pseudonym.js";
import type { LocalEdge } from "./subgraph.js";
import { hashSeed, makeRng, type Rng } from "./seed.js";
import { makeLogSink, type LogConfig } from "./sink.js";
import { makeViewSink, type ViewsConfig } from "./views.js";

/**
 * withNetwork: wires network projection into an Empirica experiment.
 *
 * Publishing goes through `scope.set()` on a participant's private channel,
 * because `EventContext` has no `setAttributes` — the only write path available
 * inside a listener is a modeled scope (docs/PLATFORM-NOTES.md §5). That is
 * also why the `nbhd` kind must be registered by the consumer: without it we
 * have nothing to call `.set()` on.
 *
 * The runloop coalesces every `set()` made during one callback into a single
 * `setAttributes` RPC (admin/runloop.ts:199-226), so publishing to n
 * participants costs one round trip, not n.
 */

/**
 * A game, however you happen to be holding it.
 *
 * Every entry point that takes a game accepts either the scope object or its id.
 * Until M6 they disagreed — `network(game)` wanted an object and read only `.id`
 * off it, while `net.inspect(gameID)` wanted the id — and the mismatch produced
 * `no network for game (no id)`, a correct message for a confusing signature.
 * `test/e2e/rand2011.test.ts` worked around it with an `{ id }` wrapper that
 * happened to be enough.
 *
 * A listener holds `stage.currentGame`; a test or an HTTP handler usually holds an
 * id. Neither should have to know which one the function it is calling prefers.
 */
export type GameRef = string | { id?: unknown };

/**
 * The id out of a `GameRef`, or undefined.
 *
 * One place, so the accepted shapes cannot drift between call sites. Returns
 * undefined rather than throwing: each caller has its own thing to say about a
 * game it cannot find, and `inspect()` in particular must answer with `undefined`
 * rather than an exception.
 */
export function gameIDOf(ref: GameRef | undefined): string | undefined {
  if (typeof ref === "string") return ref.length > 0 ? ref : undefined;
  const id = (ref as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Read-only view of one participant's private, self-written state. */
export interface StateReader {
  get<T = unknown>(key: string): T | undefined;
}

export interface ProjectContext {
  game: any;
  /** Index of the viewer in the topology. */
  viewerIndex: number;
  /** Index of the neighbor in the topology. */
  neighborIndex: number;
  /**
   * A player's PRIVATE state — what they wrote to their own channel.
   *
   * Use this, not `player.get(...)`, for anything that must stay within the
   * neighborhood. A player attribute is broadcast to every participant, so
   * projecting one restricts nothing; only values written to a private channel
   * are actually neighbor-limited.
   */
  stateOf(player: any): StateReader;
}

export interface GraphConfig {
  /**
   * How far each participant can see. `1` (default), `1.5`, `2`, `2.5`, … or
   * `"whole"`. See `NetworkConfig.graph`.
   *
   * A FUNCTION assigns per seat, and receives the realized topology because the
   * design this is for needs it:
   *
   *     radius: ({ playerCount, edges }) => {
   *       const deg = degrees(playerCount, edges);
   *       const hubs = [...deg.keys()].sort((a, b) => deg[b] - deg[a]).slice(0, 3);
   *       return Array.from({ length: playerCount }, (_, i) =>
   *         hubs.includes(i) ? 2 : 1);
   *     }
   *
   * Return one radius for everybody, or an array in SEAT order — `players[i]`
   * occupies topology index `i`, the same order `topology` receives. A short
   * array is refused rather than padded.
   *
   * Runs AFTER `topology`, which is what makes centrality expressible.
   * Visibility is then asymmetric: at those settings the hubs can see somebody
   * who cannot see them, and the rule is keyed on the VIEWER's radius alone.
   */
  radius?:
    | Radius
    | ((args: {
        game: any;
        playerCount: number;
        /** In seat order: `players[i]` occupies topology index `i`. */
        players: any[];
        /** The realized topology, so centrality is available. */
        edges: Edge[];
        rng: Rng;
      }) => Radius | Radius[]);
  /**
   * What a participant learns ABOUT somebody they are not connected to.
   *
   *     graph: {
   *       radius: 2,
   *       projectFar: (person, viewer, ctx) =>
   *         ctx.distance === 2 ? { color: ctx.stateOf(person).get("color") } : undefined,
   *     }
   *
   * Omit it — the default — and a wider radius discloses TOPOLOGY ONLY: distant
   * people appear as a shape with a name and nothing else. That default is the
   * whole reason this is a separate callback rather than `project()` receiving a
   * distance. Every `project()` written against this package ignores its context
   * argument, so routing distant people through it would turn raising the radius
   * into a full attribute disclosure about strangers — a second decision arriving
   * as a side effect of a larger number.
   *
   * Return `undefined` for a person and they still APPEAR: the shape of the
   * network is already disclosed by the radius, and vanishing them would draw a
   * network with holes in it. That differs from `project()`, where `undefined`
   * drops a neighbor entirely, and the difference is deliberate — at distance 1
   * the node and the data are the same disclosure, and beyond it they are not.
   *
   * `ctx.distance` is how many hops away they are, always 2 or more.
   * `ctx.ref` is the name this viewer sees for them. The returned value may not
   * CONTAIN a player id: that would hand over a stable, cross-viewer handle on a
   * stranger and undo the naming scheme, so it is refused at publish time rather
   * than trusted.
   *
   * Reads through `ctx.stateOf(person)` and the recording proxy exactly as
   * `project()` does, so `watch` keeps the value live.
   */
  projectFar?: (target: any, viewer: any, ctx: FarContext) => unknown;
}

/** The context a `projectFar` receives. `ProjectContext` plus the two facts it needs. */
export interface FarContext extends ProjectContext {
  /** Hops from viewer to target. Always >= 2. */
  distance: number;
  /** The name this viewer sees for this person. Never an id, never a seat. */
  ref: string;
}

export interface NetworkConfig {
  /**
   * Build the network at game start. Receives a seeded rng so the realization
   * is reproducible from the seed recorded on the game scope.
   *
   * `players` is the SEATING PLAN: `players[i]` is the participant who will
   * occupy topology index `i`, so `edge [i, j]` ties `players[i]` to
   * `players[j]`. It is here because without it a design cannot place anybody
   * deliberately — the generators return an anonymous edge list over indices,
   * and who lands where was decided afterwards, out of reach.
   *
   * That is not a hypothetical gap. Shirado & Christakis (2017) manipulate
   * exactly this: their bots are placed at central, peripheral or random nodes,
   * and the placement is the independent variable. Expressing it needs the
   * ability to say which seat a particular participant gets, and until this
   * field existed the only way to get it was to read `game.players` and rely on
   * the package happening to seat them in that order — true, but an accident of
   * two lines in `onGameStartAttribute` rather than anything promised. Now it is
   * promised, and `test/unit/seating.test.ts` fails if it stops being true —
   * including the case that matters, where a broken mapping still produces a
   * perfectly correct graph over the wrong people.
   *
   * Placement is done by RELABELING: generate the graph you want, then permute
   * the indices so the seats you care about land on the degrees you want. The
   * alternative — reordering the participants — is not available, because seats
   * are fixed before this is called.
   *
   * `playerCount` is `players.length`, kept because most designs want only the
   * number and `({ playerCount, rng })` is the common signature.
   */
  topology?: (args: {
    game: any;
    playerCount: number;
    /** In seat order: `players[i]` occupies topology index `i`. */
    players: any[];
    rng: Rng;
  }) => Edge[];
  /**
   * What ONE participant may learn about ONE neighbor.
   *
   * Pure, and the only channel through which data reaches a client. There is
   * deliberately no way for an author to choose where this is written: the
   * obvious alternative (writing to the player scope) is broadcast to everyone
   * and looks like it works.
   */
  project?: (neighbor: any, viewer: any, ctx: ProjectContext) => unknown;
  /** Explicit seed. Defaults to one derived from the game id. */
  seed?: number;
  /**
   * Limits on what may be published. Enforced by default; see `./envelope.ts`
   * for what each number rests on.
   */
  envelope?: EnvelopeLimits;
  /**
   * Keys that feed `project()` — on the player scope, or on a private channel.
   *
   * A change to any of them republishes the views that can see it. Empirica has
   * no wildcard attribute listener, so this list cannot be inferred — but
   * `project()` runs against a recording proxy, so anything it reads that is
   * missing here is reported rather than silently going stale.
   *
   * Leave it empty for a static network whose projection never changes.
   *
   * For a private key the server reads but `project()` never touches, use `read`
   * below instead — the two behave identically, and saying which you meant is the
   * point.
   */
  watch?: string[];
  /**
   * Private keys the SERVER reads but the projection does not.
   *
   * A submitted answer, a decision, anything a listener consumes rather than
   * publishes. Read back with `net.stateOf(gameID, playerID, key)`, and visible in
   * `net.inspect()`'s per-node `state`.
   *
   * Mechanically identical to `watch` — the two are unioned, and a key in either
   * gets its listener and its place in the snapshot. It is a separate field
   * because until M6 there was only `watch`, doing both jobs under one name, and
   * the second job had no recording proxy behind it: a private key the server
   * needed but nobody had listed read back as `undefined`, which is exactly what
   * "the participant has not written it yet" looks like.
   *
   * Found while building the Rand 2011 reconstruction, where the omitted key was
   * the participants' rewiring answers: every answer read back as `undefined`, so
   * `applyRewiring` got an empty answer set and the network NEVER CHANGED — in the
   * condition whose entire point is that it does — with nothing throwing anywhere
   * (`ISSUES.md` O11). `stateOf()` is the loud path that replaces it; this field
   * is what tells `stateOf()` the key is legitimate.
   *
   * Listing a key `project()` ignores costs one listener and no wire traffic,
   * since a republished view comes out byte-identical and is suppressed (§7.1).
   */
  read?: string[];
  /**
   * How much of the network each participant is shown.
   *
   *     withNetwork(Empirica, { …, graph: { radius: 1.5 } })
   *
   * `1` (the default) sends nothing extra. The client draws a STAR from
   * `useNeighbors()` alone — the viewer, their neighbors, a line to each — so
   * the display costs the neighbor-limited guarantee nothing and no assertion in
   * this repository moves. Breadboard's participants saw exactly that, enforced
   * on its own server.
   *
   * `1.5` additionally sends the ties BETWEEN a participant's neighbors: the
   * subgraph induced on their closed neighborhood. This is a real widening of
   * what a participant is told, and it is opt-in for that reason rather than
   * because it is expensive. What it costs is worth stating plainly before
   * anyone turns it on:
   *
   *   - It is more than the papers reconstructed here gave their subjects, and
   *     for Shirado & Christakis (2017) it makes the task easier — local
   *     structure is exactly what a coordinating participant lacks. Turning it
   *     on there runs a different experiment, the same way projecting `wealth`
   *     into Rand 2011 runs Nishi 2015 (see `docs/EXPERIMENTS.md`).
   *   - It tells a participant who among their neighbors know each other, which
   *     is a fact about two OTHER people that neither of them disclosed.
   *
   * Wider settings exist and are the rest of this config: `2`, `2.5`, … and
   * `"whole"`, per seat if `radius` is given a function, and changeable during a
   * game with `net.setRadius`. A value BETWEEN the steps is still refused rather
   * than rounded, because 2 and 2.5 are different studies and neither should
   * arrive as a side effect of a typo.
   */
  graph?: GraphConfig;
  /**
   * Neighbor-scoped chat.
   *
   * Off by default: it costs a listener and per-channel storage, and most
   * designs do not want it. `true` uses the defaults below.
   *
   * A message written by a participant to their own channel is fanned out by the
   * server to whoever is their neighbor AT THAT MOMENT. There is no separate
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
   * afterwards. Also the audit trail for the neighbor-limited claim on a real
   * study's own data, rather than on this package's tests.
   */
  views?: ViewsConfig;
  /**
   * An append-only run log, written as the study happens.
   *
   *     withNetwork(Empirica, { …, log: { file: "data/run.ndjson" } });
   *     // then, from any listener:
   *     net.log(stage.currentGame, { type: "round", round: 3, rows });
   *
   * **What this is for.** Analysis files are normally written in `onGameEnded`,
   * which fires only when a game ends NATURALLY. A study that is killed, crashes,
   * or is stopped mid-session never reaches it — and since upstream cannot resume one, a crash
   * mid-study is the *normal* shape of "something went wrong", because a restarted
   * server cannot put participants back in their game anyway. So the case where
   * partial data matters most was the case that produced none. Measured, not
   * imagined: a green run of `test/e2e/rand2011.test.ts` left `views.ndjson` and
   * not one CSV.
   *
   * One file for the whole study, not one per game: every record is stamped with
   * its `gameID` and its `at`, so a batch of concurrent games interleaves safely
   * and an analyst groups by game offline. Read it back with `parseNdjson` from
   * `empirica-networks/export`, which tolerates the half-written final line a hard
   * kill leaves.
   *
   * Unbuffered by default — see `batch` — because a facility that exists to
   * survive a kill should not default to holding its most recent records in
   * memory. `views` makes the opposite trade for the opposite reason.
   *
   * What goes in the records is yours. The package writes none of its own: the
   * realized network is already durable on the batch scope, and inventing a
   * parallel copy here would create two versions of the same fact.
   */
  log?: LogConfig;
  /**
   * A participant wrote one of their own private keys.
   *
   *     onPrivateState: ({ gameID, playerID, key, value }) => { … }
   *
   * Fires for any key in `watch` or `read`, on the participant's PRIVATE channel
   * only — a player-scope write is broadcast to everyone and is `Empirica.on(
   * "player", key, …)`'s business. Delivered after the republish the write
   * triggered, so a hook that ends the stage does so with everyone's view already
   * current.
   *
   * This exists because the only previous way to get it reached into the package's
   * key layout:
   *
   *     Empirica.on(NBHD_KIND, stateKey("color"), (_ctx, props) => { … });
   *
   * which requires knowing that a plain `.on` escapes the `unique` guard, and
   * which works ONLY because `withNetwork` issued
   * `ctx.scopeSub({ kinds: ["nbhd"] })` at start — so the same three lines copied
   * into a project that does not call `withNetwork` produce a listener that never
   * fires, silently (`docs/PLATFORM-NOTES.md` §11). It was in
   * `examples/shirado2017` for a whole milestone, which is how a package finds out
   * it is missing something.
   *
   * A config field rather than a `net.onPrivateState(key, cb)` method, and that is
   * a deliberate refusal: a method invites registration after the admin has
   * started, and a listener registered too late is a listener that never fires. A
   * field is read before anything is wired.
   *
   * **Synchronous.** A returned promise is not awaited, and any write made after
   * an `await` inside it lands outside the runloop's flush and reaches nobody —
   * the trap `GameNetwork` documents for mutators, arriving here by a different
   * road. Do the work inline, or queue it and write from a listener.
   *
   * A throw is caught and reported rather than propagated: with twenty
   * participants, one hook failing must not stop the other nineteen's events
   * being processed. That is the opposite of `project()`, which throws — there,
   * nothing has been sent yet and a bad view must not go out; here the write has
   * already happened and the choice is only whether to keep going.
   *
   * Fires again for a value already delivered if attributes are replayed (a
   * restart), and does not dedupe. `lastOutbox` in the chat relay is what
   * deduping looks like when a design needs it.
   */
  onPrivateState?: (event: PrivateStateEvent) => void;
}

/** One participant's write to one of their own private keys. */
export interface PrivateStateEvent {
  gameID: string;
  /** Player id, never a topology index — see `GameNetwork`. */
  playerID: string;
  key: string;
  /** The value as stored. `undefined` if the key was cleared. */
  value: unknown;
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

const defaultProject = (neighbor: any) => ({ id: neighbor.id });

/** Per-game network state, server-side only. */
interface NetworkState {
  /** Mutable: rewiring replaces this in place. */
  edges: Edge[];
  adj: number[][];
  /** player id in topology order */
  order: string[];
  seed: number;
  /**
   * How far each SEAT can see, index-aligned with `order`.
   *
   * Per seat rather than one value, because visibility is a property of the
   * participant and not of the study — and because that makes it asymmetric:
   * `radii[a] = 2` and `radii[b] = 1` two hops apart means a sees b and b does
   * not see a. Every rule that reads this must read the VIEWER's entry; reading
   * the subject's is the same picture and a different study.
   */
  radii: Radius[];
  /** The widest entry in `radii`. See `widestOf`. */
  widest: Radius;
  /**
   * Secret that names distant people to each viewer. Empty below radius 2,
   * where every visible node is in the viewer's own neighbor array and the
   * positional scheme names all of them.
   */
  viewKey: string;
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
  /**
   * How long the first channel took to come back, in ms — or `undefined` if
   * none ever has.
   *
   * Not a resource count like the rest of this record, and here anyway: it is
   * the quantity the kind-registration warning is racing, and that warning is
   * the only thing in the package that can accuse correct code of being broken
   * (`ISSUES.md` O14, O15). A number that decides whether someone is told their
   * server is misconfigured should be readable by the person being told.
   *
   * Measured from the first `addScopes` request to the first `nbhd` scope
   * arriving on the subscription, on the admin's own event loop — the same loop
   * the check's timer runs on, so the two are comparable by construction.
   */
  firstChannelMs: number | undefined;
  /** Cached serialized views, one per channel published to. */
  cachedViews: number;
  /**
   * Cached neighborhood layouts, one per channel published to at radius 1.5.
   *
   * Always zero at the default radius, where no layout is computed at all.
   */
  cachedLayouts: number;
  /**
   * Finished games still remembered by id.
   *
   * The one structure that outlives its game on purpose, and therefore the one
   * worth being able to see. Grows by one per game ended and is capped at
   * `MAX_ENDED_GAMES` (`./retention.ts`, `ISSUES.md` O5); everything else in
   * this record should return to zero between games.
   */
  endedGames: number;
  /**
   * Chat dedupe entries held — one per participant who has sent a message.
   *
   * Zero unless `chat` is enabled, and back to zero when the game ends. Reported
   * because it is keyed by player rather than by game, so it is the one release
   * that a game-keyed sweep would miss, and it did.
   */
  chatSeqs: number;
  /**
   * Players skipped at game start for having no `participantID`, since process
   * start. Not a resource count; see `lateProvisioned`.
   */
  pendingAtStart: number;
  /**
   * Players provisioned by the connect-time repair path, since process start.
   *
   * Here for one purpose: `ISSUES.md` O4 can be closed by reproducing the
   * platform path OR by ruling it out **at runtime rather than by inference**,
   * and until this counter existed there was no runtime to consult. The repair
   * fired silently, so a study could have hit the path a hundred times and left
   * no trace of it — which is precisely the shape of an entry that stays open
   * for three milestones on an argument from reading upstream's source.
   *
   * Zero is the expected value and is the evidence. It does NOT reset between
   * games: the question is whether this process ever saw it, and a per-game
   * counter would answer a question nobody asked.
   *
   * Counted separately from `pendingAtStart` because they are not the same
   * event. A player pending at start who later connects increments both, in
   * that order; one that increments only `lateProvisioned` had a
   * `participantID` all along and lost a channel some other way, which would be
   * a different defect wearing O4's clothes.
   */
  lateProvisioned: number;
}

export interface NetworkHandle {
  /** Recompute and republish every participant's view. */
  publishAll(): boolean;
  /** Live counts of everything held per game or per channel. */
  stats(): NetworkStats;
  /**
   * Games this PROCESS is currently networking, newest first.
   *
   * Renamed from `games()` in M6, because the old name invited exactly one wrong
   * reading — "the current game" — and the lifetime is the whole subtlety. A
   * process runs many games sequentially: this returns every one that has started
   * and not yet ended, which in a batch of concurrent games is several, and in a
   * test suite can be a previous scenario's if a game was never ended.
   *
   * `startedAt` is here so that "which one is current" is answerable from the
   * return value instead of by convention. It is ms since epoch, from the server
   * clock, recorded when this process began networking the game — so after a
   * restart it is the RECOVERY time, not the original start. Stated because a
   * timestamp that silently means two different things is worse than none.
   */
  activeGames(): Array<{ id: string; startedAt: number }>;
  /**
   * Everything known about one game's network, as plain data.
   *
   * Returns `undefined` for a game this process is not networking — which is
   * the honest answer for a game that has ended, was never started, or was lost
   * to a restart. It is deliberately NOT an empty snapshot: an observer
   * cannot tell an empty graph from a missing one, and this package's
   * characteristic failure is exactly that confusion.
   *
   * READ ONLY, and safe to call from anywhere — a timer, an HTTP handler, a
   * REPL. Writes are the thing that only count inside a callback
   * (docs/PLATFORM-NOTES.md §15); nothing here writes.
   */
  inspect(game: GameRef): GameSnapshot | undefined;
  /**
   * One participant's private value for one key — the loud read path.
   *
   *     const answers = net.stateOf(stage.currentGame, playerID, "rewireAnswers");
   *
   * Use this rather than `inspect(gameID)?.nodes[i]?.state[key]` for anything a
   * listener consumes. Both read the same store; the difference is entirely in
   * what happens when you are wrong, and being wrong here is invisible.
   *
   * **`undefined` means one thing only: the participant has not written this
   * key.** Every other way of not having a value throws — an undeclared key, a
   * game this process is not networking, a player outside the graph, a channel
   * that has not materialised. The snapshot path collapses all five into
   * `undefined`, and that is how `examples/rand2011` ran a whole study in which
   * the rewiring manipulation did nothing (`ISSUES.md` O11): the key was missing
   * from the key list, every answer read back as "not submitted", the network
   * never changed, and nothing anywhere errored.
   *
   * Reads are safe from anywhere — a timer, an HTTP handler, a test. It is
   * writes that only count inside a callback (`docs/PLATFORM-NOTES.md` §15).
   *
   * Not on `GameNetwork`, and not returning a scope: `inspect()`'s note about
   * observers acquiring write paths applies equally to a read accessor, so this
   * returns the stored value and nothing that can reach the store.
   */
  stateOf<T = unknown>(game: GameRef, playerID: string, key: string): T | undefined;
  /**
   * Append one record to the run log, now.
   *
   *     net.log(stage.currentGame, { type: "round", round: 3, rows });
   *
   * `gameID` and `at` are stamped on; everything in `record` is written beside
   * them. Requires `log: { file }` (or `log: { onRecord }`) in the config, and
   * **throws if there is none** — a logging call that quietly went nowhere would
   * be indistinguishable from a study that recorded nothing, which is the failure
   * this facility exists to prevent.
   *
   * The two kinds of error are treated differently on purpose. A bad call — no
   * log configured, an unresolvable game, a record that is not a plain object —
   * throws, because it is deterministic and shows up the first time the code
   * runs. A failure to WRITE (a full disk, a vanished directory) is reported and
   * swallowed, because it happens mid-study and the study matters more than its
   * telemetry.
   *
   * Safe from anywhere, unlike the mutators: this writes to the filesystem, not
   * to a scope, so it does not depend on being inside a callback.
   */
  log(game: GameRef, record: Record<string, unknown>): void;
}

export function withNetwork(collector: any, config: NetworkConfig = {}): NetworkHandle {
  const topology = config.topology ?? defaultTopology;
  const project = config.project ?? defaultProject;

  const watch = config.watch ?? [];
  const readOnly = config.read ?? [];
  /**
   * Every private key this instance can see, `watch` and `read` together.
   *
   * Unioned rather than kept apart, so that misfiling a key between the two
   * fields cannot break anything: both get a listener, both appear in
   * `inspect()`, both are readable through `stateOf()`. The distinction is
   * declarative — it records what the author meant, and gives `stateOf()`
   * something to check against — and a distinction that also changed behavior
   * would be a new way to be silently wrong, which is the thing being fixed.
   */
  const readable = [...new Set([...watch, ...readOnly])];
  const chatEnabled = Boolean(config.chat);
  const chatHistory =
    (typeof config.chat === "object" ? config.chat.history : undefined) ?? 200;
  /**
   * playerID -> highest outbox seq already relayed, so a republish cannot
   * duplicate.
   *
   * Keyed by PLAYER, not by game, so it is not covered by any of the game-keyed
   * deletes in `releaseGame` and has to be cleared there explicitly. That was
   * missed until `ISSUES.md` O5, and the consequence was worse than the leak:
   * Classic reuses a participant's player scope across sequential games, while
   * the client derives its sequence number from the OUTBOX ATTRIBUTE ON ITS OWN
   * CHANNEL (`src/player/chat.ts`) — a fresh channel each game, so the count
   * restarts at 1. A stale high-water mark therefore silently DROPS the first
   * messages of a later game. Witness: `test/unit/retention.test.ts`.
   */
  const lastOutbox = new Map<string, number>();
  /**
   * How much structure participants are shown. See `NetworkConfig.graph`.
   *
   * Validated here rather than at first publish: a typo in a study's config
   * should stop it starting, not surface as a screen that quietly shows less
   * than the design says.
   */
  const validRadius = (r: unknown): r is Radius =>
    r === "whole" ||
    (typeof r === "number" && Number.isFinite(r) && r >= 1 && r * 2 === Math.floor(r * 2));

  const refuseRadius = (r: unknown): never => {
    throw new Error(
      `empirica-networks: graph.radius must be at least 1 and a multiple of 0.5, or ` +
        `"whole", got ${JSON.stringify(r)}.\n\n` +
        `  1       (default) each participant sees themselves and their own connections.\n` +
        `  1.5     additionally sees the ties BETWEEN their connections.\n` +
        `  2       additionally sees their connections' connections.\n` +
        `  2.5     …and the ties among those.\n` +
        `  "whole" the entire network.\n\n` +
        `  floor(radius) bounds the PEOPLE and the fraction decides the TIES, so k and\n` +
        `  k.5 always show the same faces. A radius is refused rather than rounded\n` +
        `  because 2 and 2.5 are different studies.\n\n` +
        `  Infinity is not accepted: "whole" is the one spelling for that.\n`
    );
  };

  /**
   * The configured radius, when it is a literal.
   *
   * `undefined` when the study passed a FUNCTION, because a function cannot be
   * resolved here: it runs against the realized topology, and no game exists
   * yet. The shape is still checked eagerly — a study that passes a number
   * typed wrong stops at start-up, which is what the comment above promises —
   * and each resolved value is checked again at seat assignment, before the
   * envelope and before any channel is provisioned.
   */
  const configuredRadius = ((): Radius | undefined => {
    const r = config.graph?.radius ?? 1;
    if (typeof r === "function") return undefined;
    if (validRadius(r)) return r;
    return refuseRadius(r);
  })();

  /**
   * Resolve every seat's radius, once, after the topology is realized.
   *
   * After, and that is the load-bearing order: the asymmetric design this
   * exists for is "the most central participants see further", and centrality
   * is a property of the graph the study actually drew. `examples/shirado2017`
   * places its agents the same way.
   */
  function resolveRadii(args: {
    game: any;
    players: any[];
    edges: Edge[];
    rng: Rng;
  }): Radius[] {
    const n = args.players.length;
    const spec = config.graph?.radius ?? 1;
    const produced =
      typeof spec === "function"
        ? spec({ game: args.game, playerCount: n, players: args.players, edges: args.edges, rng: args.rng })
        : spec;

    if (!Array.isArray(produced)) {
      if (!validRadius(produced)) refuseRadius(produced);
      return new Array<Radius>(n).fill(produced);
    }
    // A short array would leave somebody at a radius nobody chose, and the
    // screen would look entirely correct. Refused rather than padded.
    if (produced.length !== n) {
      throw new Error(
        `empirica-networks: graph.radius returned ${produced.length} value(s) for ` +
          `${n} participant(s). Return one radius per seat, in seat order, or a single ` +
          `radius for everybody. Padding the short end would seat somebody at a radius ` +
          `the design did not choose.`
      );
    }
    for (const r of produced) if (!validRadius(r)) refuseRadius(r);
    return [...produced];
  }
  /**
   * Does anything go on the wire beyond the neighbor views?
   *
   * A named predicate rather than `graphRadius > 1` repeated, and that is not
   * tidiness: `"whole" > 1` is FALSE in JavaScript — comparing a string to a
   * number yields NaN — so the widest setting in the package would have sent
   * nothing at all, silently, at both of the places that test used to appear.
   */
  const showsStructure = (r: Radius): boolean => r !== 1;
  /**
   * Does anyone appear in a picture without appearing in the view that names
   * them?
   *
   * False at 1 and 1.5, where the ball is the viewer plus their own neighbors
   * and the positional scheme covers every node. True from 2 upward, where a
   * visible node has no entry in `NEIGHBORS` and needs a name of its own.
   */
  const needsRefs = (r: Radius): boolean => r === "whole" || r >= 2;

  /**
   * The widest setting in a game, for the two decisions that are about the GAME
   * rather than about a viewer.
   *
   * `commit()` asks "could this edge change matter to anybody", and
   * `republishAround` asks "how far do I have to walk before filtering". Both
   * would be wrong to ask per viewer and both must be cheap, so they are derived
   * once per game and kept beside the radii.
   */
  /** The one value, when there is one. `undefined` for a mixed study. */
  const uniformOf = (radii: Radius[]): Radius | undefined =>
    radii.length > 0 && radii.every((r) => r === radii[0]) ? radii[0] : undefined;

  const widestOf = (radii: Radius[]): Radius =>
    radii.reduce<Radius>(
      (a, b) => (a === "whole" || b === "whole" ? "whole" : Math.max(a, b)),
      1
    );
  const projectFar = config.graph?.projectFar;
  /**
   * nbhd scope id -> where each of that viewer's nodes was last laid out, BY
   * PLAYER ID, together with the shape those positions belong to.
   *
   * Keyed by player rather than by position in the array because a neighborhood
   * renumbers when a tie is dropped; see `graph_payload.ts`. Keyed per SCOPE
   * because each viewer has their own picture — one cache per game would hand
   * every participant somebody else's coordinates, which is a perfectly
   * plausible drawing of a graph nobody has.
   */
  const lastLayout = new Map<string, LayoutCache>();
  const viewSink = makeViewSink(config.views);
  const logSink = makeLogSink(config.log);

  const networks = new Map<string, NetworkState>();
  /** nbhd scope id -> the modeled scope object we can call .set() on. */
  const channelScopes = new Map<string, any>();
  /** games waiting for their channel scopes to materialise before first publish */
  const awaitingPublish = new Set<string>();
  /** games networked by a previous process, waiting for their channels to arrive */
  const recovering = new Set<string>();
  /** gameID -> (topology index -> playerID), rebuilt from the channels themselves */
  const recoveredOrder = new Map<string, Map<number, string>>();
  const games = new Map<string, any>();
  /**
   * When THIS process began networking each game.
   *
   * Not when the game started: after a restart the original start time is not
   * recoverable from anything durable, and inventing one would make
   * `activeGames()` report a lie with a plausible shape. `activeGames`'s doc
   * comment says which it is.
   */
  const startedAt = new Map<string, number>();
  const seqByGame = new Map<string, number>();
  /** nbhd scope id -> last published view, serialized. Suppresses no-op writes. */
  const lastPublished = new Map<string, string>();
  /** Keys already warned about, so the hot path warns once rather than per publish. */
  const reportedMissing = new Set<string>();
  /** Whether the duplicate-lifecycle-listener check has already run. */
  let reportedDuplicates = false;
  /**
   * Whether ANY channel scope has ever materialised in this process.
   *
   * The evidence behind the kind-registration check. Process-wide rather than
   * per-game because registration is a process-wide property: once one channel
   * has come back as a modeled scope, the kind is registered, and no later
   * game can prove otherwise.
   */
  let sawAnyChannel = false;
  /** Whether the one-shot registration check has already been scheduled. */
  let registrationCheckArmed = false;
  /**
   * When channels were first requested from Tajriba, and how long the first one
   * took to come back. The evidence the registration check rests on, made
   * visible — see `NetworkStats.firstChannelMs`.
   */
  let firstProvisionAt: number | undefined;
  let firstChannelMs: number | undefined;
  /** Per PROCESS, not per game — see `NetworkStats.lateProvisioned`. */
  let pendingAtStart = 0;
  let lateProvisioned = 0;
  /**
   * The warning this process has already printed, if it printed one — so that a
   * channel arriving afterwards can retract it rather than leaving a false
   * accusation as the last word in the log.
   */
  let accusation: { created: number; waitMs: number } | undefined;
  /**
   * Games known to be over. Ids only, oldest first, capped.
   *
   * This is the one thing deliberately NOT released per game, because it is what
   * stops a finished game's channels being re-adopted when the kind subscription
   * replays them. A string id per game is a few dozen bytes against one Scope
   * object per participant, so the trade is heavily favorable — but it used to
   * be unbounded in the number of games a process ran, which is `ISSUES.md` O5.
   *
   * Bounded rather than cleared on some batch signal, and forgetting the oldest
   * is safe for a reason worth stating: a replay that re-adopts an evicted
   * game's channels also replays that game's own `start` attribute, and
   * `onGameStartAttribute` releases an already-ended game rather than networking
   * it. So an eviction costs a transient hold, not a permanent one, in the
   * ordering where the channels arrive first. See `./retention.ts`.
   */
  const endedGames = new Set<string>();
  /** Whether the eviction warning has been said. Once per process; see below. */
  let reportedEviction = false;
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
  /**
   * Channels that currently hold a structure payload.
   *
   * Only so one can be cleared when a viewer's radius drops below the setting
   * that produced it. See the write loop in `publish`.
   */
  const graphSent = new Set<string>();
  const historyByGame = new Map<string, EdgeEvent[]>();
  /** Every change to how far somebody can see, per game. See `RadiusEvent`. */
  const radiusLogByGame = new Map<string, RadiusEvent[]>();

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
    // Here rather than at withNetwork() time, and the timing is the whole
    // mechanism: registrations happen while the callbacks module is being
    // evaluated, and `withNetwork(...)` is one statement inside it. Counting at
    // that moment would miss every listener declared below the call — which in
    // both shipped examples is most of them. `start` fires once the admin
    // connects, after module evaluation is complete.
    reportDuplicateLifecycleListeners();
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
    // Before every early return below, including the ended-game one: reaching
    // this line at all proves the kind is registered, which is the only thing
    // the registration check needs to know.
    if (!sawAnyChannel && firstProvisionAt !== undefined) {
      firstChannelMs = Date.now() - firstProvisionAt;
      if (accusation) {
        warn(registrationRetractionMessage(accusation.created, accusation.waitMs, firstChannelMs));
        accusation = undefined;
      }
    }
    sawAnyChannel = true;
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
    const evicted = rememberEndedGame(endedGames, game.id, endedGamesCap());
    if (evicted !== undefined && !reportedEviction) {
      reportedEviction = true;
      warn(endedGamesEvictedMessage(endedGamesCap()));
    }
    // The chat relay's dedupe state is keyed by player, so none of the
    // game-keyed deletes below reach it. Read the seating order BEFORE
    // `networks.delete`, which is the only record of who was in this game.
    for (const playerID of networks.get(game.id)?.order ?? []) lastOutbox.delete(playerID);
    // Before anything else: a game ending is the last moment its records are
    // certainly still wanted, and the buffer would otherwise sit until the next
    // game filled it or the process exited. A no-op for the run log at its
    // default `batch: 1`, and not a no-op for anyone who raised it.
    viewSink?.flush();
    logSink?.flush();
    gameNetworks.delete(game.id);
    historyByGame.delete(game.id);
    radiusLogByGame.delete(game.id);

    // Read the channel map BEFORE clearing it: the per-scope maps are keyed by
    // channel scope id, not by game, so this is the only way to find them.
    for (const scopeID of Object.values(readChannels(game))) {
      channelScopes.delete(scopeID);
      lastPublished.delete(scopeID);
      // Keyed by scope id like `lastPublished`, so none of the game-keyed
      // deletes below reach it. This is `ISSUES.md` O5's shape exactly: a map
      // whose key is not the game accumulates one entry per participant per
      // game, for the life of the process, and nothing about it is visible from
      // inside a running study.
      lastLayout.delete(scopeID);
    }
    releaseChannels(game.id);

    networks.delete(game.id);
    games.delete(game.id);
    startedAt.delete(game.id);
    seqByGame.delete(game.id);
    recoveredOrder.delete(game.id);
    awaitingPublish.delete(game.id);
    recovering.delete(game.id);
  }

  /**
   * Held in a const so the duplicate-listener detector can exclude it BY
   * IDENTITY.
   *
   * This is a plain `.on` on `game/start` — one of the six pairs the detector
   * watches. As an inline `async (ctx, { game }) => …` its shape was exactly a
   * `unique` wrapper's, so a consumer registering a single, correct
   * `onGameStart` alongside `withNetwork` would have been warned about entirely
   * healthy code. Both shipped examples do precisely that, so the detector would
   * have cried wolf on its own package's examples.
   *
   * Naming it happens to fix that a second way — an arrow assigned to a `const`
   * takes the const's name, so this is now `AsyncFunction/"onGameStartAttribute"/2`
   * and no longer collides. That is a side effect of readable code, not a
   * guarantee: inlining it again, or a build that mangles names, would restore
   * the collision without touching the detector. The identity exclusion is the
   * one that is actually load-bearing, and it holds either way.
   */
  const onGameStartAttribute = async (ctx: any, { game }: any) => {
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
    // Recorded on first sight, including on the recovery path below — so it is
    // consistently "when this process picked the game up", never sometimes that
    // and sometimes the original start.
    if (!startedAt.has(game.id)) startedAt.set(game.id, Date.now());

    // Already networked by a previous process.
    //
    // This listener re-fires on restart, because attribute listeners replay
    // attributes the admin already holds (PLATFORM-NOTES §4d) and `start` is one
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
    // `players` is handed to `topology` and then used, unchanged, to build
    // `order` below. Same array, same tick — which is what makes the seating-plan
    // guarantee in NetworkConfig.topology a contract rather than a coincidence.
    const edges = topology({ game, playerCount: players.length, players, rng });
    const adj = adjacency(players.length, edges);

    /**
     * Who sees how far, resolved here because this is the first moment it can
     * be: a radius function takes the realized topology, and the envelope check
     * below needs the answer.
     */
    const radii = resolveRadii({ game, players, edges, rng });
    const uniform = radii.every((r) => r === radii[0]) ? radii[0] : undefined;

    // Before provisioning and before anything is recorded: an out-of-envelope
    // topology should fail while the experiment is still abandonable, not after
    // participants have been committed to a game that will run badly.
    checkDegrees(adj, config.envelope, warn);
    checkVision(adj, radii, config.envelope, warn);

    // Recorded so the exact realization is reconstructible from stored data —
    // on the BATCH, because the game scope is delivered to every participant and
    // this is the seating plan of the network they are inside (PLATFORM-NOTES
    // §4c). Suffixed by game id since one batch holds many games.
    const batch = game.batch;
    if (!batch) {
      throw new Error(
        `empirica-networks: game ${game.id} has no batch, so the realized network cannot ` +
          `be recorded. Without it the run is not reproducible and cannot survive a restart.`
      );
    }
    batch.set(NETWORK_KEYS.seed(game.id), seed);
    batch.set(NETWORK_KEYS.network(game.id), edges);
    // What this study SHOWED people, recorded next to the graph it ran on
    // because it is the other half of the same question and is not derivable
    // from anything else here. Write-once, like the seed: unlike `network` and
    // `history` it cannot change while a game runs.
    //
    // TWO KEYS, and the split is not redundancy. `networkRadii` is the complete
    // record and is written always, so its absence has exactly one cause —
    // "predates the key" — which is the property `networkRadius`'s own docstring
    // argues for and which an array under that key would have destroyed, since
    // absent would then mean "predates" OR "was mixed". `networkRadius` keeps
    // its old meaning and is written only when there IS a single answer, so
    // every reader that exists today keeps working unchanged.
    //
    // Keyed by player id rather than by seat: the seating plan lives on each
    // participant's channel as `topologyIndex` and not on the batch, so a
    // seat-indexed vector would be a record nobody holding this scope can read.
    const radiiByPlayer: Record<string, Radius> = {};
    for (const [i, p] of players.entries()) radiiByPlayer[p.id] = radii[i]!;
    batch.set(NETWORK_KEYS.radii(game.id), radiiByPlayer);
    if (uniform !== undefined) batch.set(NETWORK_KEYS.radius(game.id), uniform);
    // The secret that names distant people to each viewer.
    //
    // Minted for EVERY game, including the ones that will never send a name, for
    // the reason `NETWORK_KEYS.radius` gives about writing itself at every
    // radius: a key that appears only when it is first needed is a key that is
    // missing the first time somebody widens a radius mid-session, and the
    // failure then is that every participant's map of the distant network
    // silently renames itself. 32 bytes and one attribute is a cheap way not to
    // have that conversation later.
    const viewKey = makeViewKey();
    batch.set(NETWORK_KEYS.viewKey(game.id), viewKey);

    const order: string[] = players.map((p: any) => p.id);
    networks.set(game.id, { edges, adj, order, seed, radii, widest: widestOf(radii), viewKey });
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
    // The opening assignment, so this log alone describes the run — including a
    // study that never changes anybody's, where it is the only entry and says so.
    const radiusStart: RadiusEvent = {
      op: "start",
      after: { ...radiiByPlayer },
      seq: seqByGame.get(game.id) ?? 0,
      at: startEvent.at,
    };
    radiusLogByGame.set(game.id, [radiusStart]);
    batch.set(NETWORK_KEYS.radiusHistory(game.id), [radiusStart]);
    batch.set(NETWORK_KEYS.history(game.id), [startEvent]);

    gameNetworks.set(game.id, makeGameNetwork(game));

    // Stamped BEFORE the await, not inside `armRegistrationCheck`. The round
    // trip is part of what the check is waiting out, and on a fast server a
    // channel can materialise before `addScopes` even resolves — measuring from
    // after it would report a latency of zero for the case that matters least
    // and nothing at all for the case that matters most.
    if (firstProvisionAt === undefined) firstProvisionAt = Date.now();
    const { pending, created } = await provisionChannels(ctx, game, (playerID) =>
      order.indexOf(playerID)
    );
    armRegistrationCheck(created.length);
    // A player with no participantID gets no channel, and `publish` refuses to
    // send a partial view — so one unprovisioned player blocks EVERY view in
    // the game, not just their own. That is the right call (a partial publish
    // leaves participants stale with no signal), but it must not be silent.
    if (pending.length > 0) {
      pendingAtStart += pending.length;
      warn(pendingChannelsMessage(pending, players.length));
    }

    // Channel scopes arrive asynchronously via the listener above; if they are
    // not all present yet, publish once they are.
    if (!publishAll(game)) awaitingPublish.add(game.id);
  };
  collector.on("game", "start", onGameStartAttribute);

  /**
   * Republish when a watched attribute changes.
   *
   * One listener per key, registered here at setup, because Empirica dispatches
   * attribute listeners by `kind-key` and has no wildcard. A change to player P
   * republishes P's neighbors (they see P) and P itself (a projection may read
   * the viewer's own state). The byte-identical check in `publish` makes the
   * over-reach free on the wire.
   */
  for (const key of readable) {
    // (a) the player scope — public, broadcast to everyone by Classic.
    collector.on("player", key, (_ctx: any, props: any) => {
      const player = props?.player;
      if (player?.id) republishAround(player.id);
    });

    // (b) the participant's own private channel — the neighbor-limited path.
    //
    // One list covers both scopes deliberately. Which scope a key lives on is
    // the author's choice and can change; making them remember two lists would
    // turn a moved key into silently frozen neighborhoods. Registering a
    // listener for a key nobody uses costs nothing.
    collector.on(NBHD_KIND, stateKey(key), (_ctx: any, props: any) => {
      const scope = props?.[NBHD_KIND];
      const playerID = scope?.get?.(NBHD_KEYS.PLAYER_ID);
      if (typeof playerID !== "string") return;
      republishAround(playerID);
      // After the republish, so a hook that ends the stage does it with every
      // participant's view already current.
      notifyPrivateState(scope, playerID, key);
    });
  }

  /**
   * Fan a message out to the sender's CURRENT neighbors.
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
   * (docs/PLATFORM-NOTES.md §9).
   *
   * Kept anyway, because that replay is undocumented behavior we found by
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
      // Whether Classic actually produces such a player is not established, and
      // this is a net rather than a fix for an observed failure. It is not an
      // exotic path either: `game.players` is
      // `scopesByKindMatching("player", "gameID", id)` — a filter over an
      // ATTRIBUTE — while `player.participantID` is a FIELD assigned inside
      // Classic's own `_.on("player", …)`. Two mechanisms, so they cannot be
      // assumed in step. See docs/PLATFORM-NOTES.md §20.
      //
      // `indexOf` is passed for the same reason game start passes it, and
      // leaving it out was a real defect (`ISSUES.md` O4): the channel carried
      // `topologyIndex: -1`, the OWNER listener records seats only for
      // `idx >= 0`, and `tryRecover` refuses a game with a gap in its seating
      // plan rather than guessing who sits where. So a game repaired by this
      // path ran correctly and was quietly unrecoverable at the next restart.
      // `state.order` is the order fixed at game start and already contains this
      // player: they were in `game.players` all along, missing a channel rather
      // than a seat.
      if (!readChannels(game)[player.id]) {
        // Counted and said out loud BEFORE the repair, so the record survives a
        // `provisionChannels` that throws. O4's done-when offers "ruled out at
        // runtime rather than by inference" as a way to close, and a repair that
        // leaves no trace makes that impossible: the path could have run in
        // every study ever conducted with this package and nobody would know.
        lateProvisioned += 1;
        warn(lateProvisionMessage(player.id, gameID));
        await provisionChannels(ctx, game, (playerID) => state.order.indexOf(playerID));
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

    const targets: {
      scope: any;
      view: unknown[];
      graph?: GraphPayload;
      /** Who the refs in `graph.far` were. Recorded, never delivered. */
      far?: Array<{ ref: string; id: string; hop: number }>;
      json: string;
      viewer: string;
    }[] = [];
    // `viewer` as well as `label`, so the envelope can sum per participant. One
    // view being large and one participant receiving many are different failures
    // with different fixes, and only the second is visible from a total.
    const sizes: MeasuredPayload[] = [];
    const readKeys = new Set<string>();
    /** Shapes laid out during THIS publish, so identical pictures cost one layout. */
    const sharedLayouts = new Map<string, LayoutCache>();

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

      const neighbors: unknown[] = [];
      /**
       * Topology indices of the neighbors ACTUALLY delivered, in delivery order.
       *
       * Not `state.adj[i]`. A neighbor whose player has gone, or whose
       * `project()` returned `undefined`, is skipped below and never reaches the
       * view — so the subgraph's local indices have to be derived from what was
       * sent rather than from what was adjacent. Off by one here draws a
       * complete, well-formed graph connecting the wrong people.
       */
      const delivered: number[] = [];
      for (const j of state.adj[i] ?? []) {
        const neighborID = state.order[j];
        const neighbor = neighborID ? byID.get(neighborID) : undefined;
        if (!neighbor) continue;

        const label = `${playerID}'s view of ${neighborID}`;
        let view: unknown;
        try {
          // Recording proxies: whatever project() reads here is what the view
          // depends on, and therefore what has to be watched for it to stay
          // live. Both arguments are wrapped — a projection can key off the
          // viewer's own state as easily as the neighbor's.
          view = project(
            recordReads(neighbor, readKeys),
            recordReads(viewer, readKeys),
            {
              game,
              viewerIndex: i,
              neighborIndex: j,
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
        sizes.push({ bytes: projectionBytes(view), label, viewer: playerID });
        neighbors.push(view);
        delivered.push(j);
      }

      /**
       * The ties among this viewer's own neighbors, at radius 1.5 only.
       *
       * The layout is reused verbatim while the shape is unchanged, so a
       * neighbor changing a watched attribute moves nobody — the thing a
       * participant is watching their neighborhood FOR would otherwise be
       * invisible under everything rearranging around it.
       */
      let graphPayload: GraphPayload | undefined;
      let farRecord: Array<{ ref: string; id: string; hop: number }> | undefined;
      // THIS viewer's radius, never the game's and never the subject's.
      const radius = state.radii[i] ?? 1;
      if (showsStructure(radius)) {
        const seen = ball(state.adj, i, radius);
        /**
         * Everyone in the picture who is not in the delivered view.
         *
         * Empty below radius 2 by construction, so nothing here runs for a study
         * at the default or at 1.5.
         *
         * SORTED BY (distance, ref), and that is not presentation. `delivered`
         * follows `state.adj[i]`, which `adjacency` returns sorted by SEAT — fine
         * at radius 1, where it is four or five numbers about people the viewer
         * already knows, and a disclosure as soon as the ball is large: a
         * seat-ordered list of most of the study is the seating plan arriving
         * through the ORDER of an array rather than through any value in it.
         * Sorting by ref destroys that ordering and is still deterministic, so
         * the byte-identical suppression below keeps working.
         */
        const far: FarNode[] = [];
        const farNodes: number[] = [];
        if (needsRefs(radius)) {
          const rows: Array<{ k: number; id: string; hop: number; ref: string }> = [];
          for (const k of seen.nodes) {
            const hop = seen.dist[k] ?? Infinity;
            if (hop < 2 || !Number.isFinite(hop)) continue;
            const id = state.order[k];
            if (!id) continue;
            rows.push({ k, id, hop, ref: refFor(state.viewKey, playerID, id) });
          }
          rows.sort((x, y) => x.hop - y.hop || (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
          // Two people under one name is a picture that still looks right, with
          // two participants merged into one. Rare — 40 bits over a ball this
          // size — and silent, which is why it is checked rather than assumed.
          const refs = new Set(rows.map((r) => r.ref));
          if (refs.size !== rows.length) {
            throw new Error(
              `empirica-networks: two people in ${playerID}'s view were given the same ` +
                `name. This is a hash collision, not a configuration error; re-running ` +
                `the game mints a new key and will not reproduce it.`
            );
          }
          for (const r of rows) {
            let farView: unknown;
            if (projectFar) {
              const target = byID.get(r.id);
              const label = `${playerID}'s view of ${r.id} at distance ${r.hop}`;
              if (target) {
                try {
                  farView = projectFar(
                    recordReads(target, readKeys),
                    recordReads(viewer, readKeys),
                    {
                      game,
                      viewerIndex: i,
                      neighborIndex: r.k,
                      distance: r.hop,
                      ref: r.ref,
                      stateOf: (player: any) => makeStateReader(player, channels, readKeys),
                    }
                  );
                } catch (e) {
                  const err = new Error(
                    `empirica-networks: graph.projectFar() threw while building ${label}: ` +
                      `${e instanceof Error ? e.message : String(e)}`
                  );
                  (err as Error & { cause?: unknown }).cause = e;
                  throw err;
                }
              }
              if (farView !== undefined) {
                validateProjection(farView, label);
                // The one rule `project()` does not have. See `validateNoIdentifiers`.
                validateNoIdentifiers(farView, (v) => byID.has(v), label);
                sizes.push({
                  bytes: projectionBytes(farView),
                  label,
                  viewer: playerID,
                  // Measured against the per-view limit — it came from an
                  // author's callback, which is exactly what that limit detects —
                  // but NOT summed, because these bytes are already inside the
                  // structure payload charged below.
                  perViewOnly: true,
                });
              }
            }
            // Present even with no data. The radius has already disclosed that
            // this person is there; dropping them would draw a network with
            // holes in it, which is a different and wronger picture.
            far.push(farView === undefined ? { ref: r.ref, d: r.hop } : { ref: r.ref, d: r.hop, view: farView });
            farNodes.push(r.k);
          }
          farRecord = rows.map((r) => ({ ref: r.ref, id: r.id, hop: r.hop }));
        }

        const nodes = [i, ...delivered, ...farNodes];
        const ids = nodes.map((k) => state.order[k] ?? "");
        // Ball edges are global; the wire carries local indices. Anything naming
        // a node that was not delivered is dropped rather than renumbered — a
        // neighbor can vanish between the walk and the publish, and an edge to
        // a node nobody has is a line to a coordinate that belongs to somebody
        // else.
        const localOf = new Map(nodes.map((k, at) => [k, at]));
        const localEdges: LocalEdge[] = [];
        for (const [a, b] of seen.edges) {
          const x = localOf.get(a);
          const y = localOf.get(b);
          if (x === undefined || y === undefined || x === y) continue;
          localEdges.push(x < y ? [x, y] : [y, x]);
        }
        localEdges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

        /**
         * One layout per distinct SHAPE, not per viewer.
         *
         * Two participants looking at the same people with the same ties between
         * them have the same picture to draw; they only number it differently.
         * At the default radius that never happens, so this map holds one entry
         * per viewer and buys nothing. At whole-network vision it is the whole
         * cost: every viewer's ball is the entire graph, so the first one lays
         * it out and the rest reuse it.
         *
         * Measured on this machine at n=50 whole-network: 4.9 ms per layout, so
         * 245 ms of a single event loop for one republish — a quarter second
         * during which nothing else in the study is served. One layout instead
         * of n brings that back to 4.9 ms. (Machine-local, per ISSUES.md O1.)
         *
         * Preferring this viewer's OWN cache when it matches, because that one
         * carries the warm start their picture has been settling into; the
         * shared entry is only better than laying out from scratch.
         */
        const shapeID = shapeKey(ids, localEdges);
        const own = lastLayout.get(scopeID);
        const cache = own?.key === shapeID ? own : sharedLayouts.get(shapeID);

        const built = buildGraphPayload({
          ids,
          edges: localEdges,
          // Finite on the wire even when the study asked for everything: for
          // `"whole"` the honest number is how far this viewer's own component
          // actually reached, and `whole` carries the intent that no number can.
          radius: radius === "whole" ? seen.eccentricityWithin : radius,
          whole: radius === "whole" ? true : undefined,
          far,
          seed: state.seed,
          cache,
        });
        graphPayload = built.payload;
        lastLayout.set(scopeID, built.cache);
        sharedLayouts.set(shapeID, built.cache);
        sizes.push({
          bytes: projectionBytes(graphPayload),
          label: `${playerID}'s neighborhood structure`,
          viewer: playerID,
          // Counts toward what this participant receives, not toward
          // `maxViewBytes`, which detects an over-broad `project()` and this did
          // not come from one.
          aggregateOnly: true,
        });
      }

      // Skip participants whose view is byte-identical to what they already
      // have. Without this, one player changing one attribute rewrites every
      // neighbor's whole neighborhood on the wire, and the client sees a
      // change event for a value that did not change.
      // The structure is part of the suppression key, not just the neighbor
      // views. It has to be: a tie forming BETWEEN two of this viewer's
      // neighbors changes their structure and leaves their neighbor list
      // byte-identical, so a key over `neighbors` alone would skip the publish
      // and freeze the drawing while every other part of the screen updated.
      const json = JSON.stringify(graphPayload ? [neighbors, graphPayload] : neighbors);
      if (lastPublished.get(scopeID) === json) continue;

      targets.push({
        scope,
        view: neighbors,
        graph: graphPayload,
        far: farRecord,
        json,
        viewer: playerID,
      });
    }

    reportUnwatchedKeys(readKeys);

    if (targets.length === 0) return true;

    checkViewBytes(sizes, config.envelope, warn);

    const seq = (seqByGame.get(game.id) ?? 0) + 1;
    seqByGame.set(game.id, seq);

    // All sets happen inside this callback, so the runloop flushes them as one
    // batched setAttributes.
    const at = Date.now();
    for (const { scope, view, graph, far, json, viewer } of targets) {
      scope.set(NBHD_KEYS.NEIGHBORS, view, { ephemeral: true });
      // Same callback, therefore the same batched setAttributes: a participant
      // never holds a neighbor list from one publish and a structure from
      // another, which would draw ties between the wrong people for as long as
      // the skew lasted.
      if (graph) {
        scope.set(NBHD_KEYS.GRAPH, graph, { ephemeral: true });
        graphSent.add(scope.id);
      } else if (graphSent.has(scope.id)) {
        /**
         * CLEARED, because nothing else would.
         *
         * A radius that drops to 1 stops producing a payload, and an attribute
         * that is simply not written keeps its last value — so the participant
         * would go on being drawn the ball they had when their radius was wider,
         * indefinitely, while every other part of their screen updated. It
         * cannot happen without `setRadius`, which is why it appears in this
         * stage and not the two before it.
         *
         * `null` rather than a delete: `networkGraphOf` already maps it to
         * `undefined`, which is "this study is at radius 1, draw a star" — the
         * correct picture rather than a blocked one.
         *
         * CONDITIONAL on having sent one. Writing it unconditionally would have
         * the default path touching a key it has never touched, and "radius 1
         * sends zero bytes" is a claim with a test behind it.
         */
        scope.set(NBHD_KEYS.GRAPH, null, { ephemeral: true });
        graphSent.delete(scope.id);
      }
      // Monotonic counter, used client-side to detect the silent dones-wiring
      // failure where scopes materialise but every .get() returns undefined.
      scope.set(NBHD_KEYS.SEQ, seq, { ephemeral: true });
      lastPublished.set(scope.id, json);
      // Recorded here rather than per-neighbor above, so the log holds one
      // entry per DELIVERY. Participants skipped by the byte-identical check
      // never reach this loop and correctly produce no record: they were not
      // sent anything.
      //
      // Both writes are part of one batched RPC, so "recorded" and "sent" stand
      // or fall together — with the caveat that a failure of that RPC would
      // leave records for views nobody received. There is no callback to hang
      // the confirmation off, so this is stated rather than handled.
      // `graph` alongside `view`, not inside it: at radius 1.5 the structure is
      // half of what this participant was delivered, and it is the half that
      // cannot be reconstructed afterwards. `undefined` at the default radius,
      // where `JSON.stringify` omits it entirely and the file is byte-identical
      // to one written before this field existed.
      // `far` rides beside `graph`, never inside it: `graph` is byte-for-byte
      // what went on the wire, and this is the server's key to its own payload —
      // which refs were which people. Without it a captured run above radius 1
      // records that somebody was shown four anonymous nodes and loses which
      // four, and the structure joins to nothing.
      viewSink?.record({
        gameID: game.id,
        viewer,
        seq,
        at,
        view,
        graph,
        far,
      } satisfies ViewRecord);
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
      // network in which the wrong people are neighbors, and the run looks
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

    // A game recovered from a previous process keeps the record that process
    // wrote, because `onGameStartAttribute` diverts here before reaching the
    // write. So if this process was started with a different `graph.radius`, the
    // stored value now describes a study these participants are no longer in:
    // they saw one thing before the restart and will see another after it, and
    // nothing else in the system would say so.
    //
    // A warn rather than a throw, for the reason the edge-list warn below gives:
    // the game is already live, and refusing to publish would strand the people
    // inside it. The record is left alone — overwriting it would replace a true
    // statement about the first half of the session with a true statement about
    // the second, and lose the fact that they differ.
    /**
     * ADOPT the recorded radii rather than re-resolving the config.
     *
     * A literal cannot drift, so the scalar version could safely compare config
     * against record. A function can: it runs against the realized topology, and
     * a game recovered after rewiring would resolve to a different vector for
     * reasons that have nothing to do with the study being reconfigured. What
     * participants were actually shown is the fact worth keeping — the same
     * argument the view key below rests on.
     */
    const recorded = readRadii(game);
    // Fall back through the older records before the config: a game networked
    // before `networkRadii` existed has only the scalar, and a game networked
    // before either has neither. Only then does this process's own setting get
    // to decide, and only because something must.
    const legacy = readRadius(game);
    const radii: Radius[] = order.map(
      (id) => recorded?.[id] ?? legacy ?? configuredRadius ?? 1
    );

    // The warning, now element-wise. It is about a restart at a changed
    // configuration, which is still a real event; it is NOT about the radii
    // differing from each other, which under this feature is the ordinary state.
    const previous = recorded !== undefined ? order.map((id) => recorded[id]) : undefined;
    const previousUniform = previous?.every((r) => r !== undefined && r === previous[0])
      ? previous[0]
      : undefined;
    if (previous !== undefined && configuredRadius !== undefined) {
      const differing = order.filter((id) => recorded![id] !== configuredRadius);
      if (differing.length > 0) {
        // The uniform case keeps the sentence it always had — it is what an
        // operator greps for, and it is still the common restart. The mixed one
        // cannot use it, because there is no single number the game "was
        // networked at" to name.
        warn(
          previousUniform !== undefined
            ? `empirica-networks: game ${game.id} was networked at graph.radius ` +
                `${previousUniform} and this process is configured for ${configuredRadius}. Its ` +
                `participants have been shown both. The recorded value is left as ` +
                `${previousUniform}; neither describes the whole session, and analysis of this ` +
                `game should treat the radius as unknown from the restart onward.`
            : `empirica-networks: game ${game.id} was networked with its participants at ` +
                `differing radii, and ${differing.length} of ${order.length} of them are not at ` +
                `the graph.radius ${JSON.stringify(configuredRadius)} this process is configured ` +
                `for. Those participants have been shown both. The record is left as it stands; ` +
                `no single radius describes the whole session for them, and analysis should ` +
                `treat theirs as unknown from the restart onward.`
        );
      }
    }

    // Adopt the key this game's names were computed under, so a participant's
    // picture of the distant network survives the restart with its labels
    // intact. Minting a fresh one would rename everybody at once, which looks
    // to a participant like every stranger being replaced by a different
    // stranger — and nothing on their screen would say otherwise.
    const storedKey = game.batch?.get(NETWORK_KEYS.viewKey(game.id));
    let viewKey: string;
    if (typeof storedKey === "string" && storedKey.length > 0) {
      viewKey = storedKey;
    } else {
      viewKey = makeViewKey();
      game.batch?.set(NETWORK_KEYS.viewKey(game.id), viewKey);
      // Only worth saying when names were in play. A game networked before this
      // key existed sent no refs at all, so there is nothing to have renamed.
      if (radii.some(needsRefs)) {
        warn(
          `empirica-networks: game ${game.id} has no recorded view key and ` +
            `${radii.filter(needsRefs).length} of its participants are at a radius that names ` +
            `people a participant is not connected to. A new key has been recorded, so ` +
            `any such name shown before the restart has changed. Treat names in this ` +
            `game as comparable only within one of the two halves.`
        );
      }
    }

    networks.set(game.id, {
      edges,
      adj: adjacency(order.length, edges),
      order,
      radii,
      widest: widestOf(radii),
      seed: typeof seed === "number" ? seed : 0,
      viewKey,
    });
    recovering.delete(game.id);
    // Reload the log a previous process wrote, so `history()` is complete
    // across a restart rather than starting again from empty.
    const stored = game.batch?.get(NETWORK_KEYS.history(game.id));
    historyByGame.set(game.id, Array.isArray(stored) ? (stored as EdgeEvent[]).slice() : []);
    const storedRadiusLog = game.batch?.get(NETWORK_KEYS.radiusHistory(game.id));
    radiusLogByGame.set(
      game.id,
      Array.isArray(storedRadiusLog) ? (storedRadiusLog as RadiusEvent[]).slice() : []
    );
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
      // Again on every rewire, for the same reason degrees are: a mutation can
      // put somebody inside a ball they were outside of a moment ago.
      checkVision(s.adj, s.radii, config.envelope, warn);
      // Again on every rewire, for the same reason degrees are: a mutation can
      // put somebody inside a ball they were outside of a moment ago.
      checkVision(s.adj, s.radii, config.envelope, warn);

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
      /**
       * At radius 1.5, an edge change is somebody else's business too.
       *
       * A tie between two participants changes the PICTURE of everyone adjacent
       * to both of them — that tie is now inside their neighborhood — while
       * leaving their neighbor lists untouched. `affected` is the endpoints,
       * which is exactly right at radius 1 and silently short by everybody who
       * can see the change at 1.5: their drawing would freeze holding a tie that
       * had gone, or missing one that had arrived, while every other part of
       * their screen kept updating.
       *
       * The neighbors of both endpoints is a superset of that set and is two
       * lookups rather than an intersection. Republishing somebody whose picture
       * did not change costs nothing: the byte-identical check drops it before
       * anything reaches the wire.
       */
      // Widened by the WIDEST seat in the game, not by each viewer's own radius.
      // The question here is "could this edge change matter to anybody", which is
      // about the game; asking it per viewer would be an optimization, and the
      // comment above explains why republishing somebody whose picture did not
      // change is free.
      if (showsStructure(s.widest)) {
        for (const id of affected) {
          const k = s.order.indexOf(id);
          if (k === -1) continue;
          for (const m of ball(s.adj, k, s.widest).nodes) {
            const neighborID = s.order[m];
            if (neighborID) dirty.add(neighborID);
          }
        }
      }
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
      radiusOf(playerID) {
        const s = state();
        return s.radii[indexOf(playerID)] ?? 1;
      },
      setRadius(playerID, radius) {
        const s = state();
        const i = indexOf(playerID);
        if (!validRadius(radius)) refuseRadius(radius);
        const before = s.radii[i] ?? 1;
        if (before === radius) return false;

        s.radii = s.radii.map((r, k) => (k === i ? radius : r));
        s.widest = widestOf(s.radii);

        const batch = games.get(gameID)?.batch;
        if (!batch) {
          throw new Error(
            `empirica-networks: game ${gameID} has no batch, so this radius change cannot ` +
              `be recorded. Refusing to apply it rather than let what a participant is ` +
              `shown and what the record says diverge.`
          );
        }
        const after: Record<string, Radius> = {};
        for (const [k, id] of s.order.entries()) after[id] = s.radii[k] ?? 1;
        const event: RadiusEvent = {
          op: "set",
          player: playerID,
          from: before,
          to: radius,
          after,
          // The counter as it stands NOW. Every view published after this point
          // carries a higher one, which is what lets an auditor order a change
          // against a delivery without reasoning about clocks — two events from
          // one process inside one millisecond cannot be ordered by time.
          seq: seqByGame.get(gameID) ?? 0,
          at: Date.now(),
        };
        const log = radiusLogByGame.get(gameID) ?? [];
        log.push(event);
        radiusLogByGame.set(gameID, log);
        batch.set(NETWORK_KEYS.radii(gameID), after);
        batch.set(NETWORK_KEYS.radiusHistory(gameID), [...log]);

        // Only this participant, because visibility is keyed on the viewer: how
        // far somebody can see changes their own screen and nobody else's, not
        // even the screens of the people who newly become visible to them.
        //
        // An OPTIMIZATION rather than a correctness property, and worth saying
        // so: publishing everybody would be equally correct, because the
        // byte-identical check drops every screen that did not move. Measured —
        // widening the set to the whole game leaves the tests green.
        publish(games.get(gameID), new Set([playerID]));
        return true;
      },
      radiusHistory() {
        return (radiusLogByGame.get(gameID) ?? []).slice();
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
        // Everyone whose neighborhood could differ: the union of before and
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
      tell(playerID, key, value) {
        // `indexOf` for its throw: telling a player who is not in this game's
        // network is a programming error, and writing to a channel outside the
        // graph would be a leak with nothing to indicate it happened.
        indexOf(playerID);
        if (typeof key !== "string" || key.length === 0) {
          throw new Error("empirica-networks: tell() needs a non-empty string key");
        }

        // The same validator a projection goes through, deliberately. This is
        // the second path from server to client, so it gets the first path's
        // checks: a Scope carries a reference to the GLOBAL attribute store, so
        // writing one here would ship every attribute of every participant to
        // this client — the exact leak `project()` is guarded against, arriving
        // through a newer door. Cycles, BigInt, functions, Map/Set and NaN are
        // refused too.
        validateProjection(value, `tell(${playerID}, ${JSON.stringify(key)})`);

        const game = games.get(gameID);
        if (!game) {
          throw new Error(`empirica-networks: game ${gameID} is no longer networked`);
        }
        const scopeID = readChannels(game)[playerID];
        const scope = scopeID ? channelScopes.get(scopeID) : undefined;
        if (!scope) {
          // Loud, not skipped. An unmaterialised channel is the one case where
          // this write silently reaches nobody, and for a design where the told
          // value IS the stimulus — a rewiring offer, say — a dropped write
          // means that one participant decides on no information while everyone
          // else decides on theirs, and the data records a choice rather than a
          // missing question. Retrying is not open to us: the write only counts
          // inside the caller's callback (PLATFORM-NOTES §15), and by the time a
          // channel appears that callback is over.
          throw new Error(
            `empirica-networks: player ${playerID} has no materialised channel in game ` +
              `${gameID}, so tell(${JSON.stringify(key)}) would reach nobody. Refusing ` +
              `rather than dropping it silently. Channels materialise shortly after game ` +
              `start, so tell() from a round or stage listener rather than from ` +
              `game.start itself.`
          );
        }
        scope.set(toldKey(key), value);
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

      /**
       * Whose screen can this person's value appear on?
       *
       * Their neighbors, and — once a study projects at distance — everyone
       * within the radius. Distance is symmetric, so the set of viewers who can
       * see p is the ball AROUND p, and one walk answers it for all of them.
       *
       * Without `projectFar` nothing beyond distance 1 carries anybody's
       * attributes, so the old one-hop set is still exactly right and is kept:
       * widening it unconditionally would walk the graph on every attribute
       * change in every study, including the overwhelming majority that run at
       * the default.
       */
      const dirty = new Set<string>([playerID]);
      if (projectFar && state.radii.some(needsRefs)) {
        // ONE walk, read against each viewer's OWN radius. Stage 1 could take
        // the ball around p wholesale, because with a single radius `v sees p`
        // and `p sees v` were the same statement. They are not any more: the
        // set is `{ v : d(v,p) <= r_v }`, which is not a ball around anything.
        // Using p's radius here instead of each viewer's is the same
        // subject-versus-viewer confusion the verifier's asymmetry arm exists to
        // catch, arriving in the invalidation path rather than the delivery one.
        const seen = ball(state.adj, i, state.widest);
        for (const [j, id] of state.order.entries()) {
          const d = seen.dist[j];
          if (d === undefined || !Number.isFinite(d)) continue;
          const r = state.radii[j] ?? 1;
          if (r === "whole" || d <= Math.floor(r)) dirty.add(id);
        }
      } else {
        for (const j of [i, ...(state.adj[i] ?? [])]) {
          const id = state.order[j];
          if (id) dirty.add(id);
        }
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
  /**
   * Warn if a lifecycle helper was registered more than once.
   *
   * Reads `collector.attributeListeners`, which is marked `/** @internal *\/`
   * upstream but is a plain array on the instance. Depending on an internal
   * field is a real cost, taken deliberately: the alternative is that the
   * consumer's second `onStageEnded` never runs and nothing anywhere says so,
   * and this is the only place the duplicate is visible at all.
   *
   * Every failure mode degrades to SILENCE. If the field is missing, is not an
   * array, or the calibration probe does not recognize what it produced, the
   * detector switches off rather than guessing — a heuristic firing on a shape
   * it does not understand would train people to ignore it, and this warning has
   * to be believed the one time it fires.
   *
   * `src/admin/listeners.ts` carries the counting and the message, pure, so the
   * false-positive filters are testable without a server.
   */
  /**
   * Arm the one-shot check for an unregistered scope kind — `ISSUES.md` O14.
   *
   * The trap: `networkKinds` is passed to `AdminContext.init` in the consumer's
   * own `server/src/index.js`, and skipping it is silently fatal. The channels
   * are created in Tajriba either way; upstream's `Scopes` simply drops each one
   * as an unknown kind, so nothing here ever holds a scope to write to, nothing
   * throws, and every participant sits with an empty neighborhood forever.
   *
   * `assertKindsRegistered` exists for this and cannot be called from here — see
   * its comment. So this observes the consequence: channels demonstrably created,
   * none ever materialised.
   *
   * One-shot per process, not per game, for two reasons. Registration cannot
   * change while the process runs, so a second check could only repeat the first.
   * And a per-game timer would re-accuse on every game of a broken batch, which
   * turns one legible warning into noise.
   *
   * `unref()` so a pending check never holds a process open — this must not turn
   * a clean exit into a hang in anyone's test suite. That mattered when the wait
   * was a flat 5 s and matters more now it scales with the channel count
   * (`ISSUES.md` O15): at n=200 the timer outlives the study by 20 s.
   */
  function armRegistrationCheck(created: number): void {
    if (registrationCheckArmed || sawAnyChannel || created === 0) return;
    registrationCheckArmed = true;
    const waitMs = registrationWaitMs(created);
    const timer = setTimeout(() => {
      if (sawAnyChannel) return;
      // Remembered so the OWNER listener can take it back if a channel turns up
      // after all. See `registrationRetractionMessage`.
      accusation = { created, waitMs };
      warn(registrationNotDetectedMessage(created, waitMs));
    }, waitMs);
    timer.unref?.();
  }

  function reportDuplicateLifecycleListeners(): void {
    // Once per process. `start` can fire again if the admin reconnects
    // (`initOrStop` tears the subscriptions down and rebuilds them), and the
    // registration list cannot change in between — so a second report would be
    // the same message twice, which is how a message stops being read.
    if (reportedDuplicates) return;
    reportedDuplicates = true;
    try {
      const calibration = calibrate(collector);
      if (!calibration) return;
      const dupes = duplicateLifecycleListeners(collector.attributeListeners, {
        shape: calibration.shape,
        placement: calibration.placement,
        // Our own plain `game/start` listener, by identity. See its declaration.
        exclude: new Set<unknown>([onGameStartAttribute]),
      });
      if (dupes.length > 0) warn(duplicateListenersMessage(dupes));
    } catch {
      // A detector must never be the reason a study fails to start.
    }
  }

  /**
   * Hand a participant's private write to the author's hook.
   *
   * See `NetworkConfig.onPrivateState` for the design decisions. What is here is
   * the two guards and the catch.
   */
  function notifyPrivateState(scope: any, playerID: string, key: string): void {
    const hook = config.onPrivateState;
    if (!hook) return;

    const gameID = scope?.get?.(NBHD_KEYS.GAME_ID);
    // Only for a game this process is actually networking. Channels outlive
    // their game and are replayed to any process that subscribes to the kind, so
    // without this an ended or foreign game's attributes would arrive at the hook
    // as though someone had just written them — and the author's handler would be
    // reasoning about a game whose state they have already released.
    if (typeof gameID !== "string" || !games.has(gameID)) return;

    try {
      hook({ gameID, playerID, key, value: scope.get(stateKey(key)) });
    } catch (e) {
      // Reported with a stack, unlike the sinks' one-line report: this hook holds
      // experiment logic rather than telemetry, and the useful question is which
      // line of the author's handler failed. Swallowed rather than rethrown so
      // one participant's event cannot stop the rest of the game's, which is
      // stated in the field's own documentation.
      console.error(
        `empirica-networks: onPrivateState threw for ${playerID}'s ${JSON.stringify(key)} ` +
          `in game ${gameID} — the write itself succeeded and everyone's view was ` +
          `republished, so what did not happen is whatever your handler does:\n` +
          `${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
      );
    }
  }

  /**
   * Append one record to the run log.
   *
   * See `NetworkHandle.log`. The three throws are all programming errors that
   * surface on the first run; write failures are the sink's business and are
   * reported there rather than raised here.
   */
  function log(ref: GameRef, record: Record<string, unknown>): void {
    if (!logSink) {
      throw new Error(
        `empirica-networks: net.log() was called but no run log is configured, so the ` +
          `record would have gone nowhere. Add \`log: { file: "data/run.ndjson" }\` to ` +
          `withNetwork(). Silently dropping it is how a study discovers at analysis time ` +
          `that it recorded nothing.`
      );
    }
    const gameID = gameIDOf(ref);
    if (!gameID) {
      throw new Error(
        `empirica-networks: net.log() needs a game scope or its id string — what was ` +
          `passed had neither: ${JSON.stringify(ref)}. Every record is stamped with its ` +
          `game, because one log file holds a whole study.`
      );
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(
        `empirica-networks: net.log() takes a plain object, not ` +
          `${Array.isArray(record) ? "an array" : typeof record}. Each line of the log is ` +
          `one object, and anything else cannot carry the stamped gameID or be read back ` +
          `by a \`record.type\` switch.`
      );
    }
    // The stamp goes first so a line is readable in `head`, and the author's
    // fields spread over it — so a design that keeps its own `at` (an event time
    // that is not the moment it was logged) wins, deliberately.
    logSink.record({ gameID, at: Date.now(), ...record });
  }

  function reportUnwatchedKeys(readKeys: Set<string>): void {
    // Against the UNION, not `watch` alone. A key declared in `read` still has
    // its listener, so a projection that reads one is live and warning about it
    // would be a false alarm — and a false alarm on this path teaches people to
    // ignore the one warning in the package that catches a stale neighborhood.
    const missing = unwatchedKeys(readKeys, readable).filter((k) => !reportedMissing.has(k));
    if (missing.length === 0) return;
    for (const k of missing) reportedMissing.add(k);
    warn(unwatchedKeysMessage(missing, readable));
  }

  /**
   * Assemble one game's snapshot from live state, as plain data.
   *
   * Every value crossing this boundary is a number, string, array or plain
   * object. No `Scope` is returned, and that is load-bearing rather than
   * stylistic: a scope carries `.set()`, so handing one to an observer hands it
   * the publisher's write path (see ./inspect.ts).
   */
  /**
   * Read ONE participant's private value, loudly.
   *
   * See `NetworkHandle.stateOf` for what each throw is for. The implementation
   * is deliberately not `inspect(gameID)?.nodes.find(...)`: that would build the
   * whole snapshot — every node, the metrics, the replayed history — to read one
   * attribute, and it would inherit `inspect()`'s `undefined` for a game this
   * process is not networking, which is the answer this accessor exists to
   * refuse.
   */
  function stateOf<T = unknown>(
    ref: GameRef,
    playerID: string,
    key: string
  ): T | undefined {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("empirica-networks: stateOf() needs a non-empty string key");
    }
    if (!readable.includes(key)) throw new Error(unlistedKeyMessage(key, watch, readOnly));

    const gameID = gameIDOf(ref) ?? "(no id)";
    const state = networks.get(gameID);
    const game = games.get(gameID);
    if (!state || !game) {
      throw new Error(
        `empirica-networks: game ${gameID} is not networked by this process, so ` +
          `stateOf(${JSON.stringify(key)}) has no answer. The game has not started, has ` +
          `ended, or was lost to a restart.`
      );
    }
    if (!state.order.includes(playerID)) {
      throw new Error(
        `empirica-networks: player ${playerID} is not in game ${gameID}'s network`
      );
    }

    const scopeID = readChannels(game)[playerID];
    const scope = scopeID ? channelScopes.get(scopeID) : undefined;
    if (!scope) {
      // The same call as `tell()`'s, for the same reason at the opposite
      // direction. A participant with no materialised channel has never had
      // anywhere to write, so `undefined` here does not mean "chose nothing" —
      // it means "was never asked", and scoring the two the same way is how a
      // non-response gets recorded as a decision. Loud, and it names the field
      // that shows how widespread the problem is: a game in this condition is
      // already publishing nothing to anyone, because `publish()` refuses
      // partial views.
      throw new Error(
        `empirica-networks: player ${playerID} has no materialised channel in game ` +
          `${gameID}, so their private state cannot be read — this is not the same as ` +
          `their having written nothing. The whole game is stalled while any channel is ` +
          `missing; see inspect(gameID).pendingChannels.`
      );
    }
    return scope.get(stateKey(key)) as T | undefined;
  }

  function inspect(ref: GameRef): GameSnapshot | undefined {
    const gameID = gameIDOf(ref);
    const state = gameID ? networks.get(gameID) : undefined;
    const game = gameID ? games.get(gameID) : undefined;
    if (!state || !game || !gameID) return undefined;

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
      for (const key of readable) {
        // Both halves, because which scope a key lives on is the author's
        // choice and the key list deliberately covers both (see the listener
        // registration above). An operator looking at a stalled study should
        // not have to know which one the author picked.
        if (player) attrs[key] = player.get(key);
        // Reading the private channel is the whole reason this depends on the
        // explicit scope subscription:
        // `withNetwork`'s explicit `ctx.scopeSub({ kinds: ["nbhd"] })` is what
        // makes a participant's own writes reach this process at all. Without
        // it these are all `undefined` and nothing errors
        // (docs/PLATFORM-NOTES.md §12). `test/e2e/monitor.test.ts` asserts a
        // participant-written value arrives here, so a regression is loud.
        if (channelScope) privateState[key] = channelScope.get(stateKey(key));
      }

      const neighbors = [...(state.adj[i] ?? [])];
      return {
        index: i,
        playerID,
        degree: neighbors.length,
        neighbors,
        radius: state.radii[i] ?? 1,
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
      radius: uniformOf(state.radii),
      radii: state.order.map((id, i) => ({ playerID: id, radius: state.radii[i] ?? 1 })),
      // Read from storage rather than from config, which is the whole point of
      // carrying both: this is what the run's own data says, while `radius`
      // above is what participants are being shown now.
      recordedRadius: readRadius(game),
      seq: seqByGame.get(gameID) ?? 0,
      nodes,
      metrics: graphMetrics(state.order.length, state.edges),
      history: historyFrames(gameID, historyByGame.get(gameID) ?? [], state.order),
      pendingChannels,
      awaitingPublish: awaitingPublish.has(gameID),
      watch: [...readable],
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
      firstChannelMs,
      cachedViews: lastPublished.size,
      cachedLayouts: lastLayout.size,
      endedGames: endedGames.size,
      chatSeqs: lastOutbox.size,
      pendingAtStart,
      lateProvisioned,
    }),
    activeGames: () =>
      [...games.keys()]
        .map((id) => ({ id, startedAt: startedAt.get(id) ?? 0 }))
        // Newest first, so `activeGames()[0]` is the most recently started game
        // rather than whatever insertion order happens to give. Not "the current
        // game" — see the interface — but at least a defined one.
        .sort((a, b) => b.startedAt - a.startedAt),
    inspect,
    stateOf,
    log,
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
  /** How far this participant can currently see. */
  radiusOf(playerID: string): Radius;
  /**
   * Change how far one participant can see, mid-game.
   *
   *     net.setRadius(subject, 2);   // from the next publish, they see two hops
   *
   * Returns false if it was already that. Subject to the same rule as the other
   * mutators: **only from inside a listener**, or the write will not flush.
   *
   * Republishes exactly one screen. Visibility is keyed on the VIEWER, so
   * widening somebody's radius changes what THEY are shown and nothing about
   * what anybody else is shown — including the people who newly become visible
   * to them.
   *
   * Recorded as a `RadiusEvent`, because for a study where the widening IS the
   * manipulation the sequence is the independent variable and a snapshot would
   * lose it. Narrowing is recorded the same way and is worth being clear about:
   * it stops further bytes and does not retract what a participant has already
   * seen, which no mechanism here could.
   */
  setRadius(playerID: string, radius: Radius): boolean;
  /** Every radius change since game start, oldest first. */
  radiusHistory(): RadiusEvent[];
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
  /**
   * Tell ONE participant one thing, privately. Server-authored.
   *
   *     net.tell(decider, "offer", { with: otherID, theirLastAction: "C" });
   *
   * Read on the client with `useNetworkTold()`. Writes to that participant's own
   * channel, so nobody else receives it — including the person the value is
   * about.
   *
   * **This is the second path from server to client, and the only one that is
   * not `project()`.** It exists because `project()` runs over a viewer's CURRENT
   * neighbors, which cannot express "show this subject one fact about someone
   * they are not connected to" — the information a rewiring offer is made of
   * (Rand, Arbesman & Christakis 2011).
   *
   * It does not weaken the guarantee, and the difference is worth stating
   * exactly: `project()` remains the only path by which one participant's data
   * reaches another. What goes here is authored by your own server code, and you
   * decide what it contains — so the discipline `project()` enforces
   * structurally is yours to keep here. In particular, **do not pass a whole
   * neighbor or player object**: it is refused (a Scope carries the global
   * attribute store), but the reason it is refused is the reason to be careful
   * with what you assemble by hand.
   *
   * Subject to the same rule as the mutators: **only from inside a listener.**
   * Throws rather than dropping the write if the participant's channel has not
   * materialised, because a told value is usually a stimulus, and a missing
   * stimulus that records a choice anyway is worse than a crash.
   */
  tell(playerID: string, key: string, value: unknown): void;
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
export function network(game: GameRef): GameNetwork {
  const gameID = gameIDOf(game);
  const handle = gameID ? gameNetworks.get(gameID) : undefined;
  if (!handle) {
    throw new Error(
      `empirica-networks: no network for game ${gameID ?? "(no id)"}. ` +
        `Either the game has not started yet, it has ended, or withNetwork() was never ` +
        `called on this collector.` +
        (gameID
          ? ""
          : ` Pass a game scope or its id string — what was passed had neither: ` +
            `${JSON.stringify(game)}.`)
    );
  }
  return handle;
}

/**
 * Read the realized edge list for a game.
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

/**
 * Read how much of the network this game showed its participants.
 *
 * `undefined` means NOT RECORDED, and deliberately not `1`. A run from before
 * this key existed and a run that deliberately drew a star are different facts
 * about a dataset, and defaulting would silently assert the second about the
 * first — the same conflation `readNetwork` avoids between "no record" and "an
 * empty graph", which is documented there as having made a recovery guard
 * unfireable.
 */
export function readRadius(game: any): Radius | undefined {
  const raw = game?.batch?.get(NETWORK_KEYS.radius(game.id));
  // `"whole"` is a RECORDED VALUE, not a malformed one. It was not, until this
  // line: the setting was added and the accessor still tested `typeof raw ===
  // "number"`, so a study that showed its participants the entire network read
  // back as never having recorded anything — which is the one thing this
  // accessor's whole docstring says it must never do. It also made the
  // restart-mismatch guard unfireable for those games, since that guard is
  // written `recordedRadius !== undefined && …`.
  //
  // A stringified NUMBER is still not a record. `"1.5"` means something wrote
  // this key by a path that does not exist in this package, and treating it as
  // 1.5 would invent a fact about a dataset.
  if (raw === "whole") return raw;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Read how far EACH participant could see, by player id.
 *
 * The complete record where `readRadius` answers only when there is a single
 * answer. `undefined` means not recorded — and because the key is written at
 * every setting including the uniform default, that has exactly one cause: the
 * record predates the key. It never means "everybody saw one hop".
 *
 * A game recorded before this key existed still has `readRadius`, so read that
 * first if you only need the uniform case; read this one to learn that a study
 * showed different participants different amounts, which is a manipulation and
 * is not derivable from anything else in a finished dataset.
 */
export function readRadii(game: any): Record<string, Radius> | undefined {
  const raw = game?.batch?.get(NETWORK_KEYS.radii(game.id));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, Radius> = {};
  for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
    // Same rule the scalar accessor follows: `"whole"` is a value and a
    // stringified number is not a record.
    if (r === "whole" || typeof r === "number") out[id] = r as Radius;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
