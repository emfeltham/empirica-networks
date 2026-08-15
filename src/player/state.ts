import type { JsonValue } from "@empirica/core/player";
import { stateKey } from "../shared/keys.js";
import type { Nbhd } from "./mode.js";

/**
 * A participant's own private state.
 *
 * This is the write path that makes the module's guarantee mean something.
 * `player.set(key, value)` is the obvious thing to reach for and it is broadcast
 * to every participant — Classic cross-links everyone to every player node — so
 * projecting such a value restricts nothing about who can read it. Values
 * written here go to the participant's own channel, which is linked to them
 * alone, and reach anyone else only through the server's `project()`.
 *
 * Keys are namespaced under `state:` so a participant cannot overwrite the
 * server's `neighbors` or `_seq` on the same scope.
 */
export interface NetworkState {
  /** Read one of your own values back. */
  get<T = unknown>(key: string): T | undefined;
  /**
   * Write one of your own values. Visible to the server and, through
   * `project()`, to your neighbours — nobody else.
   *
   * Typed `JsonValue` rather than `unknown` because it goes over the wire as
   * JSON: a Map, a class instance or a function would be silently mangled.
   */
  set(key: string, value: JsonValue): void;
}

export function networkStateOf(nbhd: Nbhd | undefined): NetworkState | undefined {
  if (!nbhd) return undefined;
  return {
    get: <T = unknown>(key: string) => nbhd.get(stateKey(key)) as T | undefined,
    set: (key: string, value: JsonValue) => {
      nbhd.set(stateKey(key), value);
    },
  };
}
