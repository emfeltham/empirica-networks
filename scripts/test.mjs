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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

for (const tier of ["unit", "mode"]) {
  const files = testFiles(tier);
  if (files.length === 0) {
    skipped.push(tier);
    continue;
  }
  console.log(`\n=== ${tier} (${files.length} file(s)) ===`);
  run("npx", ["tsx", "--test", "--test-force-exit", ...files]);
  ran += files.length;
}

const e2e = testFiles("e2e");
if (e2e.length === 0) {
  skipped.push("e2e");
} else {
  console.log(`\n=== e2e (${e2e.length} file(s), bundled) ===`);
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

  run(process.execPath, ["--test-force-exit", "--test", ...bundled]);
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
