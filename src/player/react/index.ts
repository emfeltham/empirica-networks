import { usePartModeCtx, usePartModeCtxKey } from "@empirica/core/player/classic/react";
import { useMemo } from "react";
import { graphModelOf, type GraphModel, type GraphOptions, type Subgraph } from "../graph.js";
import type { EmpiricaNetworkContext, Nbhd } from "../mode.js";
import { networkStateOf, type NetworkState } from "../state.js";
import { neighborChatOf, type NeighborChat } from "../chat.js";
import {
  assertNetworkMode,
  neighborsOf,
  networkGraphOf,
  networkSelfOf,
  networkToldOf,
  NetworkModeNotInstalledError,
  type NetworkGraphInfo,
  type NetworkSelf,
  type NetworkTold,
} from "../view.js";

/**
 * React hooks.
 *
 * Thin by design. `usePartModeCtxKey` is public and generic, so subscribing to a
 * custom mode key needs no reimplementation of Empirica's subscription plumbing.
 * All derivation lives in `../view.ts`, which is testable without React; what is
 * here is the part that only a browser can exercise.
 *
 * Separate entry point (`empirica-networks/player/react`) so that importing the
 * mode does not pull React into a headless or server bundle.
 */

/**
 * The raw channel scope. Escape hatch; prefer the two hooks below.
 */
export function useNbhd(): Nbhd | undefined {
  // Both hooks run unconditionally — the guard below is a render-time throw, not
  // an early return, so the rules of hooks hold.
  const mode = usePartModeCtx<Partial<EmpiricaNetworkContext>>();
  const nbhd = usePartModeCtxKey<EmpiricaNetworkContext, "nbhd", Nbhd>("nbhd");

  // Checked after the hook calls but before upstream's effect runs, so ours is
  // the error that escapes rather than the TypeError from inside core.
  assertNetworkMode(mode);

  return nbhd;
}

/**
 * The neighbors this participant can see, as returned by the server's
 * `project()`. `undefined` until the first publish; see `neighborsOf`.
 *
 *   const neighbors = useNeighbors<{ id: string; choice: string }>();
 *   if (!neighbors) return <Loading />;
 */
export function useNeighbors<T = unknown>(): T[] | undefined {
  return neighborsOf<T>(useNbhd());
}

/** This participant's own position in the network. */
export function useNetworkSelf(): NetworkSelf | undefined {
  return networkSelfOf(useNbhd());
}

/**
 * Read and write this participant's own PRIVATE state.
 *
 *   const state = useNetworkState();
 *   state.set("choice", "A");     // only neighbors will see it, via project()
 *
 * Use this instead of `player.set()` for anything that must stay inside the
 * neighborhood: player attributes are broadcast to every participant, so
 * projecting one restricts nothing.
 *
 * Memoised on the channel identity so the returned object is stable across
 * renders and safe in a dependency array.
 */
export function useNetworkState(): NetworkState | undefined {
  const nbhd = useNbhd();
  return useMemo(() => networkStateOf(nbhd), [nbhd]);
}

/**
 * Neighbor-scoped chat.
 *
 *   const chat = useNeighborChat();
 *   chat?.messages.map((m) => <li key={`${m.from}-${m.seq}`}>{m.text}</li>);
 *   chat?.send("hello");
 *
 * Requires `chat: true` in `withNetwork(...)`; without it `send` writes to a
 * slot nobody relays and `messages` stays empty.
 *
 * NOT memoised on the channel alone, unlike `useNetworkState`: `messages` is
 * read fresh each render because a new message must re-render, and a stable
 * object holding a stale array would silently stop updating the transcript.
 */
export function useNeighborChat(): NeighborChat | undefined {
  const nbhd = useNbhd();
  return neighborChatOf(nbhd);
}

/**
 * Read what the SERVER told this participant, privately.
 *
 *   const told = useNetworkTold();
 *   const offer = told?.get<{ with: string; theirLastAction: string }>("offer");
 *
 * Written server-side with `network(game).tell(playerID, key, value)`. Nobody
 * else receives it — including the participant it is about.
 *
 * The counterpart to `useNetworkState()`, and the split is the point: `state` is
 * what YOU wrote and your neighbors may see through `project()`; `told` is what
 * the SERVER wrote to you and nobody else sees at all. Needed for anything the
 * server knows and a participant should learn about a NON-neighbor, which
 * `project()` structurally cannot express.
 *
 * NOT memoised, unlike `useNetworkState`: told values change during play, and a
 * stable object holding a stale read would silently stop updating.
 */
export function useNetworkTold(): NetworkTold | undefined {
  return networkToldOf(useNbhd());
}

/**
 * The participant's neighborhood as a drawable node-link model.
 *
 *     const graph = useNetworkGraph({ nodeAttrs: (n) => ({ color: n.data?.color }) });
 *     return <NetworkGraph model={graph} fallback={<p>Joining the network…</p>} />;
 *
 * At the default radius this draws a STAR — the viewer at the center, one node
 * per neighbor, one line to each — and it is built entirely from data this
 * browser already has. Nothing extra crosses the wire to render it, which is
 * what makes a Breadboard-style display cost the neighbor-limited guarantee
 * nothing: Breadboard's own client is also ego-only, sending no tie between two
 * of your neighbors.
 *
 * `undefined` until the first publish, for the same reason `useNeighbors()` is:
 * drawing an isolated node during startup looks entirely normal and is a data
 * validity bug. Branch on it.
 *
 * `self` is the viewer's own projected data — normally `useNetworkState()` reads
 * — and is passed in rather than read here because only the study knows which
 * of its private keys belongs on the screen.
 *
 * NOT memoised, and that is a decision rather than an oversight. The obvious
 * memo keys are `seq` and the neighbor count, and both are wrong: `seq` is
 * written server-side alongside `neighbors` but nothing guarantees this browser
 * applies the two in one batch, so a model rebuilt on `seq` can close over the
 * previous publish's neighbors — a correct-looking picture that is one state
 * behind, which is the exact class of failure this package is written against.
 * The work being skipped is O(degree) over at most a few dozen numbers, bounded
 * by `envelope.maxDegree`. Correctness is worth more than that.
 */
export function useNetworkGraph(
  opts: GraphOptions = {},
  self?: unknown
): GraphModel | undefined {
  const neighbors = useNeighbors();
  const structure = useNetworkStructure();
  return graphModelOf(
    {
      neighbors,
      self,
      subgraph: structure ? { edges: structure.edges, positions: structure.positions } : undefined,
    },
    {
      ...opts,
      // Not the author's to declare: the server says which study this is.
      // `null` means the structure arrived and is unusable, and the one thing
      // that must not happen then is a star — a correct-looking picture of a
      // different study. `undefined` means the key is absent, which at radius 1
      // is the ordinary case.
      expectSubgraph: opts.expectSubgraph ?? structure === null,
    }
  );
}

/**
 * The server-sent structure of this neighborhood, or `undefined` at radius 1.
 *
 * Rarely needed directly — `useNetworkGraph()` already folds it in. Reach for it
 * to branch on the radius a study is actually running at, which is worth doing
 * in instructions text: at 1.5 a participant can see which of their connections
 * know each other, and a screen that does not say so is showing them something
 * they were not told to expect.
 *
 * `undefined` is radius 1; `null` is "arrived and unusable" — see
 * `networkGraphOf`.
 */
export function useNetworkStructure(): NetworkGraphInfo | null | undefined {
  return networkGraphOf(useNbhd());
}

export { NetworkGraph, type NetworkGraphProps } from "./NetworkGraph.js";
export {
  NetworkGraphStyles,
  NETWORK_GRAPH_CSS,
  DARK2_CSS,
  COOPERATION_CSS,
} from "./styles.js";
export type { NetworkGraphInfo };
export {
  egoRingLayout,
  graphModelOf,
  svgAttrs,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type GraphOptions,
  type NodeRef,
  type Point,
  type Subgraph,
} from "../graph.js";

export { NetworkModeNotInstalledError };
export type { NeighborChat, NetworkSelf, NetworkState, NetworkTold };
