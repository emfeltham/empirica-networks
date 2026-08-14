/**
 * Client-side entry. Safe in browser bundles: imports only
 * @empirica/core/player*, never /admin.
 */
export { EmpiricaNetwork, Nbhd, DonesWiringError } from "./mode.js";
export type { EmpiricaNetworkContext, NetworkContext } from "./mode.js";
// Derivations, usable without React — headless clients and bots need these too.
export {
  assertNetworkMode,
  neighborsOf,
  networkSelfOf,
  NetworkModeNotInstalledError,
} from "./view.js";
export type { NetworkSelf } from "./view.js";
export * from "../shared/keys.js";
