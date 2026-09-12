/**
 * What a bot is called, and why that is a privacy decision rather than a naming one.
 *
 * Zero imports, like `./lifecycle.ts`.
 *
 * ## Measured, 2026-08-16, @empirica/core@1.12.5
 *
 * **Every participant in a game receives every other participant's
 * `participantIdentifier`** — the raw value of `?participantKey=`. Classic writes
 * it as an immutable attribute on the player scope at `PARTICIPANT_CONNECT`, and
 * `startGame` links every participant to every player node, so it arrives on
 * everybody's wire. Witness: `test/e2e/bots.test.ts` ("a co-player's recruitment
 * identifier is on the wire"), which finds each participant's identifier as a
 * substring of every other participant's received frames.
 *
 * Two consequences, and they are separate.
 *
 * 1. **For bots.** There is no naming scheme a bot can use that participants
 *    cannot read. `bot-1` is not a private detail of the runner's configuration;
 *    it is on screen, in a browser, one `JSON.stringify` away. For a design like
 *    Shirado & Christakis (2017) — where subjects are not told which of their
 *    neighbors are software — a recognisable identifier is not a leak of
 *    metadata, it is the manipulation itself, disclosed. So this module's job is
 *    to make the indistinguishable choice the easy one and the recognisable
 *    choice loud.
 *
 * 2. **For everyone else, bots or not.** In a deployed study `participantKey`
 *    carries the recruitment identity — the Prolific PID, whatever the
 *    recruitment URL put there. Co-players learn it. That is
 *    upstream's, affects every Empirica Classic study rather than only networked
 *    ones, and is filed as `ISSUES.md` U10.
 */

/**
 * Substrings that give a bot away.
 *
 * The same words `docs/PLATFORM-NOTES.md` §17 searched the Empirica bundles for,
 * turned around: there they were how we established Empirica ships no bots, here
 * they are how a participant would establish that yours are. `test` and `debug`
 * are added because a study that ran with its rehearsal keys is the same mistake
 * arriving by a different road.
 */
const MARKERS = [
  "bot",
  "agent",
  "robot",
  "simulat",
  "artificial",
  "virtual",
  "npc",
  "fake",
  "dummy",
  "test",
  "debug",
];

/**
 * A warning about identifiers a participant could pick out, or `undefined`.
 *
 * Deliberately a warning and not a throw. It is a heuristic over strings, so it
 * has false positives a study cannot be blocked by — a real Prolific PID can
 * contain `bot` — and false negatives it must not be trusted against: matching
 * nothing here means only that these three words are absent, not that the
 * identifiers look like your participants'. The runner prints it once and
 * carries on.
 */
export function botMarkerWarning(identifiers: readonly string[]): string | undefined {
  const hits: string[] = [];
  for (const id of identifiers) {
    const lower = id.toLowerCase();
    const marker = MARKERS.find((m) => lower.includes(m));
    if (marker !== undefined) hits.push(`${id} (contains "${marker}")`);
  }
  if (hits.length === 0) return undefined;
  const shown = hits.slice(0, 3).join(", ");
  const more = hits.length > 3 ? `, and ${hits.length - 3} more` : "";
  return (
    `empirica-networks: ${hits.length} of ${identifiers.length} bot identifier(s) ` +
    `name themselves as bots: ${shown}${more}. Every participant in the game ` +
    `receives every other participant's identifier (ISSUES.md U10), so these are ` +
    `readable from a browser. If your design does not tell participants which of ` +
    `their neighbors are software, this discloses it. See docs/BOTS.md.`
  );
}

/**
 * Identifiers shaped like the ones Empirica's own client generates.
 *
 * `createNewParticipant` in `@empirica/core/player` sets `?participantKey=` to
 * `Date.now().toString()` — a 13-digit millisecond timestamp — so that is the
 * shape a bot blends into during local development, which is what this default
 * is for and the only thing it is for.
 *
 * **It is the wrong shape for a deployed study**, and not marginally: if your
 * humans arrive as 24-character Prolific PIDs, three 13-digit numbers among them
 * are the three bots, in order. In a real run, pass `identifiers` drawn from the
 * same space as your recruitment keys. `runBots` cannot do that for you — it does
 * not know how you recruit — so it refuses to invent them and takes the list.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the output is a pure
 * function of its arguments and the unit tier can assert it.
 */
export function botIdentifiers(
  count: number,
  opts: { now?: number; spacingMs?: number } = {}
): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`empirica-networks: botIdentifiers(count) needs a non-negative integer, got ${count}`);
  }
  const now = opts.now ?? Date.now();
  // Distinct, because Tajriba keys a participant by identifier: two bots sharing
  // one would be one participant connecting twice, and the second would displace
  // the first with no error anywhere.
  const spacing = opts.spacingMs ?? 1;
  return Array.from({ length: count }, (_, i) => String(now + i * spacing));
}

/**
 * Reject a bad identifier list before anything connects.
 *
 * Duplicates are the one that has to be fatal rather than a warning. Tajriba
 * identifies a participant BY this string, so two bots sharing one are one
 * participant with two sockets: the game reaches its player count one short and
 * waits forever, and the only symptom is a study that never starts. That is the
 * failure this whole file exists to make impossible to reach quietly.
 */
export function assertIdentifiers(identifiers: readonly string[]): void {
  if (identifiers.length === 0) {
    throw new Error(
      "empirica-networks: runBots needs at least one identifier. Pass the keys your " +
        "bots should connect with — botIdentifiers(n) generates development-shaped ones."
    );
  }
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of identifiers) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `empirica-networks: bot identifiers must be non-empty strings, got ${JSON.stringify(id)}.`
      );
    }
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  if (dupes.size > 0) {
    throw new Error(
      `empirica-networks: duplicate bot identifier(s): ${[...dupes].join(", ")}. ` +
        `Tajriba identifies a participant by this string, so duplicates are ONE ` +
        `participant connecting twice — the game would sit one player short of its ` +
        `count and never start, with nothing logged.`
    );
  }
}
