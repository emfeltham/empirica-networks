/**
 * Bench runner. Bundled to CJS first, same as the e2e tier and for the same
 * reason: the published @empirica/core cannot be loaded from raw Node in either
 * module system (docs/PLATFORM-NOTES.md §3a).
 *
 * Two entry points, because participants now run in child processes: the
 * coordinator (server + callbacks + admin) and the shard (participants). The
 * shard's built path is handed over in BENCH_SHARD rather than computed inside
 * the bundle, which has no reliable notion of where it came from.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".tmp-bench");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [
    path.join(root, "test/bench/envelope.ts"),
    path.join(root, "test/bench/shard.ts"),
  ],
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

// The exit code is FORWARDED, not rethrown: `--assert` makes this gate CI
// (`ISSUES.md` O6), and execFileSync's own throw would bury a legible
// "3 receipts missing" report under an ESM stack trace from a wrapper script.
try {
  execFileSync(process.execPath, [path.join(outDir, "envelope.cjs"), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, BENCH_SHARD: path.join(outDir, "shard.cjs") },
  });
} catch (e) {
  process.exit(typeof e.status === "number" ? e.status : 1);
}
