/**
 * `empirica-networks/export` must stay loadable from plain Node.
 *
 * The row builders and `toCSV` are pure functions over plain data, and the README
 * tells analysts they "run offline over data collected months ago". Until M5 they
 * could not: the only way to reach them was `empirica-networks/admin`, which pulls
 * in `@empirica/core/admin` — and that cannot be loaded from raw Node in either
 * module system (`docs/PLATFORM-NOTES.md` §3a). An offline analysis script died on
 * `cross-fetch/polyfill` before executing a line.
 *
 * Found by writing exactly such a script (`examples/*\/recover.mjs`), which is the
 * point: the trap was documented, the docs pointed at it, and the packaging still
 * walked into it. So this asserts the property rather than restating the intent.
 *
 * Modeled on `test/unit/graphology.test.ts`'s dependency check and on
 * `test/unit/monitor_isolation.test.ts`: scan the SOURCE, so the test is
 * meaningful before `npm run build` has run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SRC = path.join(process.cwd(), "src", "admin", "export.ts");

test("src/admin/export.ts imports nothing at runtime", () => {
  const source = fs.readFileSync(SRC, "utf8");
  const imports = [...source.matchAll(/^import\s+(.*?)from\s+"([^"]+)"/gms)];

  assert.ok(imports.length > 0, "no imports found at all, so this scan is not working");

  for (const [, clause, from] of imports) {
    // A type-only import is erased at build time and costs nothing at runtime.
    assert.match(
      clause!,
      /^type\s|^\{\s*type\s/,
      `export.ts has a RUNTIME import of "${from}". Everything reachable from ` +
        `empirica-networks/export must be loadable from plain Node ESM, and a runtime ` +
        `import is how @empirica/core creeps back in (PLATFORM-NOTES §3a).`
    );
  }
});

test("nothing @empirica or node: is named anywhere in export.ts", () => {
  // Belt and braces on the scan above: a dynamic `await import()` or a `require`
  // would not match the static-import regex.
  const source = fs.readFileSync(SRC, "utf8");
  const code = source
    // Strip block and line comments — §3a is discussed in the prose there.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const forbidden of ["@empirica", "node:", "require(", "import("]) {
    assert.ok(
      !code.includes(forbidden),
      `export.ts references "${forbidden}", which would make the offline subpath unloadable`
    );
  }
});

test("the built subpath exists and is free of @empirica, when a build is present", () => {
  // Conditional on the build, deliberately, and reported rather than skipped
  // silently: the unit tier runs on machines that have not built, and a test that
  // quietly passes when it checked nothing is the failure this repo guards against.
  const built = path.join(process.cwd(), "dist", "export", "index.js");
  if (!fs.existsSync(built)) {
    console.log("    (no dist/export/index.js — run `npm run build` to check the artifact)");
    return;
  }
  const js = fs.readFileSync(built, "utf8");
  assert.ok(!js.includes("@empirica"), "the built export subpath must not import @empirica");
  assert.match(js, /export\s*\{[^}]*toCSV/s, "toCSV is exported from the subpath");
  assert.match(js, /edgeRows/, "edgeRows is in the subpath");
  assert.match(js, /viewRows/, "viewRows is in the subpath");
  // Named here as well, because this test exists to catch a regression in the
  // export map and a list that stops at the builders that happened to exist when
  // it was written would not. These two are the reason an analyst can read a
  // radius 1.5 run offline at all.
  assert.match(js, /structureRows/, "structureRows is in the subpath");
  assert.match(js, /positionRows/, "positionRows is in the subpath");
});
