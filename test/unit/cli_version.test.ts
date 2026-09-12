import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The verify CLI prints which @empirica/core it was compiled against, so a user
 * can tell whether the run reflects their own install. A wrong number there is
 * worse than none, because it is stated with confidence.
 *
 * It used to print a literal of its own, checked against package.json by this
 * test — while `src/harness/compat.ts` held a SECOND literal of the same number
 * that nothing read and nothing checked (`ISSUES.md` O7b). There is now one
 * declaration, `VERIFIED_CORE`, and `test/unit/upstream_pin.test.ts` holds it
 * against the pin and against every `@empirica/core@…` citation in the docs.
 * What is left to check here is that the CLI has not grown a private copy again.
 */
test("the CLI prints the one pin declaration rather than a literal of its own", () => {
  const cli = fs.readFileSync(path.join(root, "src/verify/cli.ts"), "utf8");

  assert.match(
    cli,
    /import \{ VERIFIED_CORE \} from "\.\.\/harness\/compat\.js"/,
    "cli.ts takes the version from src/harness/compat.ts"
  );
  assert.match(cli, /\$\{VERIFIED_CORE\}/, "…and prints it");

  // The failure this guards: someone hardcodes 1.12.5 — or worse, a stale
  // 1.12.4 — back into cli.ts, and the two numbers drift apart again in silence.
  const literal = cli.match(/=\s*"\d+\.\d+\.\d+"/);
  assert.equal(
    literal,
    null,
    `cli.ts declares a version literal of its own (${literal?.[0]}). ` +
      `The pin is declared once, in src/harness/compat.ts.`
  );
});

test("the leak check's minimum n is documented in the CLI help", () => {
  // n<4 makes the check vacuous (below it every named topology makes everyone
  // everyone's neighbor). The CLI must say so rather than silently accept and
  // report a meaningless PASS.
  const cli = fs.readFileSync(path.join(root, "src/verify/cli.ts"), "utf8");
  assert.match(cli, /minimum 4/, "help text states the minimum");
  assert.match(cli, /args\.n < 4/, "the minimum is actually enforced");
});

test("--topology is validated too, not cast and ignored", () => {
  // The same principle as the test above, asserted for the other flag because it
  // was NOT held there. `--topology` used to be parsed as `argv[++i] as "ring"`:
  // every string typechecked, none took effect, and `--topology=star` ran a ring
  // while the verdict printed "topology: star of N … PASS". A tool whose whole
  // purpose is to be trusted about the guarantee reported a shape it had not run.
  //
  // A source-text test for the same reason as the one above: `cli.ts` imports
  // `@empirica/core/console` and calls `main()` at module scope, so the unit tier
  // cannot load it. The accounting it delegates to IS unit-loadable, and is
  // covered directly in `leak_vacuity.test.ts`.
  const cli = fs.readFileSync(path.join(root, "src/verify/cli.ts"), "utf8");
  assert.doesNotMatch(
    cli,
    /topology\s*=\s*[^;]*\bas\s+"ring"/,
    "the unchecked cast is back, and with it a flag that is reported but not honored"
  );
  assert.match(cli, /preflightCliTopology/, "an unknown or vacuous topology is refused");
});
