/**
 * Runner for `tools/shirado-figure.ts`.
 *
 * Bundled to CJS before running for the same reason the browser tier is: the
 * published @empirica/core cannot be loaded from raw Node in either module
 * system (docs/PLATFORM-NOTES.md §3a), and the figure script imports the
 * harness, which imports core's admin entry.
 *
 * Deliberately NOT part of `npm run test:browser`. That command runs every file
 * in test/browser/, and this one drives twenty Chromium contexts through a real
 * five-minute-limit session to produce one PNG for the manuscript. It is run by
 * hand when the figure needs regenerating.
 *
 *   npm run figure:shot -- /path/to/output.png
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const out = process.argv[2];
if (!out) {
  console.error("usage: npm run figure:shot -- <output.png>");
  process.exit(1);
}

const bundled = path.join(root, ".tmp-test", "shirado-figure.cjs");
await build({
  entryPoints: [path.join(root, "tools/shirado-figure.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning",
  sourcemap: "inline",
  // Playwright resolves its browser binaries relative to its own install.
  external: ["playwright"],
});

execFileSync(process.execPath, [bundled], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, NBHD_ROOT: root, FIGURE_OUT: path.resolve(out) },
});
