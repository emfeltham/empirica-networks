import { usePlayer, useStage } from "@empirica/core/player/classic/react";
import { useNeighbors, useNetworkSelf } from "empirica-networks/player/react";
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

  const neighbors = useNeighbors();
  const self = useNetworkSelf();

  // `undefined` means "not known yet", and is deliberately distinct from `[]`,
  // which means "genuinely has no neighbours". Rendering [] while loading would
  // show this participant as isolated and look entirely normal.
  if (!neighbors) {
    return <div className="p-8 text-gray-500">Joining the network…</div>;
  }

  const myColor = player.get("color");

  return (
    <div className="p-8 space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Your colour</h2>
        <div className="flex gap-2 mt-2">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => player.set("color", c)}
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
          Being straight about the limit, because the obvious reading of the
          line above is stronger than what is true.

          This demo stores the colour with `player.set("color", …)`, and Empirica
          cross-links every participant to every player node — so the raw
          attribute IS broadcast to everyone, whatever the topology. What is
          neighbour-limited is the PROJECTION.

          For a real experiment where the value itself must stay private, do not
          put it on the player scope. See the README.
        */}
        <p className="mt-2 text-xs text-amber-700">
          Note: in this demo the colour is also stored as a plain player
          attribute, which Empirica broadcasts to everyone. The neighbour list is
          private; the underlying attribute is not.
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
