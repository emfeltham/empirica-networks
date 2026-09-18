/**
 * Runner for `tools/radius-ladder.ts`.
 *
 * Bundled to CJS for the reason `figure-shot.mjs` gives, and kept out of `npm
 * run test:browser` for the same one: it starts three real servers in turn and
 * drives twelve Chromium contexts through each, to produce three PNGs for the
 * manuscript. Run by hand when the figure needs regenerating.
 *
 *   npm run figure:ladder -- /path/to/figures/
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const out = process.argv[2];
if (!out) {
  console.error("usage: npm run figure:ladder -- <output directory>");
  process.exit(1);
}

const bundled = path.join(root, ".tmp-test", "radius-ladder.cjs");
await build({
  entryPoints: [path.join(root, "tools/radius-ladder.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning",
  sourcemap: "inline",
  external: ["playwright"],
});

execFileSync(process.execPath, [bundled, path.resolve(out), ...process.argv.slice(3)], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, NBHD_ROOT: root },
});
