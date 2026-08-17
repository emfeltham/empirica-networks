/**
 * Browser test runner.
 *
 * Bundled to CJS before running, for the same reason the e2e tier is: the
 * published @empirica/core cannot be loaded from raw Node in either module
 * system (docs/PLATFORM-NOTES.md §3a), and `two_windows.ts` imports the harness,
 * which imports core's admin entry. `monitor_page.ts` does not need that — the
 * monitor is deliberately free of Empirica — but it is bundled the same way so
 * the tier has one shape rather than two.
 *
 * Kept out of `npm test` on purpose. It needs a Chromium download, and
 * `two_windows.ts` additionally needs the Empirica CLI and roughly a minute of
 * wall clock — too heavy to sit in the loop developers run constantly, and the
 * slowest possible way to learn something the e2e tier already covers faster. It
 * is the acceptance check, run deliberately.
 *
 * Each file runs in its OWN process, one at a time. `two_windows.ts` owns ports
 * 3000 and 8844 and refuses to start if anything else holds them, so a shared
 * process or a parallel run would make one file's leftovers the other file's
 * failure.
 *
 *   npm run test:browser                 # every file
 *   npm run test:browser -- monitor      # only files whose name matches
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "test/browser");

const filters = process.argv.slice(2);
const all = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .sort();
const files = all.filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)));

// A filter that matches nothing is an error, not a silent success: `npm run
// test:browser -- montior` would otherwise report a green run having executed
// nothing, which is the same class of failure this package keeps guarding
// against (scripts/test.mjs makes the same choice for tiers).
if (files.length === 0) {
  console.error(
    `No browser test matches ${filters.map((f) => JSON.stringify(f)).join(", ")}.\n` +
      `Known files: ${all.join(", ")}`,
  );
  process.exit(1);
}

for (const file of files) {
  const out = path.join(root, ".tmp-test", file.replace(/\.ts$/, ".cjs"));

  await build({
    entryPoints: [path.join(dir, file)],
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

  console.log(`\n=== browser: ${file} ===`);
  execFileSync(process.execPath, [out], {
    stdio: "inherit",
    cwd: root,
    // `import.meta.url` is empty under CJS, so the repo root is passed in.
    env: { ...process.env, NBHD_ROOT: root },
  });
}
