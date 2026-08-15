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
import type { EdgeEvent, ViewRecord } from "../shared/keys.js";

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

/** One row of `views.csv`: one viewer's sight of one neighbour at one delivery. */
export interface ViewRow {
  game_id: string;
  /** Player id of the participant this was delivered to. */
  viewer: string;
  seq: number;
  t: number;
  /** Position within the view — stable, and defined even for a projection with no id. */
  neighbour_index: number;
  /** The projected `id`, when there is one. Empty otherwise. */
  neighbour_id: string;
  /** Everything else `project()` returned, one column per field. */
  [field: string]: string | number;
}

/**
 * Flatten captured views into one row per viewer per neighbour per delivery.
 *
 * This is where the shape changes, and why capture is NDJSON: a view is a
 * variable-length array of author-defined objects, so the columns cannot be
 * known until the whole log is in hand. Here it is, so they can be.
 *
 * Long rather than wide — one row per neighbour, not one row per view with the
 * neighbours packed into a cell — because the resulting table joins directly
 * against `edges.csv` on `(viewer, neighbour_id, t)`. A wide table would have to
 * be unpacked before any of the questions this exists to answer could be asked.
 *
 * Nested values are JSON-encoded into their cell. Flattening them into
 * `a.b.c` columns guesses at a schema the author did not declare, and a
 * projection deep enough to need it is better read as JSON anyway.
 */
export function viewRows(records: ViewRecord[]): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const r of records) {
    for (const [index, entry] of (r.view ?? []).entries()) {
      const row: ViewRow = {
        game_id: r.gameID,
        viewer: r.viewer,
        seq: r.seq,
        t: r.at,
        neighbour_index: index,
        neighbour_id: "",
      };
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
          if (k === "id" && typeof v === "string") {
            row.neighbour_id = v;
            continue;
          }
          row[k] = scalar(v);
        }
      } else {
        // A projection may return a bare value (`project: (n) => n.id`). Give it
        // a column rather than dropping it — silently exporting nothing for a
        // legal projection is the kind of gap found during analysis.
        row["value"] = scalar(entry);
      }
      rows.push(row);
    }
  }
  return rows;
}

function scalar(v: unknown): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

/**
 * Rows to CSV.
 *
 * Quotes every field rather than guessing which need it. Player ids are ULIDs
 * today and would not need quoting, but a CSV writer that is correct only for
 * the current id format is a trap for whoever changes the id format.
 *
 * Headers are the union of every row's keys, in first-seen order, and not just
 * the first row's. Edge and snapshot rows are uniform so it never mattered
 * there — but view rows carry author-defined columns, and an optional field that
 * happens to be absent from record 1 would otherwise be dropped from the entire
 * export without a word.
 */
export function toCSV(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "";
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(k);
      }
    }
  }
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [
    headers.map(esc).join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(",")),
  ].join("\n");
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
