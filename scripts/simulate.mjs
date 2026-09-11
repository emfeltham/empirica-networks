/**
 * Bundle and run `simulate`.
 *
 * The published `@empirica/core` cannot be loaded from raw Node in either module
 * system (`docs/PLATFORM-NOTES.md` §3a), so everything that reaches
 * `@empirica/core/admin` is bundled to CJS first. This is the same block
 * `scripts/bench.mjs` uses, copied rather than shared — the duplication is
 * deliberate and `e2e-one.mjs` explains why.
 *
 *   node scripts/simulate.mjs --seeds 1 --arms control,agent
 *   npm run simulate -- --seeds 10
 *
 * The bundle re-spawns itself once per session, because the example reads
 * `SHIRADO2017_OUT` at module load. `process.argv[1]` inside the bundle is the
 * path written here, so the child is the same file with a corrected environment.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".tmp-simulate");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/verify/simulate.ts")],
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

try {
  execFileSync(process.execPath, [path.join(outDir, "simulate.cjs"), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: root,
  });
} catch (e) {
  // Forwarded, not rethrown: a non-zero exit means the audit failed, which is a
  // result this script has to be able to report.
  process.exit(typeof e.status === "number" ? e.status : 1);
}
