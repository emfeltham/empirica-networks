import { usePlayer } from "@empirica/core/player/classic/react";
import {
  DARK2_CSS,
  NetworkGraph,
  NetworkGraphStyles,
  useNeighbors,
  useNetworkGraph,
  useNetworkSelf,
  useNetworkState,
} from "empirica-networks/player/react";
import React from "react";

/**
 * Shirado & Christakis (2017), the participant screen.
 *
 * The whole task: pick a color different from every neighbor's. Continuous — no
 * rounds, no submit — because the paper's game runs for five minutes and anyone may
 * change color at any time.
 *
 * WHY THIS IS A GRAPH AND NOT A LIST. It was a list, with a comment saying the
 * screen "reconstructs a design, not an interface, and polishing it would imply
 * otherwise". That was right while the interface was undocumented. It is not:
 * the paper's SI carries eight full-page screenshots of the live participant UI
 * (§1.3, pp. 5-12), and Breadboard's shipped experiment archives carry the
 * stylesheets that produced them. What subjects saw was a node-link diagram —
 * themselves at the center, larger, labelled "You", one circle per neighbor, a
 * thick red bar across any tie to someone sharing their color. A row of detached
 * dots is not a neutral simplification of that; it withholds the adjacency the
 * task is about, and is the further reading of the design, not the safer one.
 *
 * This is still a RECONSTRUCTION. No participant data has been collected, and no
 * result here has been compared with the paper's. See docs/EXPERIMENTS.md.
 *
 * WHAT IS DELIBERATELY ABSENT FROM THIS SCREEN, and why it is still the more
 * important half of the file:
 *
 *   the global conflict count   The server knows it and never publishes it. A
 *                               participant who knew whether the NETWORK was solved
 *                               would know when to stop trying, and not knowing is
 *                               the coordination problem the paper measures.
 *   the network structure       The graph drawn here is a STAR and cannot be
 *                               anything else: it is built from `useNeighbors()`,
 *                               which carries your neighbors and no tie between
 *                               two of them. Breadboard enforced the same limit
 *                               server-side, and told subjects so in as many
 *                               words. Nothing extra crosses the wire to draw it.
 *   anyone else's color         Not hidden by this component — never sent to this
 *                               browser at all. That is what makes the task hard,
 *                               and it is asserted at the wire by
 *                               `test/e2e/shirado2017.test.ts`.
 */

const COLORS = ["green", "orange", "purple"];

/** ColorBrewer Dark2, which the paper's SI states was chosen to be CVD-safe. */
const SWATCH = {
  green: "#1b9e77",
  orange: "#d95f02",
  purple: "#7570b3",
};

export function Game() {
  const player = usePlayer();
  const state = useNetworkState();
  const neighbors = useNeighbors();
  const self = useNetworkSelf();

  // Private state: written to this participant's own channel, so it reaches other
  // participants only through the server's project() — and therefore only their
  // neighbors. player.set("color", …) would broadcast it to everyone and the
  // coordination problem would quietly become trivial.
  const myColor = state?.get("color");

  const graph = useNetworkGraph(
    {
      // The server's value becomes an SVG attribute, and `DARK2_CSS` selects on
      // it. The participant's OWN node is colored too: in the SI screenshots the
      // ego circle carries the subject's own choice, and a screen showing
      // everyone's color but yours would be a different task.
      nodeAttrs: (n) => ({ color: n.data?.color }),
      // Computed from what this participant can already see, so it reveals
      // nothing they were not sent. NOT the global count.
      edgeAttrs: (a, b) => ({ conflict: !!a.data?.color && a.data?.color === b.data?.color }),
    },
    { color: myColor }
  );

  // `undefined` is "not known yet" and is NOT the same as `[]`. Barabási–Albert
  // leaves nobody isolated, so `[]` here would mean something has gone wrong — but
  // rendering it as "you have no neighbors" while still loading would look
  // completely normal, which is why the hook refuses to conflate the two.
  if (!neighbors) {
    return <div className="p-8 text-gray-500">Joining the network…</div>;
  }

  const neighborColors = neighbors.map((n) => n.color);
  const myConflicts = myColor ? neighborColors.filter((c) => c === myColor).length : 0;

  return (
    <div className="h-full flex flex-col md:flex-row">
      <NetworkGraphStyles extra={DARK2_CSS} />

      {/* Breadboard's split: the graph on the left at half the width, white,
          and the instructions and choices on the right. Stacks below 800px,
          as its own stylesheet does. */}
      <div className="h-1/3 md:h-full md:w-1/2 bg-white p-4">
        <NetworkGraph
          model={graph}
          ariaLabel="You and the participants you are connected to."
          // The fill IS the task here, so the state has to exist as text as
          // well. Without this the graph is one role="img" with no content.
          describe={(n) =>
            n.self
              ? `You: ${n.data?.color ?? "no color yet"}.`
              : `A connection: ${n.data?.color ?? "no color yet"}${
                  n.data?.color && n.data.color === myColor ? ", the same as yours" : ""
                }.`
          }
        />
      </div>

      <div className="h-2/3 md:h-full md:w-1/2 overflow-auto bg-gray-100 border-l-2 border-gray-200 p-8 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Your color</h2>
          <div className="flex gap-3 mt-2">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => state?.set("color", c)}
                className={`w-12 h-12 rounded-full border-4 ${
                  myColor === c ? "border-black" : "border-transparent"
                }`}
                style={{ backgroundColor: SWATCH[c] }}
                aria-label={c}
                aria-pressed={myColor === c}
                title={c}
              />
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold">Your connections ({neighbors.length})</h2>
          {myColor && myConflicts > 0 ? (
            <p className="mt-2 text-sm text-red-700">
              {myConflicts} of your connections {myConflicts === 1 ? "has" : "have"} the
              same color as you. Those connections are marked in red.
            </p>
          ) : myColor ? (
            <p className="mt-2 text-sm text-green-700">
              None of your connections share your color.
            </p>
          ) : (
            <p className="mt-2 text-sm text-gray-500">Pick a color to begin.</p>
          )}
        </div>

        {/*
          The honest statement of what "done" means here, and the reason the
          screen cannot say "solved". Zero local conflicts is not zero global
          conflicts: the paper's own example has subjects who have solved the
          problem from their own point of view while the network has not.
        */}
        <p className="text-sm text-gray-500">
          The session ends when <em>everyone</em> differs from all of their own
          connections. You cannot see whether that has happened — only your own
          part of it.
        </p>

        {/*
          The tail of the id, not the head: these are ULIDs, so participants created
          in the same millisecond share a long prefix and a truncated head makes
          distinct people look identical.
        */}
        <p className="text-xs text-gray-400">
          You are node …{self?.playerID?.slice(-6)} with {self?.degree} connection(s).
          You are seeing your own connections and nothing beyond them.
          {player.get("exitStatus") ? " Session over." : ""}
        </p>
      </div>
    </div>
  );
}
