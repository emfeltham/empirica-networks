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
import { execFileSync, spawnSync } from "node:child_process";
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

/**
 * The ports a file that drives a real `empirica` needs: 3000 for the server,
 * 8844 for its vite client.
 */
const PORTS = [3000, 8844];

/**
 * The orphan that a port check cannot see.
 *
 * `empirica` starts the experiment's own callbacks server through an npm
 * wrapper chain, and npm puts it in its own process group — so a file that
 * kills its dev server's group on the way out, as every file here does, still
 * leaves that server running. It holds no port, so nothing notices. It is a
 * live Tajriba CLIENT: when the next file starts a server on 3000, the orphan
 * reconnects to it and registers the PREVIOUS example's listeners — its
 * topology, its `project()`, its lifecycle — alongside the new one's.
 *
 * Measured. `network_graph.ts` (shirado2017) followed by `two_windows.ts`
 * (minimal) failed three times with three different assertions, including a
 * reported LEAK, and passed every time either ran alone. Nothing in the failures
 * named a stale process, which is what `ISSUES.md` O8 is about and why the
 * counts below are printed rather than swept in silence.
 *
 * The pattern is the session-token path, which every process in the chain
 * carries and which names the example it belongs to. It cannot match anything
 * outside this repository's own examples.
 */
const ORPHAN_PATTERN = "empirica-networks/examples/.*callBackSessionToken";

function holders() {
  const byPort = spawnSync("lsof", ["-ti", PORTS.map((p) => `:${p}`).join(",")], {
    encoding: "utf8",
  });
  const byName = spawnSync("pgrep", ["-f", ORPHAN_PATTERN], { encoding: "utf8" });
  const pids = [...(byPort.stdout ?? "").split("\n"), ...(byName.stdout ?? "").split("\n")]
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(pids)];
}

/**
 * Leave the machine clean, and say so if it was not.
 *
 * Between files, not only before the first: the contamination above is created
 * by one file and paid for by the next.
 */
function sweep(label) {
  const deadline = Date.now() + 30_000;
  let killed = 0;
  for (;;) {
    const pids = holders();
    if (pids.length === 0) {
      if (killed > 0) console.log(`${label}: swept ${killed} orphaned process(es)`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `still ${pids.length} process(es) holding ports ${PORTS.join(", ")} or matching ` +
          `${ORPHAN_PATTERN} after 30s: ${pids.join(", ")}\n` +
          `    pkill -f "${ORPHAN_PATTERN}"; lsof -ti:${PORTS.join(",")} | xargs kill -9`
      );
    }
    spawnSync("kill", ["-9", ...pids], { stdio: "ignore" });
    killed += pids.length;
    // A short pause without a foreground sleep: the kill returns before the OS
    // has reaped the group or released the listening sockets.
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},400)"]);
  }
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
  sweep(`  ${file}`);
  execFileSync(process.execPath, [out], {
    stdio: "inherit",
    cwd: root,
    // `import.meta.url` is empty under CJS, so the repo root is passed in.
    env: { ...process.env, NBHD_ROOT: root },
  });
}
