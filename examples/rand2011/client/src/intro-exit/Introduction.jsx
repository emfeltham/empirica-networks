import { usePlayer } from "@empirica/core/player/classic/react";
import React from "react";
import { Button } from "../components/Button";

/**
 * The instructions.
 *
 * The two payoff numbers below are written out, and they are the ONE place in
 * this client that restates something from `server/src/design.js`. They are not
 * imported, because a client importing across into the server package depends on
 * Vite's `fs.allow` resolving outside the client root, and a build that works on
 * one machine and not another is a worse problem than this one.
 *
 * The exposure is bounded and worth naming: instructions that disagree with the
 * payoff rule are a validity problem rather than a typo, because subjects would
 * be optimising against a game they were never in. Nothing here computes a
 * payoff — the server does that once and tells each participant their own — so
 * the risk is confined to these two numbers. If you change
 * COST_PER_NEIGHBOUR or BENEFIT_PER_NEIGHBOUR, change them here too.
 *
 * Deliberately does NOT tell participants the network condition, the rewiring
 * rate, or that any structure exists beyond their own connections: "we do not
 * inform subjects about the structure of the network."
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
          You are connected to some of the other participants. Each round you make
          one choice, and it applies to <strong>all</strong> of your connections at
          once.
        </p>
        <ul className="list-disc ml-6 space-y-1">
          <li>
            If you <strong>cooperate</strong>, you pay <strong>50 units</strong> for
            each person you are connected to, and each of them gains <strong>100 units</strong>.
          </li>
          <li>
            If you <strong>defect</strong>, you pay nothing and nobody gains anything
            from you.
          </li>
        </ul>
        <p>
          After each round you will see what each of your connections chose, and your
          own score. In some sessions you will also be offered the chance to break an
          existing connection or form a new one.
        </p>
        <p>
          You will only ever see the choices of people you are directly connected to.
          After each round there is a chance the session ends.
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
