/**
 * What a long-running process is allowed to keep forever.
 *
 * `withNetwork` releases everything a finished game was holding
 * (`test/e2e/retention.test.ts`) with one deliberate exception: the ids of games
 * known to be over. That list is what stops a finished game's private channels
 * being re-adopted when Tajriba replays every scope of our kind. It is also the
 * only structure in the module that grew with the number of games a process ran
 * — `ISSUES.md` O5 — which is what this file bounds.
 *
 * Zero imports, deliberately. Same rule as `./registration.ts`: anything
 * reachable from a unit test must not drag `@empirica/core` in behind it
 * (`docs/CONTRIBUTING.md` §2, `docs/PLATFORM-NOTES.md` §3a).
 */

/**
 * Ended-game ids remembered at most, per process.
 *
 * The arithmetic, since a cap with no stated cost is just a magic number. A
 * Tajriba id is a 36-character string, so a full list costs on the order of a
 * megabyte — against one Empirica `Scope` object per participant per game,
 * which is what the list exists to avoid holding. Ten thousand sequential games
 * is far outside anything the target regime describes (n ≤ 50, and a study is
 * tens of games), so the expected number of evictions in a real deployment is
 * zero and the cap is a backstop rather than a policy.
 *
 * Overridable for tests through `endedGamesCap()` below, because a test that
 * had to end ten thousand games to reach the eviction path would not be written.
 */
export const MAX_ENDED_GAMES = 10_000;

/** Env seam, so the eviction path is reachable without ending 10,000 games. */
export const ENDED_GAMES_CAP_ENV = "EMPIRICA_NETWORKS_MAX_ENDED_GAMES";

export function endedGamesCap(): number {
  const raw = process.env[ENDED_GAMES_CAP_ENV];
  if (raw === undefined) return MAX_ENDED_GAMES;
  const n = Number(raw);
  // A malformed override falls back rather than producing a cap of NaN, which
  // would compare false against everything and silently switch eviction off.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_ENDED_GAMES;
}

/**
 * Remember one ended game, forgetting the oldest if that puts us over `cap`.
 *
 * Returns the id evicted, or `undefined`. A `Set` iterates in insertion order,
 * so the first entry is the least recently ended; re-ending a game already in
 * the list moves it back to the end rather than leaving it near eviction, which
 * matters because `releaseGame` is reachable twice for one game (from the
 * `game/status` listener and from the `hasEnded` branch of game start).
 *
 * Takes the set rather than owning it so the caller keeps one obvious place
 * where the module's per-game state lives, and so this stays a pure function of
 * (set, id, cap) that a unit test can drive directly.
 */
export function rememberEndedGame(
  ended: Set<string>,
  gameID: string,
  cap: number
): string | undefined {
  ended.delete(gameID);
  ended.add(gameID);
  if (ended.size <= cap) return undefined;
  const oldest = ended.values().next().value as string | undefined;
  if (oldest === undefined) return undefined;
  ended.delete(oldest);
  return oldest;
}

/**
 * Said once, at the first eviction.
 *
 * The warning has to be honest about being mostly harmless, or it is the kind of
 * message that teaches people to ignore warnings from this package — and two of
 * them (`ISSUES.md` O14) have to be believed the one time they fire.
 */
export function endedGamesEvictedMessage(cap: number): string {
  return (
    `empirica-networks: this process has now ended ${cap} games, which is the cap on the ` +
    `list of finished games it remembers, so the oldest ids are being forgotten.\n` +
    `  Nothing is wrong with the study that is running. What the list prevents is a\n` +
    `  finished game's private channels being re-adopted if the admin reconnects and\n` +
    `  Tajriba replays every scope of our kind. For a forgotten game that re-adoption\n` +
    `  does happen, and is undone again as soon as that game's own "start" attribute\n` +
    `  replays behind it and it is released a second time — so the usual cost is a\n` +
    `  transient hold of one scope per participant, not a permanent leak.\n` +
    `  Restarting the callbacks process between studies clears the list. Said once.`
  );
}
