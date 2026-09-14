/**
 * Export the realized network for analysis.
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

/** One row of `views.csv`: one viewer's sight of one neighbor at one delivery. */
export interface ViewRow {
  game_id: string;
  /** Player id of the participant this was delivered to. */
  viewer: string;
  seq: number;
  t: number;
  /** Position within the view — stable, and defined even for a projection with no id. */
  neighbor_index: number;
  /** The projected `id`, when there is one. Empty otherwise. */
  neighbor_id: string;
  /** Everything else `project()` returned, one column per field. */
  [field: string]: string | number;
}

/**
 * Flatten captured views into one row per viewer per neighbor per delivery.
 *
 * This is where the shape changes, and why capture is NDJSON: a view is a
 * variable-length array of author-defined objects, so the columns cannot be
 * known until the whole log is in hand. Here it is, so they can be.
 *
 * Long rather than wide — one row per neighbor, not one row per view with the
 * neighbors packed into a cell — because the resulting table joins directly
 * against `edges.csv` on `(viewer, neighbor_id, t)`. A wide table would have to
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
        neighbor_index: index,
        neighbor_id: "",
      };
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
          if (k === "id" && typeof v === "string") {
            row.neighbor_id = v;
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

/**
 * One row of `far.csv`: one person a viewer could see but was not connected to.
 *
 * An `interface` with its own index signature rather than a `type`, exactly as
 * `ViewRow` is, because a study that sets `graph.projectFar` chooses what these
 * carry and the columns cannot be known here.
 */
export interface FarRow {
  [field: string]: string | number;
  game_id: string;
  viewer: string;
  seq: number;
  t: number;
  /** As `StructureRow.radius`. */
  radius: number;
  /** Local index in the delivery, so this joins to `structure.csv` on `a_index`/`b_index`. */
  node_index: number;
  /** What this viewer called them. See `PositionRow.node_ref`. */
  ref: string;
  /** Who they actually were. Recorded server-side; the participant never saw it. */
  id: string;
  /** Hops from the viewer. Always 2 or more. */
  hop: number;
}

/**
 * Flatten the people each participant could see and could not reach.
 *
 * Its own builder rather than rows in `views.csv`, and the reason is the grain
 * rather than tidiness: `NEIGHBORS` carries distance 1 and only distance 1 — so
 * that `useNeighbors()` keeps its meaning and no assertion written against it
 * moves — which makes every row in `views.csv` hop 1 by construction. Folding
 * these in would put two different relationships in one table under a column
 * that is constant for half of it.
 *
 * Empty below radius 2, where every visible node is a neighbor and `views.csv`
 * already has them all.
 *
 * The projected fields are present only if the study set `graph.projectFar`. A
 * row with none is the ordinary case and is not an empty row: `ref`, `id` and
 * `hop` are the disclosure, and whether a participant could see somebody at all
 * is the thing most designs are manipulating.
 */
export function farRows(records: ViewRecord[]): FarRow[] {
  const rows: FarRow[] = [];
  for (const r of records) {
    const delivered = r.graph?.far ?? [];
    const recorded = r.far ?? [];
    const base = (r.view ?? []).length + 1;
    for (const [k, f] of delivered.entries()) {
      const row: FarRow = {
        game_id: r.gameID,
        viewer: r.viewer,
        seq: r.seq,
        t: r.at,
        radius: r.graph?.radius ?? 1,
        node_index: base + k,
        ref: typeof f?.ref === "string" ? f.ref : "",
        // Empty when the capture predates `ViewRecord.far`, which `auditViews`
        // refuses outright. Kept as a column rather than dropped so the table
        // says which rows it cannot account for instead of omitting them.
        id: typeof recorded[k]?.id === "string" ? recorded[k]!.id : "",
        hop: typeof f?.d === "number" ? f.d : -1,
      };
      const view = f?.view;
      if (view !== null && typeof view === "object" && !Array.isArray(view)) {
        for (const [key, v] of Object.entries(view as Record<string, unknown>)) {
          // Never let a projected field overwrite the identity columns.
          if (key in row) continue;
          row[key] = scalar(v);
        }
      } else if (view !== undefined) {
        row["value"] = scalar(view);
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * One row of `structure.csv`: one tie one viewer was shown, at one delivery.
 *
 * A `type`, not an `interface`, for the reason given at the top of this file:
 * an interface gets no implicit index signature, so `toCSV(structureRows(…))`
 * does not compile. These were interfaces when they were written, and that went
 * unnoticed for precisely the reason the note up there predicts — nothing
 * composed the two functions until a test did.
 */
export type StructureRow = {
  game_id: string;
  viewer: string;
  seq: number;
  t: number;
  /**
   * The radius this delivery was made at.
   *
   * Denormalized deliberately. The radius is also recorded per game on the batch
   * scope (`readRadius`), and for most studies this is that number repeated on
   * every row — but the two are not always the same fact. A game recovered
   * across a restart keeps the radius the FIRST process recorded while being
   * published at the second's, which the server warns about and which these rows
   * are the only per-delivery evidence of. A table read on its own should say
   * which study it describes rather than requiring a join, and the case where
   * the join would give the wrong answer is the case worth catching.
   */
  radius: number;
  /**
   * Local index of each end.
   *
   * `0` is the viewer, `1..d` index into that delivery's view, and anything
   * beyond that is somebody the viewer is not connected to — see `a_hop`.
   */
  a_index: number;
  b_index: number;
  /** The `id` of each end: the projected one for a neighbor, the recorded one beyond. */
  a_id: string;
  b_id: string;
  /**
   * Hops from the viewer to each end. `0` is the viewer, `1` a neighbor.
   *
   * Without it a tie among a viewer's own connections and a tie two steps out
   * are the same row, and which of the two a participant was shown is usually
   * the manipulation rather than a detail. It also makes the half-step rule
   * checkable from the CSV alone: at an integer radius no row may have both
   * hops equal to that radius.
   */
  a_hop: number;
  b_hop: number;
};

/** One row of `positions.csv`: where one node sat in one viewer's drawing. See above re `type`. */
export type PositionRow = {
  game_id: string;
  viewer: string;
  seq: number;
  t: number;
  /** As `StructureRow.radius`. */
  radius: number;
  node_index: number;
  node_id: string;
  /** As `StructureRow.a_hop`. */
  node_hop: number;
  /**
   * What THIS viewer called this node, for a node beyond their own neighbors.
   * Empty for the viewer and for their neighbors, who are named by their id.
   *
   * The only name the participant ever saw, and therefore the join key for
   * anything a study collected about a stranger — "which of these people did you
   * recognise" has no other answer. Deliberately not comparable across viewers:
   * two rows with the same `node_ref` and different `viewer` are two different
   * people far more often than not.
   */
  node_ref: string;
  x: number;
  y: number;
};

/**
 * Resolve a delivered local index to a player id.
 *
 * `0` is the viewer themselves; `1..d` are positions in that delivery's view,
 * read with the same rule `viewRows` uses for `neighbor_id` — a string `id`
 * field, empty otherwise. Empty is a real answer for a projection that carries
 * no id, and the index still identifies the node, which is why both are columns.
 */
function idAt(record: ViewRecord, local: number): string {
  if (local === 0) return record.viewer;
  const view = record.view ?? [];
  if (local > view.length) {
    // Somebody the viewer is not connected to. The delivery named them only by
    // a per-viewer ref, so this is the only way back to an identity — and it is
    // why `ViewRecord.far` is written server-side at all. Without it these rows
    // carried an empty id, indistinguishable from a projection that has none.
    const f = (record.far ?? [])[local - 1 - view.length];
    return typeof f?.id === "string" ? f.id : "";
  }
  const entry = view[local - 1];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "";
  const id = (entry as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : "";
}

/**
 * How many hops from the viewer the node at this local index was.
 *
 * Read off the index space rather than computed: `0` is the viewer, `1..d` are
 * their own neighbors by construction, and anything beyond carries its distance
 * in the record. `-1` for an index the record cannot account for, which is a
 * malformed delivery rather than a distance.
 *
 * Without this column a tie among a viewer's neighbors and a tie two steps out
 * are the same row, and the distinction is usually the independent variable.
 */
function hopAt(record: ViewRecord, local: number): number {
  if (local === 0) return 0;
  const view = record.view ?? [];
  if (local <= view.length) return 1;
  const f = (record.far ?? [])[local - 1 - view.length];
  return typeof f?.hop === "number" ? f.hop : -1;
}

/** This viewer's private name for the node at this local index, if it has one. */
function refAt(record: ViewRecord, local: number): string {
  const view = record.view ?? [];
  if (local <= view.length) return "";
  const f = (record.far ?? [])[local - 1 - view.length];
  return typeof f?.ref === "string" ? f.ref : "";
}

/**
 * Flatten the ties each participant was shown among their own neighbors.
 *
 * Empty unless the study ran at `graph: { radius: 1.5 }`; at the default nothing
 * is delivered and nothing is recorded.
 *
 * Long rather than wide, and separate from `viewRows` rather than folded into
 * it, for the same reason `viewRows` is separate from `edgeRows`: the grain
 * differs. A view row is one viewer's sight of one NEIGHBOR; this is one
 * viewer's sight of one TIE, and a tie between two neighbors belongs to neither
 * of their rows. Folding it in would also silently change the row count of
 * `views.csv`, which `test/e2e/views.test.ts` pins.
 *
 * Both the local indices and the resolved ids are carried. The ids join to
 * `edges.csv` and answer "was this tie real"; the indices join to `views.csv` on
 * `(viewer, seq, neighbor_index = a_index - 1)` and survive a projection that
 * carries no id at all.
 */
export function structureRows(records: ViewRecord[]): StructureRow[] {
  const rows: StructureRow[] = [];
  for (const r of records) {
    for (const edge of r.graph?.edges ?? []) {
      const [a, b] = edge;
      rows.push({
        game_id: r.gameID,
        viewer: r.viewer,
        seq: r.seq,
        t: r.at,
        radius: r.graph?.radius ?? 1,
        a_index: a,
        b_index: b,
        a_id: idAt(r, a),
        b_id: idAt(r, b),
        a_hop: hopAt(r, a),
        b_hop: hopAt(r, b),
      });
    }
  }
  return rows;
}

/**
 * Flatten where every node sat in every drawing.
 *
 * Its own builder rather than columns on `structureRows`, because a viewer with
 * no ties still has a position: their own. Denormalizing `x`/`y` onto edge rows
 * would drop exactly the isolated participant, who in a rewiring design is the
 * one worth looking at.
 *
 * This is the part of a delivery that is NOT recoverable from anything else
 * stored — positions are warm-started, so they depend on the session's history
 * rather than on its final graph. Without this the drawing a participant saw is
 * gone.
 */
export function positionRows(records: ViewRecord[]): PositionRow[] {
  const rows: PositionRow[] = [];
  for (const r of records) {
    for (const [index, p] of (r.graph?.positions ?? []).entries()) {
      rows.push({
        game_id: r.gameID,
        viewer: r.viewer,
        seq: r.seq,
        t: r.at,
        radius: r.graph?.radius ?? 1,
        node_index: index,
        node_id: idAt(r, index),
        node_hop: hopAt(r, index),
        node_ref: refAt(r, index),
        x: p.x,
        y: p.y,
      });
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
