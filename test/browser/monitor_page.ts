/**
 * The monitor's page, in a real browser, against a synthetic endpoint.
 *
 * `ISSUES.md` O9: everything else about the monitor is tested — the layout, the
 * metrics, the history replay and the change detection are pure functions on the
 * server (test/unit/monitor_*.test.ts), and the endpoint is tested against a
 * synthetic source (test/unit/monitor_http.test.ts). The served script was not.
 * The only thing standing behind the scrubber's index arithmetic, the color
 * assignment and the two banners was that they are short, and the failure mode
 * here is not a thrown error — it is a plausible picture that is wrong, which is
 * the class of failure this whole package is written against.
 *
 * REAL: real Chromium, the real `serveMonitor`, the real page, the real SSE
 * stream. SYNTHETIC: only the `MonitorSource` behind it, exactly as
 * test/unit/monitor_http.test.ts does — which is possible because `serveMonitor`
 * takes a snapshot function and never an Empirica connection (src/admin/monitor/
 * http.ts, property 1). So this file needs no Empirica CLI, no server and no
 * datastore, and costs a couple of seconds rather than the minutes
 * `two_windows.ts` costs. It is in the browser tier because it needs Chromium,
 * not because it is heavy.
 *
 * What is asserted, and why each one is here rather than left to the eye:
 *
 *   - the graph the operator sees is the graph the source described — node
 *     count, tie count, and one label per node (the relief rule: one light-mode
 *     color slot is below 3:1, so identity may never rest on the fill);
 *   - the scrubber shows the frame it names, including the ties that were
 *     REMOVED at that event, which is usually the interesting part and is drawn
 *     from a different code path than the ties that remain;
 *   - dragging to the end means live, not "the last frame", which is the one
 *     piece of index arithmetic that is silently wrong if it is wrong;
 *   - a value keeps its color when the counts change. A color assigned by
 *     frequency would repaint the whole graph every time one participant
 *     changed their mind, which destroys the thing an operator is watching for;
 *   - `gone` clears the picture. A stale graph presented as live is the exact
 *     misreport `gone` exists to prevent, and the page comment
 *     claimed this behavior before any test held it. It did not do it.
 *   - a lost stream does NOT clear the picture, but says so. The two cases are
 *     deliberately different and the difference is only visible in the browser.
 *
 * Run with: npm run test:browser -- monitor_page   (needs Chromium)
 */
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import type { GameSnapshot } from "../../src/admin/inspect.js";
import { graphMetrics, historyFrames } from "../../src/admin/inspect.js";
import { serveMonitor, type MonitorServer } from "../../src/admin/monitor/http.js";
import type { EdgeEvent } from "../../src/shared/keys.js";
import { ring, type Edge } from "../../src/topology/index.js";

const N = 6;
const ORDER = ["p0", "p1", "p2", "p3", "p4", "p5"];
const T0 = Date.UTC(2026, 7, 16, 12, 0, 0);

/** Fixed by hand from EVENTS below, not computed from the code under test. */
const FRAME_TIES = [6, 5, 4, 5, 5];

const pair = (i: number, j: number): [string, string] => [ORDER[i]!, ORDER[j]!];

/**
 * A run with something to scrub through.
 *
 * Ring of six, two ties cut, one added, one rewired — chosen so the frames have
 * DIFFERENT tie counts (6, 5, 4, 5, 5) and the live graph has 5. A history whose
 * frames all looked alike could not tell "the scrubber works" from "the scrubber
 * is stuck on live", which is the failure it is here to catch.
 */
const EVENTS: EdgeEvent[] = [
  {
    op: "start",
    added: ring(N).map(([i, j]) => pair(i, j)),
    removed: [],
    size: 6,
    at: T0,
  },
  { op: "remove", a: ORDER[0], b: ORDER[1], added: [], removed: [pair(0, 1)], size: 5, at: T0 + 1000 },
  { op: "remove", a: ORDER[1], b: ORDER[2], added: [], removed: [pair(1, 2)], size: 4, at: T0 + 2000 },
  { op: "add", a: ORDER[0], b: ORDER[3], added: [pair(0, 3)], removed: [], size: 5, at: T0 + 3000 },
  { op: "rewire", added: [pair(1, 4)], removed: [pair(4, 5)], size: 5, at: T0 + 4000 },
];

/** The live edge list: the state the events above add up to. */
const LIVE_EDGES: Edge[] = [
  [2, 3],
  [3, 4],
  [0, 5],
  [0, 3],
  [1, 4],
];

/**
 * Colors in SEAT order, with a fourth distinct value.
 *
 * Three palette slots clear the all-pairs CVD gate and the fourth value must
 * fall through to "other" — so the page has to be caught either honoring the
 * cap or quietly inventing a color that does not clear it.
 */
const COLORS = ["red", "red", "blue", "green", "green", "amber"];

/** A source whose answers this test controls outright. */
function fakeSource() {
  let present = true;
  let colors = COLORS.slice();
  let pending: string[] = [];

  return {
    setPresent(v: boolean) {
      present = v;
    },
    setColor(seat: number, v: string) {
      colors = colors.slice();
      colors[seat] = v;
    },
    setPending(ids: string[]) {
      pending = ids;
    },
    source: {
      games: () => (present ? ["g1"] : []),
      stats: () => ({ games: present ? 1 : 0, channels: N, channelScopes: N, cachedViews: N }),
      inspect: (gameID: string): GameSnapshot | undefined => {
        if (!present || gameID !== "g1") return undefined;
        const deg = new Map<number, number[]>();
        for (const [i, j] of LIVE_EDGES) {
          deg.set(i, [...(deg.get(i) ?? []), j]);
          deg.set(j, [...(deg.get(j) ?? []), i]);
        }
        return {
          gameID: "g1",
          batchID: "b1",
          n: N,
          edges: LIVE_EDGES,
          order: ORDER,
          seed: 7,
          radius: 1,
          radii: [],
          seq: 12,
          nodes: ORDER.map((playerID, index) => ({
            index,
            playerID,
            degree: (deg.get(index) ?? []).length,
            radius: 1,
            neighbors: (deg.get(index) ?? []).slice().sort((a, b) => a - b),
            channel: !pending.includes(playerID),
            attrs: {},
            state: { color: colors[index] },
          })),
          metrics: graphMetrics(N, LIVE_EDGES),
          history: historyFrames("g1", EVENTS, ORDER),
          pendingChannels: pending,
          awaitingPublish: pending.length > 0,
          watch: ["color"],
        };
      },
    },
  };
}

// ---------------------------------------------------------------- page probes

/** Everything the graph is currently showing, read out of the live DOM. */
interface Drawn {
  nodes: number;
  labels: string[];
  /** Ties present at this frame. */
  edges: number;
  /** Ties destroyed by this event, drawn dashed. */
  removed: number;
  /** Ties created by this event, drawn in the "new" color. */
  added: number;
  fills: string[];
  rows: number;
}

function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll("#graph line"));
    const circles = Array.from(document.querySelectorAll("#graph circle"));
    return {
      nodes: circles.length,
      // The label under each node, not the seat number inside it.
      labels: Array.from(document.querySelectorAll('#graph text[dy="33"]')).map(
        (t) => t.textContent ?? "",
      ),
      edges: lines.filter((l) => !l.getAttribute("stroke-dasharray")).length,
      removed: lines.filter((l) => l.getAttribute("stroke-dasharray")).length,
      added: lines.filter((l) => l.getAttribute("stroke") === "var(--good)").length,
      fills: circles.map((c) => c.getAttribute("fill") ?? ""),
      rows: document.querySelectorAll("#tableView table tr").length,
    };
  });
}

function textOf(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
}

function classOf(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (el) => el.className);
}

/** One row of the side panels, by its label. */
async function panel(page: Page, id: string, label: string): Promise<string> {
  return page.$eval(
    `#${id}`,
    (dl, want) => {
      const kids = Array.from(dl.children);
      for (let i = 0; i < kids.length - 1; i++) {
        if (kids[i]!.textContent === want) return kids[i + 1]!.textContent ?? "";
      }
      return "(no such row)";
    },
    label,
  );
}

async function scrubTo(page: Page, index: number): Promise<void> {
  await page.locator("#scrub").fill(String(index));
}

async function main(): Promise<void> {
  let browser: Browser | undefined;
  let server: MonitorServer | undefined;
  let page: Page | undefined;
  const fake = fakeSource();

  try {
    server = await serveMonitor(fake.source, { pollMs: 50, log: () => {} });
    browser = await chromium.launch();
    page = await browser.newPage();
    page.setDefaultTimeout(15_000);

    // A page error would otherwise be invisible: every assertion below reads the
    // DOM, and a script that died halfway leaves a DOM that merely looks empty.
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(m.text());
    });

    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#graph circle").length > 0);

    // ---- 1. the graph is the graph the source described ---------------------
    let d = await drawn(page);
    assert.equal(d.nodes, N, "one node per seat");
    assert.equal(d.edges, LIVE_EDGES.length, "one line per live tie");
    assert.equal(d.removed, 0, "nothing is drawn as removed while live");
    assert.equal(
      d.labels.length,
      N,
      "every node must carry a direct label — identity may not rest on the fill",
    );
    assert.deepEqual(d.labels, COLORS, "each label is that seat's watched value");
    // +1 for the header row.
    assert.equal(d.rows, N + 1, "the table view has one row per seat");
    assert.equal(await panel(page, "metrics", "participants"), String(N));
    assert.equal(await panel(page, "metrics", "ties"), String(LIVE_EDGES.length));
    assert.equal(await panel(page, "ops", "history events"), String(EVENTS.length));
    assert.equal(await panel(page, "ops", "publishes"), "12");
    // What the people being watched can see. The monitor draws the whole
    // network, so without this an operator cannot tell a study drawing stars
    // from one drawing its participants' local structure.
    assert.equal(await panel(page, "ops", "radius"), "1");
    assert.equal(
      await panel(page, "ops", "radius recorded"),
      "(no such row)",
      "no second row while the live and recorded radii agree"
    );
    assert.equal(await textOf(page, "#mode"), "live");
    console.log(`    live: ${d.nodes} nodes, ${d.edges} ties, ${d.labels.length} labels`);

    // ---- 2. color follows the value, and stops at three slots ---------------
    assert.deepEqual(
      d.fills,
      [
        "var(--s1)", // red, first seen at seat 0
        "var(--s1)", // red again
        "var(--s2)", // blue
        "var(--s3)", // green
        "var(--s3)", // green again
        "var(--muted)", // amber — the fourth value, past the palette cap
      ],
      "slots are assigned in order of first appearance in seat order",
    );
    const legend = await textOf(page, "#legend");
    assert.ok(legend.includes("amber (other)"), `the fourth value is marked as other: ${legend}`);
    assert.ok(
      legend.includes("read the labels"),
      `the legend says colors have run out: ${legend}`,
    );

    // ---- 3. the scrubber shows the frame it names ---------------------------
    //
    // Frame 2 has four ties and is the only frame whose count differs from live,
    // so this cannot pass by showing the live graph.
    await scrubTo(page, 2);
    d = await drawn(page);
    assert.equal(await textOf(page, "#mode"), "history");
    assert.equal(d.edges, FRAME_TIES[2], "the ties that existed at frame 2");
    assert.equal(d.removed, 1, "the tie CUT at frame 2 is drawn, dashed");
    const label = await textOf(page, "#scrubLabel");
    assert.ok(
      label.startsWith(`event 3/${EVENTS.length} · remove · 4 ties`),
      `the label names the frame being shown: ${label}`,
    );

    // Frame 3 ADDS a tie: five ties, one of them highlighted as new.
    await scrubTo(page, 3);
    d = await drawn(page);
    assert.equal(d.edges, FRAME_TIES[3], "the ties that existed at frame 3");
    assert.equal(d.added, 1, "the tie CREATED at frame 3 is highlighted");
    assert.equal(d.removed, 0, "frame 3 destroyed nothing");
    console.log(`    scrubbed: frame 2 = ${FRAME_TIES[2]} ties + 1 cut, frame 3 = 1 new tie`);

    // The end of the range is LIVE, not "the last frame". Off by one here and
    // the monitor silently stops following a running study.
    await scrubTo(page, EVENTS.length - 1);
    assert.equal(await textOf(page, "#mode"), "live", "dragging to the end resumes live");
    assert.equal(
      await page.$eval("#liveBtn", (b) => (b as HTMLButtonElement).disabled),
      true,
      "the live button is disabled when already live",
    );

    // ...and the explicit way back, from a scrubbed frame.
    await scrubTo(page, 0);
    assert.equal((await drawn(page)).edges, FRAME_TIES[0]);
    await page.locator("#liveBtn").click();
    assert.equal(await textOf(page, "#mode"), "live");
    assert.equal((await drawn(page)).edges, LIVE_EDGES.length, "back to the live graph");

    // ---- 4. a live update, and colors that do not move --------------------
    //
    // Seat 5 changes amber -> red, so red becomes the commonest value and amber
    // disappears. Nothing else may change color: a scale assigned by frequency
    // would repaint the graph, and an operator watching a color spread through
    // a network would be watching an artifact.
    const before = (await drawn(page)).fills.slice(0, 5);
    fake.setColor(5, "red");
    await page.waitForFunction(
      () => (document.querySelectorAll('#graph text[dy="33"]')[5]?.textContent ?? "") === "red",
      undefined,
      { timeout: 10_000 },
    );
    d = await drawn(page);
    assert.deepEqual(d.fills.slice(0, 5), before, "an update must not repaint anybody else");
    assert.equal(d.fills[5], "var(--s1)", "seat 5 takes the color of the value it now holds");
    console.log("    live update arrived over SSE; no seat was repainted");

    // ---- 5. the stall banner -----------------------------------------------
    //
    // One missing channel blocks EVERY view, not just its owner's. This is the
    // failure an operator cannot see from inside the study, so the monitor
    // saying it is the whole point of the monitor.
    fake.setPending(["p3"]);
    await page.waitForFunction(() => document.getElementById("banner")?.className === "on");
    const stall = await textOf(page, "#banner");
    assert.ok(stall.includes("NOBODY"), `the banner says the whole game is stalled: ${stall}`);
    assert.equal(await panel(page, "ops", "channels pending"), "1");
    assert.ok((await drawn(page)).nodes > 0, "a stall does not blank the graph");
    fake.setPending([]);
    await page.waitForFunction(() => document.getElementById("banner")?.className !== "on");
    console.log("    stalled-channel banner appears and clears");

    // ---- 6. gone: the picture goes with the label ---------------------------
    //
    // The assertion O9 was opened for. A restart never puts participants back
    // into their game, so there is nothing to reconnect to and the last
    // graph is not "the current state" — it is a picture of a study that has
    // stopped, presented as live.
    assert.ok((await drawn(page)).nodes > 0, "non-vacuity: there IS a graph to lose");
    fake.setPresent(false);
    await page.waitForFunction(() => document.getElementById("mode")?.textContent === "gone");
    const goneBanner = await textOf(page, "#banner");
    assert.equal(await classOf(page, "#banner"), "on", "the gone banner is visible");
    assert.ok(goneBanner.includes("no longer networking"), `banner says why: ${goneBanner}`);
    d = await drawn(page);
    assert.equal(d.nodes, 0, "the graph is cleared, not left showing a dead study as live");
    assert.equal(d.edges, 0, "no ties are left behind either");
    assert.equal(
      d.rows,
      0,
      "the table view holds the same seating plan and must not survive the graph",
    );
    assert.equal(await textOf(page, "#legend"), "", "the legend goes too");
    console.log("    gone: badge, banner, and an empty graph");

    assert.deepEqual(pageErrors, [], "the page script raised no errors");

    // ---- 7. a LOST stream is a different thing, and says so -----------------
    //
    // Frozen with a banner rather than cleared: the game may well still be
    // running, and blanking a live study because a socket dropped would be the
    // same misreport in the other direction. Asserted so the two cases cannot
    // quietly converge.
    await page.close();
    await server.stop();
    server = await serveMonitor(fake.source, { pollMs: 50, log: () => {} });
    fake.setPresent(true);

    page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#graph circle").length > 0);

    await server.stop();
    server = undefined;
    await page.waitForFunction(() => document.getElementById("banner")?.className === "on");
    const lost = await textOf(page, "#banner");
    assert.ok(lost.includes("Lost the event stream"), `the banner names the failure: ${lost}`);
    assert.ok(lost.includes("frozen"), `and says what the graph now is: ${lost}`);
    assert.equal(
      (await drawn(page)).nodes,
      N,
      "a dropped stream freezes the picture; it does not clear it",
    );
    console.log("    lost stream: banner shown, graph deliberately kept");

    console.log("\n  PASS — the monitor page, in real Chromium\n");
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  FAIL —", e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
