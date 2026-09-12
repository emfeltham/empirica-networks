/**
 * Runner for the scale-limit reproduction (test/bench/ceiling.ts).
 *
 * Bundled to CJS first, same as every other tier here: the published
 * @empirica/core cannot be loaded from raw Node in either module system
 * (docs/PLATFORM-NOTES.md §3a).
 *
 *   CEILING_N=200 node scripts/ceiling.mjs
 *   CEILING_N=125 CEILING_PLAIN=1 node scripts/ceiling.mjs
 *
 * Exits 0 if every participant reached the game, 1 otherwise — so it can be
 * looped to measure a failure RATE, which is what this failure has instead of a
 * threshold.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".tmp-ceiling");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "test/bench/ceiling.ts")],
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

execFileSync(process.execPath, [path.join(outDir, "ceiling.cjs")], {
  stdio: "inherit",
  cwd: root,
});
