/**
 * The participant's graph, in a real browser, in a real session.
 *
 * `src/player/graph.ts` is pure and `test/unit/player_graph.test.ts` holds every
 * decision in it. What that cannot hold is the part PLATFORM-NOTES §8 names as
 * the residual risk of this whole package: `usePartModeCtxKey` re-emits the same
 * `Nbhd` instance on every publish and relies on a fresh wrapper object to force
 * a re-render. If upstream ever simplifies that call, `Object.is` makes React
 * skip the render and **neighborhoods freeze at their first value** — every
 * screen still showing a correct, plausible network, permanently one publish
 * behind. Only a browser catches it, and a graph is where it is most visible.
 *
 * REAL: real `empirica` dev server, the real example, real Chromium, the real
 * exports map. n = 6, the example's own demo treatment — enough for a
 * Barabási-Albert graph with distinguishable degrees, few enough to drive in
 * under a minute.
 *
 * What is asserted, and why each is here rather than left to the eye:
 *
 *   - the drawing matches the neighborhood it claims: one circle per neighbor
 *     plus the viewer, and the heading's own count agrees with both;
 *   - EVERY tie is incident to the viewer. This is the neighbor-limited claim
 *     restated as geometry, and it is the one thing that would make a
 *     Breadboard-style display cost something. It is checked against the drawn
 *     coordinates, not against the model, because the model is already tested;
 *   - a conflict is drawn when, and only when, two colors actually collide;
 *   - the picture UPDATES when someone else acts. This is §8's residual risk and
 *     the reason this file exists;
 *   - the state exists in text as well as in fill, since in this design the fill
 *     is the task.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { batchConfig, connectAdmin, createBatch } from "../../src/harness/harness.js";

const root = process.env["NBHD_ROOT"] ?? process.cwd();
const example = path.join(root, "examples/shirado2017");
const N = 6;
const BASE = "http://localhost:3000";
const KEYS = Array.from({ length: N }, (_, i) => `g${String(i + 1).padStart(2, "0")}`);

/** Breadboard's, and `graph.ts`'s, defaults. The geometry checks below use them. */
const SIZE = 600;
const CENTER = SIZE / 2;
const EGO_R = 50;

function srtoken(): string {
  const toml = fs.readFileSync(path.join(example, ".empirica/empirica.toml"), "utf8");
  const m = toml.match(/srtoken\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no srtoken in .empirica/empirica.toml");
  return m[1]!;
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE + "/", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function portInUse(port: number): boolean {
  try {
    execFileSync("lsof", ["-ti", `:${port}`], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

interface Tab {
  key: string;
  page: Page;
}

async function openTab(browser: Browser, key: string): Promise<Tab> {
  // One context per participant. Sharing one would make them the same person.
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/?participantKey=${key}`, { waitUntil: "domcontentloaded" });
  return { key, page };
}

async function join(tab: Tab): Promise<void> {
  const { page } = tab;
  await page.getByText(/do you consent/i).waitFor({ state: "visible", timeout: 180_000 });
  await page.getByRole("button", { name: /i agree/i }).click();
  await page
    .getByText(/enter your player identifier/i)
    .waitFor({ state: "visible", timeout: 180_000 });
  await page.locator("input").first().fill(tab.key);
  await page.getByRole("button", { name: /^enter$/i }).click();
  await page.getByText(/^Instructions$/).waitFor({ state: "visible", timeout: 180_000 });
  await page.getByRole("button", { name: /i understand/i }).click();
}

/** The heading's own count, which the server published. */
async function degreeOf(tab: Tab): Promise<number> {
  const text = await tab.page.locator("h2", { hasText: /Your connections/ }).innerText();
  return Number(text.match(/\((\d+)\)/)?.[1] ?? 0);
}

interface Drawn {
  circles: number;
  selfLabels: string[];
  colors: Array<string | null>;
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; conflict: string | null }>;
  summary: string[];
}

async function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const root = document.querySelector(".nbhd-graph")!;
    // `Array.from`, not spread: this runs in the page under the repository's own
    // ES2020 lib, where a NodeList is not typed as iterable.
    const all = (sel: string) => Array.from(root.querySelectorAll(sel));
    const num = (el: Element, a: string) => Number(el.getAttribute(a));
    return {
      circles: all("circle").length,
      selfLabels: all(".nbhd-node-self text").map((t) => t.textContent ?? ""),
      colors: all("circle").map((c) => c.getAttribute("color")),
      lines: all("line").map((l) => ({
        x1: num(l, "x1"),
        y1: num(l, "y1"),
        x2: num(l, "x2"),
        y2: num(l, "y2"),
        conflict: l.getAttribute("conflict"),
      })),
      summary: all("ul li").map((li) => li.textContent ?? ""),
    };
  });
}

async function main(): Promise<void> {
  let dev: ChildProcess | undefined;
  let browser: Browser | undefined;
  const tabs: Tab[] = [];

  try {
    for (const port of [3000, 8844]) {
      if (portInUse(port)) {
        throw new Error(
          `port ${port} is already in use. Stop it and retry:\n` +
            `    lsof -ti:3000,8844 | xargs kill -9`
        );
      }
    }

    // A reused datastore carries participants from an earlier run, who occupy
    // seats these browsers then cannot fill, and the game never starts.
    fs.rmSync(path.join(example, ".empirica/local"), { recursive: true, force: true });

    const log = fs.openSync("/tmp/empirica-network-graph.log", "w");
    dev = spawn("empirica", [], { cwd: example, stdio: ["ignore", log, log], detached: true });
    await waitFor(serverUp, "empirica dev server on :3000", 300_000);

    const admin = await connectAdmin({ url: BASE + "/query", srtoken: srtoken() } as any);
    try {
      const batch = await createBatch(admin, batchConfig(N, 1, [{ botCount: 0 }]));
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
    for (const key of KEYS) tabs.push(await openTab(browser, key));
    // Serially: the identifier screen races if every tab submits at once.
    for (const tab of tabs) await join(tab);

    await waitFor(
      async () =>
        (
          await Promise.all(
            tabs.map((t) =>
              t.page
                .locator(".nbhd-graph svg")
                .isVisible()
                .catch(() => false)
            )
          )
        ).every(Boolean),
      "the graph in every window"
    );
    console.log(`  ${N} windows joined and drew a graph`);

    // Everyone green: every tie is a conflict, which is the unambiguous end of
    // the range and makes the conflict assertion below a real one.
    for (const tab of tabs) {
      await tab.page.locator('button[title="green"]').click();
      await tab.page.waitForTimeout(120);
    }
    await tabs[0]!.page.waitForTimeout(3_000);

    const degrees = await Promise.all(tabs.map(degreeOf));
    console.log(`  degrees: ${degrees.join(",")}`);
    assert.ok(
      degrees.some((d) => d > 0),
      "a Barabasi-Albert graph leaves nobody isolated; a run where it did proves nothing"
    );

    for (const [i, tab] of tabs.entries()) {
      const d = degrees[i]!;
      const g = await drawn(tab.page);

      assert.equal(
        g.circles,
        d + 1,
        `${tab.key}: the drawing must match the neighborhood it claims (degree ${d})`
      );
      assert.deepEqual(g.selfLabels, ["You"], `${tab.key}: exactly one node is the viewer`);

      assert.equal(g.lines.length, d, `${tab.key}: one tie per neighbor at radius 1`);
      for (const l of g.lines) {
        // Every drawn tie starts exactly one ego radius from the center. This is
        // the neighbor-limited claim as geometry: a tie between two of this
        // viewer's neighbors could not satisfy it, and neither could a tie to
        // somebody they cannot see.
        const fromEgo = Math.hypot(l.x1 - CENTER, l.y1 - CENTER);
        assert.ok(
          Math.abs(fromEgo - EGO_R) < 0.5,
          `${tab.key}: a tie not incident to the viewer was drawn (${fromEgo.toFixed(1)} from center)`
        );
      }

      // Everyone chose green, so every tie collides.
      assert.ok(
        g.colors.every((c) => c === "green"),
        `${tab.key}: the server's value must reach the DOM as an attribute, or no CSS selects it`
      );
      assert.ok(
        g.lines.every((l) => l.conflict === "1"),
        `${tab.key}: every tie is a color conflict and must be drawn as one`
      );

      assert.equal(
        g.summary.length,
        d + 1,
        `${tab.key}: the state must exist in text too — here the fill IS the task`
      );
    }
    console.log("  every window drew its own neighborhood, star-shaped, all conflicting");

    // §8's residual risk: does the picture still change when somebody else acts?
    const mover = degrees.findIndex((d) => d > 0);
    await tabs[mover]!.page.locator('button[title="purple"]').click();
    await tabs[0]!.page.waitForTimeout(3_000);

    let sawNeighborUpdate = false;
    for (const [i, tab] of tabs.entries()) {
      if (i === mover) continue;
      const g = await drawn(tab.page);
      if (g.colors.includes("purple")) {
        sawNeighborUpdate = true;
        assert.ok(
          g.lines.some((l) => l.conflict === "0"),
          `${tab.key}: a neighbor who no longer shares your color must stop conflicting`
        );
      }
    }
    assert.ok(
      sawNeighborUpdate,
      "no window saw the change. Either the mover is isolated (impossible on Barabasi-Albert) " +
        "or published views have stopped reaching React — PLATFORM-NOTES §8's residual risk, " +
        "which looks exactly like a correct screen one publish behind."
    );

    // And the viewer's own node, which is not in `neighbors` and reaches the
    // drawing by a different path.
    const own = await drawn(tabs[mover]!.page);
    assert.equal(
      own.colors[0],
      "purple",
      "the viewer's own choice must reach their own node; a screen showing everyone's color but yours is another task"
    );

    console.log("  live updates reach the drawing, on both paths");
    console.log("network_graph: ok");
  } finally {
    for (const tab of tabs) await tab.page.context().close().catch(() => {});
    await browser?.close().catch(() => {});
    // The whole process group: killing only `empirica` leaves vite and the
    // callbacks server holding their ports, breaking the NEXT run.
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
