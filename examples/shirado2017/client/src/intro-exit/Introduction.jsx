import { usePlayer } from "@empirica/core/player/classic/react";
import React from "react";
import { Button } from "../components/Button";

/**
 * The instructions.
 *
 * Deliberately describes the COLLECTIVE goal without giving any way to observe it.
 * The paper's subjects knew what the group had to achieve and could see only their
 * own neighborhood; that gap is the coordination problem, so the instructions have
 * to state the goal and the screen has to withhold the progress.
 *
 * Also deliberately silent about the shape of the network, the number of
 * participants' connections, and the existence of hubs.
 */
export function Introduction({ next }) {
  const player = usePlayer();

  function handleSubmit(event) {
    event.preventDefault();
    player.set("introDone", true);
    next();
  }

  return (
    <div className="mt-3 sm:mt-5 p-20 max-w-prose">
      <h3 className="text-lg leading-6 font-medium text-gray-900">Instructions</h3>
      <div className="mt-2 mb-6 space-y-3 text-sm text-gray-500">
        <p>
          You are connected to some of the other participants. Everyone chooses a
          color — <strong>green</strong>, <strong>orange</strong> or{" "}
          <strong>purple</strong> — and may change it at any time.
        </p>
        <p>
          <strong>
            The group succeeds when every single participant has a different color
            from all of the people they are connected to.
          </strong>{" "}
          It is a group task: your own connections being fine is not enough.
        </p>
        <p>
          You will see the colors of the people you are connected to, and nothing
          else — not the rest of the group, and not how close the group is to
          finishing. The session runs for up to five minutes, and ends as soon as
          the group succeeds.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <Button type="submit">
          <p>I understand</p>
        </Button>
      </form>
    </div>
  );
}
