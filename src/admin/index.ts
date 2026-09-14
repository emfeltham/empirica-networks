/**
 * Server-side entry. Node only — imports @empirica/core/admin, which cannot be
 * loaded unbundled (docs/PLATFORM-NOTES.md §3a). Never import this from client
 * code.
 */
export {
  Nbhd,
  networkKinds,
  assertKindsRegistered,
  KindsNotRegisteredError,
  REGISTRATION_DIFF,
} from "./kinds.js";
// The automatic counterpart to `assertKindsRegistered`, exported so a test can
// assert the message and a consumer can recognize it. Defined apart from
// `kinds.ts` so `with_network.ts` can import it without inheriting
// @empirica/core/admin/classic — see `registration.ts`.
export {
  REGISTRATION_CHECK_MS,
  REGISTRATION_CHECK_PER_CHANNEL_MS,
  registrationWaitMs,
  registrationNotDetectedMessage,
  registrationRetractionMessage,
} from "./registration.js";
export type { NetworkKinds } from "./kinds.js";
export { provisionChannels, readChannels, resetChannels } from "./provision.js";
export type { ChannelMap, ProvisionResult } from "./provision.js";
export {
  withNetwork,
  readNetwork,
  readRadius,
  readSeed,
  network,
  gameIDOf,
} from "./with_network.js";
export type {
  GameNetwork,
  GameRef,
  NetworkConfig,
  NetworkHandle,
  NetworkStats,
  PrivateStateEvent,
  ProjectContext,
} from "./with_network.js";
export { validateProjection, projectionBytes, ProjectionError } from "./projection.js";
export {
  checkDegrees,
  checkViewBytes,
  checkNeighborhoodBytes,
  resolveEnvelope,
  defaultMaxDegree,
  DEFAULT_ENVELOPE,
  MEASURED_DENSE_N,
  MEASURED_SPARSE_DEGREE,
  EnvelopeError,
} from "./envelope.js";
export type { EnvelopeLimits, ResolvedEnvelope } from "./envelope.js";
export {
  edgeRows,
  snapshotRows,
  viewRows,
  historyIsConsistent,
  parseNdjson,
  toCSV,
} from "./export.js";
export type { EdgeRow, NdjsonParse, SnapshotRow, ViewRow } from "./export.js";
export { makeViewSink } from "./views.js";
export type { ViewsConfig, ViewSink } from "./views.js";
// The shared writer behind both `views: { file }` and `log: { file }`. Exported
// because the run log's config type is the sink's, and a consumer typing a
// `log:` object needs the name.
export { makeLogSink, makeNdjsonSink } from "./sink.js";
export type { LogConfig, LogRecord, NdjsonSink, NdjsonSinkConfig, SinkOptions } from "./sink.js";
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
