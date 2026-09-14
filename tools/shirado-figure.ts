/**
 * Capture the Shirado & Christakis participant screen for the manuscript.
 *
 * This is a FIGURE GENERATOR, not a test, which is why it lives in `tools/` and
 * not in `test/browser/`: `npm run test:browser` runs every file in that
 * directory, and twenty Chromium contexts have no business in the acceptance
 * suite. Run it deliberately, when the figure needs regenerating:
 *
 *   npm run figure:shot
 *
 * It reuses `test/browser/two_windows.ts`'s arrangement — a real `empirica` dev
 * server, the real example, real browsers — because that arrangement is already
 * known to work and the alternative is a second, differently-broken one.
 *
 * `examples/shirado2017` is NOT modified. The only thing written inside it is
 * `.empirica/local`, the throwaway datastore, which its own `.empirica/.gitignore`
 * ignores.
 *
 * n = 20 with no agents: the paper's control arm and the size §5 of the
 * manuscript describes. The example also ships an n = 6 demo treatment, which is
 * easier to drive and would put a figure in the paper at a size the surrounding
 * text does not claim.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { batchConfig, connectAdmin, createBatch } from "../src/harness/harness.js";

const root = process.env["NBHD_ROOT"] ?? process.cwd();
const example = path.join(root, "examples/shirado2017");
const out = process.env["FIGURE_OUT"];
if (!out) throw new Error("FIGURE_OUT must name the output .png path");

const N = 20;
const BASE = "http://localhost:3000";
const COLORS = ["green", "orange", "purple"];
const KEYS = Array.from({ length: N }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);

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
  const context = await browser.newContext({
    viewport: { width: 900, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/?participantKey=${key}`, { waitUntil: "domcontentloaded" });
  return { key, page };
}

/**
 * Consent, identifier, instructions. `?participantKey=` namespaces the session
 * but does not skip the identifier screen, so each tab enters its own.
 */
async function join(tab: Tab): Promise<void> {
  const { page } = tab;
  await page.getByText(/do you consent/i).waitFor({ state: "visible", timeout: 180_000 });
  await page.getByRole("button", { name: /i agree/i }).click();

  await page
    .getByText(/enter your player identifier/i)
    .waitFor({ state: "visible", timeout: 180_000 });
  await page.locator("input").first().fill(tab.key);
  await page.getByRole("button", { name: /^enter$/i }).click();

  // The example's own Introduction. No name field on this one.
  await page.getByText(/^Instructions$/).waitFor({ state: "visible", timeout: 180_000 });
  await page.getByRole("button", { name: /i understand/i }).click();
}

async function degreeOf(tab: Tab): Promise<number> {
  const text = await tab.page.locator("h2", { hasText: /Your connections/ }).innerText();
  return Number(text.match(/\((\d+)\)/)?.[1] ?? 0);
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

    // The example's own throwaway datastore, gitignored. A reused one carries
    // participants from an earlier run, who occupy seats the twenty browsers
    // then cannot fill, and the game never starts.
    fs.rmSync(path.join(example, ".empirica/local"), { recursive: true, force: true });

    console.log("  starting `empirica` in examples/shirado2017 (clean datastore) …");
    const log = fs.openSync("/tmp/empirica-figure.log", "w");
    dev = spawn("empirica", [], { cwd: example, stdio: ["ignore", log, log], detached: true });
    await waitFor(serverUp, "empirica dev server on :3000", 300_000);

    const admin = await connectAdmin({ url: BASE + "/query", srtoken: srtoken() } as any);
    try {
      const batch = await createBatch(admin, batchConfig(N, 1, [{ botCount: 0 }]));
      await admin.taj.setAttribute({
        key: "lobbyConfig",
        val: JSON.stringify({
          kind: "shared",
          duration: 300_000_000_000,
          strategy: "ignore",
        }),
        nodeID: batch.id,
      });
      await batch.running();
      console.log(`  batch running: ${N} players, no agents`);
    } finally {
      admin.stop();
    }

    browser = await chromium.launch();
    for (const key of KEYS) tabs.push(await openTab(browser, key));
    console.log(`  opened ${tabs.length} browser windows`);

    // Serially: the identifier screen races if twenty tabs submit at once.
    for (const tab of tabs) await join(tab);
    console.log("  all twenty joined");

    await waitFor(
      async () =>
        (
          await Promise.all(
            tabs.map((t) => t.page.getByText(/Your color/i).isVisible().catch(() => false))
          )
        ).every(Boolean),
      "the game screen in every window"
    );

    // Round-robin the three colors. Neighbors mostly differ, some clash — which
    // is what a participant's screen looks like partway through a real session.
    for (const [i, tab] of tabs.entries()) {
      await tab.page.locator(`button[title="${COLORS[i % 3]}"]`).click();
      await tab.page.waitForTimeout(120);
    }
    console.log("  every window picked a color");

    // Let every projection land before reading any screen.
    await tabs[0]!.page.waitForTimeout(3_000);

    // The most connected participant: the fullest neighborhood, and on a
    // Barabási-Albert graph the one a reader learns most from.
    const degrees = await Promise.all(tabs.map(degreeOf));
    let pick = 0;
    for (let i = 1; i < degrees.length; i++) if (degrees[i]! > degrees[pick]!) pick = i;
    console.log(`  degrees: ${degrees.join(",")} -> capturing ${tabs[pick]!.key} (degree ${degrees[pick]})`);

    const target = tabs[pick]!.page.locator("div.max-w-prose").first();
    await target.screenshot({ path: out });
    console.log(`  wrote ${out}`);
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
