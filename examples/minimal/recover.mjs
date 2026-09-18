/**
 * Rebuild the structure tables from a captured run.
 *
 *   node recover.mjs data/views.ndjson              # every game in the file
 *   node recover.mjs data/views.ndjson <gameID>     # just one
 *
 * WHY THIS ONE IS DIFFERENT FROM THE OTHER TWO. `rand2011` and `shirado2017`
 * recover from `run.ndjson` — the events their own listeners wrote — because
 * their analysis tables are about the game. This one recovers from
 * `views.ndjson`, because what is worth recovering here is what each
 * participant was SHOWN, and at `NBHD_RADIUS=1.5` that includes the ties among
 * their neighbors and where every node was drawn.
 *
 * The positions are the reason capture matters rather than being a convenience.
 * They are warm-started, so they follow the session's history rather than its
 * final graph: unlike the edge list, they are not a function of anything else
 * stored, and a run whose views were not captured has lost the screens its
 * participants actually saw, permanently.
 *
 * At the default radius this writes nothing and says so. That is not a failure
 * — no structure is delivered at radius 1, so there is none to recover — and it
 * is the sentence that distinguishes "the run had no structure" from "this
 * script did not find the file".
 *
 * A hard kill can cut the final line mid-record. `parseNdjson` drops what will
 * not parse and counts it, so a truncated tail is reported rather than silently
 * costing a delivery.
 */
import fs from "node:fs";
import path from "node:path";
import { farRows, parseNdjson, positionRows, structureRows, toCSV } from "empirica-networks/export";

const [viewsPath, onlyGame] = process.argv.slice(2);
if (!viewsPath) {
  console.error("usage: node recover.mjs data/views.ndjson [gameID]");
  process.exit(1);
}
if (!fs.existsSync(viewsPath)) {
  console.error(
    `no such file: ${viewsPath}\n` +
      `Views are captured only when MINIMAL_OUT is set:\n` +
      `    MINIMAL_OUT=data NBHD_RADIUS=1.5 empirica`
  );
  process.exit(1);
}

const { records, dropped } = parseNdjson(fs.readFileSync(viewsPath, "utf8"));
if (dropped > 0) {
  console.warn(`${dropped} line(s) dropped as unparseable — the usual cause is a hard kill`);
}

const byGame = new Map();
for (const r of records) {
  if (!r?.gameID) continue;
  if (onlyGame && r.gameID !== onlyGame) continue;
  const list = byGame.get(r.gameID) ?? [];
  list.push(r);
  byGame.set(r.gameID, list);
}

if (byGame.size === 0) {
  console.error(onlyGame ? `no records for game ${onlyGame}` : "no records in this file");
  process.exit(1);
}

const root = path.dirname(path.resolve(viewsPath));
let wroteAny = false;

for (const [gameID, gameRecords] of byGame) {
  const ties = structureRows(gameRecords);
  const nodes = positionRows(gameRecords);
  const distant = farRows(gameRecords);

  if (ties.length === 0 && nodes.length === 0) {
    console.log(
      `${gameID}: no structure in ${gameRecords.length} record(s) — this game ran at radius 1, ` +
        `where none is delivered`
    );
    continue;
  }

  const dir = path.join(root, gameID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "structure.csv"), toCSV(ties));
  fs.writeFileSync(path.join(dir, "positions.csv"), toCSV(nodes));
  // Only above radius 1.5, where a participant can see somebody they are not
  // connected to. Written only when there is something in it: an empty table is
  // a question a reader has to answer, and "this study had no such people" is
  // better said by its absence than by a header with no rows.
  if (distant.length > 0) {
    fs.writeFileSync(path.join(dir, "far.csv"), toCSV(distant));
  }
  wroteAny = true;

  // Counted off the HOPS rather than off `a_index !== 0 && b_index !== 0`, which
  // was the right question only at 1.5. Above that most ties touch neither the
  // viewer nor another neighbor, so the old predicate answered "nearly all of
  // them" and said nothing.
  //
  // Three categories that SUM to the total, which the first version of this did
  // not: it reported "among neighbors" and "reaching further" and silently left
  // out every tie incident to the viewer — on a ring of 4 at radius 2 that was
  // half of them, and the line read 16 ties, 0 + 8. A summary whose parts do not
  // add up invites the reader to trust the total and ignore the split.
  const toYou = ties.filter((t) => t.a_hop === 0 || t.b_hop === 0).length;
  const amongNeighbors = ties.filter((t) => t.a_hop === 1 && t.b_hop === 1).length;
  const reachingOut = ties.filter((t) => t.a_hop > 1 || t.b_hop > 1).length;
  console.log(
    `${gameID}: ${ties.length} tie row(s) — ${toYou} to the viewer, ` +
      `${amongNeighbors} among their neighbors, ${reachingOut} reaching further — ` +
      `${nodes.length} position row(s)` +
      (distant.length > 0 ? `, ${distant.length} distant person row(s)` : ``) +
      ` -> ${dir}`
  );
}

if (!wroteAny) {
  console.log(
    "Nothing written. Run the study with NBHD_RADIUS=1.5 (or 2) to deliver structure worth recovering."
  );
}
