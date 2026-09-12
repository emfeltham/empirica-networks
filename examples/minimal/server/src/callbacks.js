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
export const net = withNetwork(Empirica, {
  // Seeded from the game id unless you pass `seed`, and recorded on the game
  // scope, so the realized graph is reconstructible from stored data.
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),

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
