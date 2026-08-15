/**
 * Export the realised network for analysis.
 *
 * Empirica timestamps every attribute change, so the raw material is already
 * there — but the native export is scope/attribute shaped, which is awkward for
 * network analysis. These produce the two tables an analyst actually wants,
 * in the `Connected`/`Disconnected` shape Breadboard used, so existing scripts
 * port with little change.
 *
 * Deliberately PURE and free of Empirica types: the functions take a game id and
 * an event log, not a game scope. That means they run offline over a stored
 * export, they unit test in milliseconds with no server, and an analyst can
 * reuse them on data collected months ago.
 */
import type { EdgeEvent } from "../shared/keys.js";

/** One row of `edges.csv`. */
export interface EdgeRow {
  game_id: string;
  /** Wall clock, ms, from the event that caused it. */
  t: number;
  event: "connected" | "disconnected";
  player_a: string;
  player_b: string;
}

/** One row of `network_snapshots.csv`. */
export interface SnapshotRow {
  game_id: string;
  t: number;
  /** Edge count at this point. */
  size: number;
  /** Full edge list, `a|b` pairs separated by spaces. */
  edges: string;
}

/**
 * Every tie change, oldest first.
 *
 * The initial graph appears as `connected` rows at game start, because
 * `withNetwork` records it as a `start` event — so a study that never rewires
 * still exports its network here rather than an empty file.
 *
 * Pairs are emitted in the order the event recorded them. No attempt is made to
 * canonicalise a/b: for a directed reading of "who was connected to whom" the
 * caller may care, and dropping the distinction is not ours to do.
 */
export function edgeRows(gameID: string, history: EdgeEvent[]): EdgeRow[] {
  const rows: EdgeRow[] = [];
  for (const e of history) {
    // Removals first within an event: a `rewire` that drops (a,b) and adds
    // (a,c) reads more naturally as a departure then an arrival, and a reader
    // scanning for "when did a lose b" should not have to look past an add.
    for (const [a, b] of e.removed ?? []) {
      rows.push({ game_id: gameID, t: e.at, event: "disconnected", player_a: a, player_b: b });
    }
    for (const [a, b] of e.added ?? []) {
      rows.push({ game_id: gameID, t: e.at, event: "connected", player_a: a, player_b: b });
    }
  }
  return rows;
}

/**
 * The full edge list after each event.
 *
 * Derived by replaying the log rather than stored, so it cannot drift from the
 * event history — and a snapshot that disagreed with the events it was built
 * from would be worse than no snapshot at all.
 */
export function snapshotRows(gameID: string, history: EdgeEvent[]): SnapshotRow[] {
  const live = new Set<string>();
  const rows: SnapshotRow[] = [];
  for (const e of history) {
    for (const [a, b] of e.removed ?? []) live.delete(pairKey(a, b));
    for (const [a, b] of e.added ?? []) live.add(pairKey(a, b));
    rows.push({
      game_id: gameID,
      t: e.at,
      size: live.size,
      edges: [...live].sort().join(" "),
    });
  }
  return rows;
}

/**
 * Replay consistency: does the log's own `size` agree with replaying it?
 *
 * Worth having as a check rather than an assumption. The log is written by a
 * live server across a run that may include a restart, and a silent divergence
 * between "what we said happened" and "what the events add up to" is exactly the
 * kind of thing that is discovered during analysis, months later.
 */
export function historyIsConsistent(history: EdgeEvent[]): boolean {
  const live = new Set<string>();
  for (const e of history) {
    for (const [a, b] of e.removed ?? []) live.delete(pairKey(a, b));
    for (const [a, b] of e.added ?? []) live.add(pairKey(a, b));
    if (live.size !== e.size) return false;
  }
  return true;
}

/**
 * Rows to CSV.
 *
 * Quotes every field rather than guessing which need it. Player ids are ULIDs
 * today and would not need quoting, but a CSV writer that is correct only for
 * the current id format is a trap for whoever changes the id format.
 */
export function toCSV(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [
    headers.map(esc).join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(",")),
  ].join("\n");
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
