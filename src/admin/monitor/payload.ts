/**
 * What the monitor endpoint actually serves, and how it decides something
 * changed.
 *
 * Pure. `buildPayload` takes a snapshot and the previous payload; it does no
 * I/O, holds no state, and knows nothing about HTTP. That is what lets the
 * change detection, the warm-start threading and the "is this game gone" answer
 * be unit tested without a server — the same split ./layout.ts exists for.
 */
import type { GameSnapshot } from "../inspect.js";
import { layout, type LayoutOptions, type Point } from "../layout.js";
import { edgeKey } from "../subgraph.js";

export interface MonitorPayload {
  snapshot: GameSnapshot;
  /** Node coordinates, index-aligned with `snapshot.nodes`. */
  positions: Point[];
  /**
   * Digest of everything the UI draws.
   *
   * Used to suppress no-op pushes, the same way `publish()` suppresses
   * byte-identical views. A quiet study should cost an idle
   * SSE connection and nothing else.
   */
  digest: string;
}

export interface BuildOptions {
  /** Previous payload, for warm-starting the layout and for change detection. */
  previous?: MonitorPayload;
  layout?: LayoutOptions;
}

/**
 * Build the payload for one snapshot.
 *
 * The layout is recomputed only when the graph's SHAPE changed. A player
 * changing a watched attribute must not move anybody: an operator watching a
 * color spread across a network would otherwise see the whole picture
 * rearrange on every choice, which makes the thing they are watching for
 * impossible to see.
 */
export function buildPayload(snapshot: GameSnapshot, opts: BuildOptions = {}): MonitorPayload {
  const previous = opts.previous;
  const reuse =
    previous !== undefined &&
    previous.snapshot.gameID === snapshot.gameID &&
    previous.snapshot.n === snapshot.n &&
    edgeKey(previous.snapshot.edges) === edgeKey(snapshot.edges);

  const positions = reuse
    ? previous.positions
    : layout(snapshot.n, snapshot.edges, {
        // Seeded from the game's own seed, so the picture is reproducible from
        // stored data next to the graph it draws.
        seed: snapshot.seed,
        ...opts.layout,
        // Warm start from wherever the nodes already were, so a rewire moves
        // the ties that changed instead of teleporting everyone (./layout.ts).
        initial: previous?.positions,
      });

  const payload = { snapshot, positions, digest: "" };
  payload.digest = digestOf(payload);
  return payload;
}

/**
 * Has anything the UI draws changed?
 *
 * Compares digests rather than object identity, because `inspect()` builds a
 * fresh object every poll — identity is always different and would push on
 * every tick.
 */
export function payloadChanged(a: MonitorPayload | undefined, b: MonitorPayload): boolean {
  return a?.digest !== b.digest;
}

function digestOf(payload: Omit<MonitorPayload, "digest">): string {
  // Positions are rounded before hashing. Warm-started layouts differ in the
  // last float digits for graphs that are structurally identical, and pushing an
  // SSE frame because a node moved 1e-13 pixels is a busy-loop wearing a
  // change-detection costume.
  return JSON.stringify({
    snapshot: payload.snapshot,
    positions: payload.positions.map((p) => [Math.round(p.x), Math.round(p.y)]),
  });
}
