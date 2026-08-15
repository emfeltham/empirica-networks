/**
 * Browser test runner.
 *
 * Bundled to CJS before running, for the same reason the e2e tier is: the
 * published @empirica/core cannot be loaded from raw Node in either module
 * system (docs/PLATFORM-NOTES.md §3a), and this test imports the harness, which
 * imports core's admin entry.
 *
 * Kept out of `npm test` on purpose. It needs the Empirica CLI, a Chromium
 * download, and roughly a minute of wall clock — too heavy to sit in the loop
 * developers run constantly, and it is the slowest possible way to learn
 * something the e2e tier already covers faster. It is the acceptance check, run
 * deliberately.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".tmp-test/two_windows.cjs");

await build({
  entryPoints: [path.join(root, "test/browser/two_windows.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning",
  sourcemap: "inline",
  // Playwright resolves its browser binaries relative to its own install, so
  // inlining it would break that lookup.
  external: ["playwright"],
});

execFileSync(process.execPath, [out], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, NBHD_ROOT: root },
});
