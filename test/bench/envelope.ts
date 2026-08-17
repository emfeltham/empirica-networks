/**
 * Does the shipped implementation still fit the envelope the README claims?
 *
 * The numbers in README "Supported envelope" came from the SPIKE — a different
 * codebase, measured before projection, validation, the recording proxy, the
 * byte-identical check and the private state path existed. Carrying "Verified"
 * across to this package without re-running it is exactly the kind of inherited
 * claim that goes quietly stale.
 *
 * Not part of `npm test`: it takes minutes and spawns hundreds of participants.
 *   npm run bench                       # the default cells, one run each
 *   npm run bench -- --max 100          # skip the big ones
 *   npm run bench -- --rounds 200
 *   npm run bench -- --repeats 3        # what SPIKE-REPORT §5-6 asks for
 *   npm run bench -- --dense --payload 1024   # degree x VIEW SIZE, not degree alone
 *
 * What is measured is END-TO-END publish latency: the wall time from a watched
 * attribute changing to a neighbour's client holding the new value. That is the
 * number a participant experiences, and it includes everything this package adds
 * on top of the transport.
 *
 * Alongside it, FIRST-CHANNEL latency — the wall time from the first `addScopes`
 * request to the first `nbhd` scope arriving back on the admin's subscription.
 * A second quantity in a file about one thing, added 2026-08-16 because it is
 * only large under load, and the load is here: it turned out to span two orders
 * of magnitude across these cells and had been assumed constant, which is
 * `ISSUES.md` O15. Reported per run and as the slowest across repeats, since
 * its only consumer is a deadline and a deadline is sized by the worst case.
 *
 * TWO CORRECTIONS to how this used to measure, both made 2026-08-15 and both
 * changing the published numbers:
 *
 * 1. **Receipts come from the mode's subscription, not from polling.** The old
 *    loop waited on `waitFor`, which polls every 25ms, so every latency was
 *    rounded up to a 25ms bin. Measured side by side on the same rounds: polled
 *    p50 52.4ms against a true 33.3ms, with 49 of 55 samples on one bin edge.
 *    The "very tight distribution" the README highlighted was the bin.
 * 2. **Participants live in child processes.** They used to share this event
 *    loop with the server callbacks and the admin connection. Sharding is what
 *    SPIKE-REPORT §5-6 asks for before publishing a number, and it is why n >=
 *    200 was previously unmeasured.
 *
 * This process now runs the server, the callbacks and the admin only; every
 * participant is in a shard (test/bench/shard.ts).
 */
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import { projectionBytes } from "../../src/admin/projection.js";
import { complete, ringLattice } from "../../src/topology/index.js";
import {
  batchConfig,
  connectAdmin,
  createBatch,
  startCallbacks,
} from "../../src/verify/harness.js";
import { withServer } from "../../src/verify/server.js";
import type { Sample } from "./shard.js";

interface Cell {
  n: number;
  /** Half-degree: ringLattice(n, m) has degree 2m. Ignored when `dense`. */
  m: number;
  /** A complete graph instead: degree n-1, the densest a graph can be. */
  dense?: boolean;
  /**
   * Padding per neighbour view, overriding `--payload` for this cell.
   *
   * Per-cell rather than global for a reason measured the hard way on
   * 2026-08-16: the same cell measured 7.3ms and 18.3ms in two sweeps an hour
   * apart, while three repeats WITHIN each sweep agreed to under 10%. Whatever
   * that offset is, it is shared by everything in a sweep — so a comparison
   * across two sweeps mostly measures the sweeps. Any paired question ("does
   * payload cost more than degree?") has to have both arms in ONE sweep, and
   * that is only expressible if the payload rides on the cell.
   */
  payload?: number;
}

const degreeOfCell = (c: Cell): number => (c.dense ? c.n - 1 : 2 * c.m);

/** Sparse and realistic: degree 8 is the spike's cell, and the README's claim. */
const CELLS: Cell[] = [
  { n: 25, m: 4 },
  { n: 50, m: 4 },
  { n: 100, m: 4 },
  { n: 150, m: 4 },
  { n: 200, m: 4 },
];

/**
 * `npm run bench -- --dense`. The cells `maxDegree` needs and did not have.
 *
 * The default `maxDegree: 16` is documented as MEASURED, and the measurement
 * behind it (SPIKE-REPORT §4) swept sparse graphs at n up to 100 — it says
 * nothing about a small dense one. Rand, Arbesman & Christakis (2011) caps degree
 * at nothing and reports a tail to about 20 at n ≈ 19.6, so
 * `examples/rand2011` has to raise the limit to 64 with a paragraph of
 * justification. That paragraph is a bug report: **16 conflates a per-participant
 * payload limit with a latency-at-scale limit, and only the second was measured**
 * (`docs/M6-HARDENING.md` §3.3).
 *
 * So: the same n at two densities, then the same density at two n. That is the
 * comparison that says whether degree or total fan-out is the thing that costs,
 * and it is the input a decision about the default needs.
 *
 * `n=20 d=19` is the cell the Rand reconstruction actually runs.
 */
/**
 * `npm run bench -- --bytes`. Degree x VIEW SIZE, the product nothing had measured.
 *
 * `maxNeighbourhoodBytes` (64 KiB) is documented as NOT measured — a footgun
 * detector standing in for the thing the degree sweep did not cover. These cells
 * are what it would take to replace the guess with a number.
 *
 * PAIRED WITHIN ONE SWEEP, which is the whole design: each degree appears twice,
 * once with a two-field view and once padded to ~1 KiB, so the pair differs only
 * in payload. A sweep-level offset of the kind measured on 2026-08-16 (the same
 * cell at 7.3ms and 18.3ms an hour apart) then cancels, because it applies to
 * both arms equally. Comparing a padded sweep against `--dense` numbers recorded
 * on another day would not have that property, and would have been the obvious
 * thing to do.
 *
 * `n=50 d=49 pad=1024` is the cell that matters: ~54 KiB per participant per
 * publish, just under the current default, and the densest realistic case in the
 * target regime.
 */
const BYTES_CELLS: Cell[] = [
  { n: 20, m: 0, dense: true, payload: 0 },    // d=19, ~1.5 KiB neighbourhood
  { n: 20, m: 0, dense: true, payload: 1024 }, // d=19, ~21 KiB
  { n: 50, m: 0, dense: true, payload: 0 },    // d=49, ~3.7 KiB
  { n: 50, m: 0, dense: true, payload: 1024 }, // d=49, ~54 KiB — near the limit
];

const DENSE_CELLS: Cell[] = [
  { n: 20, m: 4 },              // d=8   — sparse control at the same n
  { n: 20, m: 0, dense: true }, // d=19  — a complete graph at the paper's n
  { n: 50, m: 4 },              // d=8   — sparse control at the same n
  { n: 50, m: 0, dense: true }, // d=49  — well past anything measured
  { n: 100, m: 8 },             // d=16  — the default limit at the measured n
];

/** Rounds are cheap; the first few are not representative. */
const WARMUP = 5;
const MAX_SHARDS = 8;

const argv = process.argv.slice(2);
const flag = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const ROUNDS = flag("rounds", 100);
/** Gap between writes. Above the expected latency, so rounds do not overlap. */
const ROUND_MS = flag("roundMs", 250);
const MAX_N = flag("max", Infinity);
const MIN_N = flag("min", 0);
/**
 * Participants per shard process.
 *
 * Exposed because it turned out to be the dominant term. Sweeping it at n=100,
 * 2026-08-15, p50 fell 43.1 -> 10.1 -> 8.0ms as the slice went 50 -> 25 -> 13,
 * and n=50 in ONE shard (36.2ms) was slower than n=100 across four (10.1ms). The
 * cost tracks participants-per-PROCESS, not n. So every figure this bench prints
 * is an upper bound that keeps falling as the harness is spread thinner — which
 * is the honest thing to say about it, and the reason the sweep is kept.
 */
const PER_SHARD = flag("perShard", 25);
/**
 * Runs per cell, each against a FRESH server.
 *
 * SPIKE-REPORT §5-6 asks for three before a number is published, and until
 * 2026-08-16 every figure in the README was a single run (`ISSUES.md` O1).
 * Default 1 because the sweep is for when a number is about to be quoted, not
 * for the inner loop — but a number quoted from a `--repeats 1` run should say
 * so, and the summary line below does.
 *
 * A fresh server per run matters more than it looks: `withServer` is per-run, so
 * repeats also re-measure process startup, batch creation and first publish,
 * which is where the run-to-run variance actually lives.
 */
const REPEATS = Math.max(1, flag("repeats", 1));
/**
 * Extra bytes per neighbour view. The dimension the bench did not have.
 *
 * `defaultMaxDegree` lifted the degree cap at n <= 50 on a measurement taken
 * with a TWO-FIELD projection, so it established that degree is cheap *at small
 * view sizes* and nothing else. Degree x view size is the product a
 * participant's uplink carries, it is what SPIKE-REPORT §4's client-bandwidth
 * finding was about, and it is what `maxNeighbourhoodBytes` (64 KiB, a guess)
 * was added to guard. Padding each view lets the guess be checked instead.
 *
 * A constant string, so the byte-identical suppression in `publish` is not
 * affected — `tick` is what changes between rounds, exactly as before.
 */
const PAYLOAD = Math.max(0, flag("payload", 0));
/**
 * `--assert`: exit non-zero on a CORRECTNESS regression. Never on a slow one.
 *
 * This is the flag that lets the bench run in CI (`ISSUES.md` O6), and the
 * distinction it draws is the whole decision. A latency threshold on a shared
 * 2-4 vCPU GitHub runner would flap — the dominant term here is participants
 * per process competing for cores, which is precisely what a shared runner
 * cannot hold steady. A gate that flaps gets muted, and a muted job is worse
 * than no job, because it reads as coverage.
 *
 * What IS machine-independent is whether every publish arrived. `delivered ==
 * expected` and `silent == 0` are exact, they do not care how fast the host is,
 * and they are what actually breaks when a regression lands: a dropped
 * republish, a stalled game, a byte-identical check that suppresses too much.
 * So those are the gate, and the timings are recorded beside them ungated.
 *
 * n >= 200 is excluded: it fails to start on this platform for reasons that are
 * not ours (`ISSUES.md` U7, PLATFORM-NOTES §16), and gating on it would make the
 * job red for a documented upstream defect.
 */
const ASSERT = argv.includes("--assert");

/** Above this, a cell failing to start is upstream's known defect, not a regression. */
const ASSERT_MAX_N = 200;

/** Correctness regressions found this run. Empty is the only passing state. */
const failures: string[] = [];

/** Representative of a real one: a Tajriba id plus the round-stamped tick. */
const SAMPLE_ID = "x".repeat(36);
const SAMPLE_TICK = "999:1755300000000.123";

const payloadOf = (c: Cell): number => c.payload ?? PAYLOAD;

/** What one view and one whole neighbourhood weigh, at this payload and degree. */
function viewSizes(d: number, payload: number): { view: number; nbhd: number } {
  const view = projectionBytes(
    payload > 0
      ? { id: SAMPLE_ID, tick: SAMPLE_TICK, pad: "p".repeat(payload) }
      : { id: SAMPLE_ID, tick: SAMPLE_TICK }
  );
  // The array the participant actually receives: d views, brackets and commas.
  return { view, nbhd: d * view + Math.max(0, d - 1) + 2 };
}

const SHARD_ENTRY = process.env.BENCH_SHARD;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

interface Shard {
  proc: ChildProcess;
  /** Global participant indices this shard owns, in local order. */
  offset: number;
  count: number;
  degrees: number[];
  clockRef: number;
  /** Resolve whatever the coordinator is currently waiting on. */
  expect: (t: string) => Promise<any>;
}

function spawnShard(url: string, index: number, offset: number, count: number): Shard {
  const proc = fork(SHARD_ENTRY!, [], {
    env: {
      ...process.env,
      BENCH_URL: url,
      BENCH_INDEX: String(index),
      BENCH_COUNT: String(count),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // A shard that dies takes its IPC channel with it, and `.send()` to a closed
  // channel raises an asynchronous `error` EVENT — not a throw, so no try/catch
  // around the call can see it, and an unhandled `error` on an EventEmitter is
  // fatal to the coordinator. Measured 2026-08-16: the n=200 sweep for
  // `ISSUES.md` O15 lost its second and third repeats this way, after the first
  // had already recorded the shard loss as a result. The whole design of the
  // loop below is that a cell which cannot start is DATA; a crash here threw
  // that away in the one place it was most needed.
  proc.on("error", () => {
    /* the exit handler in `expect` is what reports this, with a reason */
  });
  const shard: Shard = {
    proc,
    offset,
    count,
    degrees: [],
    clockRef: 0,
    expect: (t: string) =>
      new Promise((resolve, reject) => {
        const onMessage = (msg: any) => {
          if (msg?.t === "failed") {
            cleanup();
            reject(new Error(`shard ${index}: ${msg.message}`));
          } else if (msg?.t === t) {
            cleanup();
            resolve(msg);
          }
        };
        const onExit = (code: number | null) => {
          cleanup();
          reject(new Error(`shard ${index} exited (${code}) while waiting for "${t}"`));
        };
        const cleanup = () => {
          proc.off("message", onMessage);
          proc.off("exit", onExit);
        };
        proc.on("message", onMessage);
        proc.on("exit", onExit);
      }),
  };
  return shard;
}

const describeCell = (c: Cell): string =>
  `  n=${String(c.n).padStart(3)}  d=${String(degreeOfCell(c)).padStart(2)}` +
  `  pad=${String(payloadOf(c)).padStart(4)}B`;

/**
 * The repeat summary — the line a published number should be quoted from.
 *
 * Median of the per-run p50s, with the observed range beside it. The range is
 * the point: `ISSUES.md` O1's standing complaint is not that the single runs
 * were wrong, it is that a single run cannot say whether it was typical, and a
 * summary that collapsed to one figure would reproduce that.
 *
 * Spread is reported as a percentage of the median so cells of different
 * magnitudes are comparable at a glance — a 3ms range means something different
 * at p50 4ms than at p50 40ms.
 */
function summarise(cell: Cell, runs: CellResult[]): void {
  if (runs.length === 0) {
    console.log(`${describeCell(cell)}  ── no run completed`);
    return;
  }
  const p50s = runs.map((r) => r.p50).sort((a, b) => a - b);
  const median = percentile(p50s, 50);
  const lo = p50s[0]!;
  const hi = p50s[p50s.length - 1]!;
  const spread = median > 0 ? ((hi - lo) / median) * 100 : NaN;
  const dropped = runs.reduce((a, r) => a + (r.expected - r.delivered), 0);
  const silent = runs.reduce((a, r) => a + r.silent, 0);
  // Worst case, not median. This number's only consumer is a deadline, and a
  // deadline is sized by the slowest run it has to survive — a median would
  // describe exactly the runs that were never in danger.
  const chans = runs.map((r) => r.firstChannelMs).filter((x): x is number => x !== undefined);
  const slowest = chans.length === runs.length ? `${Math.max(...chans)}ms` : "NEVER (some runs)";
  console.log(
    `${describeCell(cell)}  ══ p50 median ${median.toFixed(1)}ms  ` +
      `(${lo.toFixed(1)}–${hi.toFixed(1)} across ${runs.length}/${REPEATS} runs, ` +
      `spread ${spread.toFixed(0)}%)  slowest 1st channel ${slowest}` +
      `${dropped !== 0 ? `  ${dropped} RECEIPTS MISSING` : ""}` +
      `${silent > 0 ? `  ${silent} SILENT ROUNDS` : ""}\n`
  );
}

/** One run of one cell. `p50` is the headline; the rest is what makes it readable. */
interface CellResult {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  delivered: number;
  expected: number;
  silent: number;
  shardCount: number;
  /** p50 over the first third of post-warmup rounds, and over the last third. */
  early: number;
  late: number;
  /**
   * How long the first `nbhd` scope took to come back through the subscription,
   * measured from the first `addScopes` request. `undefined` means none ever
   * did, which at any n in this file is a broken run rather than a slow one.
   */
  firstChannelMs: number | undefined;
  /** 1-minute load average when this run started. */
  load: number;
  /** Coordinator CPU seconds consumed BY THIS RUN, user+system. */
  cpu: number;
  /** Wall seconds this run's measured window took, for a duty-cycle read. */
  wall: number;
}

async function runCell(cell: Cell): Promise<CellResult> {
  resetChannels();
  const { n, m } = cell;
  const d = degreeOfCell(cell);
  const payload = payloadOf(cell);
  const pad = "p".repeat(payload);
  const sizes = viewSizes(d, payload);
  // Never fewer than two: one shard means every participant is back in a single
  // event loop, which is the arrangement this rewrite exists to escape.
  const shardCount = Math.min(MAX_SHARDS, Math.max(2, Math.ceil(n / PER_SHARD)));

  // Kept so the run can report how long the first channel took to come back —
  // the quantity the kind-registration warning races (`ISSUES.md` O15). It is
  // measured here rather than in a test because the only place it has ever been
  // large is under the load this file exists to produce.
  let net: NetworkHandle | undefined;

  const listeners = (_: any) => {
    _.unique.on("game", "start", (_ctx: any, { game }: any) => {
      if (!game.get("start")) return;
      const round = game.addRound({});
      round.addStage({ duration: 3_600_000 });
    });
    net = withNetwork(_, {
      topology: ({ playerCount }: any) =>
        cell.dense ? complete(playerCount) : ringLattice(playerCount, m),
      project: (neighbour: any) =>
        payload > 0
          ? { id: neighbour.id, tick: neighbour.get("tick"), pad }
          : { id: neighbour.id, tick: neighbour.get("tick") },
      watch: ["tick"],
      // Stated rather than relied on. Every limit is raised to exactly what this
      // cell is known to need, for a dense or padded run: the point of such a run
      // is to find out what the limit SHOULD be, so enforcing the current one
      // would make the measurement impossible — but setting the known figure
      // rather than switching the check off means an unexpected topology or an
      // unexpectedly large view still fails loudly.
      envelope: {
        maxDegree: Math.max(16, d),
        maxViewBytes: Math.max(8192, sizes.view * 2),
        maxNeighbourhoodBytes: Math.max(65536, sizes.nbhd * 2),
        onExceed: "throw",
      },
    });
  };

  // The latency survives a failed run, and that is the point: at n=200 most
  // runs do not complete (`docs/PLATFORM-NOTES.md` §16), and those are exactly
  // the runs in which the registration warning fires. Reporting the figure only
  // on success would measure the check everywhere except where it goes wrong.
  try {
    return await withServer(
      async (server) => {
        const admin = await connectAdmin(server);
        const callbacks = await startCallbacks(server, networkKinds, listeners);
        const shards: Shard[] = [];

        try {
          let offset = 0;
          for (let i = 0; i < shardCount; i++) {
            const count = Math.floor(n / shardCount) + (i < n % shardCount ? 1 : 0);
            shards.push(spawnShard(server.url, i, offset, count));
            offset += count;
          }
          // Machine and coordinator state, captured per run rather than per sweep.
          //
          // `ISSUES.md` O1's open half is a ~2.5x offset at a fixed cell that is
          // shared by everything in a sweep and differs between sweeps. Two
          // candidates survive elimination — the COORDINATOR process (one per
          // sweep, so its JIT and heap state is exactly the thing shared) and
          // transient machine load — and neither was measurable from the output.
          // Both are free to record, so now every figure carries them.
          const loadAtStart = os.loadavg()[0]!;
          const cpuAtStart = process.cpuUsage();
          const wallAtStart = Date.now();

          const readies = await Promise.all(shards.map((s) => s.expect("ready")));
          readies.forEach((r, i) => (shards[i]!.clockRef = r.clockRef));

          const batch = await createBatch(admin, batchConfig(n, 1));
          await batch.running();

          const playing = shards.map((s) => s.expect("playing"));
          for (const s of shards) s.proc.send({ t: "play" });
          const played = await Promise.all(playing);
          played.forEach((p, i) => (shards[i]!.degrees = p.degrees));

          // A writer's expected audience is its own degree. Tracking it turns
          // "how fast" into "how fast, and did everyone get it" — at n=400 the
          // second question is the one that can quietly go wrong.
          const degreeOf = (global: number): number => {
            const s = shards.find((x) => global >= x.offset && global < x.offset + x.count)!;
            return s.degrees[global - s.offset] ?? 0;
          };
          let expected = 0;

          for (let r = 0; r < ROUNDS; r++) {
            const global = r % n;
            const s = shards.find((x) => global >= x.offset && global < x.offset + x.count)!;
            s.proc.send({ t: "write", local: global - s.offset, round: r });
            if (r >= WARMUP) expected += degreeOf(global);
            await new Promise((res) => setTimeout(res, ROUND_MS));
          }

          // Let the last rounds land before asking for the tally.
          await new Promise((res) => setTimeout(res, 2_000));
          const collected = await Promise.all(
            shards.map((s) => {
              const p = s.expect("samples");
              s.proc.send({ t: "collect" });
              return p;
            })
          );

          const samples = (collected.flatMap((c) => c.samples) as Sample[]).filter(
            (x) => x.round >= WARMUP
          );
          const sorted = samples.map((x) => x.ms).sort((a, b) => a - b);
          const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
          const clockSpread =
            Math.max(...shards.map((s) => s.clockRef)) - Math.min(...shards.map((s) => s.clockRef));
          const rounds = new Set(samples.map((x) => x.round));
          const silent = ROUNDS - WARMUP - rounds.size;

          // Latency against POSITION IN THE RUN, so a session that gets slower as
          // writes accumulate is visible instead of averaged away. Tajriba stores
          // attributes append-only, so "the 90th write is slower than the 10th"
          // was a plausible mechanism and this is what rules it in or out.
          //
          // Measured 2026-08-16 and it is ruled OUT: n=25 gives the same p50 at 20
          // rounds and at 100 (7.3ms both), and early/late agree within a run. Kept
          // because it is the cheap standing check on a claim the soak cannot make
          // — arm A measures memory over a long session and says nothing about
          // latency over one (PLATFORM-NOTES §14).
          const third = Math.max(1, Math.floor((ROUNDS - WARMUP) / 3));
          const at = (lo: number, hi: number) =>
            percentile(
              samples
                .filter((x) => x.round >= lo && x.round < hi)
                .map((x) => x.ms)
                .sort((a, b) => a - b),
              50
            );
          const early = at(WARMUP, WARMUP + third);
          const late = at(ROUNDS - third, ROUNDS);

          const result: CellResult = {
            mean,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
            max: sorted[sorted.length - 1] ?? NaN,
            delivered: sorted.length,
            expected,
            silent,
            shardCount,
            early,
            late,
            firstChannelMs: net?.stats().firstChannelMs,
            load: loadAtStart,
            cpu: (() => {
              const d = process.cpuUsage(cpuAtStart);
              return (d.user + d.system) / 1e6;
            })(),
            wall: (Date.now() - wallAtStart) / 1000,
          };
          // Reported per run rather than only in the summary: a repeat sweep that
          // printed one aggregate would hide the case the sweep exists to expose,
          // which is one run of three behaving unlike the other two.
          console.log(
            `${describeCell(cell)}  ` +
              `mean ${mean.toFixed(1).padStart(6)}ms  ` +
              `p50 ${result.p50.toFixed(1).padStart(6)}ms  ` +
              `p95 ${result.p95.toFixed(1).padStart(6)}ms  ` +
              `p99 ${result.p99.toFixed(1).padStart(6)}ms  ` +
              `max ${result.max.toFixed(1).padStart(6)}ms`
          );
          console.log(
            `${" ".repeat(10)}shards=${shardCount}  ` +
              `load ${result.load.toFixed(1)}  ` +
              `coordCPU ${result.cpu.toFixed(1)}s/${result.wall.toFixed(0)}s  ` +
              `first/last third ${early.toFixed(1)}/${late.toFixed(1)}ms  ` +
              `1st channel ${result.firstChannelMs === undefined ? "NEVER" : `${result.firstChannelMs}ms`}  ` +
              `view ${sizes.view}B  nbhd ${(sizes.nbhd / 1024).toFixed(1)}KiB  ` +
              `delivered ${sorted.length}/${expected} receipts` +
              `${silent > 0 ? `, ${silent} SILENT ROUNDS` : ""}` +
              `, clock spread ${clockSpread.toFixed(1)}ms`
          );

          for (const s of shards) s.proc.send({ t: "bye" });
          await Promise.all(
            shards.map(
              (s) =>
                new Promise<void>((res) => {
                  if (s.proc.exitCode !== null) return res();
                  s.proc.on("exit", () => res());
                  setTimeout(() => res(), 5_000);
                })
            )
          );
          return result;
        } finally {
          for (const s of shards) {
            try {
              s.proc.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
          try {
            await callbacks.stop();
          } catch {
            /* best effort */
          }
          admin.stop();
        }
      },
      { logLevel: process.env.BENCH_LOG ?? "error" }
    );
  } catch (e) {
    if (e instanceof Error) {
      (e as Error & { firstChannelMs?: number }).firstChannelMs = net?.stats().firstChannelMs;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  if (!SHARD_ENTRY) {
    throw new Error("BENCH_SHARD is not set — run this through `npm run bench`");
  }
  console.log("\n  empirica-networks — end-to-end publish latency\n");
  console.log(
    `  attribute set -> a neighbour's client holds the new value\n` +
      `  ${ROUNDS} rounds per cell, ${WARMUP} warmup dropped, one writer per round\n` +
      `  ${REPEATS} run(s) per cell, fresh server each` +
      `${PAYLOAD > 0 ? `, +${PAYLOAD}B padding per neighbour view` : ""}\n`
  );
  const cells = argv.includes("--bytes")
    ? BYTES_CELLS
    : argv.includes("--dense")
      ? DENSE_CELLS
      : CELLS;
  for (const cell of cells) {
    if (cell.n > MAX_N || cell.n < MIN_N) continue;
    const runs: CellResult[] = [];
    for (let r = 0; r < REPEATS; r++) {
      // A cell that cannot start is a RESULT, not a crash: n=200 does not reach
      // first publish on this platform (docs/PLATFORM-NOTES.md §16), and aborting
      // the run there would throw away the cells that did work. Per REPEAT for
      // the same reason: a cell that fails once and completes twice is a more
      // useful thing to report than a cell with no number at all.
      try {
        const result = await runCell(cell);
        runs.push(result);
        const missing = result.expected - result.delivered;
        // Exact, and machine-independent — see ASSERT. `!==` rather than `>`:
        // MORE receipts than expected means the degree bookkeeping and the
        // delivery disagree, which is as much a defect as a shortfall.
        if (missing !== 0) {
          failures.push(`${describeCell(cell).trim()}: ${missing} receipts missing`);
        }
        if (result.silent > 0) {
          failures.push(`${describeCell(cell).trim()}: ${result.silent} silent rounds`);
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        const ms = (e as Error & { firstChannelMs?: number })?.firstChannelMs;
        console.log(
          `${describeCell(cell)}  DID NOT COMPLETE: ${why}` +
            `  [1st channel ${ms === undefined ? "NEVER" : `${ms}ms`}]`
        );
        if (cell.n < ASSERT_MAX_N) {
          failures.push(`${describeCell(cell).trim()}: did not complete — ${why}`);
        }
      }
    }
    if (REPEATS > 1) summarise(cell, runs);
  }
  console.log(
    "\n  Every sample is one recipient's receipt, so a round of degree d\n" +
      "  contributes up to d of them: the tail is the slowest neighbour, not an\n" +
      "  average one. Receipts are taken on the mode's own flush — the moment a\n" +
      "  real client could first render — not by polling.\n" +
      "\n  CAVEATS. Participants are sharded across processes, but all of them\n" +
      "  and the server are on ONE MACHINE, so at large n they compete for cores\n" +
      "  and the network is loopback: no real WAN latency is included here. The\n" +
      "  dominant term is participants per PROCESS rather than n, so every figure\n" +
      "  is an upper bound that keeps falling as the harness is spread thinner\n" +
      "  (`--perShard`). That confound is the one thing repeats cannot fix: it is\n" +
      "  systematic, so it biases all three runs the same way.\n" +
      (REPEATS > 1
        ? "  Quote the ══ summary line, not an individual run.\n"
        : "  Each line is a SINGLE run; SPIKE-REPORT.md §5-6 asks for three with\n" +
          "  fresh servers before a number is published — use `--repeats 3`.\n") +
      (PAYLOAD > 0
        ? `  Views are padded to ${PAYLOAD}B, so these cells measure degree x view\n` +
          "  size rather than degree alone.\n"
        : "  Views are two fields, so these cells measure degree at SMALL view\n" +
          "  sizes. For degree x view size — what `maxNeighbourhoodBytes` guards —\n" +
          "  use `--payload`.\n")
  );
}

main().then(
  () => {
    if (!ASSERT) process.exit(0);
    if (failures.length === 0) {
      console.log("  --assert: every publish arrived, no silent rounds.\n");
      process.exit(0);
    }
    // Named individually. "The bench failed" sends the reader back to a
    // hundred lines of output to find out which cell and how.
    console.error(`\n  --assert FAILED — ${failures.length} correctness regression(s):\n`);
    for (const f of failures) console.error(`    ${f}`);
    console.error(
      "\n  These are delivery failures, not slow ones: a publish that never\n" +
        "  arrived, or a round no recipient saw. Latency is deliberately NOT\n" +
        "  gated here (`ISSUES.md` O6).\n"
    );
    process.exit(1);
  },
  (e) => {
    console.error("\n  bench failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
