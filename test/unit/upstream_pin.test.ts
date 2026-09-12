import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Everything this package knows about Empirica was measured against ONE version,
 * and `docs/CONTRIBUTING.md` §6 requires every such claim to say which — "measured
 * 2026-08-16 against `@empirica/core@1.12.5`", not "measured". Thirty-eight
 * citations follow that convention today.
 *
 * A convention like that is only worth the ink if bumping the pin makes the stale
 * claims say so. Two mechanisms, answering different questions:
 *
 *   `.github/workflows/drift.yml` — "upstream released something; do the contracts
 *     still hold?" Weekly, against `@empirica/core@latest`, running the mode and
 *     e2e tiers. That is how a fixed upstream defect announces itself: several have
 *     characterization tests that assert the CURRENT broken behavior, so a fix
 *     upstream turns them red with a message saying to close the finding.
 *
 *   this file — "you bumped the pin; here is every claim still dated to the
 *     version you left." Nothing did this (`ISSUES.md` O7b), so an upgrade could
 *     re-date nothing and leave thirty-eight measurements asserting a number that
 *     was no longer the number.
 *
 * It runs in the unit tier deliberately: no server, no Empirica import, so the
 * cheapest tier carries the alarm and `npm test` cannot skip it.
 *
 * NOT asserted here: that the INSTALLED core matches the pin. `drift.yml` installs
 * `@empirica/core@latest` with `--no-save` and then runs the tiers, so that
 * assertion would fail first and mask the contract failures the job exists to
 * find — turning the alarm into a tautology about the version number. Everything
 * below reads only files under version control, which `--no-save` leaves alone.
 */

const PIN = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = pkg.devDependencies?.["@empirica/core"];
  assert.ok(declared, "package.json pins @empirica/core as a devDependency");
  return String(declared).replace(/^[\^~]/, "");
})();

test("VERIFIED_CORE is the pinned @empirica/core", () => {
  // src/harness/compat.ts is read as TEXT rather than imported: it pulls
  // @empirica/core/admin, which cannot be loaded unbundled and is what separates
  // the unit tier from e2e (docs/PLATFORM-NOTES.md §3a). Same idiom as
  // cli_version.test.ts.
  const compat = fs.readFileSync(path.join(root, "src/harness/compat.ts"), "utf8");
  const match = compat.match(/export const VERIFIED_CORE = "([^"]+)"/);
  assert.ok(match, "compat.ts declares VERIFIED_CORE");
  assert.equal(
    match![1],
    PIN,
    `compat.ts says the harness is verified against ${match![1]} but package.json ` +
      `pins ${PIN}. Re-verify, then update the constant — not the other way round.`
  );
});

/**
 * Files that may carry an `@empirica/core@<version>` citation. `dist` and
 * `.tmp-test` are build output (copies of the comments in `src`), `node_modules`
 * is not ours, and `package.json` states the pin rather than citing it.
 */
const ROOTS = ["src", "test", "docs", "scripts", "examples", ".github"];
const ROOT_FILES = ["README.md", "ISSUES.md", "CHANGELOG.md"];

/**
 * Citations that are deliberately historical — "broken in X, fixed in Y" — and so
 * must NOT be re-dated on a bump. Empty, and that is the honest state: nothing in
 * the repo yet describes a version other than the one it runs on, because there
 * has only ever been one. Add `{ file, version, why }` here rather than weakening
 * the check, so the exception is visible and argued.
 */
const HISTORICAL: Array<{ file: string; version: string; why: string }> = [];

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|md|yml|yaml|json)$/.test(entry.name)) out.push(full);
  }
}

test("every @empirica/core citation names the pinned version", () => {
  const files: string[] = [];
  for (const r of ROOTS) {
    const dir = path.join(root, r);
    if (fs.existsSync(dir)) walk(dir, files);
  }
  for (const f of ROOT_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) files.push(p);
  }

  const stale: string[] = [];
  let seen = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/@empirica\/core@(\d+\.\d+\.\d+)/g)) {
        seen++;
        const version = m[1]!;
        if (version === PIN) continue;
        if (HISTORICAL.some((h) => h.file === rel && h.version === version)) continue;
        stale.push(`  ${rel}:${i + 1} — cites ${version}`);
      }
    });
  }

  // Non-vacuity. A regex that matched nothing would pass this test forever, and
  // silently: the whole convention could be deleted from every document and the
  // guard would still be green.
  assert.ok(
    seen >= 20,
    `only ${seen} @empirica/core citations found — the convention or this scan has ` +
      `broken, and a scan that finds nothing agrees with everything`
  );

  assert.deepEqual(
    stale,
    [],
    `the pin is ${PIN}, but these still cite an older version:\n${stale.join("\n")}\n\n` +
      `A bump is not a find-and-replace. Each of these is a MEASUREMENT, and the new ` +
      `version is exactly the reason to doubt it — re-take it, then re-date it. The ` +
      `everything in docs/PLATFORM-NOTES.md is where this matters most; the attributes() ` +
      `finding in particular, because ISSUES.md O11's ` +
      `design rests on there being no attribute enumeration at any layer.`
  );
});
