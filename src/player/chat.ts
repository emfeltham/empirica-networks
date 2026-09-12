/**
 * Neighbor-scoped chat, client side.
 *
 * Sending and receiving use different routes, and the asymmetry is deliberate.
 * A participant can only write to their OWN channel, so `send` writes to an
 * outbox there and the server fans the message out to whoever is currently a
 * neighbor. Writing directly into a neighbor's channel would work — nothing
 * in Empirica prevents it (docs/PLATFORM-NOTES.md §4a) — and would be building
 * on the absence of write access control, which is a bug to design against.
 *
 * Received messages arrive on this participant's own channel, so what has
 * already been delivered survives a rewire: dropping a tie stops new messages
 * without erasing the conversation.
 */
import { NBHD_KEYS, OUTBOX_KEY, type ChatMessage } from "../shared/keys.js";
import type { Nbhd } from "./mode.js";
import { networkStateOf } from "./state.js";

export interface NeighborChat {
  /** Everything delivered to this participant, oldest first. */
  messages: ChatMessage[];
  /** Send to your current neighbors. Returns the message's sequence number. */
  send(text: string): number;
}

export function neighborChatOf(nbhd: Nbhd | undefined): NeighborChat | undefined {
  if (!nbhd) return undefined;
  const state = networkStateOf(nbhd);
  if (!state) return undefined;

  return {
    messages: (nbhd.get(NBHD_KEYS.CHAT) ?? []) as unknown as ChatMessage[],
    send(text: string): number {
      // The sequence number is what lets the server drop a duplicate relay: an
      // attribute listener can fire again for a value it has already seen, and
      // without a counter the same message would appear twice in a transcript.
      const prev = state.get<{ seq?: number }>(OUTBOX_KEY);
      const seq = (prev?.seq ?? 0) + 1;
      state.set(OUTBOX_KEY, { seq, text, at: Date.now() });
      return seq;
    },
  };
}
