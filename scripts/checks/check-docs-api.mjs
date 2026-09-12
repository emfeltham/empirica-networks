#!/usr/bin/env node
/**
 * Check that every `empirica-networks` import written in the documentation
 * actually resolves against the built package.
 *
 * The failure this catches is specific and has happened here: an export is
 * renamed, the code and tests move with it, and a snippet in a document keeps
 * compiling in the reader's head. `net.games()` became `net.activeGames()` at
 * M6; `EdgeRow` stopped being an interface; the export helpers moved to their
 * own subpath. Each of those is a documented import that silently stopped being
 * true.
 *
 * Scope, deliberately narrow: **import specifiers and subpaths only.** Full
 * doc-tests were considered and rejected — most snippets
 * are fragments by design, and rewriting them into compilable programs would
 * make them worse documentation to catch errors this already catches. What is
 * checked here is the part that goes stale without anyone noticing.
 *
 * Requires `npm run build` first: it reads the generated .d.ts files, because
 * importing the modules is not possible — `@empirica/core/admin` cannot be
 * loaded from bare Node in either module system (docs/PLATFORM-NOTES.md §3a),
 * which is the same constraint that shaped the package's own entry points.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const SKIP = new Set(["node_modules", "dist", ".git"]);

function markdownFiles(dir = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".tmp-")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

/**
 * Named imports from this package, with the line they appear on.
 *
 * Only inside fenced code blocks: prose mentions a name in backticks constantly,
 * and treating those as imports would flag every sentence about a type.
 */
function importsOf(text) {
  const found = [];
  const lines = text.split("\n");
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;

    const m = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](empirica-networks(?:\/[^"']*)?)["']/.exec(line);
    if (m) {
      const names = m[1]
        .split(",")
        .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      found.push({ subpath: m[2], names, line: i + 1 });
      continue;
    }
    // `import * as topology from "empirica-networks/topology"` — subpath only.
    const star = /^\s*import\s+\*\s+as\s+\w+\s+from\s+["'](empirica-networks(?:\/[^"']*)?)["']/.exec(line);
    if (star) found.push({ subpath: star[1], names: [], line: i + 1 });
  }
  return found;
}

/** The .d.ts a subpath resolves to, via package.json exports. */
function typesFor(subpath) {
  const key = subpath === "empirica-networks" ? "." : `.${subpath.slice("empirica-networks".length)}`;
  const entry = PKG.exports?.[key];
  if (!entry) return { error: `not in package.json exports` };
  const types = typeof entry === "string" ? undefined : entry.types;
  if (!types) return { error: `exports["${key}"] declares no types` };
  const path = resolve(ROOT, types);
  if (!existsSync(path)) return { error: `${types} missing — run \`npm run build\`` };
  return { path };
}

/**
 * Every name a .d.ts exports.
 *
 * tsup emits `export { A as Name, ... }` with internal aliases, so the name a
 * consumer writes is the one AFTER `as`. Re-exported declarations
 * (`export declare function x`) are collected too, since not every entry uses
 * the aliased form.
 */
const cache = new Map();
function exportsOf(path) {
  if (cache.has(path)) return cache.get(path);
  const text = readFileSync(path, "utf8");
  const names = new Set();

  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] ?? bits[0] ?? "").trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(
    /export\s+declare\s+(?:function|class|const|let|var|abstract\s+class)\s+(\w+)/g
  )) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/export\s+(?:type|interface|enum)\s+(\w+)/g)) names.add(m[1]);

  cache.set(path, names);
  return names;
}

let problems = 0;
let checked = 0;

for (const file of markdownFiles()) {
  for (const { subpath, names, line } of importsOf(readFileSync(file, "utf8"))) {
    const where = `${relative(ROOT, file)}:${line}`;
    const resolved = typesFor(subpath);
    if (resolved.error) {
      console.error(`${where}  ${subpath} — ${resolved.error}`);
      problems++;
      continue;
    }
    const available = exportsOf(resolved.path);
    for (const name of names) {
      checked++;
      if (!available.has(name)) {
        console.error(`${where}  "${name}" is not exported by ${subpath}`);
        problems++;
      }
    }
  }
}

console.log(`${checked} documented import(s) checked against dist; ${problems} problem(s).`);
process.exit(problems > 0 ? 1 : 0);
