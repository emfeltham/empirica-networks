import { toldKey } from "../shared/keys.js";
import type { Nbhd } from "./mode.js";

/**
 * Pure derivations from a neighborhood channel.
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
  /** The viewer's player id, in the same id space as neighbor projections. */
  playerID: string | undefined;
  /**
   * Number of neighbors currently visible, or undefined before the first
   * publish. Undefined means "not known yet", NOT "isolated".
   */
  degree: number | undefined;
  /** Publish counter, incremented server-side on every republish. */
  seq: number | undefined;
}

/**
 * The projected neighbor views, or `undefined` until the server has published.
 *
 * The undefined-until-ready convention matches Empirica's own hooks
 * (`usePlayer`, `useGame`), and it matters more here than it does there: an
 * empty array is a legitimate result — a node with no neighbors — so returning
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

/** Values the SERVER wrote to this participant's channel. Read-only. */
export interface NetworkTold {
  /**
   * One server-authored value, or `undefined` if the server has not written it.
   *
   * `undefined` is genuinely ambiguous here — "never written" and "written as
   * undefined" are the same answer — and unlike `neighborsOf` there is no
   * published flag to disambiguate, because the server decides per key whether a
   * key exists at all. Designs that need "asked and declined" distinguishable
   * from "never asked" should say so in the value (`{ offered: false }`), not in
   * its absence.
   */
  get<T = unknown>(key: string): T | undefined;
}

/**
 * Read what the server told this participant, privately.
 *
 * Deliberately read-only: this namespace is the server's, and a participant's own
 * writes go through `networkStateOf`. Nothing enforces that at the wire — a
 * participant can write any attribute anywhere (PLATFORM-NOTES §4a) — so this is
 * an API that does not invite the mistake, not a permission check. Server code
 * reading these values back and trusting them would be trusting participant
 * input, which is the standing warning in the README.
 *
 * NOT memoised on the channel, for the same reason `neighborChatOf` is not: the
 * whole point is that values change during play, and a stable object closing over
 * a stale read would silently stop updating.
 */
export function networkToldOf(nbhd: Nbhd | undefined): NetworkTold | undefined {
  if (!nbhd) return undefined;
  return {
    get: <T = unknown>(key: string) => nbhd.get(toldKey(key)) as T | undefined,
  };
}

/**
 * The server-sent structure of this neighborhood, at radius 1.5.
 *
 * THREE ANSWERS, NOT TWO, and the third is the reason this is a function rather
 * than a getter:
 *
 *   undefined  the key is absent. This study runs at the default radius; the
 *              client draws a star and that is correct.
 *   null       the key is present and unusable. Something is wrong, and the one
 *              thing that must NOT happen is falling back to a star — that is a
 *              correct-looking picture of a DIFFERENT study, with nothing
 *              anywhere saying so. Callers wait instead.
 *   object     usable.
 *
 * The same distinction `neighborsOf` draws between `undefined` and `[]`, for the
 * same reason: the failure mode of this whole package is a plausible picture of
 * a graph nobody has.
 *
 * Validated rather than trusted, and not out of suspicion of the server. The
 * value is ephemeral and arrives on the ordinary attribute path, so a stale or
 * partial shape is representable — and an edge naming a node outside the
 * delivered neighborhood would be drawn to whatever coordinate happened to sit
 * at that index, which is a line between two real people who are not tied.
 *
 * A malformed POSITION rejects the whole payload rather than being dropped.
 * Dropping one would compact the array, and the array is index-aligned with the
 * neighbor list — so every node after the gap would take the place of the next
 * one along, which is the same off-by-one the server side is shaped to avoid.
 * A malformed EDGE is dropped, because an edge is not positional: losing one
 * loses a tie, which is visible, rather than moving everybody, which is not.
 */
export function networkGraphOf(nbhd: Nbhd | undefined): NetworkGraphInfo | null | undefined {
  const raw = nbhd?.graph;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return null;
  const g = raw as { radius?: unknown; edges?: unknown; positions?: unknown };

  if (typeof g.radius !== "number" || !Number.isFinite(g.radius)) return null;
  if (!Array.isArray(g.positions) || !Array.isArray(g.edges)) return null;

  const positions: Array<{ x: number; y: number }> = [];
  for (const p of g.positions) {
    const q = p as { x?: unknown; y?: unknown } | null;
    if (!q || typeof q !== "object") return null;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return null;
    positions.push({ x: q.x as number, y: q.y as number });
  }

  const n = positions.length;
  const edges = (g.edges as unknown[]).filter(
    (e): e is [number, number] =>
      Array.isArray(e) &&
      e.length === 2 &&
      Number.isInteger(e[0]) &&
      Number.isInteger(e[1]) &&
      e[0] !== e[1] &&
      (e[0] as number) >= 0 &&
      (e[1] as number) >= 0 &&
      (e[0] as number) < n &&
      (e[1] as number) < n
  );

  return { radius: g.radius, edges, positions };
}

export interface NetworkGraphInfo {
  /** What the study is configured to show. `1.5` is the only value sent today. */
  radius: number;
  /** Pairs of indices into `neighbors`, offset by one; 0 is the viewer. */
  edges: Array<[number, number]>;
  /** Index-aligned with those indices. */
  positions: Array<{ x: number; y: number }>;
}

export class NetworkModeNotInstalledError extends Error {
  constructor() {
    super(
      "empirica-networks: the participant context was built without the network " +
        "mode, so there is no neighborhood to read. Pass modeFunc to " +
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
