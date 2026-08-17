/**
 * Shirado & Christakis (2017) — server wiring.
 *
 * A RECONSTRUCTION of the design in:
 *
 *   Shirado, H. & Christakis, N. A. (2017). Locally noisy autonomous agents
 *   improve global human coordination in network experiments. Nature 545,
 *   370-374. https://doi.org/10.1038/nature22332
 *
 * NOT a replication: the design was rebuilt from the paper, no data has been
 * collected with it, and nothing has been compared to the authors' results. What
 * IS here, since M7, is both arms — the 30 control sessions AND the agent
 * conditions (3 agents x 3 noise levels x 3 placements) that are the paper's
 * actual contribution. The agents run as a separate headless process, `../bots.mjs`,
 * on `empirica-networks/bots`; this file is the half that places them and records
 * which nodes they were. See the README, and `ISSUES.md` O10 for why it took a new
 * entry point rather than a config flag.
 *
 * Every rule lives in `./design.js`, which imports nothing and is unit-tested by
 * `test/unit/shirado2017.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import { edgeRows, network, toCSV, topology, withNetwork } from "empirica-networks/admin";
import {
  ATTACHMENT,
  BOT_COUNT,
  TIME_LIMIT_SECONDS,
  conflictCount,
  exportFiles,
  isSolved,
  placeBots,
} from "./design.js";

export const Empirica = new ClassicListenersCollector();

/** Where CSVs land at game end, relative to wherever the server was started. */
const OUT_DIR = process.env["SHIRADO2017_OUT"] ?? "data";

/**
 * The agents' participant keys, shared with `../bots.mjs` through the environment.
 *
 *   SHIRADO2017_BOT_KEYS=1755000000001,1755000000002,1755000000003
 *
 * A SHARED LIST rather than a recognisable prefix, and that is forced rather than
 * fastidious. Every participant in a game receives every other participant's
 * `participantIdentifier` — the raw `?participantKey=` — because Classic writes it
 * on the player scope and links everyone to every player node (`ISSUES.md` U10,
 * measured in `test/e2e/bots.test.ts`). So a key like `bot-1` is readable from any
 * participant's browser, and in THIS design that is not a metadata leak: subjects
 * are not told which of their neighbours are software, so a recognisable key
 * discloses the manipulation itself.
 *
 * Hence: the server recognises agents by holding the list, not by reading a
 * pattern, and `botIdentifiers()` generates keys shaped like the ones Empirica's
 * own client produces. In a deployed study, use keys drawn from the same space as
 * your human recruitment keys — see `docs/BOTS.md`.
 */
function botKeys() {
  return new Set(
    (process.env["SHIRADO2017_BOT_KEYS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Is this player one of the agents? Answerable only by holding the list.
 *
 * Reads the environment on each call rather than at module load. Twenty calls per
 * game start is nothing, and it buys the property that matters: the list can be
 * set after this module is imported, which is what lets `test/e2e/shirado2017.test.ts`
 * run the agent arm against this file UNMODIFIED — the whole point of that test.
 */
const isBotPlayer = (player) => botKeys().has(player?.get("participantIdentifier"));

/**
 * The condition, read off the treatment.
 *
 * The treatment is the single source of truth for the arm a session is in. The
 * agents do not read it — they are told their noise level through their own
 * private channel (`net.tell` at stage start), so the runner cannot be started
 * against a condition the server is not running. Two processes each reading their
 * own copy of the config is exactly how a study ends up with 10% agents recorded
 * as 30%.
 */
function conditionOf(game) {
  const treatment = game.get("treatment") ?? {};
  return {
    bots: Number(treatment["botCount"] ?? 0),
    placement: String(treatment["botPlacement"] ?? "random"),
    noise: Number(treatment["botNoise"] ?? 0),
  };
}

/** Per-game agent seating, decided in `topology` and needed again at export. */
const botSeating = new Map();

/**
 * Live session state, in this process only.
 *
 * Holds the scope objects the colour listener needs in order to WRITE — ending the
 * stage is a write, and a write only counts inside a callback
 * (`docs/PLATFORM-NOTES.md` §15), so the listener has to have them to hand rather
 * than fetch them.
 *
 * Not persisted, and that is honest rather than lazy: a server restart never puts
 * participants back in their game (U2), so there is no session to resume and
 * nothing worth surviving.
 */
const sessions = new Map();

/**
 * One stage, running the whole 5 minutes.
 *
 * Not rounds. The paper's game is continuous — "each subject was allowed to choose
 * a colour from three choices ... AT ANY TIME" — so there is nothing to divide into
 * rounds, and inventing them would change the task from coordination under time
 * pressure into a sequence of simultaneous-move games.
 */
Empirica.onGameStart(({ game }) => {
  const round = game.addRound({ name: "Coordination" });
  round.addStage({ name: "color", duration: TIME_LIMIT_SECONDS });
});

/**
 * ONE `onStageStart`. See the note in the Rand 2011 example: these helpers are
 * wrapped in a `unique` guard keyed on the scope, so a SECOND registration of the
 * same helper never runs (`ISSUES.md` U8). One each, dispatch inside.
 */
Empirica.onStageStart(({ stage }) => {
  const game = stage.currentGame;
  const { placement, noise } = conditionOf(game);
  const botIndices = (botSeating.get(game.id)?.seats ?? []).slice().sort((a, b) => a - b);

  sessions.set(game.id, {
    game,
    stage,
    startedAt: Date.now(),
    changes: [],
    solved: false,
    tSolutionMs: undefined,
    // Kept as a Set of PLAYER IDS rather than of seats: the colour listener is
    // handed a playerID, and converting seat-to-player on every change would be a
    // lookup per move for something fixed at game start.
    botPlayerIDs: new Set(
      botIndices.map((i) => net.inspect(game.id)?.order?.[i]).filter(Boolean)
    ),
    botIndices,
    botPlacement: placement,
    botNoise: noise,
  });

  // The graph, logged once at the start. Recovery needs it for `session.csv`'s
  // node and edge counts, and it cannot change: this design never rewires.
  const snapshot = net.inspect(game.id);
  if (snapshot) {
    /**
     * `events` is the package's OWN edge history, verbatim, and it is the whole
     * reason `edges.csv` can be recovered.
     *
     * The graph is durable already — `withNetwork` writes the history to the batch
     * scope — but durable in the STORE, which `recover.mjs` deliberately does not
     * read: it is an offline script over one text file, and Tajriba's store format
     * is upstream's to change. So the edge list has to be in the log too, and
     * copying the events rather than rebuilding them from `snapshot.edges` is what
     * makes recovery byte-identical: `edgeRows` keys each row on the event's own
     * `at`, which a reconstruction here would have to invent.
     *
     * One record is complete for this design and would not be for a rewiring one.
     * The Rand port logs the same events incrementally as they accumulate; here
     * there is exactly one `start` event, and asserting that rather than assuming
     * it is what the guard below does.
     */
    const events = network(game).history();
    if (events.length !== 1) {
      // Not fatal — the log is still worth writing — but it means either the
      // history was not ready at stage start or this design has started rewiring,
      // and a silently short `edges.csv` is the failure this whole item was about.
      // eslint-disable-next-line no-console
      console.warn(
        `shirado2017: expected exactly one edge event at stage start, got ${events.length}. ` +
          `edges.csv will be recovered from what was logged.`
      );
    }
    net.log(game, {
      type: "graph",
      n: snapshot.n,
      edges: snapshot.edges.length,
      maxDegree: snapshot.metrics.maxDegree,
      // The condition, so a recovered session knows which arm it belonged to. A
      // rescued session that cannot say that is not a rescued observation.
      bots: botIndices.length,
      botPlacement: botIndices.length > 0 ? placement : "",
      botNoise: botIndices.length > 0 ? noise : "",
      botIndices,
      events,
    });
  }

  /**
   * Tell each agent how noisy to be, on its own private channel.
   *
   * `net.tell` rather than an environment variable in `../bots.mjs`, and that is
   * the load-bearing choice in the whole bot arrangement: with two processes each
   * reading their own copy of the condition, a study runs 10%-noise agents and
   * records them as 30% with nothing anywhere disagreeing. Here the treatment is
   * the only source, and the runner physically cannot act on a noise level the
   * server did not send.
   *
   * At STAGE start, not game start: `tell()` needs the participant's channel to
   * exist, and the package refuses rather than writing into nothing.
   *
   * It reaches only its own recipient, and it is validated by the same
   * `validateProjection` as a view — so this does not weaken the design's
   * guarantee. No human is told anything, and no participant learns which of their
   * neighbours were told what.
   */
  for (const index of botIndices) {
    const playerID = snapshot?.order?.[index];
    if (playerID) network(game).tell(playerID, "noise", noise);
  }
});

export const net = withNetwork(Empirica, {
  /**
   * "the network structure was created de novo for each session by attaching new
   * nodes (each with two links) to existing nodes" — Barabási–Albert, m = 2.
   *
   * Seeded, so the realised graph is recoverable from the seed the package records
   * on the batch scope. That matters more here than usual: the paper shows the
   * solvability of a session depends on the graph it drew ("some networks could be
   * intrinsically easier to solve"), so an analysis that cannot recover the exact
   * graph cannot control for it.
   */
  topology: ({ game, players, playerCount, rng }) => {
    const graph = topology.barabasiAlbert(playerCount, ATTACHMENT, { rng });
    const { bots, placement } = conditionOf(game);

    // Which SEATS the agents got. `players[i]` is whoever will occupy topology
    // index `i` — that is the package's seating guarantee, and it is the whole
    // reason placement is expressible at all (`test/unit/seating.test.ts`).
    const botSeats = players.flatMap((p, i) => (isBotPlayer(p) ? [i] : []));
    botSeating.set(game.id, { seats: botSeats, placement, expected: bots });

    if (bots === 0) return graph;

    if (botSeats.length !== bots) {
      // Loud, and it has to be: the session would run, produce a complete and
      // plausible session.csv, and be in a condition nobody chose. The usual
      // cause is that the runner was not started, or was started with different
      // keys — so name both halves of the contract.
      // eslint-disable-next-line no-console
      console.error(
        `shirado2017: treatment asks for ${bots} agent(s) but ${botSeats.length} of the ` +
          `${playerCount} seated participants matched SHIRADO2017_BOT_KEYS. This session ` +
          `is NOT in the condition it will be labelled with. Check that ../bots.mjs is ` +
          `running and that both processes have the same SHIRADO2017_BOT_KEYS.`
      );
    }
    if (botSeats.length === 0) return graph;

    return placeBots(graph, playerCount, botSeats, placement, rng);
  },

  /**
   * "Subjects could see only the colours of neighbours to whom they were directly
   * connected, in addition to their own colour."
   *
   * That single sentence is the entire experiment, and it is why this design is the
   * package's sharpest test. If a non-neighbour's colour reached a browser, the
   * coordination problem would become trivial — the dependent variable is TIME TO
   * SOLUTION, so a leak would not make the numbers wrong in a visible way, it would
   * drive them toward zero while every screen still looked right.
   *
   * `colour` is PRIVATE state written by the participant to their own channel, so it
   * reaches other participants only through this projection. `player.set("color",
   * …)` would broadcast it to everyone and the task would quietly stop being hard.
   */
  project: (neighbour, viewer, ctx) => ({
    id: neighbour.id,
    color: ctx.stateOf(neighbour).get("color"),
  }),

  /**
   * Republishes on every colour change, and makes `color` readable server-side.
   *
   * No `read` list here, unlike the Rand 2011 example: this design has exactly one
   * private key and the projection reads it, so it belongs in `watch` and there is
   * nothing left over. A `read` entry would be a declaration that is not true.
   *
   * The solution detector below reads colours by INDEX across the whole graph, so
   * it takes them from `inspect()` rather than key-by-key through `stateOf()` — one
   * snapshot per change instead of twenty accessor calls. `stateOf()` is the right
   * tool when a listener consumes one participant's value; this is the other case.
   */
  watch: ["color"],

  /**
   * Barabási–Albert at n=20, m=2 has a mean degree just under 4, but hubs: the
   * paper's own "central" condition is defined by the three highest-degree nodes.
   * The measured default of 16 has room at this size, and it is left at the default
   * deliberately — unlike the Rand port, nothing in this design pushes past it, so
   * there is no reason to raise it and every reason not to.
   */

  /**
   * Capture what each participant was shown, and when.
   *
   * On, because for this design it is the audit trail for the claim the whole
   * experiment rests on: `test/e2e/views.test.ts` runs the neighbour-limited check
   * over a captured log, and the same check runs over a real study's own data.
   */
  views: { file: path.join(OUT_DIR, "views.ndjson") },

  /**
   * The run log, and here it is not a convenience: **this experiment's dependent
   * variable IS the change log** — when each colour was chosen, and what the
   * global conflict count was afterwards. Held only in `sessions` until game end,
   * a killed or crashed session lost every bit of it, and a session that ran four
   * of its five minutes before dying is exactly the data you would most want.
   *
   * Left at the package default of `batch: 1`, so every record is on disk as it
   * happens. A few dozen changes per session makes the syscalls irrelevant, and
   * this is the log where buffering would cost the most.
   *
   * `recover.mjs` rebuilds `session.csv` and `changes.csv` from it, and
   * `test/unit/shirado2017.test.ts` pins that against what a clean finish writes.
   */
  log: { file: path.join(OUT_DIR, "run.ndjson") },

  /**
   * The solution check, driven by participants' own colour writes.
   *
   * Registered here rather than as `Empirica.on(NBHD_KIND, stateKey("color"), …)`,
   * which is what this file did for a whole milestone. That worked, and it is
   * worth being precise about what was wrong with it: it reached into the
   * package's private key layout, it required knowing that a plain `.on` escapes
   * the `unique` guard (`ISSUES.md` U8), and it fired ONLY because `withNetwork`
   * issues `ctx.scopeSub({ kinds: ["nbhd"] })` at start — so the same three lines
   * copied into a project that does not call `withNetwork` produce a listener that
   * never runs, silently (`docs/PLATFORM-NOTES.md` §12, U3).
   *
   * That dependency has not gone away, it has moved inside the package where it
   * belongs. `test/e2e/shirado2017.test.ts` asserting that a solved game actually
   * ends is still the witness that U3 has not regressed.
   */
  onPrivateState: detectSolution,
});

/**
 * A participant chose a colour: record it, and end the session if it solved the graph.
 *
 * Wired in as `onPrivateState` above — a function declaration so it can be named
 * in the config before it is defined here, beside the rest of the game logic.
 *
 * The key is checked even though `color` is the only one declared. It costs a
 * comparison, and the alternative is that adding a second private key to this
 * design silently starts running the solution detector on it.
 */
function detectSolution({ gameID, playerID, key }) {
  if (key !== "color") return;

  const session = sessions.get(gameID);
  if (!session || session.solved) return;

  const snapshot = net.inspect(gameID);
  if (!snapshot) return;

  const colorAt = (i) => snapshot.nodes[i]?.state["color"];
  const conflicts = conflictCount(snapshot.edges, colorAt);
  const node = snapshot.nodes.find((n) => n.playerID === playerID);

  /**
   * The global conflict count is recorded HERE and published NOWHERE.
   *
   * It goes into this process's memory and, at game end, into a CSV. It is never
   * written to a scope of any kind, because a participant who knew the global count
   * would know whether the job was done — and not knowing is the coordination
   * problem the paper measures. If you want to watch it live, that is what
   * `monitor()` is for: a separate loopback port, no participant subscription
   * (`MODULE-DESIGN.md` §15).
   */
  const change = {
    type: "change",
    tMs: Date.now() - session.startedAt,
    playerID,
    topologyIndex: node?.index ?? -1,
    degree: node?.degree ?? 0,
    color: node?.state["color"],
    // Recorded because it CANNOT be recovered afterwards. An agent writes the same
    // key, on the same kind of channel, through the same code path as a human —
    // that is the property the bots were built to have — so nothing in the data
    // distinguishes them unless this column does.
    isBot: session.botPlayerIDs.has(playerID),
    conflictsAfter: conflicts,
  };
  session.changes.push(change);
  // On disk as it happens. This is the dependent variable; keeping it only in
  // memory until game end meant a session that died at four minutes produced
  // nothing at all.
  net.log(gameID, change);

  if (!isSolved(snapshot.n, snapshot.edges, colorAt)) return;

  session.solved = true;
  session.tSolutionMs = Date.now() - session.startedAt;

  // The outcome, on the batch scope — durable, and not delivered to participants
  // (§4c). On the game scope every participant would learn the solution time,
  // which for a session that has just ended is harmless, and for one that has not
  // would be the global signal this design withholds. Same place either way.
  session.game.batch?.set(`solution:${gameID}`, {
    solved: true,
    tSolutionMs: session.tSolutionMs,
    changes: session.changes.length,
  });

  net.log(gameID, { type: "solved", tSolutionMs: session.tSolutionMs });

  // A write, so it has to happen inside a callback — and it does: the hook is
  // called from inside the attribute listener that delivered the colour, not from
  // a timer (`docs/PLATFORM-NOTES.md` §15). That is also why this function is
  // synchronous: an `await` here would put this `end()` outside the runloop's
  // flush, where it would update the server and reach nobody.
  session.stage.end("ended", "network properly coloured");
}

/**
 * Write the analysis files.
 *
 * `edges.csv` comes from the package (and includes the initial graph, so a static
 * network still exports its structure rather than an empty file); the other two are
 * this experiment's. All three are pure functions over plain data, so the same code
 * runs offline over a stored log.
 */
Empirica.onGameEnded(({ game }) => {
  const session = sessions.get(game.id);
  const snapshot = net.inspect(game.id);
  const history = network(game).history();

  // Content is built by a pure function so it can be asserted without a server
  // (`test/unit/shirado2017.test.ts`); what is left here is the filesystem.
  const files = exportFiles(
    game.id,
    {
      n: snapshot?.n ?? 0,
      edges: snapshot?.edges.length ?? 0,
      solved: Boolean(session?.solved),
      tSolutionMs: session?.tSolutionMs ?? "",
      changes: session?.changes.length ?? 0,
      maxDegree: snapshot?.metrics.maxDegree ?? 0,
      bots: session?.botIndices?.length ?? 0,
      botPlacement: session?.botPlacement ?? "",
      botNoise: session?.botNoise ?? "",
      botIndices: session?.botIndices ?? [],
    },
    session?.changes ?? [],
    toCSV(edgeRows(game.id, history)),
    toCSV
  );

  const dir = path.join(OUT_DIR, game.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }

  sessions.delete(game.id);
  botSeating.delete(game.id);
  // eslint-disable-next-line no-console
  console.log(
    `shirado2017: ${session?.solved ? `solved in ${session.tSolutionMs}ms` : "unsolved"} — ` +
      `wrote ${dir}/{${Object.keys(files).join(",")}}`
  );
});
