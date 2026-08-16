/**
 * Rand, Arbesman & Christakis (2011) — the design, as pure functions.
 *
 *   Rand, D. G., Arbesman, S. & Christakis, N. A. (2011). Dynamic social
 *   networks promote cooperation in experiments with humans. PNAS 108(48),
 *   19193-19198. https://doi.org/10.1073/pnas.1108243108
 *
 * A RECONSTRUCTION of that design from the paper. Not a replication: no data has
 * been collected here and nothing has been compared to theirs. See the README.
 *
 * WHY THIS FILE HAS NO EMPIRICA IMPORT, AND WHY THAT MATTERS MORE THAN IT LOOKS.
 *
 * Everything with a rule in it lives here — payoffs, who is offered a rewiring
 * decision, whether the game continues — so that all of it is testable in
 * milliseconds by `test/unit/rand2011.test.ts`, with no server and no browser.
 * `callbacks.js` is left with wiring.
 *
 * That split is the one defence available against the problem that an example is
 * a TEMPLATE: it gets copied, and the tests do not travel with the copy. The
 * least-bad answer is to make the part that gets copied small, pure, and correct
 * — a payoff rule you can read in one screen and check by hand is a payoff rule
 * that survives being pasted into someone else's repo. See
 * `docs/M5-ADOPTION.md` §2.
 *
 * Every number below is quoted from the paper, with the sentence it came from.
 */

export const COOPERATE = "C";
export const DEFECT = "D";

/**
 * "cooperation entails paying 50 units for each neighbor and results in each
 * neighbor gaining 100 units; defection involves paying no costs and generating
 * no benefits."
 *
 * Note the cost is per NEIGHBOUR, not per round, which is what makes degree part
 * of the incentive: a well-connected cooperator pays more. The paper is explicit
 * that this is deliberate — "we do not normalize payoffs across subjects with
 * different numbers of connections, creating an incentive to increase the number
 * of cooperative partners".
 */
export const COST_PER_NEIGHBOUR = 50;
export const BENEFIT_PER_NEIGHBOUR = 100;

/** "the probability that another round will occur is 0.8". */
export const CONTINUATION_PROBABILITY = 0.8;

/**
 * "At the beginning of the experiment, the social network is initialized with
 * 20% of possible links being formed at random."
 */
export const INITIAL_DENSITY = 0.2;

/**
 * The four conditions, with the rewiring rate each implies.
 *
 * `k` is "a percentage k of subject pairs are picked at random to have their
 * connections updated" — a fraction of ALL PAIRS, not of all existing ties. At
 * n = 20 that is 190 pairs, so k = 0.3 means about 57 decisions per round spread
 * over 20 people. Getting this wrong by using ties instead of pairs would make
 * the fluid condition far less fluid than the paper's, while still running.
 */
export const CONDITIONS = {
  /** "the social network is regenerated randomly after every round". */
  random: { k: 0, regenerate: true },
  /** "the network is static and remains in its initial configuration". */
  fixed: { k: 0, regenerate: false },
  /** "the viscous condition, the network updates relatively infrequently, with k = 10%". */
  viscous: { k: 0.1, regenerate: false },
  /** "the fluid condition, the network updates relatively frequently, with k = 30%". */
  fluid: { k: 0.3, regenerate: false },
};

/**
 * One player's payoff for one cooperation round.
 *
 * `neighbourActions` is what each of this player's CURRENT neighbours chose. A
 * player with no neighbours scores 0, which is correct rather than a special
 * case: they pay nothing and receive nothing.
 *
 * Pure and total, so `test/unit/rand2011.test.ts` checks it against the paper's
 * arithmetic by hand.
 *
 * Called in exactly ONE place — `callbacks.js`, at the end of each cooperation
 * round — and the resulting number is sent to each participant with `tell()`
 * rather than recomputed in the browser. That is deliberate: a second
 * implementation of a payoff rule on the client is how the number on screen and
 * the number in the data silently come to disagree, and it is also what the paper
 * describes ("subjects are informed ... about their own payoff").
 */
export function roundPayoff(ownAction, neighbourActions) {
  const cooperators = neighbourActions.filter((a) => a === COOPERATE).length;
  const benefit = BENEFIT_PER_NEIGHBOUR * cooperators;
  const cost = ownAction === COOPERATE ? COST_PER_NEIGHBOUR * neighbourActions.length : 0;
  return benefit - cost;
}

/**
 * Whether another round follows this one.
 *
 * Takes the seeded rng, so the realised session length is reproducible from the
 * seed this package records on the batch scope. The paper's sessions ran a
 * stochastic number of rounds and reported eleven; a fixed round count would
 * have been a deviation, and it would have been an avoidable one.
 */
export function anotherRound(rng) {
  return rng() < CONTINUATION_PROBABILITY;
}

/** Every unordered pair of n players, as index pairs. */
export function allPairs(n) {
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  return pairs;
}

/**
 * Fisher-Yates, on a copy, driven by the supplied rng.
 *
 * Local rather than imported from the package: this file must stay free of
 * imports so it can be read and copied on its own, and it is six lines.
 */
function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Which rewiring decisions happen this round, and who makes each one.
 *
 * "In each round, a percentage k of subject pairs are picked at random to have
 * their connections updated. If a connection already exists between the pair of
 * subjects, one of the two (picked at random) is offered the chance to break the
 * connection. If no connection already exists, one of the two (picked at random)
 * is offered the chance to form a new connection."
 *
 * Returns one entry per selected pair: `{ decider, other, exists }`, all indices.
 * A subject may appear as the decider in several — "a particular subject may be
 * part of multiple selected subject pairs and thus have the chance to update
 * multiple links in a given round" — so callers must handle a LIST of offers per
 * person, not one. Delivering only the last would quietly reduce the rewiring
 * rate, which is the independent variable.
 *
 * `hasEdge(i, j)` is passed in rather than an edge list, so this function does
 * not need to know how the graph is stored.
 */
export function rewiringOffers(n, k, hasEdge, rng) {
  if (k <= 0) return [];
  const pairs = allPairs(n);
  // Round rather than floor: at n = 20, k = 0.1 gives 19 exactly, and flooring a
  // value like 18.9 would bias every condition slightly downward for the life of
  // the study.
  const count = Math.min(pairs.length, Math.round(k * pairs.length));
  return shuffled(pairs, rng)
    .slice(0, count)
    .map(([i, j]) => {
      // "one of the two (picked at random)". Not "the lower index": that would
      // make position in the topology predict who decides, and the seed
      // deliberately permutes who sits where.
      const deciderFirst = rng() < 0.5;
      return {
        decider: deciderFirst ? i : j,
        other: deciderFirst ? j : i,
        exists: hasEdge(i, j),
      };
    });
}

/**
 * Apply one round of rewiring answers to an edge list.
 *
 * `answers` maps `"i-j"` (decider-other, in offer order) to a boolean: for an
 * existing tie, `true` means BREAK it; for a missing tie, `true` means FORM it.
 * An offer with no answer is left alone — "if both approved, a new tie was
 * formed" is about mutual consent in a different protocol; here the paper gives
 * the decision to one subject, so silence is simply no change.
 *
 * Returns the new edge list plus, per player, how many ties others broke with
 * them and how many others formed with them — which is exactly the feedback the
 * paper gives: "At the end of every rewiring round, each subject is told how many
 * others chose to break links with her and the number of others who formed new
 * links with her."
 *
 * Pure: takes and returns plain arrays, so a test can drive a whole session's
 * worth of rewiring with no server involved.
 */
export function applyRewiring(n, edges, offers, answers) {
  const key = (i, j) => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const present = new Set(edges.map(([i, j]) => key(i, j)));
  const brokenWith = new Array(n).fill(0);
  const formedWith = new Array(n).fill(0);

  for (const offer of offers) {
    const answer = answers[`${offer.decider}-${offer.other}`];
    if (answer !== true) continue;
    const k = key(offer.decider, offer.other);
    if (offer.exists) {
      if (!present.delete(k)) continue;
      // Counted for the OTHER party only: the decider knows what they did, and
      // telling them "1 person broke a link with you" about their own action is
      // how a feedback screen becomes misleading.
      brokenWith[offer.other] += 1;
    } else {
      if (present.has(k)) continue;
      present.add(k);
      formedWith[offer.other] += 1;
    }
  }

  const nextEdges = [...present].map((k) => k.split("-").map(Number));
  return { edges: nextEdges, brokenWith, formedWith };
}

/**
 * A random graph at the paper's initial density, as index pairs.
 *
 * Used for game start and, in the `random` condition, for every round's
 * regeneration. Deliberately NOT resampled until connected: the paper says the
 * network is initialised with 20% of possible links at random, and rejection
 * sampling for connectivity would change the distribution being sampled from.
 * The package makes the same choice for the same reason (`isConnected` is offered
 * rather than enforced).
 */
export function randomGraph(n, density, rng) {
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (rng() < density) edges.push([i, j]);
  }
  return edges;
}

/**
 * The round-level table, one row per participant per round.
 *
 * Long format, and joinable on `game_id` to the package's own `edges.csv` — so
 * "did this person's neighbourhood change after they defected" is a merge rather
 * than a conversation with whoever ran the study. That is the whole point: an
 * analyst should not have to ask how the data is laid out.
 *
 * `submitted` is carried explicitly because a non-responder is scored as a
 * defector (see `callbacks.js`), and that is OUR assumption rather than the
 * paper's. Recording it as a column lets an analyst drop those rows instead of
 * inheriting a decision they did not make; folding it into `action` would hide it.
 *
 * Pure over plain data, so it also runs offline against a stored log.
 */
export function roundRows(gameID, condition, rounds) {
  const rows = [];
  for (const { round, rows: entries } of rounds) {
    for (const e of entries) {
      rows.push({
        game_id: gameID,
        condition,
        round,
        player_id: e.playerID,
        topology_index: e.topologyIndex,
        action: e.action,
        submitted: e.submitted ? 1 : 0,
        degree: e.degree,
        payoff: e.payoff,
        wealth: e.wealth,
      });
    }
  }
  return rows;
}

/**
 * Every analysis file for one finished game, as `{ filename: contents }`.
 *
 * Pure, so the CONTENT of the export is asserted by `test/unit/rand2011.test.ts`
 * rather than by hoping. That split matters more than it looks: the export runs
 * in `onGameEnded`, which only fires when a game ends naturally, and the e2e
 * tests tear their servers down before that — so an export written inline in the
 * callback would have been exercised only by accident, on the ~20% of runs where
 * the continuation draw happened to stop. Discovered by looking in `data/` after
 * a green run and finding no CSVs in it.
 *
 * What is left in the callback is `mkdirSync` and a `writeFileSync` loop.
 *
 * `toCSV` is passed in rather than imported, so this file keeps its property of
 * importing nothing.
 */
export function exportFiles(gameID, condition, rounds, edgeCsv, snapshotCsv, toCSV) {
  return {
    "rounds.csv": toCSV(roundRows(gameID, condition, rounds)),
    "edges.csv": edgeCsv,
    "network_snapshots.csv": snapshotCsv,
  };
}

/**
 * Rebuild `exportFiles`' arguments from the append-only run log.
 *
 * THE POINT: the CSVs are written when a game ENDS, and a study that is killed,
 * crashes, or is stopped mid-session never gets there — so without this, the one
 * case where partial data matters most is the case that produces none. And a
 * crash mid-study is not hypothetical: a full server restart never puts
 * participants back in their game (`ISSUES.md` U2), so ending early is the normal
 * shape of "something went wrong".
 *
 * So `callbacks.js` appends one NDJSON record per event as it happens, and this
 * turns that log back into exactly what the game-end path passes to
 * `exportFiles`. Two entry points, one set of row builders — and
 * `test/unit/rand2011.test.ts` asserts the two produce byte-identical CSVs, so
 * "recovered" data cannot quietly differ from data that arrived the normal way.
 *
 * Pure, and tolerant of a truncated final line: a hard kill can cut the log
 * mid-record, and the caller drops what will not parse.
 */
export function fromLog(records) {
  let condition = "";
  const roundsByNumber = new Map();
  let history = [];

  for (const r of records) {
    if (r.type === "start") condition = r.condition ?? "";
    // Later records win: a round scored twice (a replayed listener) should not
    // appear twice in the table.
    else if (r.type === "round") roundsByNumber.set(r.round, r.rows);
    // Appended incrementally, so concatenation is the reconstruction.
    else if (r.type === "history") history = history.concat(r.events ?? []);
  }

  return {
    condition,
    rounds: [...roundsByNumber.keys()]
      .sort((a, b) => a - b)
      .map((round) => ({ round, rows: roundsByNumber.get(round) })),
    history,
  };
}
