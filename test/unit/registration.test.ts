/**
 * The kind-registration deadline and what it says — `ISSUES.md` O14, O15.
 *
 * O14 built a check that observes a consequence: channels demonstrably created
 * by `addScopes`, none of them ever arriving back as a modeled scope. O15 is
 * what it got wrong. The deadline was a flat 5 s, justified by "channels
 * materialise in milliseconds at every size in the envelope" — a true statement
 * about SMALL n, applied at every n. Measured 2026-08-16 (`npm run bench`,
 * three runs per cell, slowest of each):
 *
 * ```
 *   n= 25     86ms      n=150   4287ms   <- 86% of the deadline, inside the envelope
 *   n= 50    491ms      n=200   5870ms   <- past it. One n=200 run that went on to
 *   n=100   2320ms                          deliver 760/760 receipts was told its
 *                                           correct code was broken.
 * ```
 *
 * `test/e2e/kind_registration.test.ts` is still the witness that the check
 * *works* against a real server. This file is the witness for the two things
 * that cannot be produced there on demand: the deadline's arithmetic, and the
 * retraction — which needs a deadline that expires while the channels are
 * healthy and in flight, i.e. exactly the race O15 hit at n=200 and exactly the
 * race a test cannot ask a real server to lose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resetChannels } from "../../src/admin/provision.js";
import {
  REGISTRATION_CHECK_MS,
  REGISTRATION_CHECK_PER_CHANNEL_MS,
  registrationNotDetectedMessage,
  registrationRetractionMessage,
  registrationWaitMs,
} from "../../src/admin/registration.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import {
  FakeCollector,
  FakeScope,
  makeCtx,
  makeGame,
  materialise,
  type FakeCtx,
} from "./fake_admin.js";

const ENV = "EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS";

// --------------------------------------------------------------- the deadline

test("the deadline grows with the channels created, and never drops below the floor", () => {
  // Small n is unchanged. This is the case the e2e witness covers and the case
  // the original 5 s was right about, so the fix must not move it.
  assert.equal(registrationWaitMs(1), REGISTRATION_CHECK_MS);
  assert.equal(registrationWaitMs(20), REGISTRATION_CHECK_MS, "the paper's n, still the floor");
  assert.equal(registrationWaitMs(50), REGISTRATION_CHECK_MS, "the top of the target regime");

  // Above the floor it is linear in channels — the subscription replay this
  // check waits on is O(channels).
  assert.equal(registrationWaitMs(100), 100 * REGISTRATION_CHECK_PER_CHANNEL_MS);
  assert.equal(registrationWaitMs(200), 200 * REGISTRATION_CHECK_PER_CHANNEL_MS);
  assert.ok(registrationWaitMs(200) > registrationWaitMs(150));
});

/**
 * The assertion O15 exists for, stated as a margin rather than as a constant.
 *
 * A test that pinned `registrationWaitMs(150) === 15000` would pass for any
 * coefficient anyone later typed in. What has to hold is that the deadline
 * clears the measured worst case by enough to survive a slower machine — and
 * `docs/PLATFORM-NOTES.md` §19 measured that margin: the same bench cell at
 * 7.3ms and 18.3ms an hour apart, a 2.5x swing from machine power state alone.
 */
test("every measured first-channel latency clears the deadline by at least 3x", () => {
  const MEASURED: Array<[n: number, slowestMs: number]> = [
    [25, 86],
    [50, 491],
    [100, 2320],
    [150, 4287],
    [200, 5870],
  ];
  for (const [n, slowest] of MEASURED) {
    const margin = registrationWaitMs(n) / slowest;
    assert.ok(
      margin >= 3,
      `n=${n}: deadline ${registrationWaitMs(n)}ms is only ${margin.toFixed(1)}x the slowest ` +
        `measured ${slowest}ms — a 2.5x machine-state swing (PLATFORM-NOTES §19) would ` +
        `false-accuse correct code`
    );
  }
});

test("the env seam overrides the whole computation, not just the floor", () => {
  const previous = process.env[ENV];
  try {
    process.env[ENV] = "150";
    // If the seam were only a floor, a large channel count would swamp it and
    // the e2e tier would sit through the real deadline instead of 150ms.
    assert.equal(registrationWaitMs(1), 150);
    assert.equal(registrationWaitMs(500), 150);

    process.env[ENV] = "not a number";
    assert.equal(registrationWaitMs(1), REGISTRATION_CHECK_MS, "garbage falls back, not throws");
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
});

// ---------------------------------------------------------------- the message

test("the warning names both causes and asserts neither", () => {
  const text = registrationNotDetectedMessage(200, 20_000);

  // The exact phrase O15 was filed about. It converted an observation into a
  // diagnosis that this process cannot establish.
  assert.doesNotMatch(text, /almost certainly/i);

  assert.match(text, /200 private channels were created 20s ago/);
  assert.match(text, /cannot tell them apart/i, "the limit is stated, not implied");
  assert.match(text, /NOT REGISTERED/, "cause 1, and still the one to check first");
  assert.match(text, /\+\s+networkKinds/, "with the fix, because that is what a reader needs");
  assert.match(text, /only slow/i, "cause 2, carrying real weight rather than a footnote");
  assert.match(text, /pendingChannels/, "and how to tell them apart from outside");
  assert.match(text, /retracted/, "the promise the retraction message keeps");
});

test("a one-channel game is not described in the plural", () => {
  // The floor case, which is what a first install actually hits — and the
  // message is the only thing they will read about it.
  assert.match(registrationNotDetectedMessage(1, 5000), /1 private channel was created 5s ago/);
});

test("the retraction says it was wrong, and says nothing needs fixing", () => {
  const text = registrationRetractionMessage(200, 20_000, 24_100);
  assert.match(text, /RETRACTING/);
  assert.match(text, /24\.1s/, "the latency that beat the deadline, which is the useful part");
  assert.match(text, /20s deadline/);
  assert.match(text, /IS registered/);
  assert.match(text, /Nothing to fix/i);
});

// ------------------------------------------------- the retraction, as wired up

const TRIANGLE = () => [
  [0, 1],
  [1, 2],
  [0, 2],
] as Array<[number, number]>;

function experiment(): { collector: FakeCollector; ctx: FakeCtx; net: NetworkHandle } {
  const collector = new FakeCollector();
  const net = withNetwork(collector, { topology: TRIANGLE });
  return { collector, ctx: makeCtx(), net };
}

/** Run `body` with the deadline forced to `waitMs`, capturing everything logged. */
async function captureWith(
  waitMs: number,
  // `lines` is handed to the body rather than only returned, because the
  // interesting assertion in the first test below is about the state BETWEEN
  // the warning and the retraction — which only exists while the body runs.
  body: (lines: string[]) => Promise<void>
): Promise<string[]> {
  const previous = process.env[ENV];
  process.env[ENV] = String(waitMs);
  const lines: string[] = [];
  const originalLog = console.log;
  // `console.log`, not `console.warn`: `warn()` from `@empirica/core/console`
  // routes every level through `console.log` (PLATFORM-NOTES §17b).
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await body(lines);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
  return lines;
}

const accused = (lines: string[]) => lines.filter((l) => l.includes("none has materialised"));
const retracted = (lines: string[]) => lines.filter((l) => l.includes("RETRACTING"));

test.beforeEach(() => resetChannels());

test("a channel arriving after the warning retracts it", async () => {
  const { collector, ctx, net } = experiment();

  // Deadline zero: the check fires on the next turn of the loop, while the
  // channels are perfectly healthy and simply have not been delivered yet. That
  // is O15's failure at n=200, reproduced deterministically at n=3.
  const lines = await captureWith(0, async (lines) => {
    await collector.emit(
      "game/start",
      { game: makeGame("g1", ["p1", "p2", "p3"], new FakeScope("b")) },
      ctx
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(accused(lines).length, 1, "the deadline expired, so it accused — as designed");
    assert.equal(retracted(lines).length, 0, "and nothing has arrived yet to take it back");

    await materialise(collector, ctx, ctx.created);
  });

  assert.equal(retracted(lines).length, 1, "the accusation does not get the last word");
  // The retraction has to be believable on its own terms, so it carries the
  // number: an operator reading this log later needs to see that a channel did
  // arrive, not just that the package changed its mind.
  assert.match(retracted(lines)[0]!, /A channel materialised/);
  assert.equal(typeof net.stats().firstChannelMs, "number");
});

test("it is retracted once, not once per channel", async () => {
  const { collector, ctx } = experiment();
  const lines = await captureWith(0, async (lines) => {
    await collector.emit(
      "game/start",
      { game: makeGame("g1", ["p1", "p2", "p3"], new FakeScope("b")) },
      ctx
    );
    await new Promise((r) => setTimeout(r, 20));
    // Three channels arrive. A retraction per channel is how a correction turns
    // into noise, and at n=200 it would be 200 copies of the same paragraph.
    await materialise(collector, ctx, ctx.created);
  });
  assert.equal(accused(lines).length, 1);
  assert.equal(retracted(lines).length, 1);
});

test("nothing is retracted when nothing was accused", async () => {
  const { collector, ctx } = experiment();
  // The ordinary case: the deadline is generous, channels arrive well inside it,
  // and the check is silent in both directions. A retraction here would be a
  // warning about a warning that never happened.
  const lines = await captureWith(60_000, async (lines) => {
    await collector.emit(
      "game/start",
      { game: makeGame("g1", ["p1", "p2", "p3"], new FakeScope("b")) },
      ctx
    );
    await materialise(collector, ctx, ctx.created);
  });
  assert.deepEqual(accused(lines), []);
  assert.deepEqual(retracted(lines), []);
});
