/**
 * Does the shipped implementation still fit the envelope the README claims?
 *
 * The numbers in README "Supported envelope" came from the SPIKE — a different
 * codebase, measured before projection, validation, the recording proxy, the
 * byte-identical check and the private state path existed. Carrying "Verified"
 * across to this package without re-running it is exactly the kind of inherited
 * claim that goes quietly stale.
 *
 * Not part of `npm test`: it takes minutes and spawns 100 participants. Run with
 *   npm run bench
 *
 * What is measured is END-TO-END publish latency: the wall time from a watched
 * attribute changing to the neighbour's client having the new value. That is the
 * number a participant experiences, and it includes everything this package adds
 * on top of the transport.
 */
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ringLattice } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
} from "../../src/verify/harness.js";

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

interface Cell {
  n: number;
  /** Half-degree: ringLattice(n, m) has degree 2m. */
  m: number;
  rounds: number;
}

/**
 * The spike's headline cell, plus two smaller ones to see the trend.
 *
 * 100 rounds, not 20: with 20 samples the "p95" is literally the maximum, so a
 * single scheduling hiccup becomes the headline number. The first WARMUP rounds
 * are discarded — the first publish after game start pays for channel
 * materialisation that no later round repeats.
 */
const CELLS: Cell[] = [
  { n: 25, m: 4, rounds: 100 },
  { n: 50, m: 4, rounds: 100 },
  { n: 100, m: 4, rounds: 100 },
];

const WARMUP = 5;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function viewOf(p: { mode: unknown }): Record<string, unknown> {
  const neighbours = (modeOf(p).nbhd.getValue()?.neighbors ?? []) as {
    id: string;
    tick?: unknown;
  }[];
  return Object.fromEntries(neighbours.map((n) => [n.id, n.tick]));
}

async function runCell(cell: Cell): Promise<void> {
  resetChannels();
  const { n, m, rounds } = cell;
  const latencies: number[] = [];

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    withNetwork(_, {
      topology: ({ playerCount }) => ringLattice(playerCount, m),
      project: (neighbour: any) => ({ id: neighbour.id, tick: neighbour.get("tick") }),
      watch: ["tick"],
      // Degree 8 is inside the default, but say so rather than rely on it.
      envelope: { maxDegree: 16, onExceed: "throw" },
    });
  };

  await withScenario(
    { n, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork, waveSize: 25 },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(n, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
        { label: "gameID assigned", timeoutMs: 120_000 }
      );
      for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
      await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
        label: `first publish at n=${n}`,
        timeoutMs: 180_000,
      });

      // One writer per round, rotating, so the measurement is not dominated by
      // one player's position in the graph.
      for (let r = 0; r < rounds; r++) {
        const actor = participants[r % participants.length]!;
        const actorID = modeOf(actor).player.getValue()!.id;
        const watcherIDs = Object.keys(viewOf(actor));
        const watcher = participants.find((p) =>
          watcherIDs.includes(modeOf(p).player.getValue()!.id)
        );
        if (!watcher) continue;

        const value = `r${r}`;
        const started = performance.now();
        modeOf(actor).player.getValue()!.set("tick", value);
        await waitFor(() => viewOf(watcher)[actorID] === value, {
          label: `round ${r} at n=${n}`,
          timeoutMs: 60_000,
        });
        const elapsed = performance.now() - started;
        if (r >= WARMUP) latencies.push(elapsed);
      }
    }
  );

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  console.log(
    `  n=${String(n).padStart(3)}  d=${2 * m}  ` +
      `mean ${mean.toFixed(1).padStart(6)}ms  ` +
      `p50 ${percentile(sorted, 50).toFixed(1).padStart(6)}ms  ` +
      `p95 ${percentile(sorted, 95).toFixed(1).padStart(6)}ms  ` +
      `p99 ${percentile(sorted, 99).toFixed(1).padStart(6)}ms  ` +
      `max ${sorted[sorted.length - 1]?.toFixed(1).padStart(6)}ms  ` +
      `(${sorted.length} samples, ${WARMUP} warmup dropped)`
  );
}

async function main(): Promise<void> {
  console.log("\n  empirica-networks — end-to-end publish latency\n");
  console.log("  attribute set -> neighbour's client holds the new value\n");
  for (const cell of CELLS) {
    await runCell(cell);
  }
  console.log(
    "\n  Reference: SPIKE-REPORT.md §4 measured 48.6ms p95 at n=100, d=8, 2Hz\n" +
      "  on the pre-package implementation.\n" +
      "\n  CAVEAT, and it is not small: every participant runs in THIS Node\n" +
      "  process, sharing one event loop. At n=100 that is 100 mode instances\n" +
      "  contending for the same thread, which real participants in separate\n" +
      "  browsers do not do. The tail here therefore measures the harness as\n" +
      "  much as the package. Sharding participants across processes is what\n" +
      "  SPIKE-REPORT.md §5-6 requires before publishing any number, and it has\n" +
      "  not been done. Read p50 as indicative and the tail as an upper bound.\n"
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  bench failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
