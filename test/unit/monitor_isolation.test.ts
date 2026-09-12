/**
 * H1: monitor code must never reach a participant's bundle.
 *
 * The monitor is the one surface holding the complete graph — every tie, every
 * seat assignment, every participant's private state. Anything reachable from
 * the participant app is readable by participants, so this is not a tidiness
 * rule; it is the same claim the rest of the package makes about state,
 * applied to code.
 *
 * This is ruled out STRUCTURALLY rather than by
 * discipline. That is a claim about what a bundler does, so the strong test here
 * bundles the participant entry the way a consumer's vite would and reads the
 * output — the source scans below are the fast, precise version that names the
 * offending file when it fails.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** Every `.ts` under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    out.push(path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
  }
  return out;
}

test("no player-side file imports admin, the monitor, or any node builtin", () => {
  const offenders: string[] = [];
  for (const file of filesUnder(path.join(SRC, "player"))) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(SRC, file);
    // `import type` / `export type` are erased and cannot ship anything, so they
    // are not offences — but a value import from admin drags server-only code,
    // and from admin/monitor it drags the complete graph.
    //
    // `export … from` is covered as well as `import`, and that is not
    // hypothetical: the first version of this scan checked only `import`, and a
    // deliberately planted `export { PAGE } from "../admin/monitor/ui.js"` in
    // the player barrel sailed straight past it. The bundle test below caught
    // it, which is why both exist — but a re-export ships exactly as much code
    // as an import and must fail here too, where the message names the file.
    for (const line of source.match(/^(import|export)\s+(?!type\s).*from\s+["'].*$/gm) ?? []) {
      if (/from\s+["'][^"']*\/admin/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      if (/from\s+["']node:/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "player code must import neither admin nor a node builtin");
});

test("the root barrel re-exports neither half", () => {
  // The one mistake in @empirica/core's own index.ts not to inherit. If `.` ever
  // re-exported admin, every client bundle would pull the server in — and now
  // the monitor with it.
  const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
  for (const line of index.match(/^export\s+.*$/gm) ?? []) {
    assert.equal(
      /["'](\.\/)?(admin|player)/.test(line),
      false,
      `the root barrel must stay isomorphic, found: ${line.trim()}`,
    );
  }
});

test("the admin barrel does not pull the monitor in", () => {
  // `empirica-networks/admin` is what every consumer's server imports. The
  // monitor sits behind its own subpath so that a server which never opts in
  // never loads node:http or the served page — and so that "does this
  // deployment expose the whole graph" is answerable by grepping one import.
  const barrel = fs.readFileSync(path.join(SRC, "admin", "index.ts"), "utf8");
  assert.equal(
    /from\s+["']\.\/monitor/.test(barrel),
    false,
    "admin/index.ts must not re-export ./monitor",
  );
});

test("only the monitor may open a socket", () => {
  // node:http anywhere else in the package would be a second listening surface
  // that this file's reasoning does not cover.
  const allowed = path.join(SRC, "admin", "monitor", "http.ts");
  const offenders: string[] = [];
  for (const file of filesUnder(SRC)) {
    if (file === allowed) continue;
    // The test harness spawns and probes a Tajriba server; that is a client, not
    // a listener, and it never ships in the library entries.
    if (file.includes(`${path.sep}harness${path.sep}`)) continue;
    if (/from\s+["']node:http["']/.test(fs.readFileSync(file, "utf8"))) {
      offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("BUNDLED for the browser, the player entry contains no monitor at all", async () => {
  // The structural claim, exercised rather than reasoned about: run the same
  // kind of bundle a consumer's vite build runs, and read what comes out.
  const result = await build({
    entryPoints: [path.join(SRC, "player", "index.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
    external: ["@empirica/core", "@empirica/core/*", "react", "react-dom", "rxjs"],
  });
  const out = result.outputFiles.map((f) => f.text).join("\n");

  assert.ok(out.length > 0, "the bundle must be non-empty, or this asserts nothing");
  for (const forbidden of [
    "empirica-networks monitor", // the served page's own title
    "node:http",
    "createServer",
    "srtoken",
    "timingSafeEqual",
    "text/event-stream",
  ]) {
    assert.equal(
      out.includes(forbidden),
      false,
      `"${forbidden}" reached the participant bundle`,
    );
  }
});

test("BUNDLED, the react entry is equally clean", async () => {
  const result = await build({
    entryPoints: [path.join(SRC, "player", "react", "index.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
    external: ["@empirica/core", "@empirica/core/*", "react", "react-dom", "rxjs"],
  });
  const out = result.outputFiles.map((f) => f.text).join("\n");
  assert.ok(out.length > 0);
  assert.equal(out.includes("empirica-networks monitor"), false);
  assert.equal(out.includes("node:http"), false);
});

test("the monitor's HTTP layer takes no Empirica type at all", () => {
  // What makes H2 structural rather than conventional: `serveMonitor` is handed
  // a snapshot function, never a connection and never an srtoken, so there is no
  // code path from the served page to setAttribute. If this file ever imports
  // @empirica/*, that argument stops holding.
  const http = fs.readFileSync(path.join(SRC, "admin", "monitor", "http.ts"), "utf8");
  assert.equal(/from\s+["']@empirica/.test(http), false);
  assert.equal(/srtoken/i.test(http.replace(/\/\*[\s\S]*?\*\//g, "")), false,
    "srtoken must not appear outside the explanatory comment");
});
