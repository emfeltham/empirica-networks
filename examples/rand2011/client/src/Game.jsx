import { usePlayer, useStage } from "@empirica/core/player/classic/react";
import {
  COOPERATION_CSS,
  NetworkGraph,
  NetworkGraphStyles,
  useNeighbors,
  useNetworkGraph,
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
 * THE GRAPH IS A STAR, AND THAT IS THE DESIGN. It is built from `useNeighbors()`
 * alone, so it can only ever show you and the people you are tied to — never a
 * tie between two of them, never anyone further out. Breadboard drew the same
 * picture under the same limit, enforced server-side. The paper is explicit that
 * the limit is part of the manipulation: "we do not inform subjects about the
 * structure of the network or how many of their neighbors are connected to the
 * player they are currently evaluating."
 *
 * A REWIRING OFFER IS NOT ON THE GRAPH WHEN IT IS AN OFFER TO FORM. It cannot be:
 * that person is not your neighbor, so nothing about them is in the projection.
 * They arrive through `tell()` and are shown in the panel as a single node in the
 * same visual language — which is what Breadboard's own rewiring screen does.
 *
 * This is a RECONSTRUCTION. No participant data has been collected and no result
 * here has been compared with the paper's. See docs/EXPERIMENTS.md.
 */

const COOPERATE = "C";
const DEFECT = "D";

function ActionBadge({ action }) {
  if (action === COOPERATE) return <span className="text-orange-700 font-medium">cooperated</span>;
  if (action === DEFECT) return <span className="text-sky-700 font-medium">defected</span>;
  return <span className="text-gray-400">has not chosen yet</span>;
}

/** One participant, drawn the way the graph draws them. Breadboard's idiom. */
function MiniNode({ action }) {
  return (
    <svg viewBox="0 0 80 80" className="w-16 h-16 shrink-0 nbhd-graph" aria-hidden="true">
      <circle cx="40" cy="40" r="30" {...(action ? { action } : {})} />
    </svg>
  );
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

function describeNode(n, self) {
  const label = { C: "cooperated", D: "defected" };
  if (n.self) return `You: ${label[self] ?? "no choice yet"}.`;
  return `A connection: last ${label[n.data?.action] ?? "no choice yet"}.`;
}

/** The cooperation decision. One choice, applied to every connection. */
function Decide({ graph, neighbors, state, told, player, action }) {
  const submitted = player.stage.get("submit");

  return (
    <div className="h-full flex flex-col md:flex-row">
      <div className="h-1/3 md:h-full md:w-1/2 bg-white p-4">
        <NetworkGraph
          model={graph}
          ariaLabel="You and the participants you are connected to."
          describe={(n) => describeNode(n, action)}
        />
      </div>

      <div className="h-2/3 md:h-full md:w-1/2 overflow-auto bg-gray-100 border-l-2 border-gray-200 p-8 space-y-6">
        <Score score={told?.get("score")} />
        <Feedback feedback={told?.get("rewireFeedback")} />

        <div>
          <h2 className="text-lg font-semibold">Your connections ({neighbors.length})</h2>
          {neighbors.length === 0 ? (
            <p className="mt-2 text-gray-500">
              You have no connections at the moment, so this round you neither pay nor
              receive anything.
            </p>
          ) : (
            <p className="mt-2 text-sm text-gray-500">
              Orange cooperated last round; blue defected; faded has not chosen yet.
            </p>
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
function Rewire({ graph, state, told, player, action }) {
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
    <div className="h-full flex flex-col md:flex-row">
      <div className="h-1/3 md:h-full md:w-1/2 bg-white p-4">
        <NetworkGraph
          model={graph}
          ariaLabel="You and the participants you are connected to."
          describe={(n) => describeNode(n, action)}
        />
      </div>

      <div className="h-2/3 md:h-full md:w-1/2 overflow-auto bg-gray-100 border-l-2 border-gray-200 p-8 space-y-6">
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
                <li key={offer.with} className="border rounded p-3 bg-white">
                  <div className="flex gap-3 items-center">
                    {/* The same visual language as the graph, so the person
                        under consideration is recognisably one of its nodes —
                        which for a "form" offer they are not yet, and cannot be. */}
                    <MiniNode action={offer.theirLastAction} />
                    <div className="space-y-1">
                      <p className="text-sm">
                        This participant last <ActionBadge action={offer.theirLastAction} />.
                      </p>
                      <p className="text-sm font-medium">
                        {offer.exists
                          ? "You are connected to them. Break the connection?"
                          : "You are not connected to them. Form a connection?"}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
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

  const action = state?.get("action");
  const offers = told?.get("offers") ?? [];
  // Which of my ties is under a break offer this round. A "form" offer names
  // somebody who is not in the graph at all, so it cannot be marked on it.
  const breaking = new Set(offers.filter((o) => o.exists).map((o) => o.with));
  const answers = state?.get("rewireAnswers") ?? {};

  const graph = useNetworkGraph(
    {
      nodeAttrs: (n) => ({ action: n.self ? action : n.data?.action }),
      edgeAttrs: (_, b) => ({
        // Marked only once the participant has said to cut it, so the graph
        // reports a decision rather than pre-empting one.
        breaking: !!b.data?.id && answers[b.data.id] === true,
        focal: !!b.data?.id && breaking.has(b.data.id) ? 1 : 0,
      }),
    },
    { action }
  );

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
    <div className="h-full flex flex-col">
      <NetworkGraphStyles extra={COOPERATION_CSS} />
      <div className="flex-1 min-h-0">
        {name === "rewire" ? (
          <Rewire graph={graph} state={state} told={told} player={player} action={action} />
        ) : (
          <Decide
            graph={graph}
            neighbors={neighbors}
            state={state}
            told={told}
            player={player}
            action={action}
          />
        )}
      </div>
      <p className="px-8 py-2 text-xs text-gray-400 border-t">
        You are node …{self?.playerID?.slice(-6)} with {self?.degree} connection(s).
        Nobody else&apos;s choices are sent to this browser.
      </p>
    </div>
  );
}
