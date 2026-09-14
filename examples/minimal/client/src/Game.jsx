import { usePlayer, useStage } from "@empirica/core/player/classic/react";
import {
  NetworkGraph,
  NetworkGraphStyles,
  useNeighbors,
  useNetworkGraph,
  useNetworkSelf,
  useNetworkState,
} from "empirica-networks/player/react";
import React from "react";

/**
 * The same neighborhood, twice: once as a graph and once as a list.
 *
 * Both on purpose, and it is the point of this example rather than clutter. The
 * graph is the interface a participant should usually get — it is what
 * Breadboard drew, and it shows adjacency as adjacency. The list underneath is
 * what the data actually is, and it is where the distinction this example exists
 * to teach is visible: `name` is a PUBLIC player attribute and reaches every
 * participant; `color` is private, written to this browser's own channel, and
 * reaches only neighbors. Draw either from the same `useNeighbors()` array.
 *
 * The graph is a STAR and can be nothing else: it is built from that array, which
 * holds your neighbors and no tie between two of them.
 */

/** A five-slot palette, as CSS the graph's attribute selectors can match. */
const GRAPH_CSS = `
.nbhd circle[color="red"]    { fill: #ef4444; }
.nbhd circle[color="amber"]  { fill: #f59e0b; }
.nbhd circle[color="green"]  { fill: #22c55e; }
.nbhd circle[color="blue"]   { fill: #3b82f6; }
.nbhd circle[color="violet"] { fill: #8b5cf6; }
`;

const COLORS = ["red", "amber", "green", "blue", "violet"];

const SWATCH = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
};

function Swatch({ color }) {
  return (
    <div
      className={`w-8 h-8 rounded-full border ${color ? SWATCH[color] : "bg-gray-100"}`}
      title={color || "no choice yet"}
    />
  );
}

export function Game() {
  const player = usePlayer();
  const stage = useStage();

  // Private state: written to this participant's own channel, so it reaches
  // only their neighbors — via the server's project(). Using
  // player.set("color", …) here would broadcast it to everyone.
  const state = useNetworkState();

  const neighbors = useNeighbors();
  const self = useNetworkSelf();

  const myColor = state?.get("color");
  const graph = useNetworkGraph(
    // The server's value becomes an SVG attribute and GRAPH_CSS selects on it,
    // so the palette changes without the component changing.
    { nodeAttrs: (n) => ({ color: n.self ? myColor : n.data?.color }) },
    { color: myColor }
  );

  // `undefined` means "not known yet", and is deliberately distinct from `[]`,
  // which means "genuinely has no neighbors". Rendering [] while loading would
  // show this participant as isolated and look entirely normal.
  if (!neighbors) {
    return <div className="p-8 text-gray-500">Joining the network…</div>;
  }

  return (
    <div className="p-8 space-y-8">
      <NetworkGraphStyles extra={GRAPH_CSS} />

      <div className="h-64">
        <NetworkGraph
          model={graph}
          ariaLabel="You and your neighbors."
          describe={(n) =>
            n.self
              ? `You: ${myColor ?? "no color yet"}.`
              : `${n.data?.name || "A neighbor"}: ${n.data?.color ?? "no color yet"}.`
          }
        />
      </div>

      <div>
        <h2 className="text-lg font-semibold">Your color</h2>
        <div className="flex gap-2 mt-2">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => state?.set("color", c)}
              className={`w-10 h-10 rounded-full border-2 ${SWATCH[c]} ${
                myColor === c ? "border-black" : "border-transparent"
              }`}
              title={c}
            />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">
          Your neighbors ({neighbors.length})
        </h2>

        {neighbors.length === 0 ? (
          <p className="mt-2 text-gray-500">
            You have no neighbors in this network.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {neighbors.map((n) => (
              <li key={n.id} className="flex items-center gap-3">
                <Swatch color={n.color} />
                <span>{n.name || `…${n.id.slice(-6)}`}</span>
              </li>
            ))}
          </ul>
        )}

        {/*
          Showing the TAIL of the id, not the head: these are ULIDs, so players
          created in the same millisecond share a long prefix and a truncated
          head makes distinct participants look identical.
        */}
        <p className="mt-4 text-sm text-gray-500">
          You are node …{self?.playerID?.slice(-6)} with degree {self?.degree}.
          The list above contains only your neighbors — no non-neighbor&apos;s
          projected view is ever sent to this browser.
        </p>

        {/*
          The color really is neighbor-limited, because it is written with
          useNetworkState() to this participant's own channel rather than with
          player.set(). Player attributes are broadcast to everyone, so the
          earlier version of this demo showed a privacy claim it did not keep.

          The name below is deliberately still a player attribute: it is a public
          display name, and having both in one example shows the difference.
        */}
        <p className="mt-2 text-xs text-gray-500">
          Names are public player attributes. Colors are private — written to
          your own channel and shown only to your neighbors.
        </p>
      </div>

      <button
        onClick={() => player.stage.set("submit", true)}
        disabled={player.stage.get("submit")}
        className="px-4 py-2 rounded bg-black text-white disabled:opacity-40"
      >
        {player.stage.get("submit") ? "Waiting for others…" : "Done"}
      </button>

      <p className="text-xs text-gray-400">Stage: {stage?.get("name")}</p>
    </div>
  );
}
