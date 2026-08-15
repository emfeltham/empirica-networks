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
 *   npm run bench                    # the default cells
 *   npm run bench -- --max 100       # skip the big ones
 *   npm run bench -- --rounds 200
 *
 * What is measured is END-TO-END publish latency: the wall time from a watched
 * attribute changing to a neighbour's client holding the new value. That is the
 * number a participant experiences, and it includes everything this package adds
 * on top of the transport.
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
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { ringLattice } from "../../src/topology/index.js";
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
  /** Half-degree: ringLattice(n, m) has degree 2m. */
  m: number;
}

/** Sparse and realistic: degree 8 is the spike's cell, and the README's claim. */
const CELLS: Cell[] = [
  { n: 25, m: 4 },
  { n: 50, m: 4 },
  { n: 100, m: 4 },
  { n: 150, m: 4 },
  { n: 200, m: 4 },
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
    env: { ...process.env, BENCH_URL: url, BENCH_INDEX: String(index), BENCH_COUNT: String(count) },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
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

async function runCell(cell: Cell): Promise<void> {
  resetChannels();
  const { n, m } = cell;
  // Never fewer than two: one shard means every participant is back in a single
  // event loop, which is the arrangement this rewrite exists to escape.
  const shardCount = Math.min(MAX_SHARDS, Math.max(2, Math.ceil(n / PER_SHARD)));

  const listeners = (_: any) => {
    _.unique.on("game", "start", (_ctx: any, { game }: any) => {
      if (!game.get("start")) return;
      const round = game.addRound({});
      round.addStage({ duration: 3_600_000 });
    });
    withNetwork(_, {
      topology: ({ playerCount }: any) => ringLattice(playerCount, m),
      project: (neighbour: any) => ({ id: neighbour.id, tick: neighbour.get("tick") }),
      watch: ["tick"],
      // Degree 8 is inside the default, but say so rather than rely on it.
      envelope: { maxDegree: 16, onExceed: "throw" },
    });
  };

  await withServer(
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

        console.log(
          `  n=${String(n).padStart(3)}  d=${2 * m}  shards=${shardCount}  ` +
            `mean ${mean.toFixed(1).padStart(6)}ms  ` +
            `p50 ${percentile(sorted, 50).toFixed(1).padStart(6)}ms  ` +
            `p95 ${percentile(sorted, 95).toFixed(1).padStart(6)}ms  ` +
            `p99 ${percentile(sorted, 99).toFixed(1).padStart(6)}ms  ` +
            `max ${sorted[sorted.length - 1]?.toFixed(1).padStart(6)}ms`
        );
        console.log(
          `${" ".repeat(10)}delivered ${sorted.length}/${expected} expected receipts` +
            `${silent > 0 ? `, ${silent} SILENT ROUNDS` : ""}` +
            `, clock spread across shards ${clockSpread.toFixed(1)}ms`
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
}

async function main(): Promise<void> {
  if (!SHARD_ENTRY) {
    throw new Error("BENCH_SHARD is not set — run this through `npm run bench`");
  }
  console.log("\n  empirica-networks — end-to-end publish latency\n");
  console.log(
    `  attribute set -> a neighbour's client holds the new value\n` +
      `  ${ROUNDS} rounds per cell, ${WARMUP} warmup dropped, one writer per round\n`
  );
  for (const cell of CELLS) {
    if (cell.n > MAX_N || cell.n < MIN_N) continue;
    // A cell that cannot start is a RESULT, not a crash: n=200 does not reach
    // first publish on this platform (docs/PLATFORM-NOTES.md §16), and aborting
    // the run there would throw away the cells that did work.
    try {
      await runCell(cell);
    } catch (e) {
      console.log(
        `  n=${String(cell.n).padStart(3)}  d=${2 * cell.m}  ` +
          `DID NOT COMPLETE: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  console.log(
    "\n  Every sample is one recipient's receipt, so a round of degree d\n" +
      "  contributes up to d of them: the tail is the slowest neighbour, not an\n" +
      "  average one. Receipts are taken on the mode's own flush — the moment a\n" +
      "  real client could first render — not by polling.\n" +
      "\n  CAVEATS. Participants are sharded across processes, but all of them\n" +
      "  and the server are on ONE MACHINE, so at n=400 they compete for cores\n" +
      "  and the network is loopback: no real WAN latency is included here.\n" +
      "  Each line is a single run; SPIKE-REPORT.md §5-6 asks for three with\n" +
      "  fresh servers before a number is published.\n"
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  bench failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
