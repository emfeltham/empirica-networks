/**
 * Envelope enforcement.
 *
 * The module's measured support envelope is narrow, and the failure mode outside
 * it is not an error — it is an experiment that runs, looks fine to the
 * researcher, and delivers updates late to participants on slower connections.
 * By the time that is noticed the data is collected. So the limits are enforced
 * by default and have to be opted out of deliberately.
 *
 * Two limits, and they rest on DIFFERENT kinds of evidence. That distinction is
 * kept explicit in the messages, because a number presented as measured when it
 * was guessed is worse than no number:
 *
 *   maxDegree     MEASURED. The spike verified sparse graphs (d <= 16) at
 *                 n <= 100 running at ~1x the theoretical floor, and found dense
 *                 topologies fail on CLIENT bandwidth however fast the server
 *                 is. See SPIKE-REPORT.md §4.
 *
 *   maxViewBytes  NOT measured, and not a performance limit. It is a footgun
 *                 detector: one neighbour's view exceeding 8 KiB almost always
 *                 means project() returned more than the author intended. Set it
 *                 higher if your projection is genuinely large.
 *
 * Zero dependencies, so it unit tests without a server (same as `seed.ts`).
 */

export interface EnvelopeLimits {
  /** Max neighbours any one participant may have. Default 16. */
  maxDegree?: number;
  /** Max serialised bytes for ONE neighbour's view. Default 8192. */
  maxViewBytes?: number;
  /**
   * What to do when a limit is exceeded. Default "throw".
   *
   * "warn" is the escape hatch: it proceeds anyway and logs once per breach.
   * Use it when you have measured your own setup — not to quiet a message.
   */
  onExceed?: "throw" | "warn";
}

export interface ResolvedEnvelope {
  maxDegree: number;
  maxViewBytes: number;
  onExceed: "throw" | "warn";
}

export const DEFAULT_ENVELOPE: ResolvedEnvelope = {
  maxDegree: 16,
  maxViewBytes: 8192,
  onExceed: "throw",
};

export function resolveEnvelope(limits: EnvelopeLimits = {}): ResolvedEnvelope {
  return { ...DEFAULT_ENVELOPE, ...limits };
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(`empirica-networks: ${message}`);
    this.name = "EnvelopeError";
  }
}

export type WarnFn = (message: string) => void;

function breach(message: string, env: ResolvedEnvelope, warn: WarnFn): void {
  if (env.onExceed === "throw") throw new EnvelopeError(message);
  warn(`empirica-networks: ${message}`);
}

/**
 * Check the topology's degrees. Runs at game start, BEFORE provisioning, so an
 * out-of-envelope experiment fails before any participant is committed to it.
 */
export function checkDegrees(
  adj: number[][],
  limits: EnvelopeLimits = {},
  warn: WarnFn = console.warn
): void {
  const env = resolveEnvelope(limits);
  let worstIndex = -1;
  let worstDegree = 0;
  let over = 0;

  for (const [i, neighbours] of adj.entries()) {
    const d = neighbours.length;
    if (d > env.maxDegree) over++;
    if (d > worstDegree) {
      worstDegree = d;
      worstIndex = i;
    }
  }

  if (over === 0) return;

  breach(
    `topology exceeds the supported envelope: ${over} of ${adj.length} participants ` +
      `have more than ${env.maxDegree} neighbours (worst: participant ${worstIndex} ` +
      `with ${worstDegree}).\n\n` +
      `  Per-participant payload is O(degree), so a dense graph fails on CLIENT\n` +
      `  bandwidth no matter how fast the server is. Verified envelope: sparse\n` +
      `  (degree <= 16) up to n = 100.\n\n` +
      `  Use a sparser topology, or opt out deliberately:\n\n` +
      `    withNetwork(Empirica, { envelope: { maxDegree: ${worstDegree} } })\n` +
      `    withNetwork(Empirica, { envelope: { onExceed: "warn" } })\n`,
    env,
    warn
  );
}

/**
 * Check one neighbour view's serialised size.
 *
 * Reports the WORST offender per publish rather than one message per view: at
 * n=100 with degree 16 a systematic mistake would otherwise emit 1600 identical
 * warnings per publish and bury everything else.
 */
export function checkViewBytes(
  views: { bytes: number; label: string }[],
  limits: EnvelopeLimits = {},
  warn: WarnFn = console.warn
): void {
  const env = resolveEnvelope(limits);
  let worst: { bytes: number; label: string } | undefined;
  let over = 0;

  for (const v of views) {
    if (v.bytes > env.maxViewBytes) {
      over++;
      if (!worst || v.bytes > worst.bytes) worst = v;
    }
  }

  if (!worst) return;

  breach(
    `${over} neighbour view(s) exceed ${env.maxViewBytes} bytes ` +
      `(worst: ${worst.label} at ${worst.bytes} bytes).\n\n` +
      `  This limit is a mistake detector, not a measured performance ceiling: a\n` +
      `  view this large usually means project() returned more than intended.\n` +
      `  Check what it returns, or raise the limit if the size is deliberate:\n\n` +
      `    withNetwork(Empirica, { envelope: { maxViewBytes: ${worst.bytes * 2} } })\n`,
    env,
    warn
  );
}
