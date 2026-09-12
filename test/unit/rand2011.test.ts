/**
 * The Rand 2011 reconstruction's design rules, checked against the paper.
 *
 * These assert the EXPERIMENT, not the package. A ported experiment's behavior
 * is a claim, and the way this repo treats a claim is to assert it — a payoff
 * rule that is merely described in a comment is a payoff rule nobody has
 * checked. Every expected number below is worked out from the sentence quoted in
 * `examples/rand2011/server/src/design.js`, by hand, not by running the code and
 * writing down what came out.
 *
 * Unit tier rather than e2e because `design.js` imports nothing: no Empirica, no
 * server, no browser. That is the whole reason it is a separate file from
 * `callbacks.js`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeRng } from "../../src/admin/seed.js";
import {
  allPairs,
  anotherRound,
  applyRewiring,
  BENEFIT_PER_NEIGHBOR,
  exportFiles,
  CONDITIONS,
  CONTINUATION_PROBABILITY,
  COOPERATE,
  COST_PER_NEIGHBOR,
  DEFECT,
  fromLog,
  INITIAL_DENSITY,
  randomGraph,
  rewiringOffers,
  roundPayoff,
  roundRows,
  // @ts-expect-error - plain JS example module, deliberately untyped
} from "../../examples/rand2011/server/src/design.js";
import { toCSV } from "../../src/admin/export.js";

/** One rewiring offer, as `rewiringOffers` returns it. */
interface Offer {
  decider: number;
  other: number;
  exists: boolean;
}

test("the paper's constants are what the paper says", () => {
  assert.equal(COST_PER_NEIGHBOR, 50, "pay 50 units for each neighbor");
  assert.equal(BENEFIT_PER_NEIGHBOR, 100, "each neighbor gains 100 units");
  assert.equal(CONTINUATION_PROBABILITY, 0.8, "80% chance of another round");
  assert.equal(INITIAL_DENSITY, 0.2, "initialized with 20% of possible links");
  assert.equal(CONDITIONS.viscous.k, 0.1, "viscous: k = 10%");
  assert.equal(CONDITIONS.fluid.k, 0.3, "fluid: k = 30%");
  assert.equal(CONDITIONS.fixed.k, 0);
  assert.equal(CONDITIONS.random.regenerate, true);
  assert.equal(CONDITIONS.fixed.regenerate, false);
});

test("roundPayoff: worked by hand from the paper's rule", () => {
  // Three neighbors, two of whom cooperated, and I cooperated.
  //   benefit = 2 x 100 = 200 ; cost = 3 x 50 = 150 ; net = 50
  assert.equal(roundPayoff(COOPERATE, [COOPERATE, COOPERATE, DEFECT]), 50);

  // Same neighbors, but I defected: I keep the benefit and pay nothing.
  //   benefit = 200 ; cost = 0 ; net = 200
  assert.equal(roundPayoff(DEFECT, [COOPERATE, COOPERATE, DEFECT]), 200);

  // The defection incentive, stated as the arithmetic: switching to D is worth
  // exactly the cost you avoid, whatever your neighbors do.
  const nbrs = [COOPERATE, DEFECT, DEFECT, COOPERATE];
  assert.equal(
    roundPayoff(DEFECT, nbrs) - roundPayoff(COOPERATE, nbrs),
    COST_PER_NEIGHBOR * nbrs.length
  );

  // Cooperating with only defectors is a pure loss; the sign matters, because a
  // payoff rule that cannot go negative is a different game.
  assert.equal(roundPayoff(COOPERATE, [DEFECT, DEFECT]), -100);

  // Degree is part of the incentive: the paper does NOT normalize payoffs, so a
  // well-connected cooperator surrounded by cooperators earns more...
  assert.ok(
    roundPayoff(COOPERATE, Array(8).fill(COOPERATE)) >
      roundPayoff(COOPERATE, Array(2).fill(COOPERATE))
  );
  // ...and one surrounded by defectors loses more.
  assert.ok(
    roundPayoff(COOPERATE, Array(8).fill(DEFECT)) <
      roundPayoff(COOPERATE, Array(2).fill(DEFECT))
  );

  // An isolated node: pays nothing, receives nothing. A legitimate state in this
  // design, since defectors get abandoned.
  assert.equal(roundPayoff(COOPERATE, []), 0);
  assert.equal(roundPayoff(DEFECT, []), 0);
});

test("allPairs: every unordered pair, once", () => {
  assert.deepEqual(allPairs(3), [
    [0, 1],
    [0, 2],
    [1, 2],
  ]);
  // n(n-1)/2. At the paper's mean session size this is the denominator k
  // multiplies, so getting it wrong changes the rewiring rate directly.
  assert.equal(allPairs(20).length, 190);
});

test("rewiringOffers: k is a fraction of ALL PAIRS, not of existing ties", () => {
  // This is the mistake that would run perfectly and produce a much less fluid
  // network than the paper's. At n = 20 a sparse graph has ~38 ties against 190
  // pairs, so reading k as a fraction of ties would cut the rate five-fold.
  const rng = makeRng(1234);
  const sparse = new Set(["0-1", "1-2", "2-3"]);
  const hasEdge = (i: number, j: number) =>
    sparse.has(i < j ? `${i}-${j}` : `${j}-${i}`);

  const fluid = rewiringOffers(20, CONDITIONS.fluid.k, hasEdge, rng);
  assert.equal(fluid.length, 57, "0.3 x 190 = 57");

  const viscous = rewiringOffers(20, CONDITIONS.viscous.k, hasEdge, makeRng(1234));
  assert.equal(viscous.length, 19, "0.1 x 190 = 19");

  assert.deepEqual(rewiringOffers(20, 0, hasEdge, rng), [], "fixed and random: no offers");
});

test("rewiringOffers: each offer is a real pair, and `exists` matches the graph", () => {
  const rng = makeRng(99);
  const ties = new Set(["0-1", "3-4", "5-9"]);
  const hasEdge = (i: number, j: number) => ties.has(i < j ? `${i}-${j}` : `${j}-${i}`);

  const offers = rewiringOffers(12, 0.5, hasEdge, rng) as Offer[];
  for (const o of offers) {
    assert.notEqual(o.decider, o.other, "nobody is offered a tie to themselves");
    assert.ok(o.decider >= 0 && o.decider < 12);
    assert.ok(o.other >= 0 && o.other < 12);
    assert.equal(
      o.exists,
      hasEdge(o.decider, o.other),
      "an offer that misreports whether the tie exists asks the wrong question"
    );
  }

  // No pair is offered twice in one round: the paper picks a set of pairs.
  const keys = offers.map((o: Offer) =>
    o.decider < o.other ? `${o.decider}-${o.other}` : `${o.other}-${o.decider}`
  );
  assert.equal(new Set(keys).size, keys.length, "each selected pair appears once");
});

test("rewiringOffers: one subject can be the decider more than once per round", () => {
  // "a particular subject may be part of multiple selected subject pairs and
  // thus have the chance to update multiple links in a given round". The server
  // must therefore deliver a LIST of offers per person; delivering only the last
  // would silently reduce the rewiring rate, which is the independent variable.
  const offers = rewiringOffers(10, 0.6, () => false, makeRng(7)) as Offer[];
  const perDecider = new Map<number, number>();
  for (const o of offers) perDecider.set(o.decider, (perDecider.get(o.decider) ?? 0) + 1);
  assert.ok(
    [...perDecider.values()].some((c) => c > 1),
    "at k = 0.6 over 10 players somebody decides twice"
  );
});

test("rewiringOffers: who decides is not predicted by topology index", () => {
  // "one of the two (picked at random)". Always giving it to the lower index
  // would make position predict who acts, and the seed deliberately permutes who
  // sits where — so the bias would be invisible in the data and real in the
  // behavior.
  const offers = rewiringOffers(30, 0.4, () => false, makeRng(2024)) as Offer[];
  const lower = offers.filter((o) => o.decider < o.other).length;
  assert.ok(lower > 0 && lower < offers.length, "both directions occur");
  // Loose bounds: this asserts "not deterministic", not a distributional claim.
  assert.ok(
    Math.abs(lower / offers.length - 0.5) < 0.2,
    `deciders split ${lower}/${offers.length}, which looks biased`
  );
});

test("rewiringOffers is reproducible from the seed", () => {
  // The package records the seed on the batch scope; if the rewiring draw were
  // not a function of it, the recorded seed would not describe the run.
  const a = rewiringOffers(20, 0.3, () => false, makeRng(555));
  const b = rewiringOffers(20, 0.3, () => false, makeRng(555));
  assert.deepEqual(a, b);
  const c = rewiringOffers(20, 0.3, () => false, makeRng(556));
  assert.notDeepEqual(a, c, "a different seed gives a different draw");
});

test("applyRewiring: true breaks an existing tie and forms a missing one", () => {
  const edges = [
    [0, 1],
    [2, 3],
  ];
  const offers = [
    { decider: 0, other: 1, exists: true }, // break it
    { decider: 4, other: 5, exists: false }, // form it
  ];
  const out = applyRewiring(6, edges, offers, { "0-1": true, "4-5": true });

  const keys = out.edges.map(([i, j]: number[]) => `${i}-${j}`).sort();
  assert.deepEqual(keys, ["2-3", "4-5"], "one broken, one formed, one untouched");
});

test("applyRewiring: an unanswered or declined offer changes nothing", () => {
  // Silence must not be read as consent. The paper gives the decision to one
  // subject, so a missing answer is simply no change — and a version that
  // defaulted to breaking would dissolve the network on every timeout.
  const edges = [[0, 1]];
  const offers = [
    { decider: 0, other: 1, exists: true },
    { decider: 2, other: 3, exists: false },
  ];

  const unanswered = applyRewiring(4, edges, offers, {});
  assert.deepEqual(unanswered.edges.map((e: number[]) => e.join("-")), ["0-1"]);

  const declined = applyRewiring(4, edges, offers, { "0-1": false, "2-3": false });
  assert.deepEqual(declined.edges.map((e: number[]) => e.join("-")), ["0-1"]);
});

test("applyRewiring: feedback counts what OTHERS did to you, not what you did", () => {
  // "each subject is told how many others chose to break links with her and the
  // number of others who formed new links with her." A version that also counted
  // the decider's own action would tell them a stranger had acted on them when
  // in fact they had acted themselves.
  const offers = [
    { decider: 0, other: 1, exists: true }, // 0 breaks with 1
    { decider: 2, other: 1, exists: true }, // 2 breaks with 1
    { decider: 3, other: 1, exists: false }, // 3 forms with 1
  ];
  const out = applyRewiring(
    4,
    [
      [0, 1],
      [1, 2],
    ],
    offers,
    { "0-1": true, "2-1": true, "3-1": true }
  );

  assert.equal(out.brokenWith[1], 2, "two others broke links with player 1");
  assert.equal(out.formedWith[1], 1, "one other formed a link with player 1");
  assert.equal(out.brokenWith[0], 0, "player 0 acted; nobody acted on them");
  assert.equal(out.formedWith[3], 0, "player 3 acted; nobody acted on them");
});

test("applyRewiring: no duplicate edges, and edges stay canonically ordered", () => {
  // A duplicate tie would double a cooperator's cost and be invisible in a
  // rendered neighbor list.
  const offers = [{ decider: 5, other: 2, exists: false }];
  const out = applyRewiring(6, [[2, 5]], offers, { "5-2": true });
  assert.equal(out.edges.length, 1, "forming an existing tie is a no-op");
  for (const [i, j] of out.edges) assert.ok(i < j, "canonical order survives");
});

test("randomGraph: density is right on average, and it is not repaired", () => {
  const rng = makeRng(31337);
  const n = 40;
  const possible = (n * (n - 1)) / 2;
  let total = 0;
  const runs = 40;
  for (let r = 0; r < runs; r++) total += randomGraph(n, INITIAL_DENSITY, rng).length;
  const meanDensity = total / runs / possible;
  assert.ok(
    Math.abs(meanDensity - INITIAL_DENSITY) < 0.02,
    `mean density ${meanDensity.toFixed(3)} should be near ${INITIAL_DENSITY}`
  );

  // At the paper's own scale a 20% graph can strand somebody, and that is left
  // alone on purpose: resampling until connected would change the distribution
  // being sampled from. This asserts the package's stance is actually taken here
  // rather than just described.
  let sawIsolated = false;
  for (let r = 0; r < 200 && !sawIsolated; r++) {
    const g = randomGraph(8, INITIAL_DENSITY, rng);
    const degree = new Array(8).fill(0);
    for (const [i, j] of g) {
      degree[i]++;
      degree[j]++;
    }
    if (degree.includes(0)) sawIsolated = true;
  }
  assert.ok(sawIsolated, "isolated nodes occur and are not silently repaired");
});

test("anotherRound: stochastic, seeded, and near the paper's 0.8", () => {
  const rng = makeRng(4242);
  let continued = 0;
  const trials = 4000;
  for (let i = 0; i < trials; i++) if (anotherRound(rng)) continued++;
  const rate = continued / trials;
  assert.ok(
    Math.abs(rate - CONTINUATION_PROBABILITY) < 0.02,
    `continuation rate ${rate.toFixed(3)} should be near ${CONTINUATION_PROBABILITY}`
  );

  // Reproducible from the seed, so the realized session length is recoverable
  // from the seed this package stores. One rng drawn repeatedly, not a fresh one
  // per draw — a fresh rng per call would return the same value every time and
  // this assertion would hold for the wrong reason.
  const drawSeries = (seed: number) => {
    const r = makeRng(seed);
    return Array.from({ length: 20 }, () => anotherRound(r));
  };
  assert.deepEqual(drawSeries(11), drawSeries(11), "same seed, same session length");
  const series = drawSeries(11);
  assert.ok(
    new Set(series).size === 2,
    "the series must contain both outcomes, or it is not testing a draw"
  );
});

test("roundRows: long format, joinable on game_id, and it keeps `submitted`", () => {
  // The Done-when for this milestone includes "exports data an analyst can use
  // without asking anyone how", so the shape is asserted rather than described.
  const rows = roundRows("game-1", "fluid", [
    {
      round: 1,
      rows: [
        {
          playerID: "p1",
          topologyIndex: 0,
          action: COOPERATE,
          submitted: true,
          degree: 2,
          payoff: 100,
          wealth: 100,
        },
        {
          playerID: "p2",
          topologyIndex: 1,
          action: DEFECT,
          submitted: false,
          degree: 1,
          payoff: 100,
          wealth: 100,
        },
      ],
    },
  ]);

  assert.equal(rows.length, 2, "one row per participant per round");
  assert.equal(rows[0].game_id, "game-1", "joins onto edges.csv, which keys on game_id");
  assert.equal(rows[0].condition, "fluid", "the arm travels with every row");
  assert.equal(rows[0].round, 1);

  // The assumption that must stay visible: a non-responder is scored as a
  // defector, so an analyst has to be able to find them and drop them.
  assert.equal(rows[0].submitted, 1);
  assert.equal(rows[1].submitted, 0);
  assert.equal(rows[1].action, DEFECT);

  // Asserted against the real emitted header, quoting included, because that is
  // what an analyst's `read_csv` actually sees.
  const csv = toCSV(rows as Record<string, string | number>[]);
  const [header] = csv.split("\n");
  assert.deepEqual(
    header!.split(",").map((c) => c.replace(/^"|"$/g, "")),
    [
      "game_id",
      "condition",
      "round",
      "player_id",
      "topology_index",
      "action",
      "submitted",
      "degree",
      "payoff",
      "wealth",
    ],
    "column set and order are part of the contract with an analyst"
  );
});

test("roundRows: no rounds gives an empty table, not a broken one", () => {
  assert.deepEqual(roundRows("game-1", "fixed", []), []);
});

test("exportFiles: every analysis file, named and populated", () => {
  // The export runs in `onGameEnded`, which only fires when a game ends
  // NATURALLY — and the e2e tests tear their servers down first. So this path was
  // exercised only on the ~20% of runs where the continuation draw happened to
  // stop, which is not coverage. Found by looking in `data/` after a green run
  // and finding no CSVs; the content moved into a pure function so it could be
  // asserted here instead.
  const files = exportFiles(
    "game-1",
    "fluid",
    [
      {
        round: 1,
        rows: [
          {
            playerID: "p1",
            topologyIndex: 0,
            action: COOPERATE,
            submitted: true,
            degree: 2,
            payoff: 100,
            wealth: 100,
          },
        ],
      },
    ],
    "EDGES_CSV_PLACEHOLDER",
    "SNAPSHOTS_CSV_PLACEHOLDER",
    toCSV
  );

  assert.deepEqual(
    Object.keys(files).sort(),
    ["edges.csv", "network_snapshots.csv", "rounds.csv"],
    "the filenames are the contract with an analyst, and with this example's README"
  );

  // The package's own exports are passed through unchanged, not re-derived.
  assert.equal(files["edges.csv"], "EDGES_CSV_PLACEHOLDER");
  assert.equal(files["network_snapshots.csv"], "SNAPSHOTS_CSV_PLACEHOLDER");

  // And the experiment's own file has a header and a row, not just a header —
  // an empty table with correct columns is what a broken export looks like.
  const lines = files["rounds.csv"]!.trim().split("\n");
  assert.equal(lines.length, 2, `expected header + 1 row, got ${lines.length}`);
  assert.match(lines[0]!, /game_id/);
  assert.match(lines[1]!, /game-1/);
  assert.match(lines[1]!, /fluid/);
});

test("fromLog: recovering a killed run produces the SAME table as a clean finish", () => {
  // The claim this file exists to make load-bearing: the CSVs are written at game
  // end, so a study that is killed or crashes never reaches them — and after U2 a
  // crash mid-study is the normal shape of "something went wrong". The run log
  // closes that, but only if what it recovers is the same data. Two paths, one set
  // of row builders, asserted byte-for-byte rather than by inspection.
  const rows = [
    {
      playerID: "p1",
      topologyIndex: 0,
      action: COOPERATE,
      submitted: true,
      degree: 2,
      payoff: 100,
      wealth: 100,
    },
    {
      playerID: "p2",
      topologyIndex: 1,
      action: DEFECT,
      submitted: true,
      degree: 1,
      payoff: 100,
      wealth: 100,
    },
  ];

  // What the log looks like after two rounds of a run that then died.
  const log = [
    { type: "start", condition: "fluid", at: 1 },
    { type: "history", from: 0, events: [{ op: "start", added: [], removed: [], size: 1, at: 1 }] },
    { type: "round", round: 1, rows },
    { type: "history", from: 1, events: [{ op: "add", a: "p1", b: "p2", added: [["p1", "p2"]], removed: [], size: 2, at: 2 }] },
    { type: "round", round: 2, rows },
  ];

  const recovered = fromLog(log);
  assert.equal(recovered.condition, "fluid");
  assert.equal(recovered.rounds.length, 2, "both scored rounds survive");
  assert.deepEqual(
    recovered.rounds.map((r: { round: number }) => r.round),
    [1, 2],
    "in order, whatever order the log happened to be in"
  );
  assert.equal(recovered.history.length, 2, "the edge events concatenate back together");

  // The assertion that matters: the recovered table IS the live one.
  const live = exportFiles("g1", "fluid", [
    { round: 1, rows },
    { round: 2, rows },
  ], "E", "S", toCSV);
  const fromCrash = exportFiles("g1", recovered.condition, recovered.rounds, "E", "S", toCSV);
  assert.equal(
    fromCrash["rounds.csv"],
    live["rounds.csv"],
    "a recovered rounds.csv must be byte-identical to one written at game end"
  );
});

test("fromLog: out-of-order and duplicate records, and a truncated tail", () => {
  const rows = [
    { playerID: "p1", topologyIndex: 0, action: COOPERATE, submitted: true, degree: 1, payoff: 0, wealth: 0 },
  ];
  // Rounds arriving out of order still sort; a round logged twice appears once.
  // A replayed listener can produce the latter, and a duplicated row would
  // double-count a participant in the analysis.
  const recovered = fromLog([
    { type: "round", round: 2, rows },
    { type: "start", condition: "viscous" },
    { type: "round", round: 1, rows },
    { type: "round", round: 2, rows },
  ]);
  assert.deepEqual(recovered.rounds.map((r: { round: number }) => r.round), [1, 2]);
  assert.equal(recovered.condition, "viscous");

  // A hard kill can cut the final line mid-record. The caller drops what will not
  // parse, so `fromLog` never sees it — this pins the behavior of the parse step
  // that a recovery tool has to perform.
  const text = '{"type":"start","condition":"fluid"}\n{"type":"round","round":1,"ro';
  const parsed = text
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  assert.equal(parsed.length, 1, "the truncated record is dropped, the good one kept");
  assert.equal(fromLog(parsed).condition, "fluid");
});
