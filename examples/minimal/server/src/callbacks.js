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
 * Participants sit on a ring and choose a colour. Each sees only their two
 * neighbours' choices — never the rest of the graph, and not because the UI
 * hides it: a non-neighbour's colour never reaches the browser.
 */
withNetwork(Empirica, {
  // Seeded from the game id unless you pass `seed`, and recorded on the game
  // scope, so the realised graph is reconstructible from stored data.
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
  //           really is limited to neighbours. Had we used neighbour.get("color")
  //           it would have been broadcast like the name, and the privacy claim
  //           would have been hollow.
  project: (neighbour, viewer, ctx) => ({
    id: neighbour.id,
    name: neighbour.get("name"),
    color: ctx.stateOf(neighbour).get("color"),
  }),

  // Player attributes the projection depends on. A change to one republishes
  // the neighbours who can see it. Omit a key here and its changes never
  // propagate — so anything `project()` reads that is missing is reported in
  // the server log rather than going stale silently.
  watch: ["name", "color"],
});
