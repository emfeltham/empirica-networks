/**
 * Envelope enforcement.
 *
 * The module's measured support envelope is narrow, and the failure mode outside
 * it is not an error — it is an experiment that runs, looks fine to the
 * researcher, and delivers updates late to participants on slower connections.
 * By the time that is noticed the data is collected. So the limits are enforced
 * by default and have to be opted out of deliberately.
 *
 * Three limits, and they rest on DIFFERENT kinds of evidence. That distinction is
 * kept explicit in the messages, because a number presented as measured when it
 * was guessed is worse than no number:
 *
 *   maxDegree     MEASURED, and n-dependent since 2026-08-16. See
 *                 `defaultMaxDegree` for what each branch rests on.
 *
 *   maxViewBytes  NOT measured, and not a performance limit. It is a footgun
 *                 detector: one neighbour's view exceeding 8 KiB almost always
 *                 means project() returned more than the author intended. Set it
 *                 higher if your projection is genuinely large.
 *
 *   maxNbhdBytes  NOT measured either, and it exists because the degree
 *                 measurement deliberately did not measure it. See
 *                 `EnvelopeLimits.maxNeighbourhoodBytes`.
 *
 * Zero dependencies, so it unit tests without a server (same as `seed.ts`).
 */

export interface EnvelopeLimits {
  /**
   * Max neighbours any one participant may have.
   *
   * Defaults to `defaultMaxDegree(n)`, which is `n - 1` at n <= 50 and 16 above
   * it — so no cap at all within the target regime. Set a number to override.
   */
  maxDegree?: number;
  /** Max serialised bytes for ONE neighbour's view. Default 8192. */
  maxViewBytes?: number;
  /**
   * Max serialised bytes for ONE participant's WHOLE neighbourhood. Default
   * 65536 (64 KiB).
   *
   * **This exists because of what the degree measurement did not measure.** The
   * bench that justified lifting `maxDegree` (see `defaultMaxDegree`) published
   * a two-field projection, so it established that *degree* is cheap in
   * latency — it says nothing about degree x view size, which is the product a
   * participant's connection actually has to carry, and which is what
   * SPIKE-REPORT §4's "dense topologies fail on CLIENT bandwidth" was about.
   *
   * So the per-node degree cap came off and this went on in its place. Removing
   * a limit is only honest if you know which of the things it was accidentally
   * guarding still needs guarding.
   *
   * A footgun detector like `maxViewBytes`, not a measured ceiling: 64 KiB per
   * publish per participant is already generous for a design that projects what
   * it means to. `maxViewBytes` catches one view being too big; this catches many
   * reasonable views adding up, which is the failure a dense graph creates and a
   * per-view limit cannot see.
   *
   * **The number was a guess when it was chosen and has since been measured**
   * (2026-08-16, `npm run bench -- --bytes`, PLATFORM-NOTES §21). It survives,
   * with its meaning sharpened: a design sitting just under the limit — 53 KiB
   * per participant per publish, at n=50 d=49, the densest realistic case in the
   * target regime — delivers at **p50 67ms** against 10-25ms for a small-view
   * design, and drops nothing. So this is a SLOPE, not a cliff, and 64 KiB is
   * about where latency reaches 3x baseline while staying under 100ms.
   *
   * The measurement also confirmed the suspicion the limit was added on: payload
   * costs more at higher degree (~14.5x the bytes buys 1.9x the latency at d=19
   * and 2.9x at d=49), so degree x view size really is the product, and neither
   * per-view nor per-degree limits can see it alone.
   */
  maxNeighbourhoodBytes?: number;
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
  maxNeighbourhoodBytes: number;
  onExceed: "throw" | "warn";
}

/**
 * The degree ceiling that was measured on SPARSE graphs, and only there.
 *
 * SPIKE-REPORT §4: sparse graphs (d <= 16) at n <= 100 ran at ~1x the theoretical
 * floor. That sweep held degree low and varied n, so 16 is a number about n, and
 * for four milestones it was enforced as though it were a number about degree.
 */
export const MEASURED_SPARSE_DEGREE = 16;

/**
 * The largest n at which a COMPLETE graph has been measured. Beyond it, nothing
 * dense has been.
 */
export const MEASURED_DENSE_N = 50;

/**
 * The default degree cap for a graph of n participants.
 *
 * **Two branches, two pieces of evidence, which is the whole point of the
 * function existing.**
 *
 * At **n <= 50 there is no cap** (`n - 1` admits any simple graph). Measured
 * 2026-08-16, `npm run bench -- --dense`, `@empirica/core@1.12.5`, 60 rounds per
 * cell, participants sharded across processes:
 *
 *     n= 20  d= 8   p50  4.1ms   p95  9.8ms   440/440 receipts
 *     n= 20  d=19   p50  7.5ms   p95 13.9ms  1045/1045 receipts
 *     n= 50  d= 8   p50 10.1ms   p95 30.3ms   440/440 receipts
 *     n= 50  d=49   p50 16.1ms   p95 24.6ms  2695/2695 receipts
 *     n=100  d=16   p50  9.9ms   p95 11.6ms   880/880 receipts
 *
 * A COMPLETE graph at n=20 (7.5ms) is faster than a degree-8 ring at n=50
 * (10.1ms) and than the old limit's own cell, n=100 d=16 (9.9ms). Not one receipt
 * was dropped and no round was silent at any density. Degree is a second-order
 * term: what the cells actually track is participants per client process — n=50
 * across 2 shards and n=100 across 4 both put 25 per process and both land near
 * 10ms, while n=20 across 2 puts 10 per process and lands at 4ms.
 *
 * Above **n = 50 the old ceiling stands**, because nothing dense has been measured
 * there and a complete graph at n=100 is twice the fan-out of the largest cell
 * above. This is the conservative direction: the limit stays exactly where the
 * evidence for it is.
 *
 * **What this deliberately does NOT claim.** The bench projects two fields, so it
 * measured degree at small view sizes. Degree x view size is a different quantity
 * and is what SPIKE-REPORT §4's client-bandwidth finding was about — so
 * `maxNeighbourhoodBytes` was added in the same change to guard it. Raising a
 * limit is only honest if you name what the old limit was accidentally covering.
 */
export function defaultMaxDegree(n: number): number {
  if (!Number.isFinite(n)) return MEASURED_SPARSE_DEGREE;
  return n <= MEASURED_DENSE_N ? Math.max(0, n - 1) : MEASURED_SPARSE_DEGREE;
}

/**
 * The defaults, for an n that is unknown or out of the dense-measured range.
 *
 * `maxDegree` here is the CONSERVATIVE branch. `checkDegrees` knows n (it is
 * `adj.length`) and resolves the real default itself; anything that does not know
 * n gets the number that rests on the wider evidence.
 */
export const DEFAULT_ENVELOPE: ResolvedEnvelope = {
  maxDegree: MEASURED_SPARSE_DEGREE,
  maxViewBytes: 8192,
  maxNeighbourhoodBytes: 65536,
  onExceed: "throw",
};

/**
 * Resolve the limits, given n where it is known.
 *
 * `n` is optional because `checkViewBytes` has no idea what n is and does not
 * need one. Omitting it yields the conservative degree default rather than a
 * permissive one.
 */
export function resolveEnvelope(limits: EnvelopeLimits = {}, n?: number): ResolvedEnvelope {
  const base =
    n === undefined
      ? DEFAULT_ENVELOPE
      : { ...DEFAULT_ENVELOPE, maxDegree: defaultMaxDegree(n) };
  return { ...base, ...limits };
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
  // n comes from the topology itself, which is what makes an n-dependent default
  // possible at all: the limit that matters is not "how many neighbours" but
  // "how many neighbours relative to how many participants there are".
  const env = resolveEnvelope(limits, adj.length);
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

  // Which evidence this breach is against, stated in the message. At n <= 50 the
  // only way to exceed the default is to have set a lower one yourself; above it,
  // the limit is the sparse measurement and the reader needs to know that is what
  // they are up against.
  const explanation =
    limits.maxDegree !== undefined
      ? `  This is the limit YOU set. The default at n = ${adj.length} would be ` +
        `${defaultMaxDegree(adj.length)}.\n`
      : `  Measured: a COMPLETE graph is fine up to n = ${MEASURED_DENSE_N} (p50 16ms at\n` +
        `  n=50 d=49, 2026-08-16), so below that there is no degree cap at all. Above it\n` +
        `  the only measurement is SPIKE-REPORT §4's sparse sweep — degree <= ` +
        `${MEASURED_SPARSE_DEGREE} at\n` +
        `  n <= 100 — and a dense graph at this n has never been run. Per-participant\n` +
        `  payload is O(degree), so it fails on CLIENT bandwidth however fast the server\n` +
        `  is.\n`;

  breach(
    `topology exceeds the supported envelope: ${over} of ${adj.length} participants ` +
      `have more than ${env.maxDegree} neighbours (worst: participant ${worstIndex} ` +
      `with ${worstDegree}).\n\n` +
      `${explanation}\n` +
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
  views: { bytes: number; label: string; viewer?: string }[],
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

  if (worst) {
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

  // The aggregate check, second so that "one view is enormous" is reported as
  // that rather than as its consequence.
  checkNeighbourhoodBytes(views, limits, warn);
}

/**
 * Check what ONE participant receives in total, summed over their neighbours.
 *
 * The limit `maxDegree` used to be doing by accident. Lifting the degree cap at
 * n <= 50 rests on a latency measurement taken with a two-field projection
 * (`defaultMaxDegree`), so it establishes that degree is cheap **at small view
 * sizes** and nothing more. Degree x view size is the quantity a participant's
 * connection carries, and it is what SPIKE-REPORT §4's client-bandwidth finding
 * was about.
 *
 * Neither limit can see this on its own: 49 views of 1.5 KiB each are all well
 * inside `maxViewBytes` and add up to 73 KiB per publish per participant, on a
 * graph that `maxDegree` now permits. So the aggregate is checked directly.
 *
 * Grouped by `viewer` when the caller provides it. Without it there is nothing to
 * group by and this is skipped rather than guessed at — a sum over an unknown
 * partition would be either every participant's traffic at once or one
 * participant's, and reporting the wrong one would be worse than reporting none.
 */
export function checkNeighbourhoodBytes(
  views: { bytes: number; label: string; viewer?: string }[],
  limits: EnvelopeLimits = {},
  warn: WarnFn = console.warn
): void {
  const env = resolveEnvelope(limits);

  const totals = new Map<string, { bytes: number; count: number }>();
  for (const v of views) {
    if (v.viewer === undefined) continue;
    const t = totals.get(v.viewer) ?? { bytes: 0, count: 0 };
    t.bytes += v.bytes;
    t.count++;
    totals.set(v.viewer, t);
  }

  let worst: { viewer: string; bytes: number; count: number } | undefined;
  let over = 0;
  for (const [viewer, t] of totals) {
    if (t.bytes <= env.maxNeighbourhoodBytes) continue;
    over++;
    if (!worst || t.bytes > worst.bytes) worst = { viewer, ...t };
  }

  if (!worst) return;

  breach(
    `${over} participant(s) would receive more than ${env.maxNeighbourhoodBytes} bytes ` +
      `in one publish (worst: ${worst.viewer} at ${worst.bytes} bytes across ` +
      `${worst.count} neighbours).\n\n` +
      `  Each neighbour view is individually inside \`maxViewBytes\`; together they\n` +
      `  are not. This is the product a dense graph creates — degree x view size —\n` +
      `  and it is the quantity that fails on CLIENT bandwidth however fast the\n` +
      `  server is (SPIKE-REPORT §4).\n\n` +
      `  Project less per neighbour, use a sparser topology, or raise the limit if\n` +
      `  your participants are on connections that can carry it:\n\n` +
      `    withNetwork(Empirica, { envelope: { maxNeighbourhoodBytes: ${
        worst.bytes * 2
      } } })\n`,
    env,
    warn
  );
}
