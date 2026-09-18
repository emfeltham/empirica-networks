/**
 * The radius ladder, as three screens of one participant on one graph.
 *
 * FOR THE MANUSCRIPT, not for the test suite, which is why it sits in `tools/`
 * beside `shirado-figure.ts` rather than in `test/browser/`: `npm run
 * test:browser` must not spend nine minutes drawing a figure. `radius_structure`
 * asserts that the outer ring is drawn at all; this shows what each step of the
 * ladder adds, which is the one claim in the paper that prose states worse than
 * a picture does.
 *
 * ONE GRAPH FOR ALL THREE PANELS. The comparison is only honest if the shape is
 * held fixed, which is what `NBHD_TOPOLOGY` is for — left to itself the example
 * picks a ring at integer radii, and a ring has no ties among anybody's
 * neighbors, so the half step would be invisible in the very figure drawn to
 * show it. On `ringLattice(12, 2)` one viewer sees, from the centre:
 *
 *     radius 1     4 others,  4 ties     the star
 *     radius 1.5   4 others,  7 ties     no new people, the ties among them
 *     radius 2     8 others, 13 ties     four people further out
 *
 * The middle panel is the one that earns the figure: same people, more ties.
 *
 *     npm run figure:ladder -- figures/
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { batchConfig, connectAdmin, createBatch } from "../src/harness/harness.js";

const root = process.env["NBHD_ROOT"] ?? process.cwd();
const example = path.join(root, "examples/minimal");
const N = 12;
const BASE = "http://localhost:3000";
const KEYS = Array.from({ length: N }, (_, i) => `s${String(i + 1).padStart(2, "0")}`);
/** Enough distinct colors that the panels are not a wall of one hue. */
const COLORS = ["red", "amber", "green", "blue", "violet"];
const RADII = ["1", "1.5", "2"] as const;

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

/** Identical to `test/browser/radius_structure.ts`; see its note on the group kill. */
function sweepOrphans(): void {
  const look = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
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

/** What the first participant's screen actually drew, so the caption can cite it. */
async function counts(page: Page): Promise<{ circles: number; lines: number; far: number }> {
  return page.evaluate(() => {
    const g = document.querySelector(".nbhd-graph")!;
    return {
      circles: g.querySelectorAll("circle").length,
      lines: g.querySelectorAll("line").length,
      far: g.querySelectorAll(".nbhd-node-far circle").length,
    };
  });
}

async function shoot(
  radius: string,
  outDir: string,
  opts: { radii?: string; capture?: number[]; label?: string; projectFar?: boolean } = {}
): Promise<void> {
  let dev: ChildProcess | undefined;
  let browser: Browser | undefined;
  const pages: Page[] = [];
  try {
    fs.rmSync(path.join(example, ".empirica/local"), { recursive: true, force: true });
    const log = fs.openSync(`/tmp/empirica-ladder-${radius}.log`, "w");
    dev = spawn("empirica", [], {
      cwd: example,
      stdio: ["ignore", log, log],
      detached: true,
      env: {
        ...process.env,
        NBHD_RADIUS: radius,
        NBHD_TOPOLOGY: "ringLattice",
        ...(opts.radii ? { NBHD_RADII: opts.radii } : {}),
        ...(opts.projectFar ? { NBHD_PROJECT_FAR: "1" } : {}),
      },
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
      const ctx = await browser.newContext({ viewport: { width: 760, height: 820 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/?participantKey=${key}`, { waitUntil: "domcontentloaded" });
      pages.push(page);
      await join(page, key);
    }

    await waitFor(
      async () =>
        (
          await Promise.all(
            pages.map((p) => p.locator(".nbhd-graph svg").isVisible().catch(() => false))
          )
        ).every(Boolean),
      "the graph in every window"
    );
    // Colors so the panels show a study's own attributes reaching the marks, not
    // twelve identical circles.
    for (const [i, p] of pages.entries()) {
      await p.locator(`button[title="${COLORS[i % COLORS.length]}"]`).click();
    }
    await new Promise((r) => setTimeout(r, 2500));

    fs.mkdirSync(outDir, { recursive: true });
    for (const i of opts.capture ?? [0]) {
      const c = await counts(pages[i]!);
      const stem = !opts.label
        ? `radius-${radius.replace(".", "-")}`
        : (opts.capture ?? [0]).length > 1
          ? `${opts.label}-seat${i}`
          : opts.label;
      const file = path.join(outDir, `${stem}.png`);
      await pages[i]!.locator(".nbhd-graph").screenshot({ path: file });
      // Printed because the caption has to state them and they must not be typed
      // from memory: a caption that disagrees with its own figure is worse than no
      // caption. `circles` counts the viewer too.
      console.log(
        `${opts.label ?? `radius ${radius}`} seat ${i}: ${c.circles - 1} others, ` +
          `${c.lines} ties, ${c.far} beyond that participant's own connections -> ${file}`
      );
    }
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
  const outDir = process.argv[2];
  if (!outDir) throw new Error("usage: npm run figure:ladder -- <output directory> [--asymmetry]");

  /**
   * One session in which the seats do NOT agree about how far they see.
   *
   * Two adjacent participants, one held at radius 1 and one at radius 2, from a
   * single session on one graph — which is the only way to show that the wider
   * of the two is shown the narrower's neighborhood while the narrower is not
   * shown theirs. Nothing about a uniform study can show it, because under a
   * uniform study the relation is symmetric by construction.
   */
  if (process.argv.includes("--asymmetry")) {
    /**
     * With the distance projection on, and that is not decoration.
     *
     * `accountVacuity` counts an asymmetric pair only when the study projects at
     * distance, because without it the data rule is "neighbors only" and stays
     * symmetric whatever the radii say — only the structure differs. A figure
     * about asymmetry drawn at the default would illustrate the one setting the
     * package's own verifier treats as having nothing asymmetric to count.
     *
     * It changes nothing in the narrow panel: a participant at radius 1 has no
     * distant person to carry anything. The only variable between the two panels
     * is still the radius.
     */
    await shoot("1", outDir, {
      radii: "1,2",
      capture: [0, 1],
      label: "asymmetry",
      projectFar: true,
    });
    sweepOrphans();
    return;
  }

  for (const r of RADII) {
    await shoot(r, outDir);
    sweepOrphans();
  }

  /**
   * The fourth panel: radius 2 again, with the study projecting at distance.
   *
   * Same radius as the third and a different picture, which is the whole reason
   * it is worth a panel. The radius decides who is on screen; whether those
   * people carry anything is a separate declaration, and the two are easy to
   * hear as one. Drawn last so the figure reads default-then-opt-in.
   */
  await shoot("2", outDir, { projectFar: true, label: "radius-2-projected" });
  sweepOrphans();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
