import { usePlayer, useStage } from "@empirica/core/player/classic/react";
import {
  useNeighbors,
  useNetworkSelf,
  useNetworkState,
} from "empirica-networks/player/react";
import React from "react";

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
  // only their neighbours — via the server's project(). Using
  // player.set("color", …) here would broadcast it to everyone.
  const state = useNetworkState();

  const neighbors = useNeighbors();
  const self = useNetworkSelf();

  // `undefined` means "not known yet", and is deliberately distinct from `[]`,
  // which means "genuinely has no neighbours". Rendering [] while loading would
  // show this participant as isolated and look entirely normal.
  if (!neighbors) {
    return <div className="p-8 text-gray-500">Joining the network…</div>;
  }

  const myColor = state?.get("color");

  return (
    <div className="p-8 space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Your colour</h2>
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
          Your neighbours ({neighbors.length})
        </h2>

        {neighbors.length === 0 ? (
          <p className="mt-2 text-gray-500">
            You have no neighbours in this network.
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
          The list above contains only your neighbours — no non-neighbour&apos;s
          projected view is ever sent to this browser.
        </p>

        {/*
          The colour really is neighbour-limited, because it is written with
          useNetworkState() to this participant's own channel rather than with
          player.set(). Player attributes are broadcast to everyone, so the
          earlier version of this demo showed a privacy claim it did not keep.

          The name below is deliberately still a player attribute: it is a public
          display name, and having both in one example shows the difference.
        */}
        <p className="mt-2 text-xs text-gray-500">
          Names are public player attributes. Colours are private — written to
          your own channel and shown only to your neighbours.
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
