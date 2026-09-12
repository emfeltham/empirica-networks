/**
 * Rebuild the analysis CSVs from a run that ended early.
 *
 *   node recover.mjs data/run.ndjson              # every game in the log
 *   node recover.mjs data/run.ndjson <gameID>     # just one
 *
 * WHY THIS EXISTS. The CSVs are written when a game ENDS, in `onGameEnded`. A
 * study that is killed, crashes, or is stopped mid-session never reaches that —
 * and since upstream cannot resume one, a crash mid-study is the *normal* shape of "something
 * went wrong", because a restarted server cannot put participants back in their
 * game anyway. So the session is over whether you like it or not, and the rounds
 * that did complete are real data.
 *
 * `callbacks.js` appends `run.ndjson` as the run happens, through the package's
 * `net.log()`; this turns it into the same tables a clean finish produces. Not
 * approximately the same: `test/unit/rand2011.test.ts` asserts the two paths
 * produce byte-identical CSVs, because "recovered" data that quietly differs from
 * normal data is worse than no recovery at all.
 *
 * ONE LOG, MANY GAMES. Every record carries the `gameID` the package stamped on
 * it, so a batch that ran several games concurrently is one file and is separated
 * here. Before M6 this script took a per-game directory, which meant a game whose
 * directory had never been created was a game with no recoverable data.
 *
 * A hard kill can cut the final line mid-record. `parseNdjson` drops what will not
 * parse and counts it, so a truncated tail is reported rather than silently
 * costing a round.
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
import { edgeRows, parseNdjson, snapshotRows, toCSV } from "empirica-networks/export";
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
  // else. Skipped and counted rather than lumped into an arbitrary game.
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

// Beside the log, one directory per game, which is where a clean finish writes
// them too.
const root = path.dirname(path.resolve(logPath));

for (const [gameID, gameRecords] of byGame) {
  const { condition, rounds, history } = fromLog(gameRecords);
  const files = exportFiles(
    gameID,
    condition,
    rounds,
    toCSV(edgeRows(gameID, history)),
    toCSV(snapshotRows(gameID, history)),
    toCSV
  );
  const dir = path.join(root, gameID);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }

  // Reported, not inferred. A recovered session is incomplete by definition, and
  // an analyst needs to know how incomplete before deciding whether to use it.
  console.log(
    `${dir}: condition=${condition || "(unknown)"} rounds=${rounds.length} ` +
      `edgeEvents=${history.length}`
  );
}

// Once for the file, not once per game: a truncated tail belongs to the log, and
// there is no way to tell which game's record was cut in half.
if (dropped > 0) {
  console.error(
    `${logPath}: DROPPED ${dropped} unparseable line(s) — the log was truncated, ` +
      `which is what a hard kill leaves behind`
  );
}
