import { usePlayer } from "@empirica/core/player/classic/react";
import React, { useState } from "react";
import { Button } from "../components/Button";

export function Introduction({ next }) {
  const player = usePlayer();
  const [name, setName] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    // Read by the server's project() and listed in `watch`, so a change here
    // republishes to exactly the neighbours who can see this participant.
    player.set("name", name.trim() || "Anonymous");
    next();
  }

  return (
    <div className="mt-3 sm:mt-5 p-20 max-w-prose">
      <h3 className="text-lg leading-6 font-medium text-gray-900">
        You are a node in a network
      </h3>
      <div className="mt-2 mb-6 space-y-3 text-sm text-gray-500">
        <p>
          Everyone in this session sits on a ring. You will pick a colour, and
          you will see the colours picked by the two participants next to you on
          that ring — nobody else&apos;s.
        </p>
        <p>
          This is not a display rule. A non-neighbour&apos;s colour is never sent
          to your browser at all, so there is nothing to find in the page source
          or the network tab.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 my-2">
            What should your neighbours call you?
          </label>
          <input
            className="appearance-none block px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="A name or nickname"
            autoFocus
          />
        </div>
        <Button type="submit">
          <p>Next</p>
        </Button>
      </form>
    </div>
  );
}
