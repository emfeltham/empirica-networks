/**
 * One audited session with real browsers and simulated participants in it.
 *
 * `two_windows.ts` proves the browser path on four participants of the minimal
 * example. `simulate` audits complete sessions of the Shirado 2017
 * reconstruction at the design's own twenty, but every participant there is a
 * headless process: the browser, its bundle and its rendering are bypassed, and
 * the evaluation says so. This file is the overlap neither covers — the
 * reconstruction, at twenty, with four of the twenty being real Chromium
 * windows running the real client, and the whole session audited afterwards by
 * the same `auditViews` the evaluation uses.
 *
 * WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * 1. The server-side audit over the session: no delivery from outside the
 *    receiving participant's radius, and every delivery the realized graph
 *    predicts. This is the evaluation's C1, run on a session that contains
 *    browsers.
 * 2. Per browser, the client's own rendered connection count equals that
 *    participant's degree in the recorded edge list. This is the end-to-end
 *    half: it goes through the bundle, the hooks and React, which (1) does not
 *    touch.
 *
 * It does NOT assert the `two_windows.ts` wire property — "a non-neighbor's
 * color never arrived in this tab" — and the reason is worth writing down so it
 * is not added later as an improvement. That check works there because four
 * participants hold four DISTINCT colors, so a color names a participant. This
 * design gives twenty participants three colors, so every color legitimately
 * arrives in every tab from that tab's own neighbors, and a substring search
 * would fire on correct behavior. The identity-based version fails for a
 * different reason: Empirica cross-links every participant to every `player`
 * record, so a non-neighbor's player id is legitimately present in the frames
 * and its absence was never the claim. Frames are still captured and written
 * out, because they are evidence for a reader even where they are not an
 * assertion here.
 *
 * Browser participants change color on a timer rather than by the design's own
 * rule. Nothing here reads an outcome — not time to solution, not conflicts —
 * so the behavior only has to exercise the write path and keep views flowing.
 *
 * Run with: npm run test:browser -- hybrid    (needs the Empirica CLI and Chromium)
 * A full run takes about six minutes; NBHD_HYBRID_PLAY_MS shortens the play
 * phase while iterating.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

import { batchConfig, connectAdmin, createBatch } from "../../src/harness/harness.js";
import { runBots, botIdentifiers, type BotContext, type BotPolicy } from "../../src/bots/index.js";
import { auditViews, parseEdgesCsv, parseRadiiCsv } from "../../src/verify/audit.js";
// One line, because `@ts-expect-error` applies to the line that follows it and a
// multi-line import puts the untyped module specifier out of its reach — which
// reports as an UNUSED directive plus the original error, two errors for one
// cause. `simulate.ts` imports the same module the same way.
// @ts-expect-error - plain JS example module, deliberately untyped
import { BOT_INTERVAL_MS, botChoice, COLORS as DESIGN_COLORS } from "../../examples/shirado2017/server/src/design.mjs";

const root = process.env["NBHD_ROOT"] ?? process.cwd();
const example = path.join(root, "examples/shirado2017");
const OUT = path.join(root, ".tmp-hybrid");

const N = 20;
const BROWSER_KEYS = ["alpha", "bravo", "charlie", "delta"];
const BOT_COUNT = N - BROWSER_KEYS.length;
// Imported rather than repeated: these are the design's colors, and a local
// copy that drifted would click buttons that do not exist.
const COLORS: string[] = DESIGN_COLORS;
const BASE = "http://localhost:3000";
/**
 * Hard cap on the play phase. The session normally ends on the design's own
 * 300-second limit, and the browsers keep acting until it does: the example
 * writes `edges.csv` and `radius.csv` in `onGameEnded`, so a run stopped part
 * way through has no graph to audit against. The cap is the backstop for a
 * session that never ends, not the intended duration.
 */
const PLAY_CAP_MS = Number(process.env["NBHD_HYBRID_PLAY_MS"] ?? 420_000);

/** The per-game directory the example writes when the game ends. */
function gameDirs(): string[] {
  if (!fs.existsSync(OUT)) return [];
  return fs
    .readdirSync(OUT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function portInUse(port: number): boolean {
  try {
    execFileSync("lsof", ["-ti", `:${port}`], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

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

interface Tab {
  key: string;
  page: Page;
  frames: string[];
}

async function openTab(browser: Browser, key: string): Promise<Tab> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/query")) return;
    ws.on("framereceived", (data) => {
      frames.push(typeof data.payload === "string" ? data.payload : data.payload.toString());
    });
  });
  await page.goto(`${BASE}/?participantKey=${key}`, { waitUntil: "domcontentloaded" });
  return { key, page, frames };
}

/**
 * Cold tab to game screen. Each screen is identified by its own text before its
 * input is touched, for the reason `two_windows.ts` records: locating `input`
 * generically races the transition between screens.
 */
async function joinExperiment(tab: Tab): Promise<void> {
  const { page } = tab;
  await page.getByText(/do you consent/i).waitFor({ state: "visible", timeout: 180_000 });
  await page.getByRole("button", { name: /i agree/i }).click();

  await page.getByText(/enter your player identifier/i).waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("input").first().fill(tab.key);
  await page.getByRole("button", { name: /^enter$/i }).click();

  // The reconstruction's instructions screen. Its button is "I understand";
  // a generic next/continue/start matcher does not find it.
  const understood = page.getByRole("button", { name: /i understand/i }).first();
  await understood.waitFor({ state: "visible", timeout: 60_000 });
  await understood.click();
}

/** `Your connections (k)` as the client itself renders it. */
async function renderedDegree(tab: Tab): Promise<number> {
  const text = await tab.page.getByText(/your connections \(\d+\)/i).first().innerText();
  const m = text.match(/\((\d+)\)/);
  if (!m) throw new Error(`could not read a connection count from ${JSON.stringify(text)}`);
  return Number(m[1]);
}

function colorPolicy(botIDs: Set<string>): BotPolicy<{ color?: string }> {
  return {
    tickMs: Number(BOT_INTERVAL_MS),
    onStart(ctx: BotContext<{ color?: string }>) {
      // The only place a simulated participant's player id is available. The
      // browsers are then whatever viewers the audit saw that are not in here,
      // which avoids asking a page for an id the client does not publish.
      if (ctx.playerID) botIDs.add(ctx.playerID);
    },
    onTick(ctx: BotContext<{ color?: string }>) {
      const neighbors = ctx.neighbors();
      if (neighbors === undefined) return;
      const state = ctx.state();
      if (!state) return;
      const next = botChoice({
        ownColor: state.get("color") as string | undefined,
        neighborColors: neighbors.map((nb) => nb.color),
        noise: 0,
        rng: ctx.rng,
      });
      if (next !== undefined) state.set("color", next);
    },
  };
}

async function main(): Promise<void> {
  let dev: ChildProcess | undefined;
  let browser: Browser | undefined;
  const tabs: Tab[] = [];

  try {
    for (const port of [3000, 8844]) {
      if (portInUse(port)) {
        throw new Error(
          `port ${port} is already in use. This test starts its own server on a clean ` +
            `datastore, so nothing else may be running:\n    lsof -ti:3000,8844 | xargs kill -9`
        );
      }
    }

    fs.rmSync(path.join(example, ".empirica/local"), { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });

    console.log(`  starting \`empirica\` in examples/shirado2017 (clean datastore) …`);
    const log = fs.openSync("/tmp/empirica-hybrid-test.log", "w");
    dev = spawn("empirica", [], {
      cwd: example,
      stdio: ["ignore", log, log],
      detached: true,
      // The example reads this at module load, which is why the server has to
      // be started with it rather than told later.
      env: { ...process.env, SHIRADO2017_OUT: OUT, SHIRADO2017_BOT_KEYS: "" },
    });
    await waitFor(serverUp, "empirica dev server on :3000", 300_000);

    const admin = await connectAdmin({ url: BASE + "/query", srtoken: srtoken() } as any);
    try {
      const batch = await createBatch(admin, batchConfig(N, 1, [{ botCount: 0 }]));
      await admin.taj.setAttribute({
        key: "lobbyConfig",
        val: JSON.stringify({ kind: "shared", duration: 600_000_000_000, strategy: "ignore" }),
        nodeID: batch.id,
      });
      await batch.running();
      console.log(`  batch running: ${N} participants, ${BROWSER_KEYS.length} of them browsers`);
    } finally {
      admin.stop();
    }

    const botIDs = new Set<string>();
    const renderedDegrees: (number | undefined)[] = [];
    browser = await chromium.launch();
    for (const key of BROWSER_KEYS) tabs.push(await openTab(browser, key));
    for (const tab of tabs) await joinExperiment(tab);
    console.log(`  ${tabs.length} browser windows joined`);

    const run = await runBots({
      url: BASE + "/query",
      identifiers: botIdentifiers(BOT_COUNT),
      seed: 1,
      policy: colorPolicy(botIDs),
    });
    console.log(`  ${BOT_COUNT} simulated participants connected`);

    try {
      await waitFor(
        () => run.phases().every((ph: string) => ph === "playing"),
        `all ${BOT_COUNT} simulated participants playing (${run.phases().join(", ")})`
      );
      await waitFor(
        async () =>
          (await Promise.all(tabs.map((t) => t.page.getByText(/your color/i).isVisible().catch(() => false)))).every(Boolean),
        "the game screen in every browser window"
      );
      console.log("  all twenty seated; playing");

      // The browsers act until the game ends, which is what makes them
      // participants rather than open tabs: every click is a write through the
      // real client, and every write republishes to the neighbors who can see
      // it. Colors cycle rather than following the design's rule — nothing here
      // reads an outcome, so the behavior only has to exercise the path.
      const started = Date.now();
      let round = 0;
      while (gameDirs().length === 0 && Date.now() - started < PLAY_CAP_MS) {
        for (const [i, tab] of tabs.entries()) {
          const color = COLORS[(round + i) % COLORS.length]!;
          await tab.page.locator(`button[title="${color}"]`).click().catch(() => {});
        }
        // Read the rendered neighborhood WHILE the game is running. After it
        // ends the client moves to the exit survey and the game screen is gone,
        // so a read deferred to the assertions below would find nothing. The
        // graph is static in this design, so a reading taken during play is the
        // reading for the whole session; it is refreshed for the first minute
        // and then left alone.
        if (Date.now() - started < 60_000) {
          for (const [i, tab] of tabs.entries()) {
            const d = await renderedDegree(tab).catch(() => undefined);
            if (d !== undefined) renderedDegrees[i] = d;
          }
        }
        round++;
        await new Promise((r) => setTimeout(r, 3000));
      }
      const secs = Math.round((Date.now() - started) / 1000);
      assert.ok(
        gameDirs().length > 0,
        `the game did not end within ${Math.round(PLAY_CAP_MS / 1000)}s, so it wrote no edge ` +
          `list to audit against (${round} browser rounds in ${secs}s)`
      );
      console.log(`  game ended after ${secs}s of play (${round} browser rounds)`);
    } finally {
      await run.stop().catch(() => {});
    }

    // ---- the audit, over the session that just ran -------------------------
    const games = gameDirs();
    assert.equal(games.length, 1, `expected one game directory in ${OUT}, got ${games.join(", ") || "none"}`);
    const dir = path.join(OUT, games[0]!);

    const views = fs.readFileSync(path.join(OUT, "views.ndjson"), "utf8");
    const edgesText = fs.readFileSync(path.join(dir, "edges.csv"), "utf8");
    // The package's own parser, not a second one written here: an edge list read
    // two ways is two things that can disagree, and the audit below is keyed on
    // this one.
    const parsedEdges = parseEdgesCsv(edgesText);
    const graph = parsedEdges.graphs.get(games[0]!);
    assert.ok(graph, `edges.csv carries no graph for game ${games[0]}`);
    const ties = [...graph.values()].reduce((n, set) => n + set.size, 0) / 2;

    // The same call the evaluation makes, on a session containing browsers.
    const radiusPath = path.join(dir, "radius.csv");
    const radiusText = fs.existsSync(radiusPath) ? fs.readFileSync(radiusPath, "utf8") : "";
    const report = auditViews({
      views,
      edges: parsedEdges,
      radii: radiusText.trim() === "" ? undefined : parseRadiiCsv(radiusText),
    });
    console.log(
      `  audited ${report.deliveriesChecked} deliveries in ${report.recordsChecked} views ` +
        `over ${ties} recorded ties`
    );
    assert.equal(report.leaks, 0, "a delivery came from outside the receiving participant's radius");
    assert.equal(report.missingDeliveries, 0, "a delivery the realized graph predicts did not arrive");
    assert.ok(report.pass, "the audit did not pass");

    // ---- what only a browser can say --------------------------------------
    const viewers = new Set<string>();
    for (const line of views.split("\n")) {
      if (line.trim() === "") continue;
      const rec = JSON.parse(line) as { viewer?: string };
      if (rec.viewer) viewers.add(rec.viewer);
    }
    const browserIDs = [...viewers].filter((v) => !botIDs.has(v));
    assert.equal(
      browserIDs.length,
      BROWSER_KEYS.length,
      `expected ${BROWSER_KEYS.length} browser participants among the audited viewers, ` +
        `found ${browserIDs.length} (${viewers.size} viewers, ${botIDs.size} simulated)`
    );

    // Degrees as the CLIENTS rendered them against degrees as the package
    // RECORDED them. Compared as sorted multisets because the client publishes
    // no player id, so a tab cannot be tied to a row; a client that drew a
    // neighborhood the edge list does not contain still shows up here.
    assert.equal(
      renderedDegrees.filter((d) => d !== undefined).length,
      tabs.length,
      `only ${renderedDegrees.filter((d) => d !== undefined).length} of ${tabs.length} browsers ` +
        `ever rendered a connection count`
    );
    const rendered = (renderedDegrees as number[]).slice().sort((a, b) => a - b);
    const recorded = browserIDs.map((id) => graph.get(id)?.size ?? 0).sort((a, b) => a - b);
    assert.deepEqual(
      rendered,
      recorded,
      `the browsers rendered degrees ${rendered.join(",")}; the recorded edge list gives ${recorded.join(",")}`
    );
    for (const tab of tabs) {
      assert.ok(tab.frames.length > 0, `browser ${tab.key} captured no websocket frames`);
    }
    console.log(
      `  browsers rendered degrees ${rendered.join(", ")}, matching the recorded edge list; ` +
        `${tabs.reduce((n, t) => n + t.frames.length, 0)} frames captured`
    );

    fs.writeFileSync(
      path.join(OUT, "frames.json"),
      JSON.stringify(Object.fromEntries(tabs.map((t) => [t.key, t.frames.length])), null, 2)
    );
    console.log(`\n  PASS — hybrid session audited; output in ${OUT}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dev?.pid) {
      // Negative pid = the whole process group, so vite and the callbacks
      // server go too. SIGTERM first, as `two_windows.ts` does: a SIGKILL alone
      // leaves the versioned binary the CLI execs holding 3000 and 8844, which
      // breaks the NEXT run rather than this one.
      try {
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        process.kill(-dev.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

// Explicit exit on BOTH paths, not just the failure one. The bot sockets and
// Playwright's transport keep the event loop alive after main() resolves, so a
// bare `main().catch(…)` leaves a passing run hanging forever with every
// assertion already satisfied — which reads as a hung test rather than a green
// one. `two_windows.ts` ends the same way and for the same reason.
main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  FAIL —", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
