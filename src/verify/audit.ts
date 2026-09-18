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

/** One tie change, in the order it was recorded. */
export interface TieChange {
  /** Publish counter, or `-1` for a record written before the column existed. */
  seq: number;
  t: number;
  a: string;
  b: string;
  connect: boolean;
}

export interface ParsedEdges {
  graphs: GameGraphs;
  /**
   * Games whose edge log contained a disconnection.
   *
   * Returned rather than held in module state, so two audits in one process
   * cannot contaminate each other. No longer a reason to refuse: it used to be,
   * because a delivery could only be checked against the final adjacency and a
   * view that was correct when sent would read as a leak against the graph that
   * replaced it. `timeline` is what removed that, and this is now a fact about
   * the run rather than a verdict on it.
   */
  rewired: Set<string>;
  /**
   * Every tie change, in order, per game.
   *
   * The same rows as `graphs`, unflattened. `graphs` answers "what did the graph
   * end as", which is all a static study needs; this answers "what was it when
   * this view was delivered", which is the only question a rewiring study can be
   * audited on.
   */
  timeline: Map<string, TieChange[]>;
  /**
   * Rows carrying no publish counter, because they predate the column.
   *
   * Reported rather than worked around: without one, a change and the delivery
   * it caused can only be ordered by a wall clock they usually share, so those
   * games fall back to the final adjacency and the audit says how many rows put
   * it in that position.
   */
  undated: number;
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
  /** Ties delivered with an end beyond the viewer's own neighbors. Above 1.5 only. */
  farTies: number;
  /** People shown to somebody not connected to them. Above 1.5 only. */
  farShown: number;
  /** Far entries that carried a `projectFar` payload. The denominator for `farLeaks`. */
  farViews: number;
  /** Far payloads naming a participant. Must be 0. */
  farLeaks: number;
  /** Deliveries whose radius was checked against an authorization. */
  authorizationChecked: number;
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
  /**
   * The generalization of `beyondStar`, which only ever meant anything at 1.5.
   *
   * Above that radius most ties touch neither the viewer nor another neighbor,
   * so "not incident to local 0" stops separating the interesting case from the
   * ordinary one. These count what a wider radius actually adds: ties reaching
   * past the neighbor array, and the people at the far end of them.
   */
  farTies: number;
  farShown: number;
  /**
   * Far entries that carried a `projectFar` payload, and how many named a person.
   *
   * `farShown` counts people a viewer was told about; these count what they were
   * told ABOUT them. Without `projectFar` a distant person is a shape and a name,
   * so `farViews` is zero and the arm is vacuous — which is a different fact from
   * the arm having run and found nothing, and is reported as one.
   */
  farViews: number;
  /** Far payloads naming a participant. Must be 0. */
  farLeaks: number;
  /**
   * Deliveries whose stamped radius was checked against what the study authorized.
   *
   * Zero means no radius log was supplied, and therefore that every structure in
   * this audit was checked only against its own claim. A server that delivered
   * three hops and stamped `radius: 3` on it would self-certify, so this figure
   * is printed against `structuredRecords` rather than left absent.
   */
  authorizationChecked: number;
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
  const timeline: Map<string, TieChange[]> = new Map();
  let undated = 0;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { graphs, rewired, timeline, undated };

  const headers = splitCsvLine(lines[0]!);
  const col = (name: string) => headers.indexOf(name);
  const iGame = col("game_id");
  const iEvent = col("event");
  const iA = col("player_a");
  const iB = col("player_b");
  const iSeq = col("seq");
  const iT = col("t");
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

    // The same rows, kept in order as well as replayed, so a delivery can be
    // checked against the graph as it stood AT THAT MOMENT rather than against
    // the one the study finished with. `graphs` above is still the final
    // adjacency and is still what a static study needs.
    const seq = iSeq >= 0 ? Number(f[iSeq] ?? -1) : -1;
    if (!Number.isFinite(seq) || seq < 0) undated++;
    const list = timeline.get(gameID) ?? [];
    list.push({ seq, t: iT >= 0 ? Number(f[iT] ?? 0) : 0, a, b, connect });
    timeline.set(gameID, list);
  }
  // Stable within a seq: the writer emits removals before additions inside one
  // event, and a rewire that drops (a,b) and adds (a,c) has to replay in that
  // order or the intermediate graph is wrong.
  for (const list of timeline.values()) {
    list.forEach((c, i) => ((c as TieChange & { i: number }).i = i));
    list.sort((x, y) => x.seq - y.seq || x.t - y.t || (x as any).i - (y as any).i);
  }
  return { graphs, rewired, timeline, undated };
}

/**
 * The graph as it stood at a given publish.
 *
 * Replayed from the start rather than diffed from the final adjacency, because
 * the final one cannot be walked backwards: `edges.csv` records that a tie was
 * disconnected and not what the graph looked like before it.
 */
function graphAt(changes: TieChange[] | undefined, seq: number): NeighborMap {
  const g: NeighborMap = new Map();
  const link = (x: string, y: string, connect: boolean) => {
    let set = g.get(x);
    if (!set) {
      set = new Set();
      g.set(x, set);
    }
    if (connect) set.add(y);
    else set.delete(y);
  };
  for (const c of changes ?? []) {
    // A change recorded AT this publish counter was made before the publish that
    // carries it — `commit` stamps the counter as it stands and then flushes —
    // so `<=` is what puts a tie change and the delivery it caused on the right
    // sides of each other.
    if (c.seq > seq) break;
    link(c.a, c.b, c.connect);
    link(c.b, c.a, c.connect);
  }
  return g;
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

/**
 * Hops from `source` to everyone reachable, over the graph the edge log gives.
 *
 * Written here rather than imported, and the import constraint is not the only
 * reason. `src/topology/index.ts` has a runtime import so it is barred from this
 * file anyway — but `ball()` is also the function the PUBLISH PATH used to decide
 * what to send, and an audit that asked it what should have been sent would be
 * comparing the server with itself. `verify` learned that the expensive way:
 * with `ball()`'s edge filter broken it still reported PASS, because both sides
 * of the comparison moved together. `src/verify/topologies.ts` carries an
 * independent walk for the same reason; this is the offline one.
 *
 * Plain FIFO BFS over player ids. No depth limit: the caller compares against
 * whatever radius the record itself claims, and a distance is cheaper to compute
 * once than to recompute per radius.
 */
function hopsFrom(graph: NeighborMap, source: string): Map<string, number> {
  const dist = new Map<string, number>([[source, 0]]);
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    const d = dist.get(v)!;
    for (const u of graph.get(v) ?? []) {
      if (dist.has(u)) continue;
      dist.set(u, d + 1);
      queue.push(u);
    }
  }
  return dist;
}

/**
 * Does a `projectFar` payload name a participant?
 *
 * THE OFFLINE HALF OF `validateNoIdentifiers`. The publish path refuses a far
 * view carrying a player id (`src/admin/projection.ts`), because an id is a
 * stable handle that is the same for every viewer, while the `ref` beside it is
 * deliberately not: two participants comparing screens can join on an id and
 * cannot join on a ref. That check runs on the server, against the build that
 * shipped. This one runs on the capture, against the build that ran — which is
 * the only one the evaluation can speak for.
 *
 * It matters because nothing else here looks inside a far payload at all. The
 * loops above check WHO was shown and HOW FAR AWAY the payload said they were;
 * a build that put strangers' attributes in `far[k].view` would leave every one
 * of those counts clean. That failure first becomes possible at radius 2, which
 * is the radius this audit exists to cover.
 *
 * A string-only walk, like the server's: ids are strings, and a number or a
 * boolean cannot be one however it is nested.
 */
function namesAnybody(value: unknown, ids: ReadonlySet<string>): string | undefined {
  if (typeof value === "string") return ids.has(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = namesAnybody(item, ids);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const hit = namesAnybody(item, ids);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * `radius.csv`, parsed: for each game, every change in the order it happened.
 *
 * Kept as events rather than flattened into a final assignment, for the reason
 * the log is kept that way — under mutation "what was this person allowed to
 * see" has no single answer, only an answer per moment.
 */
export type ParsedRadii = Map<string, Array<{ seq: number; player: string; to: string }>>;

/**
 * Read `radius.csv` as `radiusRows` writes it.
 *
 * Local, like `parseEdgesCsv`, and for the same reason: this module may hold no
 * runtime import, and an offline analyst should be able to run it over a file
 * collected months ago with nothing installed.
 */
export function parseRadiiCsv(text: string): ParsedRadii {
  const out: ParsedRadii = new Map();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return out;

  const header = splitCsvLine(lines[0]!);
  const at = (name: string): number => header.indexOf(name);
  const iGame = at("game_id");
  const iSeq = at("seq");
  const iPlayer = at("player");
  const iTo = at("radius_to");
  if (iGame < 0 || iSeq < 0 || iPlayer < 0 || iTo < 0) {
    throw new Error(
      `parseRadiiCsv: expected columns game_id, seq, player, radius_to. Found: ` +
        `${header.join(", ")}`
    );
  }

  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const gameID = f[iGame] ?? "";
    const player = f[iPlayer] ?? "";
    if (!gameID || !player) continue;
    const list = out.get(gameID) ?? [];
    list.push({ seq: Number(f[iSeq] ?? 0), player, to: f[iTo] ?? "" });
    out.set(gameID, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.seq - b.seq);
  return out;
}

/** What the record says this participant was ALLOWED to see at this publish. */
function authorizedAt(
  radii: ParsedRadii | undefined,
  gameID: string,
  player: string,
  seq: number
): number | "whole" | undefined {
  const events = radii?.get(gameID);
  if (!events) return undefined;
  let found: string | undefined;
  // The last change to this participant at or before the publish in question.
  // `seq` and not the clock: two events from one process inside one millisecond
  // cannot be ordered by time, and a radius change is exactly the kind of thing
  // that lands there.
  for (const e of events) {
    if (e.player !== player || e.seq > seq) continue;
    found = e.to;
  }
  if (found === undefined) return undefined;
  if (found === "whole") return "whole";
  const n = Number(found);
  return Number.isFinite(n) ? n : undefined;
}

export function auditViews(input: {
  views: string;
  edges: ParsedEdges;
  /**
   * `radius.csv`, when the study changed anybody's radius during the run.
   *
   * Without it the audit checks each delivery against the radius that delivery
   * itself reports — which catches a payload inconsistent with its own claim and
   * cannot catch a claim nobody authorized. A server that delivered three hops
   * and stamped `radius: 3` on it would self-certify. With the log, the claim is
   * checked against what the study actually set.
   */
  radii?: ParsedRadii;
}): AuditResult {
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
      ties: 0, structureLeaks: 0, beyondStar: 0, farTies: 0, farShown: 0,
      farViews: 0, farLeaks: 0, authorizationChecked: 0,
      structured: 0,
    });
  }

  /**
   * A rewiring game used to be refused here, and is not any more.
   *
   * The refusal was honest about a real limitation — a view checked against the
   * graph that REPLACED the one it was built on reads as a leak — and it was
   * never a limitation of the data. `edges.csv` has carried a timestamp for
   * every row since it existed; what it lacked was a way to order a tie change
   * against a DELIVERY, which a wall clock cannot do when the change and the
   * publish it triggers land in the same millisecond. `seq` closed that, and the
   * timeline is replayed per record below.
   *
   * What survives is the case the counter is missing: a capture written before
   * that column existed can only be replayed by clock, so those games are still
   * checked against the final adjacency and still refused if they rewired —
   * stated on the count of rows that put them there rather than on the game.
   */
  const undatedRewires = [...rewired].filter(
    (gameID) => graphs.has(gameID) && (input.edges.timeline?.get(gameID) ?? []).some((c) => c.seq < 0)
  );
  for (const gameID of undatedRewires) {
    failures.push(
      `REFUSED: game ${gameID} rewired during the session and its edge log carries no ` +
        `publish counter, so a tie change cannot be ordered against a delivery — a view ` +
        `that was correct when it was sent would read as a leak against the graph that ` +
        `replaced it. Re-export with a build that writes the \`seq\` column, or audit a ` +
        `game that did not rewire.`
    );
  }

  for (const r of records) {
    const staticGraph = graphs.get(r.gameID);
    if (!staticGraph) {
      complain(
        `ERROR: a view was delivered in game ${r.gameID}, which has no graph in ` +
          `edges.csv. The views file and the edge export do not describe the same run.`
      );
      continue;
    }
    const session = perSession.get(r.gameID)!;
    /**
     * The graph as it stood when this view was delivered.
     *
     * Replayed only for a game that actually rewired AND carries the counter;
     * everything else keeps the final adjacency it has always used, so a static
     * study pays nothing and every number it produced before is unchanged.
     */
    const changes = input.edges.timeline?.get(r.gameID);
    const replay =
      rewired.has(r.gameID) && changes !== undefined && changes.every((c) => c.seq >= 0);
    const graph = replay ? graphAt(changes, r.seq) : staticGraph;
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
    /**
     * Local index -> player id, across the whole index space.
     *
     * `0` is the viewer, `1..view.length` are the delivered view in order, and
     * anything beyond that is somebody the viewer is NOT connected to. Those
     * carry only a per-viewer name on the wire, so they cannot be resolved from
     * the payload at all — `ViewRecord.far` is the server's own record of who
     * they were, written beside the payload and never delivered, and it is
     * index-aligned with `graph.far` by construction.
     */
    const far = r.far ?? [];
    const localToPlayer: Array<unknown> = [
      r.viewer,
      ...(r.view ?? []).map((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)["id"]
          : undefined
      ),
      ...far.map((f) => (typeof f?.id === "string" ? f.id : undefined)),
    ];

    /**
     * A payload that names distant people, in a capture that did not record who
     * they were, cannot be checked at all — and the checks that WOULD still run
     * (every tie resolving to a view entry) would all pass, because every far
     * index simply fails to resolve and is reported once. Refused rather than
     * half-audited, for the reason this file's header gives: a check that cannot
     * run must not be mistaken for a check that passed.
     */
    const delivered = g.far ?? [];
    if (delivered.length > 0 && far.length !== delivered.length) {
      session.structureLeaks++;
      complain(
        `REFUSED: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) was shown ` +
          `${delivered.length} person(s) they are not connected to, and this capture ` +
          `records ${far.length === 0 ? "none of them" : `${far.length} of them`}. Who ` +
          `was shown to whom cannot be established. Re-capture with a build that writes ` +
          `ViewRecord.far.`
      );
      continue;
    }

    /**
     * How far this participant was allowed to see, as the DELIVERY itself
     * reports it — not as the batch record does.
     *
     * The per-delivery radius is the only one that is right across a restart at
     * a changed setting, which is the case `StructureRow.radius` is denormalized
     * for. `floor` because the fraction decides ties and not people.
     */
    const claimed = typeof g.radius === "number" && Number.isFinite(g.radius) ? g.radius : 1;
    /**
     * The delivery's own claim, against what the study authorized.
     *
     * The payload's `radius` is the server describing itself, which is evidence
     * about consistency and not about permission. Both readings are findings and
     * neither is a pass: either somebody was shown more than the study allowed,
     * or the record of what it allowed is wrong.
     */
    const allowed = authorizedAt(input.radii, r.gameID, r.viewer, r.seq);
    if (allowed !== undefined) session.authorizationChecked++;
    if (allowed !== undefined && allowed !== "whole" && allowed !== claimed) {
      session.structureLeaks++;
      complain(
        `RADIUS MISREPORTED: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) was delivered a ` +
          `structure stamped radius ${claimed} while the record authorizes ${allowed}. ` +
          `Either the delivery was wider than the study allowed, or the record of what ` +
          `it allowed is wrong.`
      );
    }
    const depth = Math.floor(claimed);
    const hops =
      depth > 1 || delivered.length > 0 || allowed === "whole"
        ? hopsFrom(graph, r.viewer)
        : undefined;
    /**
     * A seat authorized `"whole"` is still checked, against a different quantity.
     *
     * `"whole"` authorizes no particular number, so comparing it to `claimed`
     * is meaningless — but the wire never carries `"whole"`. It carries the
     * finite eccentricity the viewer's component actually reached, and that IS
     * checkable from the edge log. Skipping these seats entirely, as this arm
     * did, meant a seat authorized `"whole"` could be delivered any radius at
     * all with no complaint.
     */
    if (allowed === "whole" && hops) {
      let ecc = 0;
      for (const d of hops.values()) if (Number.isFinite(d) && d > ecc) ecc = d;
      if (claimed !== ecc) {
        session.structureLeaks++;
        complain(
          `RADIUS MISREPORTED: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) was authorized ` +
            `the whole of their component and delivered a structure stamped radius ` +
            `${claimed}, while the edge log puts the furthest person they can reach ` +
            `${ecc} hop(s) away.`
        );
      }
    }
    const within = (id: string): boolean => {
      if (id === r.viewer) return true;
      if (!hops) return neighbors.has(id);
      const d = hops.get(id);
      return d !== undefined && d <= depth;
    };

    // Each distant person must really be as far away as the payload said. A hop
    // count is what a study would analyse on — "did seeing somebody two steps
    // away change behaviour" — so a wrong one is a wrong finding rather than a
    // cosmetic slip.
    let population: ReadonlySet<string> | undefined;
    for (const [k, f] of far.entries()) {
      session.farShown++;
      /**
       * What the viewer was told ABOUT this person, as opposed to that they
       * exist and how far away they are.
       *
       * Absent unless the study set `graph.projectFar`, which is why this is
       * counted separately rather than folded into `farShown`: zero far views
       * over a thousand far people is the default configuration behaving
       * correctly, and it must not read as an arm that ran and passed.
       */
      const payload = delivered[k]?.view;
      if (payload !== undefined) {
        session.farViews++;
        population ??= new Set(graph.keys());
        const named = namesAnybody(payload, population);
        if (named !== undefined) {
          session.farLeaks++;
          session.structureLeaks++;
          complain(
            `FAR LEAK: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) was told something ` +
              `about somebody ${String(delivered[k]?.d)} hop(s) away that names participant ` +
              `${named}. A far payload may carry a per-viewer ref and not an id: an id is ` +
              `the same handle for every viewer, so two participants can join on it.`
          );
        }
      }
      const actual = hops?.get(f.id);
      if (actual === undefined || actual !== delivered[k]?.d) {
        session.structureLeaks++;
        complain(
          `STRUCTURE: ${r.viewer} (game ${r.gameID}, seq ${r.seq}) was told somebody was ` +
            `${String(delivered[k]?.d)} hop(s) away and the edge log puts them ` +
            `${actual === undefined ? "out of reach entirely" : `${actual} away`}.`
        );
      } else if (actual > depth) {
        session.structureLeaks++;
        complain(
          `STRUCTURE LEAK: ${r.viewer} was shown somebody ${actual} hops away at radius ` +
            `${claimed} in game ${r.gameID} (seq ${r.seq}).`
        );
      }
    }

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
      if (!within(x) || !within(y)) {
        session.structureLeaks++;
        complain(
          `STRUCTURE LEAK: ${r.viewer} was shown a tie involving somebody outside their ` +
            `radius of ${claimed} in game ${r.gameID} (seq ${r.seq}).`
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
      // THE HALF STEP, offline. At an integer radius a tie between two people who
      // are BOTH at the outer edge is not delivered — it is what the next half
      // step adds. Both ends are visible either way, so every arm above passes
      // it, and without this a study asking for 2 could have been given 2.5 with
      // the record showing nothing wrong.
      if (hops && claimed === depth && depth > 1) {
        const dx = hops.get(x);
        const dy = hops.get(y);
        if (dx !== undefined && dy !== undefined && dx >= depth && dy >= depth) {
          session.structureLeaks++;
          complain(
            `STRUCTURE: ${r.viewer} was shown the tie between two people who are each ` +
              `${depth} hops away, in game ${r.gameID} (seq ${r.seq}). At radius ${claimed} ` +
              `that tie is not delivered — it is what radius ${depth + 0.5} adds.`
          );
          continue;
        }
      }
      if (a !== 0 && b !== 0) session.beyondStar++;
      if (typeof a === "number" && typeof b === "number") {
        const edge = Math.max(a, b);
        if (edge > (r.view ?? []).length) session.farTies++;
      }
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
  const farTies = sessions.reduce((s, x) => s + x.farTies, 0);
  const farShown = sessions.reduce((s, x) => s + x.farShown, 0);
  const farViews = sessions.reduce((s, x) => s + x.farViews, 0);
  const farLeaks = sessions.reduce((s, x) => s + x.farLeaks, 0);
  const authorizationChecked = sessions.reduce((s, x) => s + x.authorizationChecked, 0);
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
  if (structuredRecords > 0 && beyondStar === 0 && farShown === 0) {
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

  /**
   * An arm that did not run says so, per this file's header.
   *
   * Without a radius log every structure was checked only against the radius it
   * stamped on itself, which cannot catch a delivery nobody authorized. That is
   * a weaker audit than the same output with `radius.csv` present, and the two
   * are indistinguishable in the result unless this is said.
   */
  if (structuredRecords > 0 && authorizationChecked === 0) {
    notes.push(
      `no radius log was supplied, so all ${structuredRecords} structure(s) were checked ` +
        `against the radius each delivery reported for itself and none against what the ` +
        `study authorized. Export radius.csv to check the claim rather than its consistency`
    );
  } else if (authorizationChecked > 0) {
    notes.push(
      `${authorizationChecked} of ${structuredRecords} structure(s) were checked against ` +
        `an authorized radius`
    );
  }

  // The far payload arm, on its own denominator. Zero far views over any number
  // of far people is `projectFar` being unset, which is the default and not a
  // result; it must not read as an arm that ran clean.
  if (farShown > 0) {
    notes.push(
      farViews === 0
        ? `${farShown} distant person(s) were shown and none carried a projected payload: ` +
            `at this setting a distant person is a shape and a name, so the far-disclosure ` +
            `arm is vacuous rather than passed`
        : `${farViews} of ${farShown} distant person(s) carried a projected payload; ` +
            `${farLeaks} named a participant`
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
    farTies,
    farShown,
    farViews,
    farLeaks,
    authorizationChecked,
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
    // Only where they mean something. Below radius 2 nobody is shown anybody
    // outside their own neighbors, so these are structurally zero and a
    // permanently empty line teaches a reader to skip lines.
    if (r.farShown > 0 || r.farTies > 0) {
      lines.push(
        `  people beyond neighbors : ${r.farShown}  (non-vacuity above radius 1.5)`,
        `  ties reaching past them : ${r.farTies}`,
        `  far payloads naming one : ${r.farLeaks}/${r.farViews} projected  (must be 0)`
      );
    }
    lines.push(
      `  radius authorized       : ${r.authorizationChecked}/${r.structuredRecords} checked`
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
    farTies: 0,
    farShown: 0,
    farViews: 0,
    farLeaks: 0,
    authorizationChecked: 0,
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
    merged.farTies += r.farTies;
    merged.farShown += r.farShown;
    merged.farViews += r.farViews;
    merged.farLeaks += r.farLeaks;
    merged.authorizationChecked += r.authorizationChecked;
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
