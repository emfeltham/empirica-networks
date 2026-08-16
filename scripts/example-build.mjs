/**
 * Build every example's client, or a named one.
 *
 *   node scripts/example-build.mjs                # all of them
 *   node scripts/example-build.mjs rand2011       # just one
 *
 * Run `npm run example:install` first — this builds, it does not install.
 *
 * WHY THIS IS A SCRIPT AND NOT A LINE IN CI. Until M6 Tier 4, CI built exactly one
 * example client (`minimal`) because that was the line someone wrote when there was
 * one example. Two more arrived in M5 and the line did not change, so seven new or
 * changed `.jsx` files shipped having been checked with `@babel/parser` — which
 * catches JSX and syntax errors and **cannot** catch a wrong import path. Iterating
 * over the directory means the next example is covered by existing.
 *
 * What a green build here actually proves, measured 2026-08-16 by breaking it on
 * purpose: an import of `empirica-networks/player/reactt` fails the build with
 * `Missing "./player/reactt" specifier in "empirica-networks" package`. So this
 * exercises the package's real **exports map** against a real bundler, which is the
 * one thing no test in the three tiers does — they all alias the package to `src`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "examples");

const available = fs
  .readdirSync(examplesDir, { withFileTypes: true })
  .filter(
    (e) => e.isDirectory() && fs.existsSync(path.join(examplesDir, e.name, "client", "package.json"))
  )
  .map((e) => e.name)
  .sort();

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!available.includes(name)) {
    console.error(`Unknown example "${name}". Available: ${available.join(", ")}`);
    process.exit(1);
  }
}
const targets = requested.length > 0 ? requested : available;
if (targets.length === 0) {
  console.error("No example clients found — nothing to build.");
  process.exit(1);
}

for (const name of targets) {
  const client = path.join(examplesDir, name, "client");
  // A missing install is reported here rather than as a bundler error about a
  // package that is simply not there.
  if (!fs.existsSync(path.join(client, "node_modules", "empirica-networks"))) {
    console.error(
      `${name}: empirica-networks is not installed in its client. ` +
        `Run: node scripts/example-install.mjs ${name}`
    );
    process.exit(1);
  }
  console.log(`\n=== ${name} ===`);
  execFileSync("npm", ["--prefix", client, "run", "build"], { stdio: "inherit", cwd: root });
}

console.log(`\nBuilt: ${targets.join(", ")}`);
