/**
 * Rebuild the analysis CSVs from a session that ended early.
 *
 *   node recover.mjs data/run.ndjson              # every session in the log
 *   node recover.mjs data/run.ndjson <gameID>     # just one
 *
 * WHY THIS MATTERS MORE HERE than in the Rand port: this experiment's dependent
 * variable IS the change log — when each colour was chosen, and what the global
 * conflict count was afterwards. Written only at game end, a session that ran four
 * of its five minutes and then died produced nothing at all, and that is precisely
 * the session you would want to look at.
 *
 * `callbacks.js` appends `run.ndjson` as each colour is chosen, through the
 * package's `net.log()`; this turns it into the same tables a clean finish
 * produces, byte-identically — asserted by `test/unit/shirado2017.test.ts`.
 *
 * ONE LOG, MANY SESSIONS. Every record carries the `gameID` the package stamped on
 * it, so a batch that ran several sessions is one file and is separated here.
 *
 * ONE THING TO READ CAREFULLY IN THE OUTPUT. A recovered session that never solved
 * gets `solved=0` and an **empty** `t_solution_ms`, not 300000 and not the elapsed
 * time. The paper censors at 300 s; a session cut short at four minutes is not even
 * a censored observation at 300 s, and writing any number there would turn "we
 * stopped watching" into a measurement. `t_ms` on the last row of `changes.csv` is
 * the only honest statement about how long it ran.
 *
 * NOTE ON A WARNING YOU WILL SEE. Node prints
 * `MODULE_TYPELESS_PACKAGE_JSON ... Reparsing as ES module` for `design.js`. It is
 * harmless — Node is observing that the Empirica scaffold's `server/package.json`
 * declares no `"type"`, so it guesses, correctly. Adding `"type": "module"` there
 * would silence it and break the scaffold's own build, which bundles `src/index.js`
 * to CommonJS with esbuild. Left as-is deliberately.
 */
import fs from "node:fs";
import path from "node:path";
import { edgeRows, parseNdjson, toCSV } from "empirica-networks/export";
import { exportFiles, fromLog } from "./server/src/design.js";

const [logPath, onlyGame] = process.argv.slice(2);
if (!logPath) {
  console.error("usage: node recover.mjs data/run.ndjson [gameID]");
  process.exit(1);
}
if (!fs.existsSync(logPath)) {
  console.error(`${logPath}: no such run log — nothing to recover`);
  process.exit(1);
}

// Reading and parsing are separate: `parseNdjson` comes from the package and is
// pure over text, which is what keeps `empirica-networks/export` loadable from
// plain Node with no build step (PLATFORM-NOTES §3a).
const { records, dropped } = parseNdjson(fs.readFileSync(logPath, "utf8"));

/** gameID -> its records, in the order they were written. */
const byGame = new Map();
for (const r of records) {
  // A record with no gameID predates the package's stamp or came from somewhere
  // else. Skipped rather than lumped into an arbitrary session.
  if (typeof r.gameID !== "string") continue;
  if (onlyGame && r.gameID !== onlyGame) continue;
  const list = byGame.get(r.gameID) ?? [];
  list.push(r);
  byGame.set(r.gameID, list);
}

if (byGame.size === 0) {
  console.error(
    `${logPath}: no records${onlyGame ? ` for game ${onlyGame}` : ""} — nothing to recover`
  );
  process.exit(1);
}

// Beside the log, one directory per session, which is where a clean finish writes
// them too.
const root = path.dirname(path.resolve(logPath));

for (const [gameID, gameRecords] of byGame) {
  const { changes, history, session } = fromLog(gameRecords);
  // `edges.csv` through the package's own `edgeRows`, over the edge events the
  // `graph` record carried — the same function the clean game-end path calls, over
  // the same events, so the file is byte-identical rather than merely similar.
  //
  // This was left EMPTY until M6 Tier 4, on the argument that the graph is durable
  // on the batch scope. It is — but durable in Tajriba's store, which this script
  // deliberately does not read (one text file, no upstream format to track). So the
  // events go in the log as well, and the network is recoverable from it alone.
  const files = exportFiles(gameID, session, changes, toCSV(edgeRows(gameID, history)), toCSV);
  const dir = path.join(root, gameID);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }

  console.log(
    `${dir}: solved=${session.solved ? session.tSolutionMs + "ms" : "NO (t_solution_ms left empty)"} ` +
      `changes=${changes.length} n=${session.n} edges=${session.edges}` +
      // An empty `edges.csv` is no longer expected, so it is reported as the
      // problem it now is rather than described as a design decision. A log written
      // before M6 Tier 4 has no `events` field, and that is what this will say.
      (files["edges.csv"] === ""
        ? " — WARNING: edges.csv is EMPTY, so this log carries no edge events " +
          "(written before M6 Tier 4, or the graph was not ready at stage start)"
        : ` edgeRows=${files["edges.csv"].trim().split("\n").length - 1}`)
  );
}

// Once for the file, not once per session: a truncated tail belongs to the log,
// and there is no way to tell whose record was cut in half.
if (dropped > 0) {
  console.error(
    `${logPath}: DROPPED ${dropped} unparseable line(s) — the log was truncated, ` +
      `which is what a hard kill leaves behind`
  );
}
