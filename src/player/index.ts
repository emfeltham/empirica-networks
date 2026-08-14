/**
 * Client-side entry. Safe in browser bundles: imports only
 * @empirica/core/player*, never /admin.
 */
export { EmpiricaNetwork, Nbhd, DonesWiringError } from "./mode.js";
export type { EmpiricaNetworkContext, NetworkContext } from "./mode.js";
export * from "../shared/keys.js";
