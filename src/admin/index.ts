/**
 * Server-side entry. Node only — imports @empirica/core/admin, which cannot be
 * loaded unbundled (docs/PLATFORM-NOTES.md §3a). Never import this from client
 * code.
 */
export { Nbhd, networkKinds, assertKindsRegistered, KindsNotRegisteredError, REGISTRATION_DIFF } from "./kinds.js";
export type { NetworkKinds } from "./kinds.js";
export { provisionChannels, readChannels, resetChannels } from "./provision.js";
export type { ChannelMap, ProvisionResult } from "./provision.js";
export { withNetwork, readNetwork } from "./with_network.js";
export type { NetworkConfig, NetworkHandle, ProjectContext } from "./with_network.js";
export { validateProjection, projectionBytes, ProjectionError } from "./projection.js";
export {
  checkDegrees,
  checkViewBytes,
  resolveEnvelope,
  DEFAULT_ENVELOPE,
  EnvelopeError,
} from "./envelope.js";
export type { EnvelopeLimits, ResolvedEnvelope } from "./envelope.js";
export { hashSeed, makeRng, randInt, shuffle } from "./seed.js";
export * as topology from "../topology/index.js";
export type { Rng } from "./seed.js";
export * from "../shared/keys.js";
