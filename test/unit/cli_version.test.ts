import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The verify CLI prints which @empirica/core it was compiled against, so a user
 * can tell whether the run reflects their own install. That version is a literal
 * in cli.ts, which means it goes stale silently the moment someone bumps the
 * dependency — and a wrong version number is worse than none, because it is
 * stated with confidence.
 */
test("BUNDLED_CORE matches the @empirica/core actually being bundled", () => {
  const cli = fs.readFileSync(path.join(root, "src/verify/cli.ts"), "utf8");
  const match = cli.match(/const BUNDLED_CORE = "([^"]+)"/);
  assert.ok(match, "cli.ts declares BUNDLED_CORE");

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = pkg.devDependencies?.["@empirica/core"];
  assert.ok(declared, "package.json pins @empirica/core as a devDependency");

  assert.equal(
    match![1],
    declared.replace(/^[\^~]/, ""),
    `cli.ts says it bundles ${match![1]} but package.json builds against ${declared}`
  );
});

test("the leak check's minimum n is documented in the CLI help", () => {
  // n<4 makes the check vacuous (everyone is everyone's neighbour on a smaller
  // ring). The CLI must say so rather than silently accept and report a
  // meaningless PASS.
  const cli = fs.readFileSync(path.join(root, "src/verify/cli.ts"), "utf8");
  assert.match(cli, /minimum 4/, "help text states the minimum");
  assert.match(cli, /args\.n < 4/, "the minimum is actually enforced");
});
