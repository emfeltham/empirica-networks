/**
 * Test runner for all three tiers.
 *
 * unit + mode run under tsx directly (they must not import @empirica/core/admin,
 * which cannot be loaded unbundled — see docs/PLATFORM-NOTES.md §3a).
 * e2e is bundled to CJS first, mirroring how consumers' servers are built.
 *
 * Empty tiers are SKIPPED with a visible message rather than passing silently or
 * erroring. `npm test` should neither fail because a tier is not written yet nor
 * pretend a tier ran when it did not.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sweep orphaned harness servers before the e2e tier, and report what was there.
 *
 * The pattern matches this harness's temp config only, and every server it starts
 * runs `--tajriba.store.mem`, so nothing with data in it is in range. The orphans
 * are upstream's: the `empirica` CLI execs a versioned binary as its own child, so a
 * killed CLI can leave the real server holding its port.
 *
 * Reported rather than silent, because the COUNT is evidence. `ISSUES.md` O8 spent
 * a session distinguishing load from orphan contamination, and a sweep that says
 * nothing would have made that impossible: "0 before the run" is what licenses
 * reading a red run as something other than a dirty machine.
 */
function sweepOrphans(label) {
  const pattern = "empirica-networks-.*tajriba.toml";
  const before = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  const count = (before.stdout ?? "").trim().split("\n").filter(Boolean).length;
  if (count > 0) {
    spawnSync("pkill", ["-f", pattern]);
    console.log(`${label}: swept ${count} orphaned harness server(s)`);
  } else {
    console.log(`${label}: 0 orphaned harness servers`);
  }
}

const ALL_TIERS = ["unit", "mode", "e2e"];

/**
 * Tier selection, so CI can run the cheap tiers across a Node version matrix
 * without needing the Empirica CLI on every runner (only e2e spawns a server).
 *
 * An unknown tier is an error rather than a silent no-op: `npm test -- unti`
 * otherwise reports success having run nothing, which is the same class of
 * failure this package keeps guarding against.
 */
const requested = process.argv.slice(2);
for (const tier of requested) {
  if (!ALL_TIERS.includes(tier)) {
    console.error(`Unknown test tier "${tier}". Known tiers: ${ALL_TIERS.join(", ")}.`);
    process.exit(1);
  }
}
const tiers = requested.length > 0 ? requested : ALL_TIERS;

function testFiles(tier) {
  const dir = path.join(root, "test", tier);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
    }
  }
  return out;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root });
}

let ran = 0;
const skipped = [];

/**
 * `--test-force-exit` is applied per tier, NOT everywhere.
 *
 * It is needed wherever a test instantiates the participant mode, because
 * `EmpiricaClassic` starts a self-rescheduling `requestAnimationFrame` loop
 * (`@empirica/core/src/player/steps.ts:238`) which is polyfilled to `setTimeout`
 * under Node and never stops. Measured 2026-08-15: 68 uncleared timers after one
 * mode test file, and the run hangs forever without the flag. Upstream's, not
 * ours — see docs/PLATFORM-NOTES.md §13.
 *
 * The unit tier does not touch the mode and exits cleanly on its own, so it does
 * NOT get the flag: leaving it on everywhere would hide a handle leak we
 * actually introduced. Verified file by file, not assumed.
 */
const NEEDS_FORCE_EXIT = new Set(["mode", "e2e"]);

for (const tier of tiers.filter((t) => t !== "e2e")) {
  const files = testFiles(tier);
  if (files.length === 0) {
    skipped.push(tier);
    continue;
  }
  console.log(`\n=== ${tier} (${files.length} file(s)) ===`);
  const flags = NEEDS_FORCE_EXIT.has(tier) ? ["--test-force-exit"] : [];
  run("npx", ["tsx", "--test", ...flags, ...files]);
  ran += files.length;
}

const e2e = tiers.includes("e2e") ? testFiles("e2e") : [];
if (e2e.length === 0) {
  if (tiers.includes("e2e")) skipped.push("e2e");
} else {
  console.log(`\n=== e2e (${e2e.length} file(s), bundled) ===`);
  sweepOrphans("e2e");
  const outDir = path.join(root, ".tmp-test");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: e2e,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outExtension: { ".js": ".cjs" },
    logLevel: "warning",
    sourcemap: "inline",
    // examples/minimal imports `empirica-networks/...` the way a real consumer
    // does. Point that at src so the example is tested against current source
    // and needs no install step here; the example's own build resolves it
    // through the exports map to dist, which is what a user actually gets.
    alias: { "empirica-networks": path.join(root, "src") },
  });

  const bundled = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".cjs"))
    .map((f) => path.join(outDir, f));

  /**
   * Cap e2e concurrency.
   *
   * `node --test` defaults to one worker per core, and every e2e file spawns a
   * REAL Tajriba server plus n participants. On a 14-core machine that is up to
   * 14 servers and a hundred-odd websocket clients at once, and the machine
   * saturates: tests start timing out waiting for Classic to assign a game,
   * with a different file failing on each run.
   *
   * That is worse than slow. A suite that fails on a rotating victim cannot be
   * used to catch a regression, and three times in one session a "failure" here
   * turned out to be load rather than a defect — each costing a real
   * investigation.
   *
   * Four helped and two helped more, but neither was clean: the last holdouts
   * were the sentinel tests, which open an EXTRA wire subscription per
   * participant on top of the mode's own and are therefore the heaviest things
   * in the suite. They pass 5/5 alone. Serial is the honest setting, and it
   * costs about a minute — cheap against one wasted afternoon chasing a
   * phantom regression.
   *
   * AND THIS IS ALREADY THE SHARDED SHAPE (measured 2026-08-16). M6 Tier 4 planned
   * to shard this tier to fix O8. It cannot: `node --test` runs each test FILE in
   * its own child process — verified directly, two files reporting two different
   * `process.pid` under `--test-concurrency=1` — so with concurrency 1 the tier is
   * already one fresh process per file, run one at a time. Re-running the tier as 25
   * separate `node --test` invocations, swept before each of three passes, gave 3, 0
   * and 2 failures across 75 file-runs: the same 1-green-in-3 as the single
   * invocation. The whole tier costs 89 s when green, so cost is not the problem
   * either. See `ISSUES.md` O8, and `scripts/e2e-repeat.mjs` for measuring a rate
   * rather than re-running once and hoping.
   */
  run(process.execPath, [
    "--test-force-exit",
    "--test-concurrency=1",
    "--test",
    ...bundled,
  ]);
  ran += e2e.length;
}

if (skipped.length) {
  console.log(`\nSKIPPED (no test files yet): ${skipped.join(", ")}`);
}
if (ran === 0) {
  console.error("\nNo tests found in any tier.");
  process.exit(1);
}
console.log(`\nRan ${ran} test file(s).`);
