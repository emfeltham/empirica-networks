/**
 * Auditing `views.ndjson`: did anyone ever receive a non-neighbour's view?
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
 *   a non-neighbour in a view    — C1 has failed. The evaluation stops; this is
 *                                  the finding and it leads the paper
 *   a neighbour missing          — not a leak. Under-delivery makes the network
 *                                  look sparser than it was; recorded, not fatal
 *   no records for a session     — the audit is VACUOUS for that session, and
 *                                  vacuous is not a pass
 *
 * The third is the one this file is shaped around. "Zero non-neighbour views" over
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

/** One delivered view, as `src/shared/keys.ts` defines it. Structural, not imported. */
interface ViewRecord {
  gameID: string;
  viewer: string;
  seq: number;
  at: number;
  view: unknown[];
}

/** A game's realised graph: player id to the set of player ids it may see. */
export type NeighbourMap = Map<string, Set<string>>;

/** Every game found in an `edges.csv`, keyed by `game_id`. */
export type GameGraphs = Map<string, NeighbourMap>;

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
}

export interface AuditResult {
  pass: boolean;
  /** Games present in the graphs, which is the population the audit is over. */
  sessions: number;
  recordsChecked: number;
  /** (viewer, neighbour) pairs examined. The denominator for `leaks`. */
  deliveriesChecked: number;
  /** Non-neighbours found in a view. Must be 0. */
  leaks: number;
  /** Neighbours absent from a view that should have carried them. */
  missingDeliveries: number;
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
 * The realised graph of every game in an `edges.csv`, in the player-id space.
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
    perSession.set(gameID, { gameID, records: 0, deliveries: 0, leaks: 0, missing: 0 });
  }

  for (const gameID of rewired) {
    if (!graphs.has(gameID)) continue;
    failures.push(
      `REFUSED: game ${gameID} rewired during the session, so its views cannot be ` +
        `checked against one static neighbour set — a view that was correct when ` +
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
    const neighbours = graph.get(r.viewer);
    if (!neighbours) {
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
            `one view. A duplicate neighbour is not a shape the projection can produce.`
        );
        continue;
      }
      seen.add(id);
      session.deliveries++;
      if (!neighbours.has(id)) {
        session.leaks++;
        complain(
          `LEAK: ${r.viewer} received non-neighbour ${id}'s view in game ${r.gameID} ` +
            `(seq ${r.seq}). C1 has failed; the evaluation stops here.`
        );
      }
    }
    for (const n of neighbours) {
      if (!seen.has(n)) session.missing++;
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

  if (dropped > 0) {
    notes.push(
      `${dropped} line(s) dropped as unparseable — the expected cause is a hard ` +
        `kill truncating the final record, which is a session ending, not a defect`
    );
  }
  if (missingDeliveries > 0) {
    notes.push(
      `${missingDeliveries} neighbour(s) missing from a view that should have ` +
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
    `  non-neighbour views     : ${r.leaks}/${r.deliveriesChecked} deliveries  (must be 0)`,
    `  views audited           : ${r.recordsChecked}  across ${r.sessions} session(s)`,
    `  missing deliveries      : ${r.missingDeliveries}  (under-delivery, not a leak)`,
    `  vacuous sessions        : ${r.vacuousSessions.length}/${r.sessions}  (must be 0)`,
    "",
  ];
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
// and its parameters says what was asked for, not what was realised.
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
 * The realised graph of one game, recovered from `edges.csv` in index space.
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
