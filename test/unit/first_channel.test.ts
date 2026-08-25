/**
 * `stats().firstChannelMs` — the number the kind-registration warning races.
 *
 * The warning in `src/admin/registration.ts` is the only thing in this package
 * that can tell someone their **correct** code is broken, and until 2026-08-16
 * the quantity it was racing had never been measured — the 5 s deadline it used
 * was justified by "channels materialise in milliseconds", which turned out to
 * be a statement about small n only (`ISSUES.md` O14, O15). This is the seam
 * that made it measurable.
 *
 * There is nothing to time here — a fake collector materialises channels in the
 * same tick, so every figure below is 0 or 1 ms. That is the point: the *shape*
 * is what a server-free test can pin down (undefined until one arrives, set
 * once, never revised), and the magnitudes come from `npm run bench`, which is
 * the only place the load exists.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork, type NetworkHandle } from "../../src/admin/with_network.js";
import {
  FakeCollector,
  FakeScope,
  makeCtx,
  makeGame,
  materialise,
  startGame,
  type FakeCtx,
} from "./fake_admin.js";

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

test.beforeEach(() => resetChannels());

test("undefined until a channel materialises, then a number", async () => {
  const { collector, ctx, net } = experiment();
  const game = makeGame("g1", ["p1", "p2", "p3"], new FakeScope("b"));

  assert.equal(net.stats().firstChannelMs, undefined, "nothing has been provisioned yet");

  // `game/start` provisions but does NOT materialise — that is a separate
  // delivery through the kind subscription, which is the whole gap the check is
  // watching. Splitting them here is what makes the assertion between the two
  // possible at all.
  await collector.emit("game/start", { game }, ctx);
  assert.equal(
    net.stats().firstChannelMs,
    undefined,
    "channels exist in Tajriba and none has come back — exactly the state that warns"
  );

  await materialise(collector, ctx, ctx.created);
  const measured = net.stats().firstChannelMs;
  assert.equal(typeof measured, "number");
  assert.ok(measured! >= 0, `expected a non-negative latency, got ${measured}`);
});

test("it is the FIRST channel, and a later one does not revise it", async () => {
  const { collector, ctx, net } = experiment();

  await startGame(collector, ctx, makeGame("g1", ["p1", "p2", "p3"], new FakeScope("b")));
  const first = net.stats().firstChannelMs;
  assert.equal(typeof first, "number");

  // A second game, provisioned and materialised well after the first. If this
  // moved the figure, every long-running process would eventually report the
  // latency of its most recent game — and the deadline this number sizes is
  // armed once, at the first game, where the process is coldest and the
  // connection burst is heaviest.
  await startGame(collector, ctx, makeGame("g2", ["p4", "p5", "p6"], new FakeScope("b")));
  assert.equal(net.stats().firstChannelMs, first, "the first measurement stands");
});
