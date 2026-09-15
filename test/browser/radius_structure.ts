/**
 * Radius 1.5, in a real browser.
 *
 * `test/e2e/subgraph.test.ts` holds the wire — containment, completeness,
 * non-vacuity — and `test/unit/graph_payload.test.ts` holds the geometry. What
 * neither can hold is whether the extra ties are actually DRAWN, and that is not
 * a small gap: every assertion in this repository would stay green if the
 * payload arrived correctly and the renderer ignored it. The screen would show a
 * perfectly good star, which is a correct-looking picture of a study running at
 * the other radius.
 *
 * REAL: the real `empirica` dev server, `examples/minimal` started with
 * `NBHD_RADIUS=1.5`, real Chromium, the real exports map. The example switches
 * to a ring lattice under that flag because a ring has no ties among anyone's
 * neighbors at all — see its `callbacks.js`.
 *
 * n = 5, the smallest size `ringLattice(n, 2)` accepts. Every participant then
 * has four neighbors on a five-node graph, which makes the closed neighborhood
 * the whole graph and is worth saying out loud: it is a legitimate shape, and it
 * means this file proves the ties are drawn, not that anything is withheld. The
 * withholding is `subgraph.test.ts`'s claim and it is made on a graph that has
 * non-neighbors to withhold.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { batchConfig, connectAdmin, createBatch } from "../../src/harness/harness.js";

const root = process.env["NBHD_ROOT"] ?? process.cwd();
const example = path.join(root, "examples/minimal");
const N = 5;
const BASE = "http://localhost:3000";
const KEYS = Array.from({ length: N }, (_, i) => `s${String(i + 1).padStart(2, "0")}`);
const COLORS = ["red", "amber", "green", "blue", "violet"];
const CENTER = 300;
const EGO_R = 50;

function srtoken(): string {
  const toml = fs.readFileSync(path.join(example, ".empirica/empirica.toml"), "utf8");
  return toml.match(/srtoken\s*=\s*"([^"]+)"/)![1]!;
}

async function waitFor(c: () => boolean | Promise<boolean>, label: string, t = 180_000) {
  const deadline = Date.now() + t;
  for (;;) {
    if (await c()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(BASE + "/", { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
/**
 * The same sweep `scripts/test-browser.mjs` runs between FILES, run between the
 * two servers this file starts.
 *
 * Needed for the reason that script documents: the callbacks server lives in its
 * own npm process group, survives the group-kill aimed at the dev server, holds
 * no port of its own, and reconnects to whatever server comes up next. Between
 * files the harness catches it; within one file nothing did, and the symptom was
 * the second run timing out on "the graph in every window" while the server log
 * showed a state mismatch. Measured at 2 failures in 4 runs before this.
 */
function sweepOrphans(): void {
  const look = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
    } catch {
      // Both tools exit non-zero when they match nothing, which is the ordinary
      // case and not an error. Treating it as one made this sweep fail every
      // run — louder than the flake it was written to fix, and in the same
      // place, which is its own small lesson about guards.
      return "";
    }
  };

  const deadline = Date.now() + 30_000;
  for (;;) {
    const pids = new Set<string>();
    for (const out of [
      look("lsof", ["-ti", ":3000,:8844"]),
      look("pgrep", ["-f", "empirica-networks/examples/.*callBackSessionToken"]),
    ]) {
      for (const pid of out.split("\n")) if (pid.trim()) pids.add(pid.trim());
    }
    if (pids.size === 0) return;
    if (Date.now() > deadline) throw new Error(`could not clear ${[...pids].join(", ")}`);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    execFileSync("sleep", ["0.3"]);
  }
}

function portInUse(p: number): boolean {
  try {
    execFileSync("lsof", ["-ti", `:${p}`], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

async function join(page: Page, key: string): Promise<void> {
  await page.getByText(/do you consent/i).waitFor({ state: "visible", timeout: 180_000 });
  await page.getByRole("button", { name: /i agree/i }).click();
  await page
    .getByText(/enter your player identifier/i)
    .waitFor({ state: "visible", timeout: 180_000 });
  await page.locator("input").first().fill(key);
  await page.getByRole("button", { name: /^enter$/i }).click();
  await page
    .getByText(/what should your neighbors call you/i)
    .waitFor({ state: "visible", timeout: 180_000 });
  await page.locator('input[type="text"]').first().fill(`name-${key}`);
  await page.getByRole("button", { name: /next/i }).click();
}

interface Drawn {
  circles: number;
  /** Marks carrying `.nbhd-node-far` — people this viewer is NOT connected to. */
  far: number;
  /** Every mark's drawn radius, so "smaller" can be checked rather than assumed. */
  radii: number[];
  farRadii: number[];
  lines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  note: string;
}

async function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const root = document.querySelector(".nbhd-graph")!;
    const all = (sel: string) => Array.from(root.querySelectorAll(sel));
    const num = (el: Element, a: string) => Number(el.getAttribute(a));
    return {
      circles: all("circle").length,
      far: all(".nbhd-node-far circle").length,
      radii: all("circle").map((c) => num(c, "r")),
      farRadii: all(".nbhd-node-far circle").map((c) => num(c, "r")),
      lines: all("line").map((l) => ({
        x1: num(l, "x1"),
        y1: num(l, "y1"),
        x2: num(l, "x2"),
        y2: num(l, "y2"),
      })),
      note: document.body.innerText,
    };
  });
}

/** A tie is incident to the viewer iff one end starts an ego radius from centre. */
function touchesEgo(l: { x1: number; y1: number; x2: number; y2: number }): boolean {
  const a = Math.hypot(l.x1 - CENTER, l.y1 - CENTER);
  const b = Math.hypot(l.x2 - CENTER, l.y2 - CENTER);
  return Math.abs(a - EGO_R) < 1.5 || Math.abs(b - EGO_R) < 1.5;
}

/**
 * One run at one radius.
 *
 * Both radii go through the same setup because the claim is the same at each —
 * that what the payload carries is what the screen shows — and only the thing
 * being looked for differs. Two servers rather than one: the example reads
 * `NBHD_RADIUS` at module load, which is also what makes it a faithful test of
 * the way a researcher actually switches.
 */
async function run(radius: "1.5" | "2"): Promise<void> {
  let dev: ChildProcess | undefined;
  let browser: Browser | undefined;
  const pages: Page[] = [];
  try {
    for (const p of [3000, 8844]) {
      if (portInUse(p)) throw new Error(`port ${p} is already in use`);
    }
    fs.rmSync(path.join(example, ".empirica/local"), { recursive: true, force: true });

    const log = fs.openSync("/tmp/empirica-radius.log", "w");
    dev = spawn("empirica", [], {
      cwd: example,
      stdio: ["ignore", log, log],
      detached: true,
      // The whole point of this file. Without it the example runs at radius 1
      // and every assertion below would be about the wrong study.
      env: { ...process.env, NBHD_RADIUS: radius },
    });
    await waitFor(serverUp, "empirica dev server on :3000", 300_000);

    const admin = await connectAdmin({ url: BASE + "/query", srtoken: srtoken() } as any);
    try {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await admin.taj.setAttribute({
        key: "lobbyConfig",
        val: JSON.stringify({ kind: "shared", duration: 300_000_000_000, strategy: "ignore" }),
        nodeID: batch.id,
      });
      await batch.running();
    } finally {
      admin.stop();
    }

    browser = await chromium.launch();
    for (const key of KEYS) {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/?participantKey=${key}`, { waitUntil: "domcontentloaded" });
      pages.push(page);
      // Serially: the identifier screen races if every tab submits at once.
      await join(page, key);
    }

    await waitFor(
      async () =>
        (
          await Promise.all(
            pages.map((p) =>
              p
                .locator(".nbhd-graph svg")
                .isVisible()
                .catch(() => false)
            )
          )
        ).every(Boolean),
      "the graph in every window"
    );
    for (const [i, p] of pages.entries()) {
      await p.locator(`button[title="${COLORS[i]}"]`).click();
      await p.waitForTimeout(120);
    }
    await pages[0]!.waitForTimeout(3_000);
    console.log(`  ${N} windows joined and drew a graph`);

    let extraTotal = 0;
    let farTotal = 0;
    for (const [i, p] of pages.entries()) {
      const g = await drawn(p);
      const degree = g.circles - 1;
      assert.ok(degree > 0, `${KEYS[i]}: neither shape leaves anybody isolated`);

      farTotal += g.far;
      // Drawn smaller, and checked rather than assumed: a participant can act on
      // a neighbor and cannot act on anybody further out, so the two must not
      // look alike. The style is the package's default and a study may override
      // it — what must not happen is the ring failing to appear at all.
      for (const r of g.farRadii) {
        assert.ok(
          r < Math.max(...g.radii),
          `${KEYS[i]}: a distant person was drawn ${r}, the same size as somebody reachable`
        );
      }

      const extra = g.lines.filter((l) => !touchesEgo(l));
      extraTotal += extra.length;

      // Every drawn tie joins two nodes that are on this screen. The renderer
      // gets local indices and could put an endpoint anywhere; a line running
      // off to a coordinate nobody was sent is the shape of the failure.
      for (const l of g.lines) {
        const ends: Array<[number, number]> = [
          [l.x1, l.y1],
          [l.x2, l.y2],
        ];
        for (const [x, y] of ends) {
          assert.ok(
            Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 600 && y >= 0 && y <= 600,
            `${KEYS[i]}: a tie was drawn to (${x}, ${y}), which is off the canvas`
          );
        }
      }

      if (radius === "1.5") {
        assert.match(
          g.note,
          /connected to each other/,
          `${KEYS[i]}: the screen must say what it is showing at this radius`
        );
      }
    }

    // THE POINT. Without this the whole file passes on a star.
    assert.ok(
      extraTotal > 0,
      `not one tie beyond a star was drawn anywhere at radius ${radius}. Either the ` +
        `payload is not reaching the renderer or the example is not running at that ` +
        `radius — and a star is a correct-looking picture of a different study.`
    );
    console.log(`  ${extraTotal} tie(s) drawn beyond every star`);

    if (radius === "2") {
      // The second ring. `graphModelOf` built its node list from `neighbors`
      // until this feature, which dropped every distant person AND silently
      // discarded every edge touching one — leaving a complete, plausible
      // radius 1.5 picture. Nothing else in the repository would have noticed:
      // the payload was correct and the renderer ignored half of it.
      assert.ok(
        farTotal > 0,
        "not one person beyond a viewer's own neighbors was drawn. At radius 2 on a " +
          "ring every participant has two. Three causes, in the order they are worth " +
          "checking: the example is running against a STALE tarball (this tier does not " +
          "reinstall — run `npm run build && npm run example:install minimal`, and look " +
          "for `graph.radius must be` in /tmp/empirica-radius.log, which is how this " +
          "was found the first time); the example is not reading NBHD_RADIUS; or the " +
          "renderer is dropping the payload's far nodes."
      );
      console.log(`  ${farTotal} distant person/people drawn, across ${N} screens`);
    }

    if (process.env["SHOT_DIR"]) {
      await pages[0]!.screenshot({
        path: path.join(process.env["SHOT_DIR"]!, `radius${radius.replace(".", "")}.png`),
      });
    }
    console.log(`radius_structure at ${radius}: ok`);
  } finally {
    for (const p of pages) await p.context().close().catch(() => {});
    await browser?.close().catch(() => {});
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

async function main(): Promise<void> {
  // Serially, and 1.5 first: it is the older claim, so a failure there is a
  // regression while a failure at 2 is the new feature not arriving.
  await run("1.5");
  // Between them, not only after: see `sweepOrphans`.
  sweepOrphans();
  await run("2");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
