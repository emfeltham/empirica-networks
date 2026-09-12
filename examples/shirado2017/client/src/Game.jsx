import { usePlayer } from "@empirica/core/player/classic/react";
import {
  useNeighbors,
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
 * WHAT IS DELIBERATELY ABSENT FROM THIS SCREEN, and why it is the more important
 * half of the file:
 *
 *   the global conflict count   The server knows it and never publishes it. A
 *                               participant who knew whether the NETWORK was solved
 *                               would know when to stop trying, and not knowing is
 *                               the coordination problem the paper measures.
 *   the network structure       You see your neighbors' colors. Not who they are
 *                               connected to, not how many, not the shape of the
 *                               graph.
 *   anyone else's color        Not hidden by this component — never sent to this
 *                               browser at all. That is what makes the task hard,
 *                               and it is asserted at the wire by
 *                               `test/e2e/shirado2017.test.ts`.
 *
 * Deliberately unstyled beyond the minimum: this reconstructs a design, not an
 * interface, and polishing it would imply otherwise.
 */

const COLORS = ["green", "orange", "purple"];

const SWATCH = {
  green: "bg-green-500",
  orange: "bg-orange-500",
  purple: "bg-purple-500",
};

function Dot({ color, ring = false }) {
  return (
    <div
      className={`w-10 h-10 rounded-full border-2 ${
        color ? SWATCH[color] : "bg-gray-100"
      } ${ring ? "border-black" : "border-transparent"}`}
      title={color || "no color yet"}
    />
  );
}

export function Game() {
  const player = usePlayer();
  const state = useNetworkState();
  const neighbors = useNeighbors();
  const self = useNetworkSelf();

  // `undefined` is "not known yet" and is NOT the same as `[]`. Barabási–Albert
  // leaves nobody isolated, so `[]` here would mean something has gone wrong — but
  // rendering it as "you have no neighbors" while still loading would look
  // completely normal, which is why the hook refuses to conflate the two.
  if (!neighbors) {
    return <div className="p-8 text-gray-500">Joining the network…</div>;
  }

  // Private state: written to this participant's own channel, so it reaches other
  // participants only through the server's project() — and therefore only their
  // neighbors. player.set("color", …) would broadcast it to everyone and the
  // coordination problem would quietly become trivial.
  const myColor = state?.get("color");

  const neighborColors = neighbors.map((n) => n.color);
  // Computed here from what this participant can already see, so it reveals
  // nothing they were not sent. NOT the global count.
  const myConflicts = myColor
    ? neighborColors.filter((c) => c === myColor).length
    : 0;

  return (
    <div className="p-8 space-y-8 max-w-prose">
      <div>
        <h2 className="text-lg font-semibold">Your color</h2>
        <div className="flex gap-3 mt-2">
          {COLORS.map((c) => (
            <button key={c} onClick={() => state?.set("color", c)} title={c}>
              <Dot color={c} ring={myColor === c} />
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">
          Your connections ({neighbors.length})
        </h2>
        <div className="flex gap-2 mt-2 flex-wrap">
          {neighbors.map((n) => (
            <Dot key={n.id} color={n.color} />
          ))}
        </div>

        {myColor && myConflicts > 0 ? (
          <p className="mt-3 text-sm text-red-700">
            {myConflicts} of your connections {myConflicts === 1 ? "has" : "have"} the
            same color as you.
          </p>
        ) : myColor ? (
          <p className="mt-3 text-sm text-green-700">
            None of your connections share your color.
          </p>
        ) : (
          <p className="mt-3 text-sm text-gray-500">Pick a color to begin.</p>
        )}

        {/*
          The honest statement of what "done" means here, and the reason the
          screen cannot say "solved". Zero local conflicts is not zero global
          conflicts: the paper's own example has subjects who have solved the
          problem from their own point of view while the network has not.
        */}
        <p className="mt-4 text-sm text-gray-500">
          The session ends when <em>everyone</em> differs from all of their own
          connections. You cannot see whether that has happened — only your own
          part of it.
        </p>
      </div>

      {/*
        The tail of the id, not the head: these are ULIDs, so participants created
        in the same millisecond share a long prefix and a truncated head makes
        distinct people look identical.
      */}
      <p className="text-xs text-gray-400">
        You are node …{self?.playerID?.slice(-6)} with {self?.degree} connection(s).
        No non-connection&apos;s color is ever sent to this browser.
        {player.get("exitStatus") ? " Session over." : ""}
      </p>
    </div>
  );
}
