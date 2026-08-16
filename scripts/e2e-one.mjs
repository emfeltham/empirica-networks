/**
 * Run ONE e2e file, bundled the same way `scripts/test.mjs` bundles the tier.
 *
 *   node scripts/e2e-one.mjs test/e2e/rand2011.test.ts
 *
 * The full e2e tier runs serially and takes minutes, and `ISSUES.md` O8 means a
 * red suite is not always a regression — so an inner loop that exercises one file
 * is worth having. It duplicates the bundling from `test.mjs` deliberately rather
 * than importing it: the point is that the two agree, and a shared helper that
 * quietly drifted would make this tool test something other than what CI runs.
 * The esbuild options below must stay identical to `scripts/test.mjs`.
 *
 * Sweep orphaned harness servers first if a run looks wrong:
 *
 *   pkill -f "empirica-networks-.*tajriba.toml"
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2).map((f) => path.resolve(root, f));

if (files.length === 0) {
  console.error("usage: node scripts/e2e-one.mjs test/e2e/<file>.test.ts [...]");
  process.exit(1);
}

const outDir = path.join(root, ".tmp-test-one");
await build({
  entryPoints: files,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outExtension: { ".js": ".cjs" },
  logLevel: "warning",
  sourcemap: "inline",
  // The examples import `empirica-networks/...` the way a real consumer does;
  // point that at src so they run against current source. Same alias test.mjs uses.
  alias: { "empirica-networks": path.join(root, "src") },
});

execFileSync(
  process.execPath,
  [
    "--test-force-exit",
    "--test-concurrency=1",
    "--test",
    ...files.map((f) => path.join(outDir, path.basename(f).replace(/\.ts$/, ".cjs"))),
  ],
  { stdio: "inherit", cwd: root }
);
