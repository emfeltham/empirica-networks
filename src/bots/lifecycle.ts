/**
 * What a bot should do next, as a pure function of what it can see.
 *
 * Zero imports, on purpose — the same rule as `../admin/registration.ts` and
 * `../admin/retention.ts`. Everything here is decidable without a server, a
 * socket or a mode, so it is decided here and asserted in the unit tier;
 * `./runner.ts` is left with wiring.
 *
 * This is the part of a bot that fails SILENTLY. A headless participant that
 * never plays produces no error, no timeout and no log line: it simply sits
 * there while the study waits for a game that will never reach its player count.
 * That happened three times while building this, for three different reasons —
 * no player scope, no game assignment, and an unset `introDone` — and from the
 * outside all three looked identical. So the phase is named, the reason a bot is
 * stuck is a string it can print, and both are covered by tests.
 */

/**
 * Where one bot is in the Classic lifecycle.
 *
 * Ordered by progress, and every transition is observable from the participant
 * side alone. There is deliberately no "error" phase: a bot that cannot proceed
 * is stuck in a named phase, which says more than a generic failure would.
 */
export type BotPhase =
  /** Connected to Tajriba, but Classic has not created a player scope yet. */
  | "connecting"
  /** A player scope exists; Classic has not assigned it to a game. */
  | "waiting"
  /** Assigned to a game, and `introDone` is unset. THE BOT'S MOVE. */
  | "intro"
  /** `introDone` is set; the private channel has not published a view yet. */
  | "starting"
  /** A view has been published. The policy runs in this phase and no other. */
  | "playing"
  /** This bot's game is over. A new assignment moves it back to `waiting`. */
  | "ended";

/** Everything the phase depends on, read off the participant mode. */
export interface BotObservation {
  /** Has Classic created this participant's player scope? */
  hasPlayer: boolean;
  /** Classic's game assignment, or undefined before/after one. */
  gameID: string | undefined;
  /** The player-scope `introDone` flag — broadcast to everyone, like all player attributes. */
  introDone: boolean;
  /** Has the server published a view to this bot's private channel? */
  published: boolean;
  /**
   * Classic's end-of-participation marker.
   *
   * Two keys rather than one because they mean different things and either can
   * arrive first: `ended` is set when the player leaves a game, `exitStatus`
   * when the participant leaves the study.
   */
  ended: boolean;
  exitStatus: unknown;
}

/**
 * The phase, from one observation.
 *
 * `ended` is checked FIRST, and that ordering is the whole subtlety. A player
 * that has finished still has a player scope, still has a `gameID`, still has
 * `introDone` set and still has a published channel — every earlier test passes
 * — so any other order reports a finished bot as `playing` and its policy keeps
 * writing into a game nobody is in.
 *
 * Note what is NOT here: the absence of a current stage. `test/e2e/shirado2017.
 * test.ts` uses `!stage` as its end signal and is right to, because that design
 * has exactly one stage. As a general rule it is wrong — a multi-stage design
 * passes through moments with no current stage between stages, and a bot that
 * treated those as the end would stop playing partway through a round.
 */
export function botPhase(obs: BotObservation): BotPhase {
  if (obs.ended || obs.exitStatus !== undefined) return "ended";
  if (!obs.hasPlayer) return "connecting";
  if (obs.gameID === undefined) return "waiting";
  if (!obs.introDone) return "intro";
  if (!obs.published) return "starting";
  return "playing";
}

/**
 * Phases in which the bot itself is the thing that has to act.
 *
 * Exported because it is the difference between "stuck" and "waiting for
 * someone else", and a stall message that cannot tell those apart sends the
 * reader to the wrong place. `intro` is the only one today; it is a set rather
 * than a comparison so that adding a second does not need a second edit here.
 */
export const BOT_ACTS_IN: ReadonlySet<BotPhase> = new Set<BotPhase>(["intro"]);

/**
 * Why a bot is still in this phase, and what to look at.
 *
 * Written for the person reading a stalled study's log at the moment they have
 * twenty participants waiting, so each one names the thing to check rather than
 * restating the phase.
 */
export function stallReason(phase: BotPhase): string {
  switch (phase) {
    case "connecting":
      return (
        "no player scope has arrived. The socket is up, so this is Classic not " +
        "running or not registering the participant — check that the callbacks " +
        "process is up and that it registered `networkKinds`."
      );
    case "waiting":
      return (
        "connected but not assigned to a game. Classic assigns on batch start, " +
        "so either no batch is running, or the batch's games are already full. " +
        "Remember the treatment's playerCount counts bots: recruit " +
        "playerCount - botCount humans, not playerCount."
      );
    case "intro":
      return (
        "assigned to a game but `introDone` is unset, and this bot is what sets " +
        "it. The runner writes it on the first poll after assignment, so if this " +
        "persists the write is not landing — see docs/PLATFORM-NOTES.md §15."
      );
    case "starting":
      return (
        "in the game and waiting for its first view. The game has not started " +
        "(not enough players have set `introDone`), or `withNetwork` has not " +
        "provisioned this participant's channel — check the server log for " +
        "`pending channels`."
      );
    case "playing":
      return "playing normally.";
    case "ended":
      return "its game is over.";
  }
}

/**
 * A stall notice, or `undefined` if there is nothing worth saying.
 *
 * Silent in `playing` and `ended` — the two phases a bot is supposed to sit in —
 * so a long, healthy session produces no noise. Everything else is a phase a bot
 * should pass through in seconds, which is what makes a duration threshold
 * meaningful at all.
 */
export function stallMessage(
  identifier: string,
  phase: BotPhase,
  heldMs: number
): string | undefined {
  if (phase === "playing" || phase === "ended") return undefined;
  const who = BOT_ACTS_IN.has(phase) ? "and it is the bot's move" : "waiting on the server";
  return (
    `empirica-networks: bot ${identifier} has been in phase "${phase}" for ` +
    `${Math.round(heldMs / 1000)}s (${who}). ${stallReason(phase)}`
  );
}
