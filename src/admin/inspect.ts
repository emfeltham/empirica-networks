/**
 * The read-only introspection surface: what a running game's network looks
 * like, as plain data.
 *
 * This exists so the monitor (./monitor) never touches an Empirica object. Two
 * separate reasons, and only the second is about tidiness:
 *
 *   1. A `Scope` handed out of a read API carries `.set()` with it, which is the
 *      same write path the publisher uses. An observer that can mutate the study
 *      is not an observer, and "returning the live object from a getter" is how
 *      that happens without anyone deciding it should. It is the same hazard
 *      `validateProjection` refuses for projections, at a different boundary.
 *   2. Plain data serializes. The monitor's whole transport is JSON over HTTP,
 *      and a snapshot that had to be marshalled at the edge would be marshalled
 *      by whatever was convenient at the time.
 *
 * Everything below the type definitions is PURE and free of Empirica types, so
 * it unit tests without a server — the same rule ./export.ts follows, for the
 * same reason.
 */
import type { EdgeEvent } from "../shared/keys.js";
import { components, degrees, maxDegree, meanDegree, type Edge } from "../topology/index.js";
import { historyIsConsistent, snapshotRows } from "./export.js";

/** One participant's seat, as the monitor sees it. */
export interface NodeSnapshot {
  /** Structural position in the topology. Stable for the life of the game. */
  index: number;
  playerID: string;
  degree: number;
  /** Structural indices this seat is currently tied to. */
  neighbors: number[];
  /**
   * Has this participant's private channel scope materialised on the server?
   *
   * False is the interesting value: it means provisioning has run but the scope
   * has not arrived, so this participant is receiving nothing and — because
   * `publish()` refuses to send a partial view — neither is anybody else. That
   * is a whole-game stall presenting as one missing node, which is exactly the
   * thing an operator cannot see from the participant side.
   */
  channel: boolean;
  /**
   * Watched keys read from the PLAYER scope. Broadcast to every participant by
   * Classic, so nothing here is private and showing it reveals nothing new.
   */
  attrs: Record<string, unknown>;
  /**
   * Watched keys read from this participant's PRIVATE channel.
   *
   * This is the sensitive half of the payload and the reason §15.1 exists: it is
   * neighbor-limited data, and the monitor holds all of it at once.
   *
   * Restricted to the declared keys (`watch` plus `read`) rather than dumping
   * the channel. Those are the keys the author said their study depends on, so
   * it is both bounded and exactly what an operator watching a live study wants
   * — and a monitor that dumped every key would eventually dump one somebody put
   * there for a reason unrelated to being displayed.
   */
  state: Record<string, unknown>;
}

/** Structural summary of a graph. All derived, nothing stored. */
export interface GraphMetrics {
  n: number;
  edgeCount: number;
  /**
   * Undirected density: 2m / n(n-1).
   *
   * Computed here rather than read off a graphology graph, which sidesteps the
   * one way to misuse the adapter and get no error: graphology's default mixed
   * `Graph` sizes its denominator to directed slots this module never fills and
   * reports 0.333 for a complete graph where 1.000 is correct
   * (src/topology/graphology.ts). Wrong and plausible is worse
   * than absent, so the number is derived from the edge list directly.
   */
  density: number;
  /** Connected components, counting isolated seats as components of one. */
  components: number;
  /** Seats with no ties at all — a participant seeing nobody. */
  isolated: number[];
  minDegree: number;
  maxDegree: number;
  meanDegree: number;
}

/** The edge list as it stood after one recorded event. */
export interface HistoryFrame {
  /** Index into the event log. */
  at: number;
  /** Wall clock, ms. */
  t: number;
  op: EdgeEvent["op"];
  /** Full edge list at this point, as structural index pairs. */
  edges: Edge[];
  /** Ties this event created, index pairs. */
  added: Edge[];
  /** Ties this event destroyed, index pairs. */
  removed: Edge[];
}

export interface HistoryFrames {
  frames: HistoryFrame[];
  /**
   * Does the log's own edge count agree with replaying it?
   *
   * Surfaced rather than asserted. A monitor that threw on an inconsistent log
   * would go blank at the exact moment something interesting was wrong; a
   * monitor that showed a scrubber silently derived from a log that does not add
   * up would be worse. So it is displayed.
   */
  consistent: boolean;
  /**
   * Pairs the replay could not map back to a seat.
   *
   * Should always be zero. Non-zero means a history event names a player who is
   * not in `order` — a seating record and an event log that disagree, which is
   * precisely the class of silent divergence `historyIsConsistent` exists for.
   * Counted and shown rather than dropped.
   */
  dropped: number;
}

/** Everything the monitor knows about one running game. */
export interface GameSnapshot {
  gameID: string;
  batchID: string | undefined;
  /** Seats, i.e. `game.players.length` at the time the network was built. */
  n: number;
  /** Current edge list, structural index pairs. */
  edges: Edge[];
  /** Player id occupying each structural position. */
  order: string[];
  seed: number;
  /**
   * How much of the network this game shows its participants: 1 or 1.5.
   *
   * The graph above says what the study RAN on; this says what it let people see
   * of it, and the two are independent. Read from the live configuration rather
   * than from the batch record, so on a process restarted with a different
   * `graph.radius` this reports what participants are being shown NOW while
   * `readRadius` reports what the record says — which is the pair that makes the
   * mismatch visible rather than a single number that quietly picks a side.
   */
  radius: number;
  /** Publish counter — how many times this game has published a view. */
  seq: number;
  nodes: NodeSnapshot[];
  metrics: GraphMetrics;
  history: HistoryFrames;
  /**
   * Player ids provisioned a channel whose scope has not materialised yet.
   *
   * Non-empty during normal startup for a moment. Non-empty for longer than that
   * means the game is stalled and nobody inside it can tell.
   */
  pendingChannels: string[];
  /** True while the game is waiting on channels before its first publish. */
  awaitingPublish: boolean;
  /**
   * Every private key this game can read back, so the UI can label columns
   * without guessing.
   *
   * `watch` and `read` together, in declaration order. The monitor makes one
   * column per entry and does not distinguish them, because the distinction is
   * about what the author's code does with a key and an operator watching a
   * study cares only that the value is there.
   */
  watch: string[];
}

/**
 * Structural summary of a graph.
 *
 * Every component of this is `src/topology/index.ts`'s, not a second
 * implementation: `degrees` and `components` already exist there because the
 * generators can legitimately produce a disconnected graph and an author needs
 * to check. A monitor computing its own would be a second answer to the same
 * question, free to drift from the one `isConnected()` gives — and the monitor
 * is the surface where a disagreement would be believed.
 *
 * The only arithmetic here is density, which is the one number the ecosystem
 * gets wrong for this module's graphs (see `GraphMetrics.density`).
 */
export function graphMetrics(n: number, edges: Edge[]): GraphMetrics {
  const deg = degrees(n, edges);
  const isolated: number[] = [];
  for (let i = 0; i < n; i++) if (deg[i] === 0) isolated.push(i);

  // Summed from the degrees, not `edges.length`: `adjacency()` dedupes and drops
  // self-loops, so a caller's raw list can be longer than the graph the module
  // actually publishes. Reporting the raw length would describe a graph nobody
  // is in.
  const edgeCount = deg.reduce((a, b) => a + b, 0) / 2;

  return {
    n,
    edgeCount,
    density: n < 2 ? 0 : (2 * edgeCount) / (n * (n - 1)),
    components: n === 0 ? 0 : components(n, edges).length,
    isolated,
    minDegree: n === 0 ? 0 : Math.min(...deg),
    maxDegree: maxDegree(n, edges),
    meanDegree: meanDegree(n, edges),
  };
}

/**
 * Replay the event log into one edge list per event, in structural indices.
 *
 * Built on `snapshotRows` rather than replaying the log again here. The replay
 * is the part that can be wrong, it already exists, and it is already tested and
 * cross-checked by `historyIsConsistent` — a second implementation would be a
 * second thing to keep in agreement, and a scrubber that disagreed with
 * `network_snapshots.csv` about what the graph was at time t would undermine
 * both.
 *
 * The mapping back to indices is the only new work: the log records PLAYER IDS
 * (so it survives without a seating table), and the monitor renders SEATS.
 */
export function historyFrames(
  gameID: string,
  history: EdgeEvent[],
  order: string[],
): HistoryFrames {
  const indexOf = new Map(order.map((id, i) => [id, i]));
  let dropped = 0;

  const toEdge = (a: string, b: string): Edge | undefined => {
    const i = indexOf.get(a);
    const j = indexOf.get(b);
    if (i === undefined || j === undefined || i === j) {
      dropped++;
      return undefined;
    }
    return i < j ? [i, j] : [j, i];
  };

  const rows = snapshotRows(gameID, history);
  const frames: HistoryFrame[] = rows.map((row, at) => {
    const event = history[at]!;
    // `snapshotRows` packs each pair as `a|b`, space separated. Player ids are
    // ULIDs — [0-9A-Z] only — so neither separator can occur inside one. A
    // segment that does not split cleanly is counted as dropped rather than
    // guessed at, so a future id format that breaks this says so instead of
    // silently rendering a smaller graph.
    const edges: Edge[] = [];
    for (const pair of row.edges.split(" ")) {
      if (pair === "") continue;
      const parts = pair.split("|");
      if (parts.length !== 2) {
        dropped++;
        continue;
      }
      const edge = toEdge(parts[0]!, parts[1]!);
      if (edge) edges.push(edge);
    }
    return {
      at,
      t: row.t,
      op: event.op,
      edges,
      added: (event.added ?? []).map(([a, b]) => toEdge(a, b)).filter(isEdge),
      removed: (event.removed ?? []).map(([a, b]) => toEdge(a, b)).filter(isEdge),
    };
  });

  // Asked of the LOG, not of the frames above. "Does the stored history describe
  // a coherent sequence" and "could we map it onto seats" are different
  // failures with different causes, and folding them into one flag would report
  // a seating mismatch as a corrupt log. `dropped` carries the second.
  return { frames, consistent: historyIsConsistent(history), dropped };
}

function isEdge(e: Edge | undefined): e is Edge {
  return e !== undefined;
}
