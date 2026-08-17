import { Scope, classicKinds } from "@empirica/core/admin/classic";
import { NBHD_KEYS, NBHD_KIND } from "../shared/keys.js";
import { REGISTRATION_DIFF } from "./registration.js";

/**
 * Admin-side model for a participant's private channel.
 *
 * One `nbhd` scope per participant, linked to that participant alone. This is
 * the ONLY channel through which projected state reaches a client, because:
 *
 *  - the `player` scope cannot be private: Classic links the cross product of
 *    every participant to every player node so the UI can render other players
 *    (admin/classic/classic.ts:304-324);
 *  - `{private: true}` does not restrict per-participant visibility despite its
 *    docstring (SPIKE-REPORT.md §2).
 *
 * Kinds is intentionally loose (`any`). Typing it as the network kind set is
 * circular — the kind map references this class, which references the map — and
 * core's own models take the same shortcut.
 */
export class Nbhd extends Scope<any, any> {
  /** Participant this channel belongs to. Immutable, written at creation. */
  get ownerParticipantID(): string | undefined {
    return this.get(NBHD_KEYS.OWNER) as string | undefined;
  }

  /** Player scope id this channel corresponds to. Immutable. */
  get playerID(): string | undefined {
    return this.get(NBHD_KEYS.PLAYER_ID) as string | undefined;
  }
}

/**
 * The kind set a consumer must register.
 *
 * This is NOT optional and NOT ergonomics: `EventContext` has no
 * `setAttributes`, so the only write path from inside a listener is
 * `scope.set()`, which requires the kind to be registered and subscribed.
 * Registration happens in the consumer's own `server/src/index.js`, not in the
 * CLI — see the error thrown by `assertKindsRegistered`.
 */
export const networkKinds = {
  ...classicKinds,
  [NBHD_KIND]: Nbhd,
} as const;

export type NetworkKinds = typeof networkKinds;

/**
 * Re-exported so the public surface is one import, while the definition lives
 * where `with_network.ts` can reach it — this module imports
 * `@empirica/core/admin/classic` for `classicKinds`, and anything importing it
 * inherits that module's `tmp` → `require("fs")` problem. See `registration.ts`.
 */
export { REGISTRATION_DIFF } from "./registration.js";

export class KindsNotRegisteredError extends Error {
  constructor() {
    super(
      `empirica-networks: the "${NBHD_KIND}" scope kind is not registered.\n` +
        `Projected state cannot be written or delivered without it.\n${REGISTRATION_DIFF}`
    );
    this.name = "KindsNotRegisteredError";
  }
}

/**
 * Verify the consumer registered our kinds. **The eager check, and opt-in.**
 *
 * Checked by identity of the constructor rather than by name, so a different
 * class registered under the same key still fails.
 *
 * `withNetwork` CANNOT call this: it is handed the listeners collector, and the
 * kind map goes to `AdminContext.init` in a different file. Reaching it from a
 * listener context means going through an `@internal` constructor field and then
 * a `protected` member of `Scopes`, which would make a *fifth* version-fragile
 * dependency on upstream internals (`.github/workflows/drift.yml`) in order to
 * check one thing — and the check would go quiet exactly when upstream moved,
 * which is the failure mode it exists to prevent.
 *
 * So this is for the one place that legitimately holds the map — the consumer's
 * own `server/src/index.js`, where it is one line and fails before the server
 * starts:
 *
 *     const kinds = { ...classicKinds, ...whateverElse };
 *     assertKindsRegistered(kinds);
 *     const ctx = await AdminContext.init(…, kinds);
 *
 * The automatic check is `registrationNotDetectedMessage` in `./registration.ts`,
 * which observes the consequence instead. It fires later and warns rather than
 * throwing; this one fires immediately and throws. Use both.
 *
 * For four milestones this function was exported and **called by nothing**,
 * while three documents recorded the trap as "impossible to skip silently" on
 * the strength of it (`ISSUES.md` O14).
 */
export function assertKindsRegistered(kinds: Record<string, unknown> | undefined): void {
  if (!kinds || kinds[NBHD_KIND] !== Nbhd) throw new KindsNotRegisteredError();
}
