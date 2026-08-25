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

/**
 * `EdgeRow` and `SnapshotRow` are `type` aliases rather than `interface`s, and that
 * is load-bearing rather than stylistic. (`ViewRow` below is an interface and
 * composes fine — it declares an index signature of its own, because a projection's
 * fields are not known in advance.)
 *
 * TypeScript gives an object type alias an implicit index signature and an
 * interface none, so `toCSV(edgeRows(…))` — two exported functions of this module,
 * composed the obvious way — did **not** compile while these were interfaces:
 * `Index signature for type 'string' is missing in type 'EdgeRow'`. It went
 * unnoticed until M6 Tier 4 because every caller that composed them was in an
 * example's plain JavaScript, and the one in TypeScript went through a placeholder
 * string. Found by writing that call in a test, not by reading the code.
 *
 * The alternative was widening `toCSV` to accept `object`, which would have made
 * `toCSV([{ a: { nested: 1 } }])` compile and emit `[object Object]`. Keeping the
 * value constraint and dropping the interface is the same fix without that cost.
 * `test/unit/shirado2017.test.ts` composes them, so `npm run check` is the guard.
 */

/** One row of `edges.csv`. */
export type EdgeRow = {
  game_id: string;
  /** Wall clock, ms, from the event that caused it. */
  t: number;
  event: "connected" | "disconnected";
  player_a: string;
  player_b: string;
};

/** One row of `network_snapshots.csv`. */
export type SnapshotRow = {
  game_id: string;
  t: number;
  /** Edge count at this point. */
  size: number;
  /** Full edge list, `a|b` pairs separated by spaces. */
  edges: string;
};

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

/** What `parseNdjson` found: the records, and what it had to throw away. */
export interface NdjsonParse<T> {
  records: T[];
  /**
   * Lines that would not parse.
   *
   * Reported rather than swallowed, because the expected cause is a hard kill
   * cutting the final record in half — and a recovery that quietly dropped a
   * round would be indistinguishable from a session that ran one round fewer.
   */
  dropped: number;
}

/**
 * Parse an NDJSON run log, tolerating a truncated tail.
 *
 * Takes the file's TEXT, not its path, and that is a constraint rather than a
 * preference: everything reachable from `empirica-networks/export` has to load
 * from plain Node with no build step (`docs/PLATFORM-NOTES.md` §3a), and
 * `test/unit/export_isolation.test.ts` enforces it by refusing this file any
 * runtime import at all — including `node:fs`. The caller's
 * `fs.readFileSync(path, "utf8")` is one line and is the line they already had.
 *
 * Exists because both shipped examples' `recover.mjs` had hand-rolled the same
 * split/parse/count loop. Blank lines are skipped and not counted: a log that
 * ends in a newline is a normal log, and reporting that as a dropped record would
 * make every clean run look truncated.
 */
export function parseNdjson<T = Record<string, unknown>>(text: string): NdjsonParse<T> {
  const records: T[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      dropped++;
    }
  }
  return { records, dropped };
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
