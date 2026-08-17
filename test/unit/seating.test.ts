/**
 * The seating plan: `topology({ players })[i]` is the participant at index `i`.
 *
 * This is the contract that makes deliberate PLACEMENT expressible — putting a
 * particular participant on a hub, or on a leaf — and it is the whole reason
 * `players` was added to the topology arguments. Shirado & Christakis (2017)
 * manipulate exactly this: central, peripheral and random bot placement is their
 * independent variable.
 *
 * Worth its own file because the guarantee is easy to hold accidentally and easy
 * to break accidentally. `withNetwork` reads `game.players` once, hands it to
 * `topology`, and then builds `order` from the same array; anything that
 * re-reads, sorts, filters or copies between those two points would break the
 * mapping while leaving every other test green — the graph would still be a
 * correct graph, just over different people.
 *
 * Driven through the fake admin rather than a server: the claim is about our two
 * lines, and the e2e tier has no headroom to spare (`ISSUES.md` O8).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resetChannels } from "../../src/admin/provision.js";
import { withNetwork } from "../../src/admin/with_network.js";
import { NBHD_KEYS } from "../../src/shared/keys.js";
import { FakeScope, makeCtx, makeGame, startGame, viewOn, FakeCollector } from "./fake_admin.js";

test.beforeEach(() => resetChannels());

const PLAYERS = ["pa", "pb", "pc", "pd"];

test("players[i] is the participant seated at topology index i", async () => {
  const collector = new FakeCollector();
  let seen: string[] | undefined;

  withNetwork(collector as any, {
    topology: ({ players, playerCount }) => {
      seen = players.map((p: any) => p.id);
      assert.equal(playerCount, players.length, "playerCount is players.length");
      // A path, so every index has a distinct degree: 0 and 3 have degree 1,
      // 1 and 2 have degree 2. Placement tests are exactly this — "which seat
      // gets the high degree" — so the fixture has to be able to tell them apart.
      return [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
    },
  });

  const ctx = makeCtx();
  const game = makeGame("g1", PLAYERS, new FakeScope("batch"));
  const channels = await startGame(collector, ctx, game);

  assert.deepEqual(seen, PLAYERS, "topology saw the players in the order withNetwork seats them");

  // The immutable index written on each channel IS the seat, and it is what
  // survives a restart (`NBHD_KEYS.INDEX`). Read it back per owner.
  const seatOf = new Map<string, number>();
  for (const ch of channels) {
    seatOf.set(ch.get(NBHD_KEYS.PLAYER_ID) as string, ch.get(NBHD_KEYS.INDEX) as number);
  }
  for (const [i, id] of PLAYERS.entries()) {
    assert.equal(seatOf.get(id), i, `${id} was seated at index ${i}`);
  }
});

test("an edge on indices ties the participants at those indices, and nobody else", async () => {
  const collector = new FakeCollector();
  // One tie only: seats 0 and 3, which are NOT adjacent in the players array.
  // A mapping that silently used arrival order, sorted ids, or an off-by-one
  // would still produce one tie — but between the wrong two people — so the
  // assertion below is about identity rather than shape.
  withNetwork(collector as any, { topology: () => [[0, 3]] });

  const ctx = makeCtx();
  const game = makeGame("g2", PLAYERS, new FakeScope("batch"));
  const channels = await startGame(collector, ctx, game);

  const viewOf = new Map<string, string[]>();
  for (const ch of channels) {
    const owner = ch.get(NBHD_KEYS.PLAYER_ID) as string;
    viewOf.set(owner, ((viewOn(ch) ?? []) as any[]).map((v) => v.id as string));
  }

  assert.deepEqual(viewOf.get("pa"), ["pd"], "seat 0 sees seat 3");
  assert.deepEqual(viewOf.get("pd"), ["pa"], "seat 3 sees seat 0");
  assert.deepEqual(viewOf.get("pb"), [], "seat 1 is on no tie");
  assert.deepEqual(viewOf.get("pc"), [], "seat 2 is on no tie");
});

test("relabelling the graph moves who is central, which is how placement works", async () => {
  // The documented technique, exercised end to end: generate a star, then permute
  // the labels so a chosen seat becomes the hub. This is what an experiment does
  // to place a bot centrally, and it is worth pinning because the alternative
  // reading — reorder the PARTICIPANTS — is not available: seats are fixed
  // before `topology` is called.
  for (const hub of [0, 1, 2, 3]) {
    resetChannels();
    const collector = new FakeCollector();
    withNetwork(collector as any, {
      topology: ({ playerCount }) => {
        const others = [...Array(playerCount).keys()].filter((i) => i !== hub);
        return others.map((i) => [hub, i] as [number, number]);
      },
    });

    const ctx = makeCtx();
    const game = makeGame(`g-hub-${hub}`, PLAYERS, new FakeScope("batch"));
    const channels = await startGame(collector, ctx, game);

    const degreeOf = new Map<string, number>();
    for (const ch of channels) {
      degreeOf.set(ch.get(NBHD_KEYS.PLAYER_ID) as string, (viewOn(ch) ?? []).length);
    }
    assert.equal(degreeOf.get(PLAYERS[hub]!), 3, `${PLAYERS[hub]} is the hub when hub=${hub}`);
    for (const [i, id] of PLAYERS.entries()) {
      if (i !== hub) assert.equal(degreeOf.get(id), 1, `${id} is a leaf when hub=${hub}`);
    }
  }
});
