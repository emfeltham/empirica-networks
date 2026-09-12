/**
 * The interface an artificial participant is written against.
 *
 * Types only — every import here is `import type`, so this file contributes
 * nothing to any bundle and a policy can be written, typechecked and unit-tested
 * without a server, a socket or `@empirica/core`.
 *
 * The shape mirrors what a HUMAN can do and refuses to exceed it, which is the
 * one design rule this whole entry point rests on. A bot reads its neighbors
 * through the same projection, writes through the same private channel, and is
 * subject to the same envelope. There is no server-side back door — no way to
 * read a non-neighbor, no way to see the graph, no way to learn the global
 * state — because a bot that could do those things would be a different kind of
 * object from the participants it is mixed in with, and any comparison between
 * them would be measuring the difference in access.
 *
 * That is also why a bot is a headless PARTICIPANT PROCESS rather than a
 * server-side object (`docs/PLATFORM-NOTES.md` §17): at the wire it is
 * indistinguishable from a browser, so it exercises the same code paths the
 * study's humans do, including the ones that would leak.
 */
import type { Rng } from "../admin/seed.js";
import type { NetworkState } from "../player/state.js";
import type { NetworkSelf, NetworkTold } from "../player/view.js";

/**
 * What one bot can see and do at the moment a hook is called.
 *
 * The accessors are FUNCTIONS, not properties, and not memoised. A policy is
 * called repeatedly over a game that is changing under it, and a snapshot object
 * captured once would go stale silently — the same reason `neighborChatOf` and
 * `networkToldOf` are not cached on the channel.
 */
export interface BotContext<T = unknown> {
  /** The participant identifier this bot connected with. Stable for its lifetime. */
  readonly identifier: string;
  /** Position in the `identifiers` array passed to `runBots`. Stable, 0-based. */
  readonly index: number;
  /**
   * This bot's player id — the id its neighbors see in their views.
   *
   * Not the participant id and not the identifier: this is the id space
   * `project()` works in, so it is the one to record if you want to know which
   * nodes were bots.
   */
  readonly playerID: string | undefined;
  /** The game this bot is currently in. Changes when Classic reassigns it. */
  readonly gameID: string | undefined;

  /**
   * The projected neighbor views, or `undefined` before the first publish.
   *
   * Exactly what `neighborsOf` gives a browser, for the same reason it gives
   * `undefined` rather than `[]`: an empty array is a legitimate result (a node
   * with no neighbors) and conflating it with "not loaded" would have a bot act
   * on an imagined isolation.
   */
  neighbors(): T[] | undefined;
  /** This bot's own degree and publish counter. `undefined` before its channel exists. */
  self(): NetworkSelf | undefined;
  /** Read and write this bot's own private state — the same channel a human writes. */
  state(): NetworkState | undefined;
  /** Read what the server told this bot privately. */
  told(): NetworkTold | undefined;

  /**
   * Milliseconds since this bot's first published view.
   *
   * Since the FIRST PUBLISH, not since connect and not since game start: it is
   * the moment the bot could first act, so it is the clock a policy's timings
   * are actually relative to. 0 before then.
   */
  elapsedMs(): number;

  /**
   * A deterministic random source, seeded from `(seed, identifier)`.
   *
   * `Math.random()` in a policy makes a study unreproducible in the one place
   * that most needs to be reproducible: Shirado & Christakis's manipulation IS
   * the bots' noise, so an unrecorded random stream is an unrecorded independent
   * variable. Reusing the same `seed` and the same `identifiers` replays the same
   * bot behavior — for the same reason, and by the same mechanism, that the
   * topology seed replays the same graph.
   */
  readonly rng: Rng;

  /**
   * Append a record to the runner's log.
   *
   * The bot side of `net.log()`, and needed for the same reason: what a bot did
   * and when is data, it is held in a process that is not the server, and a study
   * that is killed mid-session should still have it.
   */
  log(record: Record<string, unknown>): void;

  /**
   * Submit the current stage, as a human would by pressing the button.
   *
   * Only meaningful in a design with stages that end on submission. A continuous
   * design — one long stage that the server ends — must never call it, and none
   * of the policies in `examples/` do.
   */
  submit(): void;
}

/**
 * One artificial participant's behavior.
 *
 * Every hook is optional and every hook is SYNCHRONOUS. A returned promise is
 * not awaited, and this is the same trap `onPrivateState` documents arriving by
 * another road: a write made after an `await` lands outside the runloop's flush
 * and reaches nobody (`docs/PLATFORM-NOTES.md` §15). Do the work inline, or
 * record an intention and write it from the next `onTick`.
 *
 * A throw is caught, logged and swallowed. With three bots in a twenty-person
 * session, one policy failing must not take the other two down and must not
 * leave the study one player short — the same call `withNetwork` makes for
 * `onPrivateState`, for the same reason.
 */
export interface BotPolicy<T = unknown> {
  /**
   * The bot's channel has published its first view. Called once per game.
   *
   * The earliest point at which `neighbors()`, `self()` and `state()` all return
   * something, so it is where an opening move belongs.
   */
  onStart?(ctx: BotContext<T>): void;

  /**
   * What this bot can see has changed.
   *
   * Driven by the server's publish counter, so it fires when the VIEW changed,
   * not on every wire frame — `withNetwork` suppresses a byte-identical
   * republish, so a bot cannot be woken by a neighbor rewriting the same value.
   * A purely reactive policy needs nothing else.
   */
  onView?(ctx: BotContext<T>): void;

  /**
   * A timer, running from the first publish until the game ends.
   *
   * Needed by any policy that must act when NOTHING has changed, which includes
   * every deliberately-noisy agent: an agent that only ever responds to movement
   * cannot be the thing that breaks a deadlock, and breaking deadlocks is what
   * Shirado & Christakis's agents are for.
   */
  onTick?(ctx: BotContext<T>): void;

  /** Interval for `onTick`, in ms. Required whenever `onTick` is set. */
  tickMs?: number;

  /**
   * This bot's game is over. Called once per game, before any reassignment.
   *
   * Writes here are pointless — the game is gone — so this is for flushing what
   * the policy accumulated, not for a last move.
   */
  onEnd?(ctx: BotContext<T>): void;
}
