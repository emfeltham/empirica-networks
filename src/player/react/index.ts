import { usePartModeCtx, usePartModeCtxKey } from "@empirica/core/player/classic/react";
import { useMemo } from "react";
import type { EmpiricaNetworkContext, Nbhd } from "../mode.js";
import { networkStateOf, type NetworkState } from "../state.js";
import { neighborChatOf, type NeighborChat } from "../chat.js";
import {
  assertNetworkMode,
  neighborsOf,
  networkSelfOf,
  NetworkModeNotInstalledError,
  type NetworkSelf,
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
 * The neighbours this participant can see, as returned by the server's
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
 *   state.set("choice", "A");     // only neighbours will see it, via project()
 *
 * Use this instead of `player.set()` for anything that must stay inside the
 * neighbourhood: player attributes are broadcast to every participant, so
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
 * Neighbour-scoped chat.
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

export { NetworkModeNotInstalledError };
export type { NeighborChat, NetworkSelf, NetworkState };
