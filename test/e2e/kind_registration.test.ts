/**
 * The kind-registration check, against a real Empirica (`ISSUES.md` O14).
 *
 * **What went wrong, since this test is the correction.** Registering
 * `networkKinds` in the consumer's `server/src/index.js` is the one mandatory
 * edit, and skipping it is silently fatal. `assertKindsRegistered` was written to
 * catch that, three documents recorded the trap as "impossible to skip silently"
 * on the strength of it — and it was **called by nothing**, with no test. The
 * helper existed; the mechanism did not. Found 2026-08-16 while writing
 * `docs/ARCHITECTURE.md`, by trying to say which function runs at which point in
 * the lifecycle and finding this one ran at no point at all.
 *
 * So the witness matters more than the code it witnesses, and it asserts the
 * DEFECT as well as the warning: the broken arm must also show that no channel
 * ever materialises. Without that pairing this test could pass against a warning
 * that fires for some other reason, which is how the original claim survived four
 * milestones.
 *
 * `withNetwork` cannot call `assertKindsRegistered` — it holds the collector, not
 * the kind map (see that function's comment) — so the check observes the
 * consequence: channels demonstrably created by `addScopes`, none of them ever
 * arriving back as a modelled scope.
 *
 * **This needs a game**, unlike `duplicate_listeners.test.ts`: nothing is provisioned
 * until one starts, and provisioning is the whole premise. So it is the expensive
 * kind of test, and it was measured rather than assumed — at **n=2, two games**, it
 * pushed the e2e tier from a reliable 66/66 to `told.test.ts` failing on `gameID
 * assigned` twice in a row. That is exactly the earlier finding that one added
 * file with two games broke OTHER files, reproducing on the file added next.
 *
 * **n=1 is therefore the size, and halving it was the whole fix** — the tier went
 * back to 67/67 twice consecutively. One channel is enough to be created and fail
 * to materialise, which is all the check counts, and the topology is empty because
 * nothing here depends on anybody having a neighbour. One participant fewer, on one
 * file, was the difference between a tier that failed reliably and one that passes.
 * The cost of a test is a property of the test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";

import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import {
  batchConfig,
  classicKinds,
  createBatch,
  waitFor,
  withScenario,
  type AdminHandle,
} from "../../src/harness/harness.js";

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

/**
 * Shorten the wait, via the documented env seam.
 *
 * The check's real default is 5s of headroom against a slow server. Waiting that
 * out here would add five seconds to a tier that already flakes under weight
 * (`ISSUES.md` O8) to test *how long* rather than *whether*.
 */
const CHECK_MS = 150;

/** An ordinary experiment. Identical in both arms — only the kind map differs. */
function experiment(): {
  listeners: ClassicListenersCollector;
  net: NetworkHandle;
} {
  const Empirica = new ClassicListenersCollector();

  Empirica.onGameStart(({ game }: any) => {
    const round = game.addRound({});
    round.addStage({ name: "only", duration: 3_600_000 });
  });

  const net = withNetwork(Empirica, {
    topology: () => [],
    project: (neighbour: any) => ({ id: neighbour.id }),
  });

  return { listeners: Empirica, net };
}

/**
 * Run a game to the point where channels have been provisioned, and return every
 * line the package logged.
 *
 * `console.log`, not `console.warn`: `warn()` from `@empirica/core/console` routes
 * every level through `console.log`, so swapping `console.warn` captures nothing
 * (`docs/PLATFORM-NOTES.md` §18b).
 */
async function capture(
  kinds: Record<string, any>
): Promise<{ lines: string[]; net: NetworkHandle }> {
  const { listeners, net } = experiment();
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
    originalLog(...args);
  };
  try {
    await withScenario(
      { n: 1, kinds, listeners, modeFunc: EmpiricaNetwork },
      async ({
        admin,
        participants,
      }: {
        admin: AdminHandle;
        participants: { mode: unknown }[];
      }) => {
        const batch = await createBatch(admin, batchConfig(1, 1));
        await batch.running();
        await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
          label: "gameID assigned",
        });
        for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
        // Provisioning happens at game start, which the gameID assignment above
        // already implies. Wait out the check's window plus a margin, rather than
        // racing the timer we deliberately shortened.
        await new Promise((r) => setTimeout(r, CHECK_MS * 5));
      }
    );
  } finally {
    console.log = originalLog;
  }
  return { lines, net };
}

const logged = (lines: string[]) => lines.join("\n");
/**
 * Matched on the OBSERVATION, which is all the warning claims since `ISSUES.md`
 * O15. It used to say "almost certainly not registered" — a diagnosis this
 * process cannot establish, and one that was measured firing on correct code at
 * n=200. The observation is the part that has to be true.
 */
const headlines = (lines: string[]) => lines.filter((w) => w.includes("none has materialised"));
const retractions = (lines: string[]) => lines.filter((w) => w.includes("RETRACTING"));

/**
 * Both arms in ONE test, for the non-vacuity reason `duplicate_listeners.test.ts`
 * gives: the healthy arm asserts an absence, and a broken capture would satisfy
 * it perfectly. The same capture catching the warning moments earlier is what
 * makes the silence mean something.
 */
test("an unregistered scope kind is reported, and registering it is silent", async (t) => {
  const previous = process.env["EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS"];
  process.env["EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS"] = String(CHECK_MS);
  t.after(() => {
    if (previous === undefined) delete process.env["EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS"];
    else process.env["EMPIRICA_NETWORKS_REGISTRATION_CHECK_MS"] = previous;
  });

  // The mistake: classicKinds where networkKinds belongs. Exactly the diff the
  // warning prints, and exactly what a first install gets wrong.
  const broken = await capture(classicKinds);

  const reported = headlines(broken.lines);
  assert.equal(reported.length, 1, `expected exactly one warning, got ${reported.length}`);

  const text = logged(broken.lines);
  assert.match(text, /1 private channel was created/);
  assert.match(text, /empty neighbourhood/);
  // The fix reaches the operator, not just the doc comment.
  assert.match(text, /\+\s+networkKinds/);
  // And the case where the warning is wrong, in the same breath as the accusation.
  assert.match(text, /pendingChannels/);

  // The arm really is broken, so the accusation stands: nothing takes it back.
  // Paired with the healthy arm's silence below, this is what says the
  // retraction added for `ISSUES.md` O15 discriminates rather than always
  // firing — a retraction that ran unconditionally would erase every TRUE
  // warning this check will ever print.
  assert.deepEqual(retractions(broken.lines), [], "a genuinely unregistered kind is not retracted");

  // THE DEFECT, not just the warning. If channels materialised anyway, the
  // premise is gone and this warning would be accusing healthy code.
  assert.equal(
    broken.net.stats().channelScopes,
    0,
    "a channel materialised without the kind registered, so the check's premise is wrong"
  );

  // The arm that matters more. One argument's difference, and the check must have
  // nothing to say — a warning that fires on correct code is one nobody reads.
  const healthy = await capture(networkKinds);
  assert.deepEqual(
    headlines(healthy.lines),
    [],
    "the check fired on a correctly registered server, which is how a warning gets ignored"
  );
  assert.ok(
    healthy.net.stats().channelScopes > 0,
    "no channel materialised on the healthy arm either, so its silence proves nothing"
  );
});
