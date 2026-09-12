import { usePlayer, useStage } from "@empirica/core/player/classic/react";
import {
  useNeighbors,
  useNetworkSelf,
  useNetworkState,
  useNetworkTold,
} from "empirica-networks/player/react";
import React from "react";
import { Button } from "./components/Button";

/**
 * Rand, Arbesman & Christakis (2011), participant screens.
 *
 * Two stages per round, and they read from three different places. Which place a
 * value comes from is the whole reason this file is worth reading:
 *
 *   useNeighbors()      the server's project() — your connections' choices. Only
 *                       your connections are in here; a non-neighbor's choice is
 *                       never sent to this browser at all.
 *   useNetworkState()   your OWN private channel. This is where your choice goes.
 *                       `player.set()` would broadcast it to everyone.
 *   useNetworkTold()    what the SERVER told you, privately: your payoff, your
 *                       rewiring offers, and who acted on you. Needed because a
 *                       rewiring offer is about someone you are NOT connected to,
 *                       which project() structurally cannot deliver.
 *
 * Deliberately unstyled beyond the minimum. This is a reconstruction of a design,
 * not a replication of an interface — the paper's screens are not reproduced, and
 * pretending otherwise by polishing these would be a claim about the wrong thing.
 */

const COOPERATE = "C";
const DEFECT = "D";

function ActionBadge({ action }) {
  if (action === COOPERATE) return <span className="text-green-700 font-medium">cooperated</span>;
  if (action === DEFECT) return <span className="text-red-700 font-medium">defected</span>;
  return <span className="text-gray-400">has not chosen yet</span>;
}

/** Round 1 has no previous round, so there is nothing to have been told. */
function Score({ score }) {
  if (!score) return null;
  return (
    <p className="text-sm text-gray-600">
      Last round you earned <strong>{score.payoff}</strong> units. Your total is{" "}
      <strong>{score.wealth}</strong>.
    </p>
  );
}

function Feedback({ feedback }) {
  if (!feedback) return null;
  const { broken, formed } = feedback;
  if (broken === 0 && formed === 0) {
    return <p className="text-sm text-gray-500">Nobody changed their connection with you.</p>;
  }
  return (
    <p className="text-sm text-gray-600">
      {broken > 0 && <>{broken} participant(s) broke their connection with you. </>}
      {formed > 0 && <>{formed} participant(s) formed a new connection with you.</>}
    </p>
  );
}

/** The cooperation decision. One choice, applied to every connection. */
function Decide({ neighbors, state, told, player }) {
  const action = state?.get("action");
  const submitted = player.stage.get("submit");

  return (
    <div className="p-8 space-y-6 max-w-prose">
      <Score score={told?.get("score")} />
      <Feedback feedback={told?.get("rewireFeedback")} />

      <div>
        <h2 className="text-lg font-semibold">
          Your connections ({neighbors.length})
        </h2>
        {neighbors.length === 0 ? (
          <p className="mt-2 text-gray-500">
            You have no connections at the moment, so this round you neither pay nor
            receive anything.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {neighbors.map((n) => (
              <li key={n.id}>
                {/* The tail of the id, not the head: these are ULIDs, so
                    participants created in the same millisecond share a long
                    prefix and a truncated head makes distinct people look
                    identical. */}
                <span className="text-gray-500">…{n.id.slice(-6)}</span> last{" "}
                <ActionBadge action={n.action} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold">Your choice this round</h2>
        <p className="text-sm text-gray-500">
          It applies to all {neighbors.length} of your connections at once.
        </p>
        <div className="flex gap-3 mt-3">
          {[
            [COOPERATE, "Cooperate"],
            [DEFECT, "Defect"],
          ].map(([value, label]) => (
            <button
              key={value}
              /* PRIVATE. Written to this participant's own channel, so it reaches
                 other participants only through the server's project() — and
                 therefore only their connections. player.set("action", …) here
                 would broadcast it to everyone and the network would stop being
                 the manipulation. */
              onClick={() => state?.set("action", value)}
              className={`px-4 py-2 rounded border-2 ${
                action === value ? "border-black font-medium" : "border-gray-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Button
        handleClick={() => player.stage.set("submit", true)}
        primary={!submitted}
        disabled={submitted || !action}
      >
        <p>{submitted ? "Waiting for others…" : "Confirm"}</p>
      </Button>
      {!action && (
        <p className="text-xs text-gray-400">
          Choose cooperate or defect before confirming.
        </p>
      )}
    </div>
  );
}

/**
 * The rewiring decision.
 *
 * "If a connection already exists between the pair of subjects, one of the two
 * (picked at random) is offered the chance to break the connection. If no
 * connection already exists, one of the two (picked at random) is offered the
 * chance to form a new connection." A participant can be offered several at once.
 *
 * Note what is shown: the other's last choice, and nothing else. Not their
 * number of connections, not where they sit — "we do not inform subjects about
 * the structure of the network or how many of their neighbors are connected to
 * the player they are currently evaluating."
 */
function Rewire({ state, told, player }) {
  const offers = told?.get("offers") ?? [];
  const answers = state?.get("rewireAnswers") ?? {};
  const submitted = player.stage.get("submit");

  const answer = (otherID, value) => {
    // Written to this participant's own channel; the server reads it at stage
    // end. Writing into the other party's scope would work — nothing prevents it
    // — and would be building on the absence of write access control.
    state?.set("rewireAnswers", { ...answers, [otherID]: value });
  };

  return (
    <div className="p-8 space-y-6 max-w-prose">
      <h2 className="text-lg font-semibold">Connections</h2>

      {offers.length === 0 ? (
        <p className="text-sm text-gray-500">
          You have no connection decisions this round.
        </p>
      ) : (
        <ul className="space-y-4">
          {offers.map((offer) => {
            const chosen = answers[offer.with];
            return (
              <li key={offer.with} className="border rounded p-3 space-y-2">
                <p className="text-sm">
                  Participant <span className="text-gray-500">…{offer.with.slice(-6)}</span>{" "}
                  last <ActionBadge action={offer.theirLastAction} />.
                </p>
                <p className="text-sm font-medium">
                  {offer.exists
                    ? "You are connected to them. Break the connection?"
                    : "You are not connected to them. Form a connection?"}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => answer(offer.with, true)}
                    className={`px-3 py-1 rounded border-2 text-sm ${
                      chosen === true ? "border-black font-medium" : "border-gray-300"
                    }`}
                  >
                    {offer.exists ? "Break it" : "Form it"}
                  </button>
                  <button
                    onClick={() => answer(offer.with, false)}
                    className={`px-3 py-1 rounded border-2 text-sm ${
                      chosen === false ? "border-black font-medium" : "border-gray-300"
                    }`}
                  >
                    Leave it as it is
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        handleClick={() => player.stage.set("submit", true)}
        primary={!submitted}
        disabled={submitted}
      >
        <p>{submitted ? "Waiting for others…" : "Done"}</p>
      </Button>
      <p className="text-xs text-gray-400">
        Anything you leave undecided stays as it is.
      </p>
    </div>
  );
}

export function Game() {
  const player = usePlayer();
  const stage = useStage();
  const state = useNetworkState();
  const told = useNetworkTold();
  const neighbors = useNeighbors();
  const self = useNetworkSelf();

  // `undefined` means "not known yet" and is deliberately distinct from `[]`,
  // which means "genuinely has no connections". Rendering [] while loading would
  // show this participant as isolated and look entirely normal — and in this
  // design being isolated is a real state that a defector can end up in, so the
  // two must not be conflated.
  if (!neighbors) {
    return <div className="p-8 text-gray-500">Joining the network…</div>;
  }

  const name = stage?.get("name");

  return (
    <div>
      {name === "rewire" ? (
        <Rewire state={state} told={told} player={player} />
      ) : (
        <Decide neighbors={neighbors} state={state} told={told} player={player} />
      )}
      <p className="px-8 pb-8 text-xs text-gray-400">
        You are node …{self?.playerID?.slice(-6)} with {self?.degree} connection(s).
        Nobody else&apos;s choices are sent to this browser.
      </p>
    </div>
  );
}
