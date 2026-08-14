import type { Nbhd } from "./mode.js";

/**
 * Pure derivations from a neighbourhood channel.
 *
 * Kept out of the React layer on purpose. `ParticipantCtx` — the context the
 * upstream hooks read — is not exported from @empirica/core, so a hook cannot be
 * rendered against a synthetic mode using public API alone
 * (docs/PLATFORM-NOTES.md §8). Everything with a decision in it therefore lives
 * here, where it can be tested against real `Nbhd` instances with no React, no
 * DOM and no server. What remains in `player/react` is delegation.
 */

/** The viewer's own position in the network. */
export interface NetworkSelf {
  /** The viewer's player id, in the same id space as neighbour projections. */
  playerID: string | undefined;
  /**
   * Number of neighbours currently visible, or undefined before the first
   * publish. Undefined means "not known yet", NOT "isolated".
   */
  degree: number | undefined;
  /** Publish counter, incremented server-side on every republish. */
  seq: number | undefined;
}

/**
 * The projected neighbour views, or `undefined` until the server has published.
 *
 * The undefined-until-ready convention matches Empirica's own hooks
 * (`usePlayer`, `useGame`), and it matters more here than it does there: an
 * empty array is a legitimate result — a node with no neighbours — so returning
 * `[]` while loading would render a participant as isolated during startup and
 * look entirely normal. Callers are expected to branch on it, exactly as they
 * already do for `usePlayer()`.
 */
export function neighborsOf<T = unknown>(nbhd: Nbhd | undefined): T[] | undefined {
  if (!nbhd || !nbhd.published) return undefined;
  return nbhd.neighbors as T[];
}

/**
 * The viewer's own network identity, or `undefined` if no channel exists yet.
 *
 * Available EARLIER than `neighborsOf`: `playerID` is written immutably when the
 * channel is provisioned, so it is readable before any publish. `degree` and
 * `seq` stay undefined until then rather than being reported as 0.
 */
export function networkSelfOf(nbhd: Nbhd | undefined): NetworkSelf | undefined {
  if (!nbhd) return undefined;
  return {
    playerID: nbhd.playerID,
    degree: nbhd.published ? nbhd.neighbors.length : undefined,
    seq: nbhd.seq,
  };
}

export class NetworkModeNotInstalledError extends Error {
  constructor() {
    super(
      "empirica-networks: the participant context was built without the network " +
        "mode, so there is no neighbourhood to read. Pass modeFunc to " +
        "EmpiricaParticipant:\n\n" +
        '  import { EmpiricaNetwork } from "empirica-networks/player";\n' +
        "  <EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>\n"
    );
    this.name = "NetworkModeNotInstalledError";
  }
}

/**
 * Fail usefully when the mode is Classic rather than Network.
 *
 * Left to itself this is the most likely setup mistake, and it surfaces from
 * inside @empirica/core as "Cannot read properties of undefined (reading
 * 'subscribe')" — which names neither the cause nor the fix.
 *
 * A mode of `undefined` is NOT an error: that is the ordinary pre-connection
 * state on first paint.
 */
export function assertNetworkMode(mode: object | undefined): void {
  if (mode && !("nbhd" in mode)) throw new NetworkModeNotInstalledError();
}
