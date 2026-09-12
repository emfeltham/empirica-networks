#!/usr/bin/env node
/**
 * Check every relative link in the repository's markdown.
 *
 * Two failure modes, both silent and both already present before this existed:
 * a moved or renamed file leaving a dead path, and a section anchor that no
 * longer matches its heading. The second is the likelier one here — sections in
 * PLATFORM-NOTES are numbered by discovery order, so they get renumbered, and
 * there are already a §3a and two §9s.
 *
 * Deliberately does NOT check external URLs: that would make the run depend on
 * the network and on other people's uptime, which turns a link checker into a
 * flake generator. What it checks is what this repository controls.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SKIP = new Set(["node_modules", "dist", ".git", ".tmp-test", ".tmp-bench", ".tmp-soak", ".tmp-test-one"]);

/** Every .md file in the repo, minus vendored and generated trees. */
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
 * GitHub's anchor slug for a heading.
 *
 * Lowercase, strip anything that is not a word character, space or hyphen, then
 * spaces to hyphens. Inline code and emphasis markers go first, since a heading
 * like `### 1.1 Make an unlisted key a loud error` carries backticks that are not
 * part of the slug.
 */
function slug(heading) {
  return heading
    .replace(/`/g, "")
    .replace(/[*_]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(text) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slug(m[2]);
    // Duplicate headings get -1, -2, … suffixes, which is how PLATFORM-NOTES'
    // two `## 9.` sections both remain linkable.
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Links, minus anything inside a fenced code block — those are illustrative. */
function linksOf(text) {
  const links = [];
  let inFence = false;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Blank out inline code spans before matching. A `[label](path)` written
    // inside backticks is illustrative — prose ABOUT a link, not a link — and
    // this checker's own documentation was the first thing to trip on it.
    const prose = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const m of prose.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ text: m[1], target: m[2], line: i + 1 });
    }
  }
  return links;
}

const files = markdownFiles();
const anchorCache = new Map();
function anchorsFor(path) {
  if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(readFileSync(path, "utf8")));
  return anchorCache.get(path);
}

let broken = 0;
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { target, line } of linksOf(text)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    checked++;

    const [pathPart, anchor] = target.split("#");
    const resolved = pathPart === "" ? file : resolve(dirname(file), pathPart);

    if (!existsSync(resolved)) {
      console.error(`${relative(ROOT, file)}:${line}  missing file: ${target}`);
      broken++;
      continue;
    }
    if (!anchor) continue;
    // A directory link with an anchor is meaningless; a non-markdown one we
    // cannot check. Neither is an error.
    if (statSync(resolved).isDirectory() || !resolved.endsWith(".md")) continue;

    if (!anchorsFor(resolved).has(anchor)) {
      console.error(`${relative(ROOT, file)}:${line}  missing anchor: ${target}`);
      broken++;
    }
  }
}

console.log(
  `${checked} relative link(s) in ${files.length} markdown file(s); ${broken} broken.`
);
process.exit(broken > 0 ? 1 : 0);
