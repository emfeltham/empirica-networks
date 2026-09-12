/**
 * Rand, Arbesman & Christakis (2011) — server wiring.
 *
 * A RECONSTRUCTION of the design in:
 *
 *   Rand, D. G., Arbesman, S. & Christakis, N. A. (2011). Dynamic social
 *   networks promote cooperation in experiments with humans. PNAS 108(48),
 *   19193-19198. https://doi.org/10.1073/pnas.1108243108
 *
 * NOT a replication. No data has been collected with this code and nothing has
 * been compared to the paper's results. Deviations are listed in the README.
 *
 * Every rule lives in `./design.js`, which imports nothing and is unit-tested by
 * `test/unit/rand2011.test.ts`. This file is wiring, and its only decisions are
 * WHERE each value goes — which is where a reconstruction silently stops being
 * one.
 */
import fs from "node:fs";
import path from "node:path";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import { edgeRows, network, snapshotRows, toCSV, withNetwork } from "empirica-networks/admin";
import {
  applyRewiring,
  anotherRound,
  CONDITIONS,
  DEFECT,
  INITIAL_DENSITY,
  randomGraph,
  rewiringOffers,
  exportFiles,
  roundPayoff,
} from "./design.js";

export const Empirica = new ClassicListenersCollector();

/** Stage durations, seconds. Generous: this is a demonstration, not a session. */
const DECIDE_SECONDS = 120;
const REWIRE_SECONDS = 120;

/**
 * Hard stop on rounds.
 *
 * The paper's continuation probability is 0.8, which has no upper bound — one
 * session in a thousand runs past 30 rounds. A demonstration that can in
 * principle never end is a demonstration nobody can run, so this caps it and the
 * cap is recorded in the data (`rounds.csv` carries the round number) rather than
 * being an invisible property of the code.
 */
const MAX_ROUNDS = 15;

/** Where CSVs land at game end. Relative to wherever the server was started. */
const OUT_DIR = process.env["RAND2011_OUT"] ?? "data";

/**
 * Append only the edge events not yet logged, so the log stays incremental.
 *
 * The log itself is the package's — `log: { file }` below, written through
 * `net.log()`. This example used to hand-roll it: `mkdirSync` plus
 * `appendFileSync` plus a try/catch, ninety lines of it across two examples,
 * inside the copied surface a consumer cannot patch. That is what
 * moved into the package. What stays here is the
 * *incremental* part, which is this design's business: the edge history is a
 * growing array, so appending all of it every round would make the log quadratic
 * and `fromLog`'s concatenation wrong.
 */
const loggedHistory = new Map();
function logHistory(gameID, history) {
  const already = loggedHistory.get(gameID) ?? 0;
  if (history.length <= already) return;
  net.log(gameID, { type: "history", from: already, events: history.slice(already) });
  loggedHistory.set(gameID, history.length);
}

const conditionOf = (game) => {
  const name = game.get("treatment")?.condition ?? "fluid";
  const condition = CONDITIONS[name];
  if (!condition) {
    // Loud. A typo in treatments.yaml would otherwise silently fall through to
    // some default arm, and the dataset would record a condition it did not run.
    throw new Error(
      `rand2011: unknown condition "${name}". Expected one of ` +
        `${Object.keys(CONDITIONS).join(", ")} — check .empirica/treatments.yaml.`
    );
  }
  return { name, ...condition };
};

/**
 * A per-game rng for the rewiring and continuation draws.
 *
 * Deliberately NOT `Math.random`. Both draws are part of the realised design, so
 * they belong to the same reproducible record as the topology — a session whose
 * rewiring sequence came from an unseeded generator is reconstructible in
 * structure and not in sequence, and for this design the sequence is the
 * independent variable.
 *
 * Seeded from the game id, the same input `withNetwork` uses for its own default
 * seed, but offset so the two draws are not the same stream. Held in process
 * memory only, which is honest rather than lazy: a server restart ends the game
 * regardless (docs/PLATFORM-NOTES.md §4e, U2), so there is nothing to survive.
 */
const rngs = new Map();
function rngFor(game) {
  let rng = rngs.get(game.id);
  if (!rng) {
    let a = 0x9e3779b9;
    for (const ch of String(game.id)) {
      a = Math.imul(a ^ ch.charCodeAt(0), 2654435761) >>> 0;
    }
    rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rngs.set(game.id, rng);
  }
  return rng;
}

function addRound(game, number) {
  const round = game.addRound({ name: `Round ${number}`, number });
  round.addStage({ name: "decide", duration: DECIDE_SECONDS });
  // The rewiring stage exists in EVERY condition, so round and stage indices
  // mean the same thing in every arm of one dataset. In `fixed` and `random` it
  // has nothing to offer and the client says so.
  round.addStage({ name: "rewire", duration: REWIRE_SECONDS });
}

Empirica.onGameStart(({ game }) => {
  // Recorded on the batch scope, beside the seed and edge list the package puts
  // there. On the batch and not the game because a participant who knows the
  // condition knows the rewiring rate, which is information about the structure
  // the design withholds (§4b, §4c).
  game.batch?.set(`condition:${game.id}`, conditionOf(game).name);
  // `at` is stamped by `net.log` on every record, so it is not passed here.
  net.log(game, { type: "start", condition: conditionOf(game).name });
  addRound(game, 1);
});

/**
 * The whole network configuration.
 *
 * WHERE EACH VALUE LIVES IS THE ENTIRE VALIDITY OF THIS RECONSTRUCTION.
 *
 *   action  — PRIVATE. Written by the participant to their own channel with
 *             `useNetworkState()`, and it reaches anyone else only through
 *             `project()` below — so only their neighbours. Had this been
 *             `player.set("action", …)` it would be broadcast to every
 *             participant, the experiment would run identically, the screens
 *             would look right, and the network would have stopped being the
 *             manipulation.
 *
 *   wealth  — SERVER-SIDE ONLY, on the batch scope. See `scoreRound` below.
 */
export const net = withNetwork(Empirica, {
  // "the social network is initialized with 20% of possible links being formed
  // at random". Seeded, so the realised graph is recoverable from the seed the
  // package records on the batch scope.
  topology: ({ playerCount, rng }) => randomGraph(playerCount, INITIAL_DENSITY, rng),

  /**
   * What one participant learns about one neighbour.
   *
   * "At the end of each turn, subjects are informed about their neighbors'
   * choices and about their own payoff." And, for the next round's decision,
   * "subjects are reminded of their number of neighbors and the neighbors'
   * previous decisions" — which is what a persisted `action` shows: a
   * neighbour's most recent choice, standing until they change it.
   *
   * THE FIELD THAT IS NOT HERE MATTERS AS MUCH AS THE ONE THAT IS. Adding
   * `wealth: ctx.stateOf(neighbour).get("wealth")` would not be a bug in the
   * abstract — it would silently convert this into the *visible* condition of a
   * DIFFERENT published experiment (Nishi, Shirado, Rand & Christakis 2015,
   * Nature 526:426-429), whose whole finding is that this one field changes
   * behaviour and raises inequality. `test/e2e/rand2011.test.ts` asserts its
   * absence at the wire for exactly that reason.
   */
  project: (neighbour, viewer, ctx) => ({
    id: neighbour.id,
    action: ctx.stateOf(neighbour).get("action"),
  }),

  /** Republishes: a neighbour's choice is what the projection above carries. */
  watch: ["action"],

  /**
   * Read by the server, never projected. `onStageEnded("rewire")` reads each
   * decider's answers with `net.stateOf()`; no neighbour ever sees them.
   *
   * A key omitted here is not a quiet loss of a feature — `stateOf()` throws.
   * That is the fix for a real bug in this file: `rewireAnswers` was undeclared,
   * every answer read back as `undefined`, `applyRewiring` received an empty
   * answer set, and the network NEVER CHANGED in the fluid condition, whose
   * entire point is that it does. Nothing threw, every screen looked right
   * (`ISSUES.md` O11).
   */
  read: ["rewireAnswers"],

  /**
   * NO ENVELOPE OVERRIDE, and the absence is the interesting part.
   *
   * The paper does not cap degree — "we do not limit the number of connections a
   * subject can have" — reports a mean of 8.2 in the fluid condition, and its
   * Fig. 1B shows a tail to roughly 20 at a mean session size of 19.6. So a
   * faithful reconstruction needs degree up to n-1.
   *
   * This file used to raise `maxDegree` to 64 with a paragraph of justification,
   * and the package took that paragraph as the bug report it was: the default of
   * 16 came from a sweep of SPARSE graphs at n up to 100, which is a measurement
   * about n rather than about degree, and it was being enforced as though it were
   * about degree. The missing cells were then measured — `npm run bench --
   * dense` — and a COMPLETE graph at n=20 turned out to be FASTER than a degree-8
   * ring at n=50. The default is now `n - 1` at n <= 50, so at this size it admits
   * any graph and this override is unnecessary.
   *
   * A study at n = 100 would still be capped at 16 and would still have to
   * override — which is a fact about what has been measured, not about this
   * design.
   */

  /**
   * Capture what each participant was actually shown.
   *
   * On rather than off, for the reason the package documents: `project()` here
   * reads `stateOf()`, so the delivered view is NOT reconstructible afterwards
   * from the edge log plus an attribute export. Those give what someone could
   * have known; this records what they were told, and when.
   */
  views: { file: path.join(OUT_DIR, "views.ndjson") },

  /**
   * The run log, written as the study happens.
   *
   * WHY, in one line: the CSVs are written in `onGameEnded`, and a study that is
   * killed, crashes or is stopped never gets there. Measured — a green run of
   * `test/e2e/rand2011.test.ts` left `views.ndjson` and not one CSV — and after
   * U2 a restart cannot resume a game anyway, so ending early is the *normal*
   * shape of something going wrong. `recover.mjs` turns this file back into the
   * same CSVs, and `test/unit/rand2011.test.ts` pins the two byte-for-byte.
   *
   * One file for the whole study rather than one per game: each record carries
   * its `gameID`, so a batch of concurrent games interleaves safely and one
   * `parseNdjson` call recovers all of them.
   *
   * `batch` is left at the package default of 1 — every record written as it
   * arrives, no buffer. A few dozen records per round makes the syscalls
   * irrelevant, and a log that exists to survive a kill should not be holding its
   * newest rows in memory when the kill arrives.
   */
  log: { file: path.join(OUT_DIR, "run.ndjson") },
});

/**
 * ONE `onStageEnded` for BOTH stages, dispatching on the stage name.
 *
 * This is not a style choice, and the reason is a measured upstream trap:
 * **`onStageEnded` can only be registered once.** `ClassicListenersCollector`
 * wraps these helpers in a `unique` guard that records `ran-on-<attrId>` on the
 * SCOPE, shared by every listener for that (kind, key) — so the first callback to
 * run sets the marker and every later one returns without running.
 *
 * This file was originally written with two `onStageEnded` handlers, one per
 * stage. The second never ran once: the rewiring answers were never applied, the
 * network never changed in the fluid condition, no feedback was ever delivered,
 * and NOTHING ERRORED. Caught by `test/e2e/rand2011.test.ts`; recorded as
 * `docs/PLATFORM-NOTES.md` §18 and `ISSUES.md` U8.
 *
 * The same applies to `onGameStart`, `onStageStart`, `onRoundStart`,
 * `onRoundEnded` and `onGameEnded`. One registration each; dispatch inside.
 */
Empirica.onStageEnded(({ stage }) => {
  const name = stage.get("name");
  if (name === "decide") scoreRound(stage);
  else if (name === "rewire") applyRewireRound(stage);
});

/**
 * Score the cooperation round.
 *
 * Reads every participant's PRIVATE choice through `net.stateOf()`, the
 * server-side read path for private state outside `project()`. `inspect()` is
 * still used for the seating plan — who is at which index — but not for values:
 * `stateOf()` throws for an undeclared key, an ended game or an unprovisioned
 * participant, so the `undefined` below means one thing only, and the DEFECT
 * assumption is applied to a real non-response rather than to a plumbing fault.
 */
function scoreRound(stage) {
  const game = stage.currentGame;
  const snapshot = net.inspect(game.id);
  if (!snapshot) return;
  const net_ = network(game);
  const batch = game.batch;
  if (!batch) {
    // Refuse rather than score into nothing. The batch scope is where the record
    // of account lives, and a round scored with nowhere to put it is a round
    // that happened and was not recorded.
    throw new Error(`rand2011: game ${game.id} has no batch, so the round cannot be recorded`);
  }

  const roundNumber = Number(stage.round?.get("number") ?? 0);
  // Raw first, defaulted second. Keeping "what they wrote" separate from "what
  // we scored" is what lets `submitted` below be honest: collapsing them in one
  // step would make a non-response and a defection the same value, and the
  // column that lets an analyst tell them apart would be derived from the
  // already-collapsed one.
  const chose = new Map(
    snapshot.nodes.map((node) => [node.playerID, net.stateOf(game.id, node.playerID, "action")])
  );
  // DEFECT for a participant who never chose. The paper does not say what
  // happens to a non-responder — it ran incentivised on Mechanical Turk — so
  // this is OUR assumption, stated here and in the README rather than left in
  // the arithmetic. `submitted` is recorded per round so an analyst can drop
  // these rows instead of inheriting the assumption.
  const actionOf = new Map([...chose].map(([id, action]) => [id, action ?? DEFECT]));

  const rows = snapshot.nodes.map((node) => {
    const neighbours = net_.neighbors(node.playerID);
    const payoff = roundPayoff(
      actionOf.get(node.playerID),
      neighbours.map((id) => actionOf.get(id) ?? DEFECT)
    );

    /**
     * WHERE THE AUTHORITATIVE WEALTH RECORD GOES, AND WHY IT IS NOT THE PLAYER.
     *
     * `player.set("wealth", …)` is the obvious line to write, and it would
     * broadcast every participant's running wealth to every other participant —
     * making this the *visible* condition of Nishi 2015 while still looking
     * exactly like Rand 2011 on screen. So the record of account lives on the
     * BATCH scope, the one durable scope measured NOT to be delivered to
     * participants (§4c), which is where the package keeps the realised topology
     * for the same reason.
     *
     * Participants still learn their own score — "subjects are informed ...
     * about their own payoff" — but they are TOLD it (see the `tell` below)
     * rather than computing it in the browser. A second implementation of the
     * payoff rule on the client is how the number on screen and the number in
     * the data silently come to disagree.
     *
     * A participant's own tally is never read back for the record, because a
     * participant can write any attribute anywhere (U1) and a self-reported
     * payoff is untrusted input.
     */
    const wealthKey = `wealth:${game.id}:${node.playerID}`;
    const wealth = Number(batch.get(wealthKey) ?? 0) + payoff;
    // One key per player, not one map for the game: a shared map would be a
    // read-modify-write against a value the server also echoes back, which is
    // how two writes in quick succession lose one of them silently.
    batch.set(wealthKey, wealth);

    // "At the end of each turn, subjects are informed ... about their own
    // payoff." Privately, because a payoff reveals how many of your neighbours
    // cooperated and how many you have — and on the player scope that would be
    // every participant's wealth, broadcast, which is Nishi 2015's manipulation
    // rather than this one.
    net_.tell(node.playerID, "score", { round: roundNumber, payoff, wealth });

    return {
      playerID: node.playerID,
      topologyIndex: node.index,
      action: actionOf.get(node.playerID),
      submitted: chose.get(node.playerID) !== undefined,
      degree: neighbours.length,
      payoff,
      wealth,
    };
  });

  batch.set(`round:${game.id}:${roundNumber}`, rows);
  // On disk immediately, not only on the batch scope: the batch attribute is
  // durable but reading it back needs the Tajriba store, and "your data is in
  // there somewhere" is the ask-someone-how this milestone is supposed to remove.
  net.log(game, { type: "round", round: roundNumber, rows });
  logHistory(game.id, net_.history());
}

/**
 * The rewiring round is starting: draw the offers and deliver them.
 *
 * `onStageStart`, not a timer. Writes only count inside a callback
 * (docs/PLATFORM-NOTES.md §15) — the same code driven from `setTimeout` would
 * update this process's own memory correctly and reach nobody, with no error.
 */
Empirica.onStageStart(({ stage }) => {
  if (stage.get("name") !== "rewire") return;
  const game = stage.currentGame;
  const condition = conditionOf(game);
  const snapshot = net.inspect(game.id);
  if (!snapshot) return;
  const net_ = network(game);
  const order = snapshot.order;
  const rng = rngFor(game);

  // "the social network is regenerated randomly after every round, creating a
  // well-mixed population."
  if (condition.regenerate) {
    const fresh = randomGraph(order.length, INITIAL_DENSITY, rng);
    net_.rewire(fresh.map(([i, j]) => [order[i], order[j]]));
    return;
  }
  if (condition.k <= 0) return; // fixed: the network never changes

  const offers = rewiringOffers(
    order.length,
    condition.k,
    (i, j) => net_.hasEdge(order[i], order[j]),
    rng
  );

  // Stored so the stage-end handler applies exactly the offers that were made,
  // rather than redrawing them and applying answers to different questions. On
  // the BATCH scope: the offer set is who-was-asked-about-whom, which is partial
  // information about the seating plan, and the game scope reaches everyone.
  game.batch?.set(`offers:${game.id}:${stage.id}`, offers);

  const lastActionOf = new Map(
    snapshot.nodes.map((n) => [n.playerID, net.stateOf(game.id, n.playerID, "action") ?? null])
  );

  // One list per decider: a subject can be offered several decisions in the same
  // round ("a particular subject may be part of multiple selected subject pairs"),
  // and delivering only the last would silently reduce k.
  const byDecider = new Map();
  for (const o of offers) {
    if (!byDecider.has(o.decider)) byDecider.set(o.decider, []);
    byDecider.get(o.decider).push(o);
  }

  for (const [i, playerID] of order.entries()) {
    const list = byDecider.get(i) ?? [];
    /**
     * THE REASON `tell()` EXISTS.
     *
     * "before choosing to break or form a connection, the deciding subject is
     * informed of the other's action in the preceding round" — and for a FORM
     * offer the other party is, by definition, not a neighbour. `project()` runs
     * over current neighbours only, so it structurally cannot carry this, and
     * every alternative route is a broadcast: the player and game scopes both
     * reach every participant, and provisionally adding the tie would tell the
     * other party they had been named.
     *
     * Note what is NOT sent: the other's degree, and anything about the graph.
     * "We do not inform subjects about the structure of the network or how many
     * of their neighbors are connected to the player they are currently
     * evaluating." Adding `degree` here would be a one-word change that hands
     * subjects structural information the design withholds.
     *
     * Everyone is told, including people with no offers — an empty list clears
     * last round's, and a participant whose stale offers were never cleared
     * would answer a question nobody asked.
     */
    net_.tell(
      playerID,
      "offers",
      list.map((o) => ({
        with: order[o.other],
        exists: o.exists,
        theirLastAction: lastActionOf.get(order[o.other]) ?? null,
      }))
    );
  }
});

/** Apply the rewiring answers, feed back privately, and decide whether to continue. */
function applyRewireRound(stage) {
  const game = stage.currentGame;
  const snapshot = net.inspect(game.id);
  if (!snapshot) return;
  const net_ = network(game);
  const order = snapshot.order;
  const indexOf = new Map(order.map((id, i) => [id, i]));
  const offers = game.batch?.get(`offers:${game.id}:${stage.id}`) ?? [];

  // Each decider's answers, from their own private state. Untrusted input in
  // principle (U1) — but the worst a participant can do is answer their own
  // offer, which is precisely what they were asked to do. An answer naming a
  // pair nobody was offered is dropped by `applyRewiring`, which only looks at
  // the offers it was given.
  const answers = {};
  for (const node of snapshot.nodes) {
    const own = net.stateOf(game.id, node.playerID, "rewireAnswers") ?? {};
    for (const [otherID, value] of Object.entries(own)) {
      const other = indexOf.get(otherID);
      if (other === undefined) continue;
      answers[`${node.index}-${other}`] = value === true;
    }
  }

  const current = net_.edges().map(([a, b]) => [indexOf.get(a), indexOf.get(b)]);
  const result = applyRewiring(order.length, current, offers, answers);
  net_.rewire(result.edges.map(([i, j]) => [order[i], order[j]]));
  logHistory(game.id, net_.history());

  const roundNumber = Number(stage.round?.get("number") ?? 0);
  for (const [i, playerID] of order.entries()) {
    // "At the end of every rewiring round, each subject is told how many others
    // chose to break links with her and the number of others who formed new
    // links with her." Private per participant, so `tell()` again: a count of
    // who acted on you is about other people, and on the player scope it would
    // publish the rewiring pattern to everyone.
    net_.tell(playerID, "rewireFeedback", {
      broken: result.brokenWith[i],
      formed: result.formedWith[i],
      round: roundNumber,
    });
    // Clear the offers, so a stale list cannot be answered next round.
    net_.tell(playerID, "offers", []);
  }

  // "the probability that another round will occur is 0.8". Drawn from the
  // seeded rng, so the realised session length is part of the reproducible
  // record rather than an unrecoverable accident.
  if (roundNumber < MAX_ROUNDS && anotherRound(rngFor(game))) {
    addRound(game, roundNumber + 1);
  }
}

/**
 * Write the analysis files.
 *
 * At game end rather than offline, because everything needed is in memory here
 * and the alternative — telling a researcher to write their own extractor
 * against the Tajriba store — is the "ask someone how" this milestone is
 * supposed to remove. `edgeRows`/`snapshotRows` are the package's; `roundRows`
 * is this experiment's, and both are pure functions over plain data, so the same
 * code runs offline over a stored log months later.
 *
 * Note the ORDER: read the history BEFORE the game is released. `withNetwork`
 * drops its per-game state when a game ends, and `onGameEnded` runs while it is
 * still there.
 */
Empirica.onGameEnded(({ game }) => {
  const batch = game.batch;
  if (!batch) return;
  const history = network(game).history();
  const rounds = [];
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const rows = batch.get(`round:${game.id}:${r}`);
    if (rows) rounds.push({ round: r, rows });
  }

  // Content is built by a pure function so it can be asserted without a server
  // (`test/unit/rand2011.test.ts`); what is left here is the filesystem.
  const files = exportFiles(
    game.id,
    conditionOf(game).name,
    rounds,
    toCSV(edgeRows(game.id, history)),
    toCSV(snapshotRows(game.id, history)),
    toCSV
  );

  const dir = path.join(OUT_DIR, game.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }

  loggedHistory.delete(game.id);
  // eslint-disable-next-line no-console
  console.log(`rand2011: wrote ${dir}/{${Object.keys(files).join(",")}}`);
});
