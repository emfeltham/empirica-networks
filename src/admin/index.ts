/**
 * Server-side entry. Node only — imports @empirica/core/admin, which cannot be
 * loaded unbundled (docs/PLATFORM-NOTES.md §3a). Never import this from client
 * code.
 */
export { Nbhd, networkKinds, assertKindsRegistered, KindsNotRegisteredError, REGISTRATION_DIFF } from "./kinds.js";
export type { NetworkKinds } from "./kinds.js";
export { provisionChannels, readChannels, resetChannels } from "./provision.js";
export type { ChannelMap, ProvisionResult } from "./provision.js";
export { withNetwork, readNetwork, readSeed, network } from "./with_network.js";
export type {
  GameNetwork,
  NetworkConfig,
  NetworkHandle,
  NetworkStats,
  ProjectContext,
} from "./with_network.js";
export { validateProjection, projectionBytes, ProjectionError } from "./projection.js";
export {
  checkDegrees,
  checkViewBytes,
  resolveEnvelope,
  DEFAULT_ENVELOPE,
  EnvelopeError,
} from "./envelope.js";
export type { EnvelopeLimits, ResolvedEnvelope } from "./envelope.js";
export {
  edgeRows,
  snapshotRows,
  viewRows,
  historyIsConsistent,
  toCSV,
} from "./export.js";
export type { EdgeRow, SnapshotRow, ViewRow } from "./export.js";
export { makeViewSink } from "./views.js";
export type { ViewsConfig, ViewSink } from "./views.js";
// The introspection types and their pure builders. `monitor()` itself is NOT
// re-exported here: it is `empirica-networks/admin/monitor`, so a server that
// never opts in never pulls node:http or the served page into its bundle, and
// so that "does this deployment expose the whole graph" is one grep.
export { graphMetrics, historyFrames } from "./inspect.js";
export type {
  GameSnapshot,
  GraphMetrics,
  HistoryFrame,
  HistoryFrames,
  NodeSnapshot,
} from "./inspect.js";
export { hashSeed, makeRng, randInt, shuffle } from "./seed.js";
export * as topology from "../topology/index.js";
export type { Rng } from "./seed.js";
export * from "../shared/keys.js";
