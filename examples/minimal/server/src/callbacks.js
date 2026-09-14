import path from "node:path";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import { topology, withNetwork } from "empirica-networks/admin";

export const Empirica = new ClassicListenersCollector();

Empirica.onGameStart(({ game }) => {
  const round = game.addRound({ name: "Round 1" });
  round.addStage({ name: "Choose", duration: 300 });
});

/**
 * The whole network configuration.
 *
 * Participants sit on a ring and choose a color. Each sees only their two
 * neighbors' choices — never the rest of the graph, and not because the UI
 * hides it: a non-neighbor's color never reaches the browser.
 */
/**
 * The handle `withNetwork` returns, exported so `index.js` can hand it to the
 * monitor. Exporting it has no effect on its own — nothing starts here — which
 * is why the monitor is wired up in `index.js` rather than in this file: these
 * callbacks are imported directly by `test/e2e/example.test.ts`, and an import
 * that opened a socket would be a surprise in a test run.
 */
/**
 * Try a wider radius without editing this file:
 *
 *     NBHD_RADIUS=1.5 empirica     the ties AMONG your connections
 *     NBHD_RADIUS=2   empirica     your connections' connections
 *
 * At the default, each participant sees themselves and their connections — a
 * star, which is what Breadboard drew.
 *
 * Parsed as a NUMBER, not matched against a string. It was `=== "1.5"` and a
 * run at `NBHD_RADIUS=2` therefore went quietly to the default: the same class
 * of trap as `"whole" > 1` being false, which silently disabled the feature
 * inside the package. `"whole"` is not offered here at all — it is a decision
 * worth making in a file you have read (see `docs/API.md`), not by exporting an
 * environment variable.
 *
 * It switches the topology too, and that is not a convenience. Whether a radius
 * shows a participant anything is a property of the GRAPH, and which graph works
 * is not monotone in the radius:
 *
 *   1.5 needs triangles. A ring has none — your two neighbors sit on opposite
 *       sides of you and are not tied — so 1.5 on a ring draws the same star
 *       radius 1 draws. A ring LATTICE is full of them.
 *   2   needs DISTANCE, and a plain ring is ideal: your neighbors' neighbors are
 *       two new people. On the lattice at small n everybody is already within
 *       two hops and there is nothing new to show.
 *
 * So the shape that is useless at 1.5 is the right one at 2, and the one that
 * works at 1.5 stops working at 2. `verify` computes that refusal per radius
 * rather than keeping a list, for the same reason.
 *
 * The lattice needs playerCount >= 5: `ringLattice(n, 2)` requires n >= 2m+1,
 * or the ring wraps onto itself.
 */
const RADIUS = (() => {
  const raw = Number(process.env.NBHD_RADIUS);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
})();

/** Fractional radii deliver the ties among the outermost ring, so they need triangles. */
const WANTS_TRIANGLES = RADIUS % 1 !== 0;

/**
 * Where the run log and the captured views go, when they are wanted at all.
 *
 * Unset by default and unset in every test run, which is the point: this file is
 * imported UNMODIFIED by `test/e2e/example.test.ts`, with the repository root as
 * the working directory, so an unconditional path would write NDJSON into the
 * repo on every test. `rand2011` and `shirado2017` gate theirs the same way, on
 * `RAND2011_OUT` and `SHIRADO2017_OUT`.
 *
 * Set it to recover a run offline:
 *
 *     MINIMAL_OUT=data NBHD_RADIUS=1.5 empirica
 *     node recover.mjs data/views.ndjson
 */
const OUT_DIR = process.env.MINIMAL_OUT;

export const net = withNetwork(Empirica, {
  graph: { radius: RADIUS },

  /**
   * Capture what each participant was shown.
   *
   * Worth turning on here specifically because of the radius switch above. At
   * 1.5 the delivery includes the ties among a participant's neighbors and
   * where each node was drawn, and the positions are warm-started — they follow
   * the session's history rather than its final graph, so they are the one part
   * of a screen that cannot be reconstructed from the edge log afterwards. This
   * is the only example that can run at 1.5, and without capture it would be the
   * only one whose interesting half is unrecoverable.
   */
  ...(OUT_DIR
    ? {
        views: { file: path.join(OUT_DIR, "views.ndjson") },
        log: { file: path.join(OUT_DIR, "run.ndjson") },
      }
    : {}),

  // Seeded from the game id unless you pass `seed`, and recorded on the game
  // scope, so the realized graph is reconstructible from stored data.
  topology: ({ playerCount, rng }) =>
    WANTS_TRIANGLES && playerCount >= 5
      ? topology.ringLattice(playerCount, 2, { rng })
      : topology.ring(playerCount, { rng }),

  // The ONLY path from server to client. Return plain data — returning the
  // scope itself is refused, because it carries the global attribute store.
  //
  // Note where each field comes from, because it decides who can read it:
  //
  //   name  — a PLAYER attribute. Empirica broadcasts every player scope to
  //           every participant, so this is public no matter what we do here.
  //           Fine: it is a display name.
  //
  //   color — PRIVATE state, written by the participant to their own channel.
  //           It reaches other participants only through this projection, so it
  //           really is limited to neighbors. Had we used neighbor.get("color")
  //           it would have been broadcast like the name, and the privacy claim
  //           would have been hollow.
  project: (neighbor, viewer, ctx) => ({
    id: neighbor.id,
    name: neighbor.get("name"),
    color: ctx.stateOf(neighbor).get("color"),
  }),

  // Player attributes the projection depends on. A change to one republishes
  // the neighbors who can see it. Omit a key here and its changes never
  // propagate — so anything `project()` reads that is missing is reported in
  // the server log rather than going stale silently.
  watch: ["name", "color"],
});
