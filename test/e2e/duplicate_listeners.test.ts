/**
 * The duplicate-lifecycle-listener detector, against a real Empirica
 * (`ISSUES.md` U8, `docs/M6-HARDENING.md` §1.2).
 *
 * `test/unit/listeners.test.ts` covers the filters against a fake collector.
 * What only this tier can establish is the two things the fake has to assume:
 * that a real `ClassicListenersCollector` exposes what the detector reads, and
 * that the defect it warns about is still real.
 *
 * So the second test asserts the defect as well as the warning. That pairing is
 * deliberate. A warning about a defect nobody re-checks becomes folklore, and if
 * upstream ever fixes `unique` this test fails and says the warning should be
 * withdrawn rather than quietly lying to every consumer.
 *
 * **The first test runs no game and connects no participants**, because the
 * detector fires in the collector's `start` hook — nothing about a batch, a game
 * or a stage is involved in producing the warning. That is not tidiness: this
 * file's first version ran two full n=3 games and, measured 2026-08-16, moved the
 * e2e tier from reliably green to 1-3 failures in OTHER files on "gameID
 * assigned" (`ISSUES.md` O8). Removing the file restored green; making the
 * warning arms participant-free was the fix. The cost of a test is a property of
 * the test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";

import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import {
  batchConfig,
  createBatch,
  waitFor,
  withScenario,
  type AdminHandle,
} from "../../src/verify/harness.js";

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

/**
 * A complete, ordinary experiment — optionally with the one mistake.
 *
 * A real `ClassicListenersCollector` instance rather than the `(_) => {…}`
 * function form the rest of this tier uses, and that is required rather than
 * stylistic: `ctx.register(fn)` hands the function a plain `ListenersCollector`,
 * which has no `onStageEnded` at all. The detector is correctly inert there —
 * there is no lifecycle helper to duplicate — but it also means the function form
 * cannot exercise this. Every real experiment uses the instance form, including
 * both shipped examples.
 *
 * The two arms differ by exactly one line, which is what makes the healthy arm's
 * silence meaningful: the same collector class, the same harness, the same
 * `withNetwork` call.
 *
 * `topology: () => []` because nothing here depends on anybody having a
 * neighbour, and an empty graph is a legitimate configuration rather than a stub.
 */
function experiment(duplicate: boolean, ran: string[]): ClassicListenersCollector {
  const Empirica = new ClassicListenersCollector();

  Empirica.onGameStart(({ game }: any) => {
    const round = game.addRound({});
    round.addStage({ name: "only", duration: 3_600_000 });
  });

  Empirica.onStageEnded(() => {
    ran.push("first");
  });
  // The mistake. Written this way — one handler per concern — because that is
  // the obvious structure, not a contrived error.
  if (duplicate) {
    Empirica.onStageEnded(() => {
      ran.push("second");
    });
  }

  withNetwork(Empirica, {
    topology: () => [],
    project: (neighbour: any) => ({ id: neighbour.id }),
  });

  return Empirica;
}

/**
 * Start a server with these listeners and return every line the package logged.
 *
 * **`console.log`, not `console.warn`.** `warn()` from `@empirica/core/console`
 * routes every level through `console.log` (`chunk-TIKLWCJI.js`, measured
 * 2026-08-16), so swapping `console.warn` captures nothing and the assertion
 * passes or fails for reasons unrelated to the warning.
 * `test/e2e/envelope.test.ts` had the same dead capture, which never showed
 * because it did not assert on what it collected.
 *
 * Swapped BEFORE `withScenario`, because the detector runs in the collector's
 * `start` hook — which fires inside `startCallbacks`, before the scenario body
 * gets control. Passed through to the original, so a failing run still prints the
 * harness's own diagnostics.
 */
async function capture(
  listeners: ClassicListenersCollector,
  n: number,
  body?: (s: { admin: AdminHandle; participants: { mode: unknown }[] }) => Promise<void>
): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
    originalLog(...args);
  };
  try {
    await withScenario(
      { n, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
      async ({ admin, participants }) => {
        if (body) await body({ admin, participants });
      }
    );
  } finally {
    console.log = originalLog;
  }
  return lines;
}

/**
 * Empirica's logger emits ONE `console.log` per line of a multi-line message
 * (`for (const line of args[0].split("\n"))`), each with its own timestamp
 * prefix, so a warning arrives as a dozen separate calls. Reassembled here rather
 * than asserted line by line.
 */
const logged = (lines: string[]) => lines.join("\n");

const headlines = (lines: string[]) =>
  lines.filter((w) => w.includes("registered more than once"));

/**
 * Both arms in ONE test, and the reason is non-vacuity.
 *
 * The healthy arm asserts an ABSENCE, and a broken capture would satisfy it
 * perfectly. Two separate tests cannot fix that: with no participants and no
 * batch a healthy server logs literally nothing, so there is no "the microphone
 * is on" line to check for — measured, after writing exactly that assertion and
 * watching it fail for the right reason.
 *
 * Running both arms through the same `capture` in the same test makes the
 * non-vacuity structural instead: the silence means something because the very
 * same capture caught the warning moments earlier.
 */
test("the detector warns on a duplicated helper and stays silent on healthy code", async () => {
  // No participants, no batch, no game: the detector runs in the `start` hook, so
  // this is everything the warning needs.
  const broken = await capture(experiment(true, []), 0);
  const healthy = await capture(experiment(false, []), 0);

  const reported = headlines(broken);
  assert.equal(reported.length, 1, `expected exactly one warning, got ${reported.length}`);

  const text = logged(broken);
  assert.match(text, /onStageEnded\(\) {2}registered 2 times {2}\(stage\/ended\)/);
  assert.match(text, /ONLY THE FIRST WILL EVER RUN/);
  // The fix reaches the operator too, not just the doc comment.
  assert.match(text, /Register each helper ONCE and dispatch inside it/);
  // And the case where the warning is wrong, in the same breath as the
  // accusation.
  assert.match(text, /this warning is wrong/);

  // The arm that matters more. One line's difference in the experiment, and the
  // detector must have nothing to say — a warning that fires on healthy code is
  // a warning nobody reads.
  assert.deepEqual(
    headlines(healthy),
    [],
    "the detector fired on healthy code, which is how a warning gets ignored"
  );
});

test("the second handler really never runs, so the warning is about a live defect", async () => {
  // The one arm that needs a game. n=2 and an empty topology: this is about
  // upstream's dispatcher, and nothing here depends on the network.
  const ran: string[] = [];
  await capture(experiment(true, ran), 2, async ({ admin, participants }) => {
    const batch = await createBatch(admin, batchConfig(2, 1));
    await batch.running();
    await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
      label: "gameID assigned",
    });
    for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
    await waitFor(() => participants.every((p) => Boolean(modeOf(p).player.getValue()?.stage)), {
      label: "the stage is visible",
      timeoutMs: 30_000,
    });
    for (const p of participants) modeOf(p).player.getValue()!.stage!.set("submit", true);

    await waitFor(() => ran.length > 0, {
      label: "onStageEnded fired at least once",
      timeoutMs: 30_000,
    });
    // Both handlers would run in the same dispatch, so once one has fired there
    // is no second event to wait for — but give the runloop a moment rather than
    // reading `ran` in the same tick as the write that triggered it.
    await new Promise((r) => setTimeout(r, 1000));
  });

  assert.deepEqual(
    ran,
    ["first"],
    "if BOTH handlers ran, upstream fixed `unique` and this warning should be withdrawn"
  );
});
