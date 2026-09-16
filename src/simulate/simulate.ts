/**
 * `simulate`: the shipped Shirado reconstruction, run for real, with the output kept.
 *
 * Every existing tier throws its sessions away. `test/e2e/shirado2017.test.ts`
 * drives the same unmodified `callbacks.js` against a real Tajriba and then
 * deletes `data/` in a `test.after` hook, because a test's job is to assert and
 * stop. This runs the design at its own n, for its own duration, across arms and
 * seeds, and keeps every file — which is what an evaluation needs and what
 * no tier currently produces.
 *
 * A RUNNER IS NOT A TEST. It does not assert. A session that fails is data: catch
 * it, record why, continue to the next seed. `ISSUES.md` O15 is the case where
 * discarding a failed run destroyed the evidence that mattered, and the audit in
 * `audit.ts` is what judges the output, not this file.
 *
 * ── THE VACUITY RULE, AND IT CONSTRAINS EVERYTHING BELOW ────────────────────
 *
 * All twenty simulated participants run `botChoice`. It is the only policy the
 * example ships, and an agent is indistinguishable from a human by construction —
 * `is_bot` is a label applied to three seats, not a behavioral difference. So in
 * the agent arm every node executes the agent policy, and in the control arm
 * nobody is told a noise level at all, which means simulated humans need a locally
 * supplied default (0) — and noise 0 is the deterministic-agent condition, which
 * the example's README is explicit is NOT the human-only arm.
 *
 * Therefore: THIS RUNNER REPORTS SYSTEM PROPERTIES PER ARM AND NEVER OUTCOMES
 * ACROSS ARMS. `t_solution_ms` is the design's dependent variable and is a
 * forbidden cross-arm number here — a comparison between arms would be a
 * comparison of the same generative process against itself. The manifest repeats
 * this so the next reader cannot miss it.
 *
 * ── WHY ONE CHILD PROCESS PER SESSION ───────────────────────────────────────
 *
 * `callbacks.js:39` reads `SHIRADO2017_OUT` at MODULE LOAD, so one process cannot
 * write two sessions to two directories — set it afterwards and everything lands
 * silently in `data/`. (`SHIRADO2017_BOT_KEYS` is the opposite, read per call by
 * design, which is what lets the runner label seats without editing the example.)
 * The two env vars have opposite timing requirements and that asymmetry is the
 * sharpest edge in the build. Spawning one child per session with the environment
 * already correct removes the problem rather than working around it, and it gives
 * the fresh server per session the bench learned to insist on.
 *
 * What this rig does NOT exercise, and the report must say so: the React client,
 * the browser WebSocket, `Lobby()`, and the example's own `server/src/index.js`.
 * Those are the browser hybrid's job, a separate piece
 * of work.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { setLogLevel } from "@empirica/core/console";

import { networkKinds } from "../admin/kinds.js";
import { makeRng } from "../admin/seed.js";
import { barabasiAlbert } from "../topology/index.js";
import { EmpiricaNetwork } from "../player/mode.js";
import { runBots, botIdentifiers, type BotContext, type BotPolicy } from "../bots/index.js";
import { batchConfig, createBatch, waitFor, withScenario } from "../harness/harness.js";
import {
  auditViews,
  canonicalEdges,
  formatAuditResult,
  mergeAuditResults,
  parseEdgesCsv,
  structuralEdges,
  type AuditResult,
  type IndexEdge,
} from "../verify/audit.js";

// The example, imported unmodified. `SHIRADO2017_OUT` is read as this module
// loads, which is why a session runs in a child whose env was set before it
// started — see the header.
import { Empirica, net } from "../../examples/shirado2017/server/src/callbacks.js";
import {
  ATTACHMENT,
  BOT_INTERVAL_MS,
  botChoice,
  placeBots,
  TIME_LIMIT_SECONDS,
  // @ts-expect-error - plain JS example module, deliberately untyped
} from "../../examples/shirado2017/server/src/design.mjs";

/** The two arms of the evaluation. */
export interface Arm {
  name: string;
  /** Agent seats. 0 is the human-only arm. */
  bots: number;
  placement?: string;
  noise?: number;
}

export const ARMS: Record<string, Arm> = {
  control: { name: "control", bots: 0 },
  agent: { name: "agent", bots: 3, placement: "central", noise: 0.1 },
};

export interface SessionOutcome {
  arm: string;
  seed: number;
  gameID: string;
  completed: boolean;
  reason: string;
  /**
   * The graph seed the package derived, and the player id in each structural
   * position.
   *
   * Captured here because NOTHING ELSE KEEPS THEM. `withNetwork` writes the seed
   * to the batch scope, the harness runs an in-memory store, and the example's
   * own `graph` record logs the edge COUNT and the condition but not the seed —
   * so once the server stops, the seed that produced this graph is gone. C4 ("same
   * seed, same realized graph, across processes") is unanswerable without it, and
   * adding it to the example is the one thing runbook §9 forbids. Writing it into
   * our own `session.json` costs nothing and touches nothing.
   */
  recordedSeed?: number;
  order?: string[];
  /**
   * How much of the network this session showed its participants.
   *
   * Captured for the same reason the seed is: nothing else here keeps it. The
   * package records it on the batch scope and the harness's store is in memory,
   * so once the server stops the only artifact that could say whether these
   * sessions drew a star or their participants' local structure is this file.
   *
   * It is 1 in every run this rig can currently produce — the example's config
   * is a literal, fixed when its module loads, and there is no path from a flag
   * to it. Recorded anyway, because "1 because that is what ran" and "1 because
   * nobody wrote it down" are different statements about a dataset.
   */
  radius?: number | "whole";
  /**
   * Every DISTINCT radius in the session, as strings.
   *
   * `radius` above answers only when one number describes the game. A study that
   * seats some participants wider than others has no such value, and reporting
   * `undefined` for it would say "not recorded" about the most deliberately
   * configured thing in the run.
   */
  radii?: string[];
  outDir: string;
  elapsedMs: number;
  /** Which C5 failure was injected, if any. */
  injected?: string;
}

/**
 * The noise a participant acts on when the server has not told it one.
 *
 * Only agent seats receive `net.tell(playerID, "noise", …)` (`callbacks.js` at
 * stage start), and the policy cannot act without a number. Zero is the honest
 * default — it is "never deviate from the local rule" — but see the vacuity rule:
 * it makes a simulated human a deterministic agent, which is a condition the
 * design distinguishes. It is recorded in the manifest for that reason.
 */
const UNTOLD_NOISE = 0;

/** What this design's `project()` puts in a neighbor view. */
interface ColorView {
  id: string;
  color?: string;
}

function colorPolicy(seen: { gameID?: string }): BotPolicy<ColorView> {
  return {
    tickMs: Number(BOT_INTERVAL_MS),
    onStart(ctx: BotContext<ColorView>) {
      // The only place the game id is available to the runner: `BotRun` exposes
      // player ids and phases, not the game each bot landed in.
      if (ctx.gameID) seen.gameID = ctx.gameID;
      ctx.log({ type: "seated", gameID: ctx.gameID, playerID: ctx.playerID });
    },
    onTick(ctx: BotContext<ColorView>) {
      const neighbors = ctx.neighbors();
      // `undefined` before first publish, and an isolated node legitimately has
      // an empty list — so this guards on having been published to, not on
      // having neighbors.
      if (neighbors === undefined) return;
      const state = ctx.state();
      if (!state) return;

      const told = ctx.told()?.get("noise");
      const noise = typeof told === "number" ? told : UNTOLD_NOISE;
      const ownColor = state.get("color") as string | undefined;
      const next = botChoice({
        ownColor,
        neighborColors: neighbors.map((nb) => nb.color),
        noise,
        rng: ctx.rng,
      }) as string;
      if (next === ownColor) return;
      state.set("color", next);
      ctx.log({ type: "move", to: next, noise, told: typeof told === "number" });
    },
  };
}

/** The seed and seating this run would otherwise lose. See `SessionOutcome.order`. */
function captureGraph(gameID: string | undefined, outcome: SessionOutcome): void {
  if (!gameID) return;
  try {
    const snap = (
      net as {
        inspect: (id: string) =>
          | {
              seed?: number;
              order?: string[];
              radius?: number | "whole";
              radii?: Array<{ playerID: string; radius: number | "whole" }>;
            }
          | undefined;
      }
    ).inspect(gameID);
    if (!snap) return;
    outcome.gameID = gameID;
    if (typeof snap.seed === "number") outcome.recordedSeed = snap.seed;
    if (Array.isArray(snap.order)) outcome.order = snap.order;
    // `"whole"` and `undefined` are both real answers, and testing for a number
    // dropped them silently — `undefined` is what a MIXED study reports, so the
    // two cases this feature added were exactly the two the manifest lost. The
    // same mistake `readRadius` made, in a second place.
    if (snap.radius !== undefined) outcome.radius = snap.radius;
    if (Array.isArray(snap.radii) && snap.radii.length > 0) {
      const distinct = [...new Set(snap.radii.map((r) => String(r.radius)))].sort();
      outcome.radii = distinct;
    }
  } catch {
    /* a session that died before its network was built has nothing to capture */
  }
}

/**
 * One session, played to its natural end, with every output file left on disk.
 *
 * `withScenario({n: 0})` gives the server, admin, callbacks and teardown while
 * connecting no passive participants: every player here is a `runBots`
 * participant, because every player has to actually play. The e2e test connects
 * harness participants and drives them by hand, which is right for an assertion
 * and wrong for a session meant to run itself.
 */
export async function runSession(opts: {
  arm: Arm;
  seed: number;
  n: number;
  outDir: string;
  inject?: string;
}): Promise<SessionOutcome> {
  const started = Date.now();
  const outcome: SessionOutcome = {
    arm: opts.arm.name,
    seed: opts.seed,
    gameID: "",
    completed: false,
    reason: "",
    outDir: opts.outDir,
    elapsedMs: 0,
    injected: opts.inject,
  };

  const identifiers = botIdentifiers(opts.n);
  // One participant is split into its own fleet so it can be failed on its own:
  // `runBots` stops a whole fleet, not a member of one, and reaching into the
  // runner to kill a single socket would be testing a thing this rig invented
  // rather than the thing a study runs.
  const solo = opts.inject === "drop" || opts.inject === "silent" ? identifiers.slice(-1) : [];
  const fleet = solo.length > 0 ? identifiers.slice(0, -1) : identifiers;
  // The agent seats the server will label, and the runner's own list, are the
  // same three strings. A mismatch produces a session that never starts, and
  // `callbacks.js` only warns about it (runbook trap 4).
  const agentKeys = identifiers.slice(0, opts.arm.bots);
  process.env["SHIRADO2017_BOT_KEYS"] = agentKeys.join(",");

  const botLog: Record<string, unknown>[] = [];
  const seen: { gameID?: string } = {};
  try {
    await withScenario<unknown>(
      { n: 0, kinds: networkKinds, listeners: Empirica, modeFunc: EmpiricaNetwork },
      async ({ server, admin }) => {
        const run = await runBots({
          url: server.url,
          identifiers: fleet,
          seed: opts.seed,
          policy: colorPolicy(seen),
          log: (r: Record<string, unknown>) => botLog.push(r),
        });
        // A participant who connects, is seated, and then never writes a color.
        // `onTick` returning without touching state is exactly "never submits":
        // the seat is occupied and the network is complete, but nothing arrives
        // from it.
        const soloRun =
          solo.length > 0
            ? await runBots({
                url: server.url,
                identifiers: solo,
                seed: opts.seed,
                policy:
                  opts.inject === "silent"
                    ? { tickMs: Number(BOT_INTERVAL_MS), onTick() {} }
                    : colorPolicy(seen),
                log: (r: Record<string, unknown>) => botLog.push(r),
              })
            : undefined;
        let dropTimer: NodeJS.Timeout | undefined;
        try {
          const treatment: Record<string, unknown> = { botCount: opts.arm.bots };
          if (opts.arm.placement !== undefined) treatment["botPlacement"] = opts.arm.placement;
          if (opts.arm.noise !== undefined) treatment["botNoise"] = opts.arm.noise;

          const batch = await createBatch(admin, batchConfig(opts.n, 1, [treatment]));
          await batch.running();

          await waitFor(() => run.phases().every((ph: string) => ph === "playing"), {
            label: `all ${opts.n} participants playing (${run.phases().join(", ")})`,
            timeoutMs: 120_000,
          });
          // To the design's own limit, plus headroom for the end-of-game export.
          // A session that times out without solving is a normal outcome here,
          // not a failure: the dependent variable is time to solution and some
          // colorings are not found.
          if (opts.inject === "drop" && soloRun) {
            // Partway through, not at the start: the claim is about a session
            // losing a participant it already had, which is the failure a real
            // session produces. A participant who never arrived is a different
            // event and `Lobby()` owns it.
            dropTimer = setTimeout(() => {
              void soloRun.stop().then(() => botLog.push({ type: "injected", what: "drop" }));
            }, 60_000);
            dropTimer.unref();
          }

          // BEFORE the session ends: `net.inspect` throws once the game is
          // released, so a snapshot taken after the wait below is a snapshot of
          // nothing.
          captureGraph(seen.gameID, outcome);

          await waitFor(() => run.phases().every((ph: string) => ph === "ended"), {
            label: "session ended",
            timeoutMs: (Number(TIME_LIMIT_SECONDS) + 120) * 1000,
          });
          outcome.completed = true;
          outcome.reason = "ended";
        } finally {
          if (dropTimer) clearTimeout(dropTimer);
          await run.stop();
          if (soloRun && opts.inject !== "drop") await soloRun.stop();
        }
      }
    );
  } catch (e) {
    // Recorded, not thrown. The next seed still runs.
    outcome.reason = e instanceof Error ? e.message : String(e);
  }

  outcome.elapsedMs = Date.now() - started;
  // The game id and the seed the package derived, read back from what was
  // written rather than from memory — if the export disagrees with the run, the
  // export is what the analyst will have.
  try {
    const log = path.join(opts.outDir, "run.ndjson");
    if (fs.existsSync(log)) {
      for (const line of fs.readFileSync(log, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const r = JSON.parse(line) as Record<string, unknown>;
        if (r["type"] === "graph") {
          outcome.gameID = String(r["gameID"] ?? outcome.gameID);
          if (typeof r["seed"] === "number") outcome.recordedSeed = r["seed"];
        }
      }
    }
  } catch {
    /* the manifest records what it could read; the audit judges the files */
  }
  fs.writeFileSync(
    path.join(opts.outDir, "session.json"),
    JSON.stringify({ ...outcome, botLog: botLog.slice(-200) }, null, 2)
  );
  return outcome;
}

interface SweepArgs {
  seeds: number;
  arms: string[];
  n: number;
  out: string;
}

function parseArgs(argv: string[]): SweepArgs {
  const args: SweepArgs = { seeds: 10, arms: ["control", "agent"], n: 20, out: "results" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--seeds") args.seeds = Number(argv[++i]);
    else if (a.startsWith("--seeds=")) args.seeds = Number(a.slice(8));
    else if (a === "--arms") args.arms = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a.startsWith("--arms=")) args.arms = a.slice(7).split(",").filter(Boolean);
    else if (a === "--n") args.n = Number(argv[++i]);
    else if (a.startsWith("--n=")) args.n = Number(a.slice(4));
    else if (a === "--out") args.out = argv[++i] ?? "results";
    else if (a.startsWith("--out=")) args.out = a.slice(6);
  }
  return args;
}

const USAGE = `
Usage: npm run simulate -- [options]

  --seeds <n>        seeds per arm (default 10)
  --arms <a,b>       arms to run (default control,agent)
  --n <n>            participants per session (default 20, the design's own)
  --out <dir>        results root (default results)
  --check <dir>      re-audit a finished results directory (C1 and C4); no new runs
  --inject           run the three C5 failure injections, one session each

Runs the shipped Shirado 2017 reconstruction unmodified, keeps every output
file, and audits views.ndjson for C1. Reports system properties PER ARM; it
makes no cross-arm outcome claim, and none may be read from its output.
`;

/**
 * Sweep orphaned harness servers, and say how many there were.
 *
 * `scripts/test.mjs` does this before the e2e tier and the reasoning carries: the
 * `empirica` CLI execs a versioned binary as its own child, so a killed session can
 * leave the real server holding its port. A sweep matters more
 * here than in the test suite, because a session that times out is killed rather
 * than torn down, and the next twenty sessions inherit whatever it left.
 *
 * The count is reported rather than swallowed, because the count is evidence: "0
 * before this session" is what licenses reading a failed session as something
 * other than a dirty machine (`ISSUES.md` O8).
 */
function sweepOrphans(): number {
  const pattern = "empirica-networks-.*tajriba.toml";
  const before = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  const count = (before.stdout ?? "").trim().split("\n").filter(Boolean).length;
  if (count > 0) spawnSync("pkill", ["-f", pattern]);
  return count;
}

/** Audit one session's own files, so a failure names the session that produced it. */
function auditSession(o: SessionOutcome): AuditResult {
  const views = readIfPresent(path.join(o.outDir, "views.ndjson"));
  const edges = o.gameID ? readIfPresent(path.join(o.outDir, o.gameID, "edges.csv")) : "";
  return auditViews({ views, edges: parseEdgesCsv(edges) });
}

async function sweep(args: SweepArgs): Promise<number> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(args.out, runId);
  fs.mkdirSync(root, { recursive: true });
  process.stdout.write(`\n  simulate — run ${runId}\n  ${args.arms.join(", ")} × ${args.seeds} seed(s) at n=${args.n}\n\n`);

  const outcomes: SessionOutcome[] = [];
  const audits = new Map<string, AuditResult[]>();
  let halted = "";

  outer: for (const armName of args.arms) {
    const arm = ARMS[armName];
    if (!arm) {
      process.stderr.write(`\n  unknown arm: ${armName}\n\n`);
      return 1;
    }
    audits.set(armName, []);
    for (let seed = 1; seed <= args.seeds; seed++) {
      const outDir = path.join(root, armName, String(seed));
      fs.mkdirSync(outDir, { recursive: true });
      const swept = sweepOrphans();
      const label = `${armName}/${seed}`;
      process.stdout.write(`  ${label.padEnd(14)}`);

      const started = Date.now();
      try {
        execFileSync(
          process.execPath,
          [process.argv[1]!, "--session", JSON.stringify({ arm, seed, n: args.n, outDir })],
          {
            stdio: ["ignore", "ignore", "inherit"],
            env: { ...process.env, SHIRADO2017_OUT: outDir, SIMULATE_SESSION: "1" },
            // A hung child would otherwise stall an unattended sweep forever.
            // Generous: the design's own limit plus the time a slow start and a
            // full export can legitimately take.
            timeout: (Number(TIME_LIMIT_SECONDS) + 300) * 1000,
          }
        );
      } catch {
        /* the child records its own outcome; a non-zero exit is data */
      }
      const file = path.join(outDir, "session.json");
      const outcome: SessionOutcome = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as SessionOutcome)
        : {
            arm: armName,
            seed,
            gameID: "",
            completed: false,
            reason: "the session process produced no record",
            outDir,
            elapsedMs: Date.now() - started,
          };
      outcomes.push(outcome);

      // Audited as it lands, not at the end of the sweep. The kill criterion is
      // fixed in advance — one non-neighbor view ends the evaluation
      // — and a runner that discovered it ninety minutes later would be ignoring
      // an instruction it was built to obey.
      const audit = auditSession(outcome);
      audits.get(armName)!.push(audit);
      process.stdout.write(
        `${outcome.completed ? "ended " : "FAILED"}  ${(outcome.elapsedMs / 1000)
          .toFixed(0)
          .padStart(4)}s  ` +
          `${String(audit.leaks).padStart(2)}/${String(audit.deliveriesChecked).padStart(7)} leaked` +
          `${swept > 0 ? `  (swept ${swept} orphan(s))` : ""}` +
          `${outcome.completed ? "" : `  ${outcome.reason}`}\n`
      );

      if (audit.leaks > 0) {
        halted =
          `C1 FAILED in ${label}: ${audit.leaks} non-neighbor view(s) of ` +
          `${audit.deliveriesChecked} deliveries. The evaluation stops here — this is ` +
          `the finding. Do not re-run to ` +
          `see if it goes away.`;
        process.stderr.write(`\n  ${halted}\n`);
        break outer;
      }
    }
  }

  // ---- the audit, per arm ------------------------------------------------
  let failed = halted !== "";
  const reports: Record<string, unknown> = {};
  for (const armName of args.arms) {
    const mine = audits.get(armName);
    if (!mine) continue;
    const result = mergeAuditResults(mine);
    process.stdout.write(`\n  ── ${armName} ${"─".repeat(Math.max(0, 50 - armName.length))}`);
    process.stdout.write(formatAuditResult(result));
    reports[armName] = result;
    if (!result.pass) failed = true;
  }

  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        runId,
        at: new Date().toISOString(),
        n: args.n,
        seedsPerArm: args.seeds,
        arms: args.arms,
        // Repeated in the artifact, not only in the source, because this is the
        // single easiest thing for a later reader to get wrong.
        vacuityRule:
          "All participants run the example's own botChoice, so in the agent arm every " +
          "node executes the agent policy, and simulated humans act on noise=0 where the " +
          "server told them nothing. System properties are reported PER ARM. No cross-arm " +
          "outcome comparison is valid from this data, t_solution_ms included.",
        // Every session's radius, so the manifest says what these runs showed
        // people rather than leaving it to be inferred from a config file that
        // may have changed since. One value in practice; a set, because a run
        // spanning a restart at a changed radius is exactly the case worth
        // seeing here rather than discovering later.
        radii: [...new Set(outcomes.map((o) => o.radius).filter((r) => r !== undefined))],
        notExercised: [
          "the React client",
          "the browser WebSocket",
          "Lobby()",
          "examples/shirado2017/server/src/index.js",
          // Named for as long as no arm delivers one. The example's `withNetwork`
          // config is a literal fixed at module load and there is no path from a
          // flag to it, so every session here runs at the default radius and the
          // structure payload — and `auditViews`' arms over it — go unexercised.
          "the radius 1.5 structure payload (every arm runs at the default radius)",
        ],
        halted: halted === "" ? null : halted,
        sessions: outcomes,
        audit: reports,
      },
      null,
      2
    )
  );

  const completed = outcomes.filter((o) => o.completed).length;
  process.stdout.write(
    `\n  ${completed}/${outcomes.length} sessions ended; results in ${root}\n\n`
  );
  return failed ? 1 : 0;
}

function readIfPresent(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}


// ─── C4, over a results directory ─────────────────────────────────────────────

export interface ReproCheck {
  arm: string;
  seed: number;
  gameID: string;
  /** C4a: every CSV rebuilds byte-identically from `run.ndjson`. */
  rebuilt: boolean;
  /** C4b: the recorded seed regenerates the network participants were given. */
  regenerated: boolean;
  note: string;
}

/**
 * C4a — rebuild this session's exports from its log and compare byte for byte.
 *
 * `recover.mjs` writes to `dirname(log)/<gameID>/`, which IS the clean export
 * directory, so recovering in place destroys the comparison before it can be
 * made. The log is copied to a scratch directory first; that is the whole reason
 * this function does any copying at all.
 */
function rebuildsFromLog(o: SessionOutcome, scratch: string): { ok: boolean; note: string } {
  const files = ["edges.csv", "session.csv", "changes.csv"];
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    fs.copyFileSync(path.join(o.outDir, "run.ndjson"), path.join(scratch, "run.ndjson"));
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), "examples/shirado2017/recover.mjs"), path.join(scratch, "run.ndjson"), o.gameID],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    const differing = files.filter(
      (f) =>
        !fs
          .readFileSync(path.join(scratch, o.gameID, f))
          .equals(fs.readFileSync(path.join(o.outDir, o.gameID, f)))
    );
    return differing.length === 0
      ? { ok: true, note: "" }
      : { ok: false, note: `differs: ${differing.join(", ")}` };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

/**
 * C4b — regenerate the graph from the recorded seed alone.
 *
 * The stronger half of C4, and the claim a generator name and its parameters
 * cannot support: this says the seed reproduces what participants were ACTUALLY
 * given, not what was asked for. The call order matters and mirrors the example's
 * own topology function exactly — one `makeRng`, then the generator, then the
 * placement, all drawing from the same stream.
 */
function regeneratesFromSeed(
  o: SessionOutcome,
  botIndices: number[],
  placement: string
): { ok: boolean; note: string } {
  if (typeof o.recordedSeed !== "number" || !o.order) {
    return { ok: false, note: "no seed or seating recorded" };
  }
  try {
    const n = o.order.length;
    const realized = structuralEdges(
      fs.readFileSync(path.join(o.outDir, o.gameID, "edges.csv"), "utf8"),
      o.gameID,
      o.order
    );
    const rng = makeRng(o.recordedSeed);
    let regen = barabasiAlbert(n, Number(ATTACHMENT), { rng }) as IndexEdge[];
    if (botIndices.length > 0) {
      regen = placeBots(regen, n, botIndices, placement, rng) as IndexEdge[];
    }
    const ok = canonicalEdges(regen) === canonicalEdges(realized);
    return {
      ok,
      note: ok ? "" : `regenerated ${regen.length} edges, realized ${realized.length}`,
    };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

/**
 * Re-audit a completed results directory: C1 again, and C4 for the first time.
 *
 * Separate from the sweep so that auditing never requires re-running. A sweep is
 * an hour and three quarters; a question about its output should not be.
 */
function checkResults(root: string): number {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  ) as { arms: string[]; sessions: SessionOutcome[] };
  const scratch = path.join(process.cwd(), ".tmp-simulate", "recover");
  let failed = false;

  for (const arm of manifest.arms) {
    const mine = manifest.sessions.filter((s) => s.arm === arm);
    const audits: AuditResult[] = [];
    const repro: ReproCheck[] = [];

    for (const o of mine) {
      const views = readIfPresent(path.join(o.outDir, "views.ndjson"));
      const edgesText = o.gameID ? readIfPresent(path.join(o.outDir, o.gameID, "edges.csv")) : "";
      audits.push(auditViews({ views, edges: parseEdgesCsv(edgesText) }));

      let botIndices: number[] = [];
      let placement = "";
      for (const line of readIfPresent(path.join(o.outDir, "run.ndjson")).split("\n")) {
        if (line.trim() === "") continue;
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          if (r["type"] === "graph") {
            botIndices = (r["botIndices"] as number[]) ?? [];
            placement = String(r["botPlacement"] ?? "");
          }
        } catch {
          /* the audit counts torn lines; this loop only wants the graph record */
        }
      }
      const a = rebuildsFromLog(o, scratch);
      const b = regeneratesFromSeed(o, botIndices, placement);
      repro.push({
        arm,
        seed: o.seed,
        gameID: o.gameID,
        rebuilt: a.ok,
        regenerated: b.ok,
        note: [a.note, b.note].filter(Boolean).join("; "),
      });
    }

    const c1 = mergeAuditResults(audits);
    const rebuilt = repro.filter((r) => r.rebuilt).length;
    const regen = repro.filter((r) => r.regenerated).length;
    process.stdout.write(`\n  ── ${arm} ${"─".repeat(Math.max(0, 50 - arm.length))}`);
    process.stdout.write(formatAuditResult(c1));
    process.stdout.write(
      `  C4 exports rebuild from the log   : ${rebuilt}/${repro.length} sessions\n` +
        `  C4 seed regenerates the network   : ${regen}/${repro.length} sessions\n`
    );
    for (const r of repro) {
      if (!r.rebuilt || !r.regenerated) {
        process.stdout.write(`    ✗ ${r.arm}/${r.seed}: ${r.note}\n`);
      }
    }
    process.stdout.write("\n");
    if (!c1.pass || rebuilt !== repro.length || regen !== repro.length) failed = true;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  return failed ? 1 : 0;
}


// ─── C5, the part a human sample cannot give you ──────────────────────────────

/**
 * The three fault injections.
 *
 * WHAT "PASSES" MEANS HERE, and it is not what it usually means: not that the
 * session survives. Some will not. It means the data for what DID happen is
 * intact and says what happened. A session that dies and leaves an honest partial
 * record is a pass; one that dies and leaves nothing, or leaves a record implying
 * it completed, is a failure.
 *
 * The sharpest case is the last column of `session.csv`. A session that never
 * solved carries `solved=0` and an EMPTY `t_solution_ms` — not 300000 and not the
 * elapsed time. Writing a number there would turn "the recording stopped" into a
 * measurement, and the design's dependent variable is exactly that number.
 */
const INJECTIONS: { kind: string; what: string; killAfterMs?: number }[] = [
  { kind: "drop", what: "a participant drops sixty seconds into the session" },
  { kind: "silent", what: "a participant is seated but never submits a color" },
  { kind: "kill", what: "the session process is killed outright mid-game", killAfterMs: 90_000 },
];

function injectionHolds(o: SessionOutcome, scratch: string): { ok: boolean; note: string } {
  // 1. Is there a log at all, and does it still rebuild the analysis tables?
  const rebuild = rebuildsFromLog(o, scratch);
  if (!rebuild.ok) {
    // A killed session has no clean export to compare against, so a rebuild that
    // produced files is the whole claim; only a rebuild that produced nothing is
    // a failure.
    const produced = ["edges.csv", "session.csv", "changes.csv"].every((f) =>
      fs.existsSync(path.join(scratch, o.gameID, f))
    );
    if (!produced) return { ok: false, note: `run.ndjson did not rebuild: ${rebuild.note}` };
  }
  // 2. Does the record say what happened, rather than implying a clean finish?
  try {
    const csv = fs.readFileSync(path.join(scratch, o.gameID, "session.csv"), "utf8");
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    const headers = splitCsv(lines[0]!);
    const row = splitCsv(lines[1] ?? "");
    const cell = (name: string) => row[headers.indexOf(name)] ?? "";
    const solved = cell("solved");
    const t = cell("t_solution_ms");
    if (solved === "0" && t !== "") {
      return {
        ok: false,
        note: `solved=0 but t_solution_ms=${t}: the record turns a stopped recording into a measurement`,
      };
    }
    const changes = Number(cell("changes"));
    if (!Number.isFinite(changes) || changes <= 0) {
      return { ok: false, note: "no changes recorded, so nothing of the session survived" };
    }
    return { ok: true, note: `solved=${solved}, ${changes} changes recorded` };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

/** `toCSV` quotes every field; this is the inverse, for one line. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(f); f = ""; }
    else f += ch;
  }
  out.push(f);
  return out;
}

async function runInjections(args: SweepArgs): Promise<number> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(args.out, `${runId}-inject`);
  fs.mkdirSync(root, { recursive: true });
  const scratch = path.join(process.cwd(), ".tmp-simulate", "recover");
  process.stdout.write(`\n  simulate — C5 injections, run ${runId}\n\n`);

  const outcomes: SessionOutcome[] = [];
  let failed = false;
  for (const inj of INJECTIONS) {
    const outDir = path.join(root, inj.kind);
    fs.mkdirSync(outDir, { recursive: true });
    sweepOrphans();
    process.stdout.write(`  ${inj.kind.padEnd(8)} ${inj.what}\n`);

    const started = Date.now();
    try {
      execFileSync(
        process.execPath,
        [
          process.argv[1]!,
          "--session",
          JSON.stringify({ arm: ARMS["control"], seed: 1, n: args.n, outDir, inject: inj.kind }),
        ],
        {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, SHIRADO2017_OUT: outDir, SIMULATE_SESSION: "1" },
          timeout: inj.killAfterMs ?? (Number(TIME_LIMIT_SECONDS) + 300) * 1000,
          killSignal: "SIGKILL",
        }
      );
    } catch {
      /* a killed session is the injection, not an error */
    }

    const file = path.join(outDir, "session.json");
    const o: SessionOutcome = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as SessionOutcome)
      : {
          arm: "control",
          seed: 1,
          gameID: gameIDFromLog(outDir),
          completed: false,
          reason: "killed before it could write its own record",
          outDir,
          elapsedMs: Date.now() - started,
          injected: inj.kind,
        };
    const verdict = injectionHolds(o, scratch);
    outcomes.push({ ...o, reason: `${o.reason} | ${verdict.note}` });
    process.stdout.write(
      `           ${verdict.ok ? "intact " : "FAILED "} ${((Date.now() - started) / 1000).toFixed(0)}s  ${verdict.note}\n\n`
    );
    if (!verdict.ok) failed = true;
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        runId,
        at: new Date().toISOString(),
        n: args.n,
        arms: ["control"],
        radii: [...new Set(outcomes.map((o) => o.radius).filter((r) => r !== undefined))],
        criterion:
          "Not that the session survives — some do not. That the data for what did " +
          "happen is intact and says what happened, and that a session which never " +
          "solved carries an empty t_solution_ms rather than a number.",
        sessions: outcomes,
      },
      null,
      2
    )
  );
  process.stdout.write(`  results in ${root}\n\n`);
  return failed ? 1 : 0;
}

/** A killed child writes no record of itself, so the game id comes from its log. */
function gameIDFromLog(outDir: string): string {
  for (const line of readIfPresent(path.join(outDir, "run.ndjson")).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r["gameID"] === "string") return r["gameID"];
    } catch {
      /* a torn tail is expected in a killed session */
    }
  }
  return "";
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes("--inject")) return runInjections(parseArgs(argv));

  const c = argv.indexOf("--check");
  if (c >= 0) return checkResults(argv[c + 1] ?? "");

  const i = argv.indexOf("--session");
  if (i >= 0) {
    // As `cli.ts` does: upstream logs a stack trace at every stage transition,
    // which across twenty sessions buries the runner's own output in the record
    // the report is written from.
    setLogLevel("error");
    const opts = JSON.parse(argv[i + 1]!) as {
      arm: Arm;
      seed: number;
      n: number;
      outDir: string;
      inject?: string;
    };
    const outcome = await runSession(opts);
    return outcome.completed ? 0 : 1;
  }
  return sweep(parseArgs(argv));
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`\n  simulate failed: ${e instanceof Error ? e.message : String(e)}\n\n`);
    process.exit(1);
  }
);
