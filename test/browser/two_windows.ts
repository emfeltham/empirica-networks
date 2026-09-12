/**
 * The browser confirmation, automated.
 *
 * This is the plan's acceptance criterion for the example: run it against a real
 * `empirica` dev server and confirm each window sees only its own neighbours. It
 * was previously written down as a manual step, which meant in practice it was
 * an unverified claim.
 *
 * Everything here is REAL: a real `empirica` dev server (vite + Tajriba +
 * callbacks), the real example project, real Chromium windows running the real
 * bundled client. Nothing is stubbed and no internals are reached into.
 *
 * It goes further than the manual check it replaces. A person can only confirm
 * that a non-neighbour is not RENDERED; here every websocket frame each browser
 * receives is captured, so the assertion is that the non-neighbour's colour
 * never arrived in the tab at all. That is the actual claim — the bytes never
 * leave the server — and it is the one an eyeball cannot check.
 *
 * Run with: npm run test:browser   (needs the Empirica CLI and Chromium)
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
// connectAdmin opens (and closes) its own connection, so this file needs no
// direct @empirica/tajriba import — which it could not have anyway, since that
// package is deliberately not a dependency (duplicate-copy hazard).
import { batchConfig, connectAdmin, createBatch } from "../../src/harness/harness.js";

// This file is bundled to CJS before running (@empirica/core cannot be loaded
// from raw Node — docs/PLATFORM-NOTES.md §3a), and `import.meta.url` is empty
// under that format. The repo root is passed in by the runner instead.
const root = process.env["NBHD_ROOT"] ?? process.cwd();
const example = path.join(root, "examples/minimal");

const N = 4;
const BASE = "http://localhost:3000";
const KEYS = ["alpha", "bravo", "charlie", "delta"];
const COLORS = ["red", "amber", "green", "blue"];

function srtoken(): string {
  const toml = fs.readFileSync(path.join(example, ".empirica/empirica.toml"), "utf8");
  const m = toml.match(/srtoken\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no srtoken in .empirica/empirica.toml");
  return m[1]!;
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 120_000
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

/**
 * `empirica` starts vite on 8844 and the callbacks server as CHILD processes.
 *
 * A leftover vite from an earlier run holds 8844, the new client build fails,
 * and port 3000 still answers — serving the stale bundle. Everything then looks
 * alive while games never start, which is a genuinely confusing failure. So
 * check the port up front and say what to do about it.
 */
function portInUse(port: number): boolean {
  try {
    execFileSync("lsof", ["-ti", `:${port}`], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** Per-tab record of every websocket frame received. */
interface Tab {
  key: string;
  page: Page;
  frames: string[];
}

async function openTab(browser: Browser, key: string): Promise<Tab> {
  // A separate context per participant: separate storage, separate session.
  // Sharing one would make them the same participant.
  const context = await browser.newContext();
  const page = await context.newPage();
  const frames: string[] = [];

  page.on("websocket", (ws) => {
    // Only the Tajriba socket. Vite's HMR socket also carries CSS, which
    // contains colour words like "green" and would make a substring search for
    // a leaked colour fire on nothing.
    if (!ws.url().includes("/query")) return;
    ws.on("framereceived", (data) => {
      const payload = typeof data.payload === "string" ? data.payload : data.payload.toString();
      frames.push(payload);
    });
  });

  await page.goto(`${BASE}/?participantKey=${key}`, { waitUntil: "domcontentloaded" });
  return { key, page, frames };
}

/**
 * Walk a participant from a cold tab to the game screen.
 *
 * Three screens, and `?participantKey=` does NOT skip the identifier one — it
 * only namespaces the session. Each tab therefore has to enter its own
 * identifier, or all four browsers join as the same participant and the whole
 * test quietly becomes meaningless.
 */
async function joinExperiment(tab: Tab): Promise<void> {
  // Each screen is identified by its own text before its input is touched.
  // Locating `input` generically races the transition: the identifier field is
  // still mounted for a moment after submitting, so the name gets typed into the
  // OLD input, the Introduction mounts empty, and every participant ends up
  // named "Anonymous" — which still renders fine and quietly makes the test
  // unable to tell participants apart.
  const { page } = tab;

  // 1. Empirica's consent screen.
  await page.getByText(/do you consent/i).waitFor({ state: "visible", timeout: 120_000 });
  await page.getByRole("button", { name: /i agree/i }).click();

  // 2. Empirica's player identifier screen.
  await page
    .getByText(/enter your player identifier/i)
    .waitFor({ state: "visible", timeout: 120_000 });
  await page.locator("input").first().fill(tab.key);
  await page.getByRole("button", { name: /^enter$/i }).click();

  // 3. The example's own Introduction screen.
  await page
    .getByText(/what should your neighbours call you/i)
    .waitFor({ state: "visible", timeout: 120_000 });
  const nameInput = page.locator('input[type="text"]').first();
  await nameInput.fill(`name-${tab.key}`);
  // Confirm it landed before submitting — this is the exact failure above.
  await page.waitForFunction(
    (expected) =>
      (document.querySelector('input[type="text"]') as HTMLInputElement | null)?.value ===
      expected,
    `name-${tab.key}`,
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: /next/i }).click();
}

/** The names this tab can actually see, read from the rendered neighbour list. */
async function visibleNeighbourNames(tab: Tab): Promise<string[]> {
  const items = await tab.page.locator("ul li").allTextContents();
  return items.map((t) => t.trim()).filter(Boolean);
}

/**
 * Every name that arrived in this tab via the PROJECTION specifically.
 *
 * Scans the captured frames for attribute changes whose key is `neighbors` —
 * the payload written to the participant's own private channel — and collects
 * the names inside. Deliberately narrower than "does this string appear on the
 * wire": the module's guarantee is about the projection, and player-scope
 * attributes travel by a separate, broadcast route.
 */
function projectedViews(tab: Tab): { id?: string; name?: string; color?: string }[] {
  const views: { id?: string; name?: string; color?: string }[] = [];
  for (const frame of tab.frames) {
    // Cheap prefilter: most frames are not attribute changes at all.
    if (!frame.includes('"neighbors"')) continue;
    for (const m of frame.matchAll(/"key"\s*:\s*"neighbors"\s*,\s*"val"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      let parsed: unknown;
      try {
        // `val` is a JSON string containing JSON — hence the double parse. This
        // is also why searching the raw frame for `"color":"red"` finds
        // nothing: on the wire it is escaped as \"color\":\"red\".
        parsed = JSON.parse(JSON.parse(`"${m[1]}"`));
      } catch {
        continue;
      }
      if (Array.isArray(parsed)) views.push(...parsed);
    }
  }
  return views;
}

function projectedNames(tab: Tab): Set<string> {
  return new Set(
    projectedViews(tab)
      .map((v) => v?.name)
      .filter((n): n is string => typeof n === "string")
  );
}

/**
 * Dump what every window is actually showing.
 *
 * A browser failure is otherwise just "timed out waiting for X", which says
 * nothing about whether the app is on a lobby screen, an error boundary, or a
 * screen whose wording moved. Worth the twenty lines: this is the slowest test
 * in the repo to re-run blind.
 */
async function dumpTabs(tabs: Tab[]): Promise<void> {
  console.error("\n  --- what each window is showing ---");
  for (const tab of tabs) {
    let text = "(unreadable)";
    try {
      text = (await tab.page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 240);
    } catch {
      /* page may be closed */
    }
    console.error(`    [${tab.key}] ${text}`);
  }
  console.error("");
}

async function main(): Promise<void> {
  let dev: ChildProcess | undefined;
  let browser: Browser | undefined;
  const tabs: Tab[] = [];

  try {
    // ---- 1. the real dev server, on a clean datastore ----------------------
    //
    // This owns the server lifecycle rather than reusing one already running.
    // Players persist in .empirica/local, so a reused server carries
    // participants from earlier runs: they occupy slots in the batch created
    // below, the four browsers cannot all be assigned, and the game never
    // starts. That reads as a broken feature and is only a dirty datastore.
    for (const port of [3000, 8844]) {
      if (portInUse(port)) {
        throw new Error(
          `port ${port} is already in use. This test starts its own server on a clean ` +
            `datastore, so nothing else may be running. Stop it and retry:\n` +
            `    lsof -ti:3000,8844 | xargs kill -9`
        );
      }
    }

    // Only ever the example's own throwaway data, which is gitignored.
    fs.rmSync(path.join(example, ".empirica/local"), { recursive: true, force: true });

    console.log("  starting `empirica` in examples/minimal (clean datastore) …");
    const log = fs.openSync("/tmp/empirica-browser-test.log", "w");
    // detached, so the whole process group can be killed on teardown. Killing
    // only the `empirica` parent leaves vite and the callbacks server holding
    // their ports, which breaks the NEXT run rather than this one.
    dev = spawn("empirica", [], { cwd: example, stdio: ["ignore", log, log], detached: true });
    await waitFor(serverUp, "empirica dev server on :3000", 300_000);

    // ---- 2. a running batch, via the admin API ----------------------------
    const admin = await connectAdmin({ url: BASE + "/query", srtoken: srtoken() } as any);
    try {
      const batch = await createBatch(admin, batchConfig(N, 1));

      // `lobbyConfig` is a separate ATTRIBUTE on the batch scope, not part of
      // the config JSON, and `Lobby()` — which the standard scaffold registers —
      // parses it with zod on every game. Omitting it throws
      // "invalid_type: expected object, received undefined" from inside the
      // lobby callback, and the visible symptom is every participant stuck on
      // "Waiting for other players" with a full game. The repo's own e2e
      // harness never hits this because it does not register Lobby().
      await admin.taj.setAttribute({
        key: "lobbyConfig",
        val: JSON.stringify({
          kind: "shared",
          // Nanoseconds, matching the Go duration encoding in lobbies.yaml.
          duration: 300_000_000_000,
          // "ignore" rather than "fail": with a full game the lobby releases
          // immediately anyway, and a timeout should not kill the run.
          strategy: "ignore",
        }),
        nodeID: batch.id,
      });

      await batch.running();
      console.log(`  batch running: ${N} players, ring topology`);
    } finally {
      admin.stop();
    }

    // ---- 3. four real browser windows -------------------------------------
    browser = await chromium.launch();
    for (const key of KEYS) tabs.push(await openTab(browser, key));
    console.log(`  opened ${tabs.length} browser windows`);

    for (const tab of tabs) await joinExperiment(tab);
    console.log("  all four joined (consent, identifier, intro)");

    // ---- 4. everyone picks a colour ---------------------------------------
    await waitFor(
      async () =>
        (
          await Promise.all(
            tabs.map((t) => t.page.getByText(/Your colour/i).isVisible().catch(() => false))
          )
        ).every(Boolean),
      "the game screen in every window"
    );

    for (const [i, tab] of tabs.entries()) {
      await tab.page.locator(`button[title="${COLORS[i]}"]`).click();
    }
    console.log("  each window picked a distinct colour");

    // Let the projections settle.
    await waitFor(
      async () =>
        (await Promise.all(tabs.map(visibleNeighbourNames))).every((names) => names.length === 2),
      "each window showing exactly 2 neighbours"
    );

    // ---- 5. what each window can see --------------------------------------
    const seen = new Map<string, string[]>();
    for (const tab of tabs) {
      const names = (await visibleNeighbourNames(tab)).map(
        (t) => t.match(/name-\w+/)?.[0] ?? t
      );
      seen.set(tab.key, names.sort());
      console.log(`    ${tab.key} sees: ${names.join(", ")}`);
    }

    for (const tab of tabs) {
      const names = seen.get(tab.key)!;
      assert.equal(names.length, 2, `${tab.key} must see exactly 2 of the other 3`);
      assert.ok(!names.includes(`name-${tab.key}`), `${tab.key} must not see itself`);
    }

    // The visible pairs must differ, or this is a broadcast that happens to be
    // truncated rather than a per-participant projection.
    const distinct = new Set([...seen.values()].map((v) => v.join(",")));
    assert.ok(
      distinct.size > 1,
      `every window sees the same pair (${[...distinct]}), which is not a ring`
    );

    // ---- 6. the wire ------------------------------------------------------
    //
    // TWO channels reach a browser, and they have different privacy properties.
    // Conflating them is the mistake this section exists to prevent:
    //
    //   the PROJECTION  — `neighbors` on the participant's own nbhd scope.
    //                     Neighbour-limited. This is what the module guarantees.
    //
    //   the PLAYER SCOPE — Classic cross-links every participant to every player
    //                     node, so ANY `player.set(...)` is broadcast to
    //                     everyone (docs/PLATFORM-NOTES.md §4b).
    //
    // The example writes name and colour with `player.set`, so those values are
    // on every tab's wire regardless of the topology. That is asserted below as
    // a fact, not waved away — it is the trap a researcher must know about.
    let checked = 0;
    for (const tab of tabs) {
      const visible = seen.get(tab.key)!;
      const strangerKey = KEYS.find((k) => k !== tab.key && !visible.includes(`name-${k}`));
      assert.ok(strangerKey, `${tab.key} should have exactly one non-neighbour`);
      const strangerName = `name-${strangerKey}`;

      assert.ok(
        tab.frames.length > 0,
        `${tab.key} captured no websocket frames — every check here would be vacuous`
      );

      // (a) THE MODULE'S GUARANTEE: every `neighbors` payload this tab received
      //     mentions only its neighbours.
      const projected = projectedNames(tab);
      assert.ok(
        projected.size > 0,
        `${tab.key} received no projection at all — a clean result would be vacuous`
      );
      assert.ok(
        !projected.has(strangerName),
        `LEAK: ${tab.key}'s projection contained non-neighbour ${strangerName}`
      );
      for (const name of visible) {
        assert.ok(
          projected.has(name),
          `${tab.key}'s projection should contain its neighbour ${name}`
        );
      }

      const wire = tab.frames.join("\n");

      // (b) THE STRONG CLAIM, which only holds because the colour is PRIVATE
      //     state written to each participant's own channel. A non-neighbour's
      //     colour must appear nowhere in the bytes this tab received. When the
      //     example wrote colour with player.set(), this assertion failed — the
      //     value was broadcast and the demo's own promise was false.
      // Each tab picks a distinct colour, so a colour word identifies its owner.
      // Searched in the RAW frames, so a leak through any channel counts — not
      // just through the projection we know to look at.
      const strangerColor = COLORS[KEYS.indexOf(strangerKey!)]!;
      assert.ok(
        !wire.includes(strangerColor),
        `LEAK: ${tab.key} received non-neighbour ${strangerKey}'s colour ` +
          `(${strangerColor}) over the websocket`
      );

      // (c) NON-VACUITY for (b): a neighbour's colour DID arrive, so the
      //     absence above means something rather than "no colours were sent".
      const neighbourColors = new Set(
        projectedViews(tab)
          .map((v) => v?.color)
          .filter((c): c is string => typeof c === "string")
      );
      assert.ok(
        neighbourColors.size > 0,
        `${tab.key} received no neighbour colours at all — the absence above ` +
          `would be vacuous`
      );
      assert.ok(
        !neighbourColors.has(strangerColor),
        `LEAK: ${strangerColor} appeared in ${tab.key}'s projection`
      );

      // (d) THE PLATFORM'S BEHAVIOUR, for contrast: the stranger's NAME is on
      //     the wire, because names are ordinary player attributes and Empirica
      //     broadcasts every player scope. Asserted so the difference between
      //     the two paths stays visible, and so a change upstream is loud.
      assert.ok(
        wire.includes(strangerName),
        `expected ${strangerName} on ${tab.key}'s wire via the broadcast player scope ` +
          `(PLATFORM-NOTES §4b). If this now fails, Empirica's behaviour changed.`
      );

      checked++;
      console.log(
        `    ${tab.key}: sees {${[...projected].join(", ")}} · ` +
          `${strangerKey}'s colour absent from wire · ` +
          `${strangerKey}'s name present (public player attribute)`
      );
    }

    assert.equal(checked, N, "every window was checked");

    // ---- 7. a real browser refresh ----------------------------------------
    //
    // The one churn case only a browser can test. Everything the client uses to
    // prove who it is lives in the page's own storage, so a reload exercises
    // session restore for real, rather than approximating it with a fresh
    // headless connection reusing the same ns.
    //
    // What has to survive: the same seat on the ring — a reload that reseated
    // someone would silently change who they interact with for the rest of the
    // study — and a working live update afterwards, since a restored view that
    // never changes again is the failure a snapshot check cannot see.
    const reloaded = tabs[0]!;
    const before = seen.get(reloaded.key)!;

    await reloaded.page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(
      () => reloaded.page.getByText(/Your colour/i).isVisible().catch(() => false),
      `${reloaded.key} back on the game screen after a reload`
    );
    await waitFor(
      async () => (await visibleNeighbourNames(reloaded)).length === 2,
      `${reloaded.key} has its neighbourhood again after a reload`
    );

    const after = (await visibleNeighbourNames(reloaded))
      .map((t) => t.match(/name-\w+/)?.[0] ?? t)
      .sort();
    assert.deepEqual(
      after,
      before,
      `${reloaded.key} must come back to the SAME neighbours, not be reseated`
    );

    // Live, not frozen: a neighbour changes colour and the reloaded tab shows it.
    const neighbourKey = before[0]!.replace("name-", "");
    const neighbourTab = tabs.find((t) => t.key === neighbourKey)!;
    await neighbourTab.page.locator('button[title="violet"]').click();

    await waitFor(async () => {
      const titles = await reloaded.page
        .locator("ul li div[title]")
        .evaluateAll((els) => els.map((e) => e.getAttribute("title")));
      return titles.includes("violet");
    }, `${reloaded.key} sees a neighbour's NEW colour after reloading`);

    console.log(
      `    ${reloaded.key} reloaded: same neighbours {${after.join(", ")}}, updates still live`
    );

    console.log(`\n  PASS — ${N} real browsers, neighbour-limited visibility confirmed at the wire\n`);
  } catch (e) {
    await dumpTabs(tabs);
    throw e;
  } finally {
    for (const tab of tabs) await tab.page.context().close().catch(() => {});
    await browser?.close().catch(() => {});
    if (dev?.pid) {
      // Negative pid = the whole process group, so vite and the callbacks
      // server go too. Without this they survive and hold 3000/8844.
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

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  FAIL —", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
