/**
 * Bench runner. Bundled to CJS first, same as the e2e tier and for the same
 * reason: the published @empirica/core cannot be loaded from raw Node in either
 * module system (docs/PLATFORM-NOTES.md §3a).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "test/bench/envelope.ts");
const outDir = path.join(root, ".tmp-bench");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
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

execFileSync(process.execPath, [path.join(outDir, "envelope.cjs")], {
  stdio: "inherit",
  cwd: root,
});
