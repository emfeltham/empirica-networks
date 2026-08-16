/**
 * Run ONE e2e file N times, in a fresh process each time, and report the rate.
 *
 *   node scripts/e2e-repeat.mjs test/e2e/topology_visibility.test.ts 20
 *   npm run test:repeat -- test/e2e/chat.test.ts 20
 *
 * WHY THIS EXISTS. `ISSUES.md` O8 is an intermittent hang on "gameID assigned",
 * and the docs' rule for reading a red suite is now "re-read the FILE alone" — the
 * tier alone stopped separating a flake from a regression at 66 tests. That rule
 * needs a rate, not a single re-run: one green re-read of a file that fails 7% of
 * the time proves nothing, and the difference between 7% and 100% is the difference
 * between O8 and a regression.
 *
 * Fresh process per repetition on purpose. An in-process loop over the same
 * scenario does NOT reproduce O8 — measured 2026-08-16, 250 iterations of a
 * minimal scenario and 250 of the two most frequent victims' shape, zero failures —
 * so a repeat harness that reused one process would report a rate of 0 for a
 * failure that happens every third tier run.
 *
 * Bundles once and reruns the bundle, so the cost per repetition is the test and
 * not esbuild. The esbuild options are copied from `scripts/test.mjs` for the same
 * reason `e2e-one.mjs` copies them: what runs here has to be what CI runs, and a
 * shared helper that drifted would quietly make this tool measure something else.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [fileArg, countArg] = process.argv.slice(2);

if (!fileArg) {
  console.error("usage: node scripts/e2e-repeat.mjs test/e2e/<file>.test.ts [repetitions]");
  process.exit(1);
}
const file = path.resolve(root, fileArg);
if (!fs.existsSync(file)) {
  console.error(`${fileArg}: no such file`);
  process.exit(1);
}
const reps = Number(countArg ?? 10);
if (!Number.isInteger(reps) || reps < 1) {
  console.error(`repetitions must be a positive integer, got "${countArg}"`);
  process.exit(1);
}

const outDir = path.join(root, ".tmp-test-repeat");
fs.rmSync(outDir, { recursive: true, force: true });
await build({
  entryPoints: [file],
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outExtension: { ".js": ".cjs" },
  logLevel: "warning",
  sourcemap: "inline",
  alias: { "empirica-networks": path.join(root, "src") },
});
const bundled = path.join(outDir, path.basename(file).replace(/\.ts$/, ".cjs"));

/** Harness servers only — every one of them is started with `--store.mem`. */
const sweep = () => spawnSync("pkill", ["-f", "empirica-networks-.*tajriba.toml"]);
const orphans = () => {
  const r = spawnSync("pgrep", ["-f", "empirica-networks-.*tajriba.toml"], { encoding: "utf8" });
  return (r.stdout ?? "").trim().split("\n").filter(Boolean).length;
};

const failures = [];
let totalMs = 0;

for (let i = 1; i <= reps; i++) {
  // Swept before each repetition, so a leftover server from repetition i-1 cannot
  // become repetition i's explanation (O8 spent a session on that confusion).
  sweep();
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    ["--test-force-exit", "--test-concurrency=1", "--test", bundled],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const ms = Date.now() - started;
  totalMs += ms;
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const pass = Number(out.match(/^.\s*pass (\d+)$/m)?.[1] ?? 0);
  const fail = Number(out.match(/^.\s*fail (\d+)$/m)?.[1] ?? 0);
  // The wait that timed out, named, because O8 is specifically "gameID assigned"
  // and any other label is a different problem wearing the same red.
  const waits = [...out.matchAll(/timed out after \d+ms waiting for: (.+)/g)].map((m) =>
    m[1].trim()
  );
  const ok = r.status === 0 && fail === 0;
  if (!ok) {
    const log = path.join(outDir, `fail-${i}.log`);
    fs.writeFileSync(log, out);
    failures.push({ i, waits, log });
  }
  console.log(
    `${String(i).padStart(3)}/${reps} ${ok ? "ok  " : "FAIL"} ${String(ms).padStart(6)}ms  ` +
      `pass ${pass} fail ${fail} orphans ${orphans()}` +
      (waits.length ? `  timed out on: ${waits.join(" | ")}` : "")
  );
}

const rate = ((100 * failures.length) / reps).toFixed(1);
console.log(
  `\n${path.relative(root, file)}: ${failures.length}/${reps} failed (${rate}%), ` +
    `${(totalMs / reps / 1000).toFixed(1)}s per repetition`
);
for (const f of failures) {
  console.log(`  #${f.i}: ${f.waits.join(" | ") || "see log"} — ${path.relative(root, f.log)}`);
}
// A non-zero exit would make this unusable in the one place it is for: measuring a
// known-flaky file. The rate is the output.
process.exit(0);
