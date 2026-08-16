/**
 * Install this package into the shipped examples, as a PACKED TARBALL.
 *
 * Not a `file:` link, and that is the whole reason this script exists rather than
 * a line of npm config. npm turns a `file:` dependency into a symlink to the repo
 * root, whose own `node_modules` holds a second copy of `@empirica/core` — and
 * two copies break every `instanceof` inside Empirica. The symptom names nothing:
 * every participant stuck on "Waiting for other players" with a full game, and a
 * hundred zod stack traces mentioning neither this package nor the real cause.
 * Measured and written up in `docs/PLATFORM-NOTES.md` §11.
 *
 * A packed tarball produces a real directory with no nested core, so
 * `@empirica/core` resolves once — which is also exactly what a published
 * consumer gets, since core is a peerDependency. The examples therefore exercise
 * the real artifact rather than a development convenience.
 *
 *   node scripts/example-install.mjs              # every example
 *   node scripts/example-install.mjs minimal      # just one
 *
 * Installing every example's client pulls a full Vite toolchain three times, so
 * naming one is worth knowing about.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "examples");

const available = fs
  .readdirSync(examplesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(examplesDir, e.name, "server")))
  .map((e) => e.name)
  .sort();

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!available.includes(name)) {
    // An unknown name is an error rather than a silent no-op: `example:install
    // rand201` would otherwise report success having installed nothing, which is
    // the same class of failure this package keeps guarding against.
    console.error(`Unknown example "${name}". Available: ${available.join(", ")}`);
    process.exit(1);
  }
}
const targets = requested.length > 0 ? requested : available;

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd });

console.log("Building and packing…");
run("npm", ["run", "build"]);
run("npm", ["pack", "--pack-destination", "."]);

const tarball = fs
  .readdirSync(root)
  .filter((f) => f.startsWith("empirica-networks-") && f.endsWith(".tgz"))
  .sort()
  .at(-1);
if (!tarball) {
  console.error("npm pack produced no tarball");
  process.exit(1);
}

for (const name of targets) {
  const dir = path.join(examplesDir, name);
  console.log(`\n=== ${name} ===`);
  for (const half of ["server", "client"]) {
    const halfDir = path.join(dir, half);
    if (!fs.existsSync(path.join(halfDir, "package.json"))) continue;
    // Remove the previously installed copy AND the lockfile entry for it, so a
    // stale build cannot survive a re-install and be mistaken for the new one.
    fs.rmSync(path.join(halfDir, "node_modules", "empirica-networks"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(halfDir, "package-lock.json"), { force: true });
    // Vite caches pre-bundled deps; a stale cache serves the old package to the
    // browser while the server runs the new one, which is a difficult afternoon.
    fs.rmSync(path.join(halfDir, "node_modules", ".vite"), { recursive: true, force: true });
    run("npm", ["--prefix", halfDir, "install"]);
  }
}

console.log(`\nInstalled ${tarball} into: ${targets.join(", ")}`);
