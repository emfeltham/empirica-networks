/**
 * Memory soak: does anything grow without bound?
 *
 * The spike named server memory as its top remaining unknown, on the grounds
 * that `ephemeral` views live in Tajriba's memory for the lifetime of a game.
 * That is half the question, and it turned out to be the smaller half — the
 * other half was ours, and is fixed (see `test/e2e/retention.test.ts`).
 *
 * Two arms, because they answer different questions and a single run conflates
 * them:
 *
 *   A. ONE LONG GAME — upstream. Our publisher rewrites the same two keys on
 *      every publish, so if Tajriba retains per WRITE rather than per attribute,
 *      RSS grows linearly with the number of publishes and study duration is
 *      capped. If it holds current values only, RSS plateaus. This arm
 *      distinguishes those, which is the actual open question.
 *
 *   B. MANY SEQUENTIAL GAMES — ours. A study is many games in one process. This
 *      is the shape that exposed the retention leak, and the regression guard
 *      for it.
 *
 * METHOD NOTE, and it is load-bearing: this runs against a FILE store, not the
 * harness default of `--tajriba.store.mem`. With the memory store every
 * attribute is resident by construction, so a soak would measure a server
 * configuration nobody deploys and report growth that means nothing.
 *
 * Run with:
 *   npm run soak                  # default duration
 *   npm run soak -- --minutes 2   # quick smoke of both arms
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring, ringLattice } from "../../src/topology/index.js";
import {
  batchConfig,
  connectAdmin,
  connectParticipant,
  createBatch,
  gameInit,
  startCallbacks,
  uniqueNS,
  waitFor,
} from "../../src/verify/harness.js";
import { startServer, type Server } from "../../src/verify/server.js";

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

const argMinutes = (() => {
  const i = process.argv.indexOf("--minutes");
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 10;
})();

interface Sample {
  atMs: number;
  /** Tajriba process resident set size, bytes. The server we do not control. */
  rssBytes: number;
  /** This process's heap after a GC, bytes. The callbacks side. */
  heapBytes: number;
  /** Publishes driven so far. */
  writes: number;
}

/**
 * Resident set size of the Tajriba process.
 *
 * `ps` rather than anything in-process: Tajriba is a separate Go binary, so
 * Node's own memory accounting says nothing about it. POSIX-only, which is
 * stated rather than silently assumed.
 */
function rssOf(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return Number(out) * 1024; // ps reports KB
  } catch {
    return NaN;
  }
}

/** Heap after collection, so the reading is not dominated by uncollected garbage. */
function heapAfterGc(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  return process.memoryUsage().heapUsed;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * Least-squares slope over the SECOND HALF of the samples.
 *
 * The first half is warm-up: connection setup, first publishes and lazily
 * allocated buffers all land there and would tilt a whole-series fit into
 * reporting growth that has already stopped. Same discipline as the bench's
 * WARMUP.
 */
function slopeBytesPerMinute(samples: Sample[], pick: (s: Sample) => number): number {
  const tail = samples.slice(Math.floor(samples.length / 2));
  if (tail.length < 3) return NaN;
  const xs = tail.map((s) => s.atMs / 60_000);
  const ys = tail.map(pick);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

function verdict(slope: number, perHour: number): string {
  if (!Number.isFinite(slope)) return "insufficient samples";
  if (Math.abs(perHour) < 8 * 1024 * 1024) return "PLATEAU — no meaningful growth";
  return `GROWING — ~${mb(perHour)}/hour, extrapolates to ${mb(perHour * 4)} over a 4h session`;
}

// ------------------------------------------------------------------ arm A

async function armLongGame(minutes: number): Promise<void> {
  const N = 20;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empirica-networks-soak-"));
  const storeFile = path.join(dir, "tajriba.json");
  resetChannels();

  let handle: NetworkHandle | undefined;
  const listeners = (_: any) => {
    gameInit(1, 1, 7_200_000)(_);
    handle = withNetwork(_, {
      topology: ({ playerCount }) => ringLattice(playerCount, 4),
      project: (neighbour: any) => ({ id: neighbour.id, tick: neighbour.get("tick") }),
      watch: ["tick"],
    });
  };

  // FILE store: see the method note at the top.
  const server = await startServer({ storeFile, logLevel: "error" });
  const admin = await connectAdmin(server);
  const callbacks = await startCallbacks(server, networkKinds, listeners);
  const participants: Awaited<ReturnType<typeof connectParticipant>>[] = [];

  try {
    for (let i = 0; i < N; i++) {
      participants.push(await connectParticipant(server, uniqueNS(), EmpiricaNetwork));
    }
    const batch = await createBatch(admin, batchConfig(N, 1));
    await batch.running();
    await waitFor(
      () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
      { label: "gameID assigned", timeoutMs: 120_000 }
    );
    for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
    await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
      label: "first publish",
      timeoutMs: 120_000,
    });

    const samples: Sample[] = [];
    const started = Date.now();
    const endAt = started + minutes * 60_000;
    let writes = 0;
    let nextSample = 0;

    console.log(
      `  arm A: n=${N}, d=8, ~2 writes/sec, ${minutes} min, FILE store\n` +
        `  ${"elapsed".padStart(8)} ${"tajriba RSS".padStart(12)} ${"node heap".padStart(11)} ` +
        `${"writes".padStart(8)}  held`
    );

    while (Date.now() < endAt) {
      // Rotate the writer so this is not one player's neighbourhood over and
      // over, and always write a NEW value — the byte-identical check would
      // otherwise suppress the publish and the arm would measure nothing.
      const actor = participants[writes % participants.length]!;
      modeOf(actor).player.getValue()!.set("tick", `w${writes}`);
      writes++;
      await new Promise((r) => setTimeout(r, 500));

      const atMs = Date.now() - started;
      if (atMs >= nextSample) {
        nextSample = atMs + 15_000;
        const s: Sample = {
          atMs,
          rssBytes: rssOf(server.proc.pid!),
          heapBytes: heapAfterGc(),
          writes,
        };
        samples.push(s);
        const held = handle!.stats();
        console.log(
          `  ${(atMs / 60_000).toFixed(1).padStart(6)}m ${mb(s.rssBytes).padStart(12)} ` +
            `${mb(s.heapBytes).padStart(11)} ${String(writes).padStart(8)}  ` +
            `games=${held.games} scopes=${held.channelScopes} views=${held.cachedViews}`
        );
      }
    }

    const rssSlope = slopeBytesPerMinute(samples, (s) => s.rssBytes);
    const heapSlope = slopeBytesPerMinute(samples, (s) => s.heapBytes);
    console.log(
      `\n  tajriba RSS : ${verdict(rssSlope, rssSlope * 60)}` +
        `\n  node heap   : ${verdict(heapSlope, heapSlope * 60)}` +
        `\n  ${samples.length} samples, ${writes} publishes, slope fitted over the second half\n`
    );
  } finally {
    for (const p of participants) {
      try {
        p.stop();
      } catch {
        /* best effort */
      }
    }
    try {
      await callbacks.stop();
    } catch {
      /* best effort */
    }
    admin.stop();
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ arm B

async function armManyGames(games: number): Promise<void> {
  const N = 8;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empirica-networks-soak-b-"));
  const storeFile = path.join(dir, "tajriba.json");

  console.log(`  arm B: ${games} sequential games of n=${N}, one server, FILE store`);
  console.log(
    `  ${"game".padStart(6)} ${"tajriba RSS".padStart(12)} ${"node heap".padStart(11)}  held after end`
  );

  let server: Server | undefined;
  const heaps: number[] = [];

  // ONE callbacks process for the whole run, which is what production does:
  // `empirica` starts once and serves every game in the batch. Restarting it
  // per game would measure the restart path instead, and would give each game a
  // fresh withNetwork whose maps could not accumulate even if the release were
  // broken — a shape in which this arm cannot fail.
  let handle: NetworkHandle | undefined;
  let gameRef: any;
  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    handle = withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id, tick: neighbour.get("tick") }),
      watch: ["tick"],
    });
  };

  try {
    server = await startServer({ storeFile, logLevel: "error" });
    resetChannels();
    const admin = await connectAdmin(server);
    const callbacks = await startCallbacks(server, networkKinds, listeners);

    for (let g = 0; g < games; g++) {
      gameRef = undefined;
      const participants: Awaited<ReturnType<typeof connectParticipant>>[] = [];
      try {
        for (let i = 0; i < N; i++) {
          participants.push(await connectParticipant(server, uniqueNS(), EmpiricaNetwork));
        }
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        await waitFor(
          () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
          { label: `game ${g}: gameID`, timeoutMs: 120_000 }
        );
        for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
        await waitFor(
          () => participants.every((p) => modeOf(p).nbhd.getValue()?.published),
          { label: `game ${g}: published`, timeoutMs: 120_000 }
        );

        for (let w = 0; w < 10; w++) {
          modeOf(participants[w % N]!).player.getValue()!.set("tick", `g${g}w${w}`);
          await new Promise((r) => setTimeout(r, 50));
        }

        gameRef?.end("ended", "soak");
        await waitFor(() => handle!.stats().games === 0, {
          label: `game ${g}: released`,
          timeoutMs: 30_000,
        }).catch(() => {
          console.log(`  game ${g}: NOT RELEASED — ${JSON.stringify(handle!.stats())}`);
        });

        const held = handle!.stats();
        const heap = heapAfterGc();
        heaps.push(heap);
        console.log(
          `  ${String(g).padStart(6)} ${mb(rssOf(server.proc.pid!)).padStart(12)} ` +
            `${mb(heap).padStart(11)}  ` +
            `games=${held.games} scopes=${held.channelScopes} views=${held.cachedViews}`
        );
      } finally {
        for (const p of participants) {
          try {
            p.stop();
          } catch {
            /* best effort */
          }
        }
      }
    }

    try {
      await callbacks.stop();
    } catch {
      /* best effort */
    }
    admin.stop();

    const half = Math.floor(heaps.length / 2);
    const early = heaps.slice(0, half).reduce((a, b) => a + b, 0) / (half || 1);
    const late = heaps.slice(half).reduce((a, b) => a + b, 0) / (heaps.length - half || 1);
    console.log(
      `\n  node heap: first half ${mb(early)} -> second half ${mb(late)} ` +
        `(${late > early ? "+" : ""}${mb(late - early)} across ${games} games)\n`
    );
  } finally {
    server?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("\n  empirica-networks — memory soak\n");
  if (!(globalThis as { gc?: () => void }).gc) {
    console.log(
      "  NOTE: run under --expose-gc for heap figures taken after collection.\n" +
        "        Without it the node heap column includes uncollected garbage and\n" +
        "        its slope is not trustworthy. Tajriba RSS is unaffected.\n"
    );
  }

  await armLongGame(argMinutes);
  await armManyGames(argMinutes <= 2 ? 5 : 20);

  console.log(
    "  CAVEATS: one run, not the three with fresh servers that SPIKE-REPORT.md\n" +
      "  §5-6 requires before publishing a number; every participant shares this\n" +
      "  Node process; and `ps` is POSIX-only. Read the verdicts as direction,\n" +
      "  not as a benchmark.\n"
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  soak failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
