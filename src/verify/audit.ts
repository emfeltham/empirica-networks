/**
 * Auditing `views.ndjson`: did anyone ever receive a non-neighbor's view?
 *
 * This is C1 — the read guarantee — checked over complete sessions of a real
 * design, rather than over a synthetic topology in a single process. `verify`
 * establishes the guarantee at the wire with sentinels; this establishes that it
 * held through every delivery of every session a study actually ran. It is the
 * primary evidence for the claim the package exists to make, which raises rather
 * than lowers the standard for it.
 *
 * ITS OWN MODULE, IMPORTING NOTHING AT RUNTIME, for the reason `topologies.ts`
 * gives: `verify/leak_test.ts` reaches `@empirica/core/admin` and so cannot load
 * from the unit tier at all (PLATFORM-NOTES §3a). Accounting that decides whether
 * a result means anything should not be reachable only through a bundler. Like
 * `export.ts`, everything here takes the file's TEXT rather than its path, and
 * `test/unit/audit.test.ts` runs against hand-built fixtures with no server.
 *
 * THREE OUTCOMES, ALL REPORTED:
 *
 *   a non-neighbor in a view    — C1 has failed. The evaluation stops; this is
 *                                  the finding and it leads the paper
 *   a neighbor missing          — not a leak. Under-delivery makes the network
 *                                  look sparser than it was; recorded, not fatal
 *   no records for a session     — the audit is VACUOUS for that session, and
 *                                  vacuous is not a pass
 *
 * The third is the one this file is shaped around. "Zero non-neighbor views" over
 * an unstated number of views proves nothing, and a check that cannot run must
 * never be mistaken for a check that passed — the same doctrine as the `verify`
 * CLI's exit codes (`docs/API.md`). Every count here is therefore printed against
 * its denominator, and `deliveriesChecked` reaching zero is a failure.
 */

/** What `parseNdjson` found, duplicated here to keep this module import-free. */
interface Parsed<T> {
  records: T[];
  dropped: number;
}

/**
 * One delivered view.
 *
 * IMPORTED, not restated. This was a structural copy carrying a comment saying
 * "as `src/shared/keys.ts` defines it" — and then `graph` was added to the
 * canonical one and not to this, so `record.graph` was not even in scope here
 * and half of every radius 1.5 delivery went unaudited without a line of code
 * looking wrong. A duplicate that names its own source is a duplicate that will
 * drift from it.
 *
 * `import type` is erased at compile time and `keys.ts` has no imports of its
 * own, so the file is still import-free at runtime, which is what the note
 * above about `parseNdjson` actually cares about.
 */
import type { ViewRecord } from "../shared/keys.js";

/** A game's realized graph: player id to the set of player ids it may see. */
export type NeighborMap = Map<string, Set<string>>;

/** Every game found in an `edges.csv`, keyed by `game_id`. */
export type GameGraphs = Map<string, NeighborMap>;

export interface ParsedEdges {
  graphs: GameGraphs;
  /**
   * Games whose edge log contained a disconnection.
   *
   * Returned rather than held in module state, so two audits in one process
   * cannot contaminate each other. Shirado never rewires — `callbacks.js` warns
   * if its event count is not exactly one — so this is empty in practice and
   * exists to stop a rewiring design being audited against the wrong graph.
   */
  rewired: Set<string>;
}

export interface SessionAudit {
  gameID: string;
  records: number;
  deliveries: number;
  leaks: number;
  missing: number;
  /** Ties examined in delivered structure. The denominator for `structureLeaks`. */
  ties: number;
  /** Ties that joined two people the viewer could not both see, or that did not exist. */
  structureLeaks: number;
  /** Ties delivered that were NOT incident to the viewer — what radius 1.5 adds. */
  beyondStar: number;
  /** Records that carried a structure at all. */
  structured: number;
}

export interface AuditResult {
  pass: boolean;
  /** Games present in the graphs, which is the population the audit is over. */
  sessions: number;
  recordsChecked: number;
  /** (viewer, neighbor) pairs examined. The denominator for `leaks`. */
  deliveriesChecked: number;
  /** Non-neighbors found in a view. Must be 0. */
  leaks: number;
  /** Neighbors absent from a view that should have carried them. */
  missingDeliveries: number;
  /**
   * Ties examined across every delivered structure. The denominator for
   * `structureLeaks`, and zero for a study at the default radius, where none is
   * sent and none is expected.
   */
  tiesChecked: number;
  /** Ties naming somebody the viewer could not see, or that never existed. Must be 0. */
  structureLeaks: number;
  /**
   * Ties delivered beyond the viewer's own star, summed.
   *
   * The non-vacuity figure for radius 1.5, and the reason the arm is not
   * satisfied by a structure payload full of nothing but the star: that is what
   * radius 1 draws, and a run delivering it has published the extra channel and
   * put nothing in it.
   */
  beyondStar: number;
  /** Records carrying a structure. Zero at the default radius. */
  structuredRecords: number;
  /** Games with a graph but no delivered view. Not a pass. */
  vacuousSessions: string[];
  /** Lines that would not parse — the expected cause is a hard kill. */
  dropped: number;
  perSession: SessionAudit[];
  failures: string[];
  notes: string[];
}

/**
 * Parse an NDJSON text, tolerating a truncated tail.
 *
 * A copy of `export.ts`'s `parseNdjson` rather than an import of it: that module
 * is under `src/admin/`, which `test/unit/export_isolation.test.ts` keeps free of
 * runtime imports for its own reasons, and reaching across tiers to share nine
 * lines would couple two modules whose only shared property is having no imports.
 */
function parseNdjson<T>(text: string): Parsed<T> {
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

/** Split one CSV line written by `toCSV`, which quotes every field. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * The realized graph of every game in an `edges.csv`, in the player-id space.
 *
 * `edgeRows` emits `player_a`/`player_b` as player ids, which is the same space
 * `ViewRecord.viewer` and `view[].id` live in — so the audit compares directly,
 * with no index mapping to get wrong. The initial graph arrives as `connected`
 * rows at game start, because `withNetwork` records it as a `start` event.
 *
 * Rewiring is retained rather than flattened: `auditViews` refuses a game that
 * rewired instead of checking its views against a graph they predate.
 */
export function parseEdgesCsv(text: string): ParsedEdges {
  const graphs: GameGraphs = new Map();
  const rewired = new Set<string>();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { graphs, rewired };

  const headers = splitCsvLine(lines[0]!);
  const col = (name: string) => headers.indexOf(name);
  const iGame = col("game_id");
  const iEvent = col("event");
  const iA = col("player_a");
  const iB = col("player_b");
  if (iGame < 0 || iEvent < 0 || iA < 0 || iB < 0) {
    throw new Error(
      `edges.csv is missing a required column: expected game_id, event, player_a, ` +
        `player_b; found ${headers.join(", ")}`
    );
  }

  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const gameID = f[iGame] ?? "";
    const a = f[iA] ?? "";
    const b = f[iB] ?? "";
    if (gameID === "" || a === "" || b === "") continue;

    let g = graphs.get(gameID);
    if (!g) {
      g = new Map();
      graphs.set(gameID, g);
    }
    const link = (x: string, y: string, connect: boolean) => {
      let set = g!.get(x);
      if (!set) {
        set = new Set();
        g!.set(x, set);
      }
      if (connect) set.add(y);
      else set.delete(y);
    };
    const connect = f[iEvent] === "connected";
    link(a, b, connect);
    link(b, a, connect);
    if (!connect) rewired.add(gameID);
  }
  return { graphs, rewired };
}

/**
 * How many per-record complaints are quoted before the rest are counted instead.
 *
 * The counts stay exact; only the prose is capped. A genuine C1 failure at n=20
 * over a five-minute session could produce tens of thousands of LEAK lines, and an
 * unbounded array of them would go into `manifest.json` and into memory — turning
 * the most important result the evaluation can produce into an unreadable file.
 * Twenty examples and an exact total say the same thing and can be acted on.
 */
const MAX_QUOTED = 20;

export function auditViews(input: { views: string; edges: ParsedEdges }): AuditResult {
  const { graphs, rewired } = input.edges;
  const { records, dropped } = parseNdjson<ViewRecord>(input.views);
  const quoted: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  let suppressed = 0;
  const complain = (msg: string) => {
    if (quoted.length < MAX_QUOTED) quoted.push(msg);
    else suppressed++;
  };

  const perSession = new Map<string, SessionAudit>();
  for (const gameID of graphs.keys()) {
    perSession.set(gameID, {
      gameID, records: 0, deliveries: 0, leaks: 0, missing: 0,
      ties: 0, structureLeaks: 0, beyondStar: 0, structured: 0,
    });
  }

  for (const gameID of rewired) {
    if (!graphs.has(gameID)) continue;
    failures.push(
      `REFUSED: game ${gameID} rewired during the session, so its views cannot be ` +
        `checked against one static neighbor set — a view that was correct when ` +
        `delivered would read as a leak against the graph that replaced it.`
    );
  }

  for (const r of records) {
    const graph = graphs.get(r.gameID);
    if (!graph) {
      complain(
        `ERROR: a view was delivered in game ${r.gameID}, which has no graph in ` +
          `edges.csv. The views file and the edge export do not describe the same run.`
      );
      continue;
    }
    const session = perSession.get(r.gameID)!;
    const neighbors = graph.get(r.viewer);
    if (!neighbors) {
      complain(
        `ERROR: ${r.viewer} is not in the graph of game ${r.gameID}, but was ` +
          `delivered a view (seq ${r.seq}). Unknown viewer.`
      );
      continue;
    }

    session.records++;
    const seen = new Set<string>();
    for (const entry of r.view ?? []) {
      const id =
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)["id"]
          : undefined;
      if (typeof id !== "string" || id === "") {
        complain(
          `ERROR: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) received a view entry ` +
            `with no string id, so who was seen cannot be established and C1 cannot ` +
            `be checked for it.`
        );
        continue;
      }
      if (seen.has(id)) {
        complain(
          `ERROR: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) received ${id} twice in ` +
            `one view. A duplicate neighbor is not a shape the projection can produce.`
        );
        continue;
      }
      seen.add(id);
      session.deliveries++;
      if (!neighbors.has(id)) {
        session.leaks++;
        complain(
          `LEAK: ${r.viewer} received non-neighbor ${id}'s view in game ${r.gameID} ` +
            `(seq ${r.seq}). C1 has failed; the evaluation stops here.`
        );
      }
    }
    for (const n of neighbors) {
      if (!seen.has(n)) session.missing++;
    }

    // ---- the structure, at radius 1.5 ------------------------------------
    //
    // Everything above is about `view`, and what it checks are other people's
    // ATTRIBUTES. The bytes radius 1.5 adds are integers, so a payload naming
    // ties to strangers carries nothing the loop above could notice and every
    // count it produces stays clean. These are the arms `verify` added at the
    // wire, applied to the file.
    const g = r.graph;
    if (!g) continue;
    session.structured++;

    // Local index 0 is the viewer; 1..d index this record's own view, in
    // delivery order. Resolved from the record rather than from the graph,
    // because that is the mapping the participant was actually sent.
    const localToPlayer: Array<unknown> = [
      r.viewer,
      ...(r.view ?? []).map((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)["id"]
          : undefined
      ),
    ];

    for (const edge of g.edges ?? []) {
      session.ties++;
      const a = Array.isArray(edge) ? edge[0] : undefined;
      const b = Array.isArray(edge) ? edge[1] : undefined;
      const x = typeof a === "number" ? localToPlayer[a] : undefined;
      const y = typeof b === "number" ? localToPlayer[b] : undefined;
      if (typeof x !== "string" || typeof y !== "string" || x === y) {
        session.structureLeaks++;
        complain(
          `STRUCTURE: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) was shown a tie naming ` +
            `local index ${String(a)}/${String(b)}, which is outside the neighborhood they ` +
            `were sent. Who was shown to whom cannot be established for it.`
        );
        continue;
      }
      // Both ends must be visible to this viewer, and the tie must be real. A
      // drawn tie that does not exist is not a leak; it is a fabrication, and
      // it fails here for the same reason.
      if (!(x === r.viewer || neighbors.has(x)) || !(y === r.viewer || neighbors.has(y))) {
        session.structureLeaks++;
        complain(
          `STRUCTURE LEAK: ${r.viewer} was shown a tie involving somebody outside their ` +
            `neighborhood in game ${r.gameID} (seq ${r.seq}).`
        );
        continue;
      }
      if (!(graph.get(x)?.has(y) ?? false)) {
        session.structureLeaks++;
        complain(
          `STRUCTURE: ${r.viewer} was told ${x} and ${y} are connected in game ` +
            `${r.gameID} (seq ${r.seq}), and the edge log says they are not.`
        );
        continue;
      }
      if (a !== 0 && b !== 0) session.beyondStar++;
    }
  }

  failures.unshift(...quoted);
  if (suppressed > 0) {
    failures.push(
      `${suppressed} further per-record failure(s) not quoted. The counts above are ` +
        `exact; only the examples are capped.`
    );
  }

  const sessions = [...perSession.values()];
  const recordsChecked = sessions.reduce((s, x) => s + x.records, 0);
  const deliveriesChecked = sessions.reduce((s, x) => s + x.deliveries, 0);
  const leaks = sessions.reduce((s, x) => s + x.leaks, 0);
  const missingDeliveries = sessions.reduce((s, x) => s + x.missing, 0);
  const vacuousSessions = sessions.filter((x) => x.records === 0).map((x) => x.gameID);
  const tiesChecked = sessions.reduce((s, x) => s + x.ties, 0);
  const structureLeaks = sessions.reduce((s, x) => s + x.structureLeaks, 0);
  const beyondStar = sessions.reduce((s, x) => s + x.beyondStar, 0);
  const structuredRecords = sessions.reduce((s, x) => s + x.structured, 0);

  // Vacuity, stated on the denominator rather than on the session count, for the
  // reason `topologies.ts` gives: `deliveriesChecked === 0` IS the statement "no
  // pair was ever examined", and it reads as the reason rather than the symptom.
  if (deliveriesChecked === 0) {
    failures.push(
      `VACUOUS: no view delivery was examined, so nothing leaked because nothing ` +
        `was checked. A pass here would mean nothing.`
    );
  }
  for (const gameID of vacuousSessions) {
    failures.push(
      `VACUOUS: session ${gameID} has a graph but delivered no view. Its guarantee ` +
        `is unestablished, not upheld.`
    );
  }

  // Vacuity for the structural arm, on its own denominator like the two above.
  // A study that delivered structure and never once showed a tie beyond a
  // viewer's own star delivered what radius 1 delivers: the channel was opened
  // and nothing was put in it, and every other count here stays clean.
  if (structuredRecords > 0 && beyondStar === 0) {
    failures.push(
      `VACUOUS: ${structuredRecords} record(s) carried a structure and not one showed a tie ` +
        `between two of a viewer's neighbors, which is what radius 1 already draws. The ` +
        `extra channel was published empty.`
    );
  }

  if (structuredRecords > 0) {
    notes.push(
      `${structuredRecords} of ${recordsChecked} record(s) carried structure; ${beyondStar} ` +
        `tie(s) beyond a viewer's own star were delivered across ${tiesChecked} examined`
    );
  }

  if (dropped > 0) {
    notes.push(
      `${dropped} line(s) dropped as unparseable — the expected cause is a hard ` +
        `kill truncating the final record, which is a session ending, not a defect`
    );
  }
  if (missingDeliveries > 0) {
    notes.push(
      `${missingDeliveries} neighbor(s) missing from a view that should have ` +
        `carried them: under-delivery, not a leak. The network was seen as sparser ` +
        `than it was`
    );
  }

  return {
    pass: failures.length === 0,
    sessions: sessions.length,
    recordsChecked,
    deliveriesChecked,
    leaks,
    missingDeliveries,
    tiesChecked,
    structureLeaks,
    beyondStar,
    structuredRecords,
    vacuousSessions,
    dropped,
    perSession: sessions,
    failures,
    notes,
  };
}

/**
 * The report, with every count against what it was measured over.
 *
 * `formatLeakResult` explains why at length and the reasoning is identical here: a
 * bare `0` reads the same whether four hundred deliveries were examined and none
 * leaked, or the file was empty. The denominator is what makes the line
 * falsifiable.
 */
export function formatAuditResult(r: AuditResult): string {
  const lines = [
    "",
    `  empirica-networks simulate — views.ndjson audit (C1)`,
    "",
    `  non-neighbor views     : ${r.leaks}/${r.deliveriesChecked} deliveries  (must be 0)`,
    `  views audited           : ${r.recordsChecked}  across ${r.sessions} session(s)`,
    `  missing deliveries      : ${r.missingDeliveries}  (under-delivery, not a leak)`,
    `  vacuous sessions        : ${r.vacuousSessions.length}/${r.sessions}  (must be 0)`,
  ];

  // Printed only when there is structure to report on, rather than as two zeroes
  // on every run: at the default radius none is delivered and none is expected,
  // and a line reading `0/0` would invite the reading that something was checked.
  if (r.structuredRecords > 0) {
    lines.push(
      `  ties outside the view  : ${r.structureLeaks}/${r.tiesChecked} ties  (must be 0)`,
      `  ties between neighbors  : ${r.beyondStar}  (non-vacuity, must be > 0)`
    );
  }
  lines.push("");
  for (const s of r.perSession) {
    lines.push(
      `    ${s.gameID}: ${s.leaks}/${s.deliveries} leaked, ${s.records} views, ` +
        `${s.missing} missing`
    );
  }
  lines.push("");
  for (const note of r.notes) lines.push(`  note: ${note}`);
  for (const f of r.failures) lines.push(`  ✗ ${f}`);
  lines.push("", r.pass ? "  PASS" : "  FAIL", "");
  return lines.join("\n");
}

/**
 * Total several single-session audits into one arm-level result.
 *
 * Auditing per session and merging, rather than concatenating ten sessions' views
 * into one string, for two reasons. A ten-session arm is ~30 MB of NDJSON and
 * ~850,000 view entries, which is a lot of live objects to hold for no gain; and a
 * failure attributes itself to the session that produced it, which is what the
 * report has to say. The counts are additive, so nothing is lost by summing them.
 */
export function mergeAuditResults(results: AuditResult[]): AuditResult {
  const merged: AuditResult = {
    pass: true,
    sessions: 0,
    recordsChecked: 0,
    deliveriesChecked: 0,
    leaks: 0,
    missingDeliveries: 0,
    tiesChecked: 0,
    structureLeaks: 0,
    beyondStar: 0,
    structuredRecords: 0,
    vacuousSessions: [],
    dropped: 0,
    perSession: [],
    failures: [],
    notes: [],
  };
  for (const r of results) {
    merged.sessions += r.sessions;
    merged.recordsChecked += r.recordsChecked;
    merged.deliveriesChecked += r.deliveriesChecked;
    merged.leaks += r.leaks;
    merged.missingDeliveries += r.missingDeliveries;
    merged.tiesChecked += r.tiesChecked;
    merged.structureLeaks += r.structureLeaks;
    merged.beyondStar += r.beyondStar;
    merged.structuredRecords += r.structuredRecords;
    merged.dropped += r.dropped;
    merged.vacuousSessions.push(...r.vacuousSessions);
    merged.perSession.push(...r.perSession);
    merged.failures.push(...r.failures);
    merged.notes.push(...r.notes);
    if (!r.pass) merged.pass = false;
  }
  // An arm with no session at all is vacuous in its own right, and summing zeroes
  // would otherwise report a clean PASS over nothing.
  if (results.length === 0) {
    merged.pass = false;
    merged.failures.push(`VACUOUS: this arm produced no auditable session at all.`);
  }
  return merged;
}

// ─── C4: reproducibility ──────────────────────────────────────────────────────
//
// C4 asks two things of a run's record: that `edges.csv`
// rebuilds byte-identically from `run.ndjson`, and that the recorded seed
// regenerates the network participants were actually given. The second is the
// stronger claim and the one Breadboard could not make — recording a generator
// and its parameters says what was asked for, not what was realized.
//
// Both comparisons are pure over text and live here for the reason the rest of
// this module does: a check on whether a result means anything should be
// loadable without a bundler.

/** A structural edge, in topology-index space. */
export type IndexEdge = [number, number];

/**
 * An edge list in a form two graphs can be compared by.
 *
 * Pairs are ordered within themselves and then sorted, because neither the
 * generator nor the export promises an orientation or an order, and a comparison
 * that failed on those would report a difference that is not one.
 */
export function canonicalEdges(edges: IndexEdge[]): string {
  return edges
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(" ");
}

/**
 * The realized graph of one game, recovered from `edges.csv` in index space.
 *
 * `edges.csv` is in player ids; a generator works in structural indices. `order`
 * is the bridge — `order[i]` is the player seated at index `i` — and it is
 * captured into `session.json` by the runner because nothing else keeps it.
 *
 * Throws rather than skipping an unknown player: an edge naming someone outside
 * the seating means the export and the seating describe different games, and
 * silently dropping it would shrink the graph being compared.
 */
export function structuralEdges(
  edgesCsvText: string,
  gameID: string,
  order: string[]
): IndexEdge[] {
  const index = new Map(order.map((id, i) => [id, i]));
  const lines = edgesCsvText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]!);
  const iGame = headers.indexOf("game_id");
  const iEvent = headers.indexOf("event");
  const iA = headers.indexOf("player_a");
  const iB = headers.indexOf("player_b");
  const edges: IndexEdge[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    if (f[iGame] !== gameID || f[iEvent] !== "connected") continue;
    const a = index.get(f[iA] ?? "");
    const b = index.get(f[iB] ?? "");
    if (a === undefined || b === undefined) {
      throw new Error(
        `edges.csv names player ${a === undefined ? f[iA] : f[iB]}, who is not in the ` +
          `recorded seating of game ${gameID}. The export and the seating are not from ` +
          `the same run.`
      );
    }
    edges.push([a, b]);
  }
  return edges;
}
