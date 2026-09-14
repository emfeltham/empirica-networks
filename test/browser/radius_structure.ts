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

async function main(): Promise<void> {
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
      env: { ...process.env, NBHD_RADIUS: "1.5" },
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
    for (const [i, p] of pages.entries()) {
      const g = await drawn(p);
      const degree = g.circles - 1;
      assert.ok(degree > 0, `${KEYS[i]}: a ring lattice leaves nobody isolated`);

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

      assert.match(
        g.note,
        /connected to each other/,
        `${KEYS[i]}: the screen must say what it is showing at this radius`
      );
    }

    // THE POINT. Without this the whole file passes on a star.
    assert.ok(
      extraTotal > 0,
      "not one tie between two neighbors was drawn anywhere. Either the payload is " +
        "not reaching the renderer or the example is not running at radius 1.5 — and " +
        "a star is a correct-looking picture of the other study."
    );
    console.log(`  ${extraTotal} tie(s) drawn between neighbors, beyond every star`);

    if (process.env["SHOT_DIR"]) {
      await pages[0]!.screenshot({ path: path.join(process.env["SHOT_DIR"]!, "radius15.png") });
    }
    console.log("radius_structure: ok");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
