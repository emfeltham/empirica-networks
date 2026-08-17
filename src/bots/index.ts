/**
 * Artificial participants: `empirica-networks/bots`.
 *
 * `@empirica/core@1.12.5` ships no bot facility of any kind (`docs/PLATFORM-NOTES.md`
 * §17), and a substantial slice of network-experiment designs needs one — the
 * contribution of Shirado & Christakis (2017) is entirely what its bots do. This
 * is that facility, built the only way the platform allows: a headless
 * participant process, indistinguishable from a browser at the wire.
 *
 * **This entry point cannot be loaded from bare Node ESM.** It reaches
 * `@empirica/core/admin` for `TajribaConnection`, which dies on
 * `cross-fetch/polyfill` (§3a), so it is shipped as a bundled CJS artefact and
 * the export map has one `default` condition rather than an `import` that would
 * resolve and then fail. Run your bot script with plain `node`; `require` and
 * `import` both work. See `docs/BOTS.md`.
 */
export { runBots } from "./runner.js";
export type { BotRun, BotRunOptions } from "./runner.js";
export type { BotContext, BotPolicy } from "./policy.js";
export { botIdentifiers, botMarkerWarning, assertIdentifiers } from "./identity.js";
export {
  botPhase,
  stallMessage,
  stallReason,
  BOT_ACTS_IN,
  type BotObservation,
  type BotPhase,
} from "./lifecycle.js";
