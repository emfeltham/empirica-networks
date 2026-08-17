/**
 * The kind-registration diff and the automatic check's message and timing.
 *
 * **Split out of `kinds.ts`, and the split is load-bearing.** `kinds.ts` imports
 * `classicKinds` from `@empirica/core/admin/classic`, whose module graph reaches
 * `connection_test_helper.ts` → `tmp` → `require("fs")` — which throws under bare
 * Node ESM (`docs/PLATFORM-NOTES.md` §3a). `with_network.ts` needs the message
 * and the timing but not the `Nbhd` class, and importing `kinds.js` to get them
 * dragged that graph into every unit test that touches `with_network` —
 * `game_ref`, `log` and `state_of` all went red on `Dynamic require of "fs"`.
 *
 * So: everything here is plain data and pure functions with no imports at all.
 * `kinds.ts` re-exports `REGISTRATION_DIFF` so the public surface is unchanged.
 *
 * This is the entry-point rule from `docs/CONTRIBUTING.md` §2 asserting itself
 * one layer down — the same failure the root barrel exists to prevent, arriving
 * through an ordinary-looking import inside `admin/`.
 */

/**
 * The edit a consumer has to make. Two lines, and silently fatal if skipped —
 * so we would rather print it than have them discover it as missing data.
 */
export const REGISTRATION_DIFF = `
  // server/src/index.js
- import { Classic, classicKinds, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { Classic, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { networkKinds } from "empirica-networks/admin";

  const ctx = await AdminContext.init(
    argv["url"] || "http://localhost:3000/query",
    argv["sessionTokenPath"],
    "callbacks",
    argv["token"],
    {},
-   classicKinds
+   networkKinds
  );
`;

/**
 * The floor on how long to wait for a provisioned channel to materialise.
 *
 * Five seconds was the WHOLE deadline until 2026-08-16, on the reasoning that
 * "channels materialise in milliseconds at every size in the envelope". That was
 * true and it was load-bearing in a way nobody noticed: it is a statement about
 * SMALL n, and the check applies at every n. Measured (`ISSUES.md` O15, three
 * runs per cell, slowest of each):
 *
 * ```
 *   n= 25     86ms        n=150   4287ms   <- 86% of the old deadline, INSIDE the envelope
 *   n= 50    491ms        n=200   5870ms   <- past it; a run delivering 760/760
 *   n=100   2320ms                            receipts was told it was broken
 * ```
 *
 * It stays as the floor rather than being removed because at small n it is what
 * runs, it is what `test/e2e/kind_registration.test.ts` exercises, and nothing
 * in the measurement suggests it was ever wrong there.
 */
export const REGISTRATION_CHECK_MS = 5000;

/**
 * Added to the floor per channel created — the term that was missing.
 *
 * **Linear, and that is a decision the data forced.** Two shapes were candidates.
 * The competing load at game start is Classic cross-linking every participant to
 * every player scope, O(n²) deliveries (`docs/PLATFORM-NOTES.md` §16), which
 * argues for a quadratic deadline; the subscription replay this check waits on is
 * O(channels), which argues for a linear one. The measurement above settles it:
 * the growth STEEPENS to n=150 and then flattens (n=150 -> 200 is 1.37x for 1.33x
 * the participants), so a quadratic would be extrapolating growth that stops.
 * Linear is the shape that fits and the conservative choice besides.
 *
 * **100ms per channel, and the number is a safety factor, not a fit.** The fitted
 * slowest latency is nearer 30ms per channel. Three times that, because
 * `docs/PLATFORM-NOTES.md` §21 measured a 2.5x sweep-level offset attributable to
 * machine power state alone — the same cell at 7.3ms and 18.3ms an hour apart. A
 * deadline sized to a fit would false-accuse on a cold laptop. This holds a
 * margin of 3.4x-4.3x at every measured n above the floor, and roughly constant,
 * which a flat number cannot do at any value.
 *
 * **The asymmetry is why generous is right.** Waiting longer costs a
 * misconfigured study a few more seconds before it is told — and it is a study
 * that will otherwise never work at all, with someone watching its first game.
 * Firing early costs the warning its credibility, permanently and for every user.
 */
export const REGISTRATION_CHECK_PER_CHANNEL_MS = 100;

/**
 * The deadline for `created` channels, with a test seam.
 *
 * Read from the environment rather than added to `NetworkConfig`, deliberately:
 * a consumer has no reason to tune this, and a public field would be surface to
 * freeze (`PUBLICATION-PLAN.md` §2) purely so a test can run faster. The bench
 * and ceiling runners already take their parameters this way.
 *
 * The seam overrides the whole computation rather than the floor, so a test gets
 * the exact wait it asked for at any channel count. It exists because the e2e
 * witness has to WAIT the deadline out, and five seconds inside a tier that
 * already flakes under weight (`ISSUES.md` O8) is a real cost for no extra
 * confidence — the thing under test is whether the warning fires at all.
 */
export function registrationWaitMs(created: number): number {
  const raw = process.env["EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS"];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return Math.max(REGISTRATION_CHECK_MS, REGISTRATION_CHECK_PER_CHANNEL_MS * created);
}

/** Whole seconds where that reads naturally, one decimal where it does not. */
const secs = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}` : (ms / 1000).toFixed(1));

/**
 * The automatic check's message. **Observes the consequence, and since
 * 2026-08-16 declines to name the cause.**
 *
 * We know `addScopes` created `created` channel scopes — `provisionChannels`
 * throws if a returned payload carries no owner attribute, so their existence in
 * Tajriba is established rather than assumed. If not one of them has come back
 * through the subscription as a MODELLED scope, either the kind map the admin was
 * built with has no entry for our kind — upstream's `Scopes` drops an unknown
 * kind with a `scopes: unknown scope kind` warning and returns, so the scope
 * exists on the server and this process can never hold an object to call `.set()`
 * on — or the subscription is merely behind.
 *
 * **It used to say "almost certainly not registered", and that was not
 * establishable** (`ISSUES.md` O15). At n=200 a run that went on to deliver every
 * one of its 760 receipts was told its correct code was broken. The discriminator
 * was never wrong about the observation; it was wrong to convert an observation
 * into a diagnosis, and one of the two causes is a documented platform behaviour
 * this package cannot see from here. So both causes are named, ordered by
 * likelihood, and the reader is told which to check first.
 *
 * Deliberately a warning rather than a throw, and the reason is where it fires
 * from: a timer, outside the runloop, where a throw is an unhandled rejection
 * that can take down a server with participants in it. A study that is already
 * broken should not also crash.
 */
export function registrationNotDetectedMessage(created: number, waitedMs: number): string {
  return (
    `empirica-networks: ${created} private channel${created === 1 ? " was" : "s were"} created ` +
    `${secs(waitedMs)}s ago and none has materialised. Two things do this, and this process ` +
    `cannot tell them apart.\n` +
    `\n1. THE "nbhd" SCOPE KIND IS NOT REGISTERED — the likely one, and silently fatal: every ` +
    `participant sits with an empty neighbourhood forever and nothing else will report it.` +
    REGISTRATION_DIFF +
    `\n2. The subscription is only slow. Channel delivery queues behind Classic's game-start ` +
    `burst, which grows with the participant count (docs/PLATFORM-NOTES.md §16). This deadline ` +
    `scales with the channels created for that reason, but it is sized from measurements up to ` +
    `n=200.\n` +
    `\nCheck 1 first. net.inspect(gameID).pendingChannels lists who is missing. If a channel ` +
    `does arrive after this, the cause was 2, this warning was wrong, and it will be retracted ` +
    `in this log.`
  );
}

/**
 * Said when a channel arrives after the warning already fired.
 *
 * **The point is that the last word is not a false accusation.** The deadline is
 * sized from a measurement, and a measurement can be short — a slower machine, a
 * larger n than anything in `ISSUES.md` O15's table, an unlucky burst. Without
 * this, the residual failure mode of the fix is the same one the check exists to
 * prevent, pointed the other way: an operator reading a log after the fact finds
 * "your kind is not registered" and no indication that it was.
 *
 * It also converts the remaining risk into evidence. The one thing that would
 * improve the coefficient is a report of an n and a latency that beat it, and
 * this message is the only place that pair is ever printed together.
 */
export function registrationRetractionMessage(
  created: number,
  waitedMs: number,
  arrivedMs: number
): string {
  return (
    `empirica-networks: RETRACTING the registration warning above — it was wrong. A channel ` +
    `materialised ${secs(arrivedMs)}s after provisioning (${created} ` +
    `channel${created === 1 ? "" : "s"}), past the ${secs(waitedMs)}s deadline, so the ` +
    `"nbhd" kind IS registered and nothing is misconfigured.\n` +
    `Nothing to fix. The deadline is sized from measured first-channel latency ` +
    `(ISSUES.md O15) and this run beat it, which means the measurement is short somewhere — ` +
    `worth reporting with the participant count and the figure above.`
  );
}
