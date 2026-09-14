/**
 * Radius 1.5: the ties between a participant's own neighbors.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `leak.test.ts`. The sentinel arms there
 * detect leaked STATE — a value belonging to somebody a participant cannot see.
 * Radius 1.5 leaks no state. It adds STRUCTURE, and every sentinel arm in this
 * repository would pass unchanged whether this feature were correct or
 * catastrophically wrong, because the extra bytes are integers rather than
 * anybody's attribute. That is a hole, and it is the shape of hole this package
 * is written against, so the invariant gets its own arms:
 *
 *   containment    every tie delivered to a participant joins two people that
 *                  participant can see, and is a tie that really exists.
 *   completeness   nothing inside the declared radius is missing, so a study
 *                  cannot pass by sending less than it says it does.
 *   non-vacuity    somebody actually receives a tie beyond their own star. A run
 *                  where nobody does published the channel and put nothing in
 *                  it, which looks identical from every screen.
 *   default off    at radius 1 the key is absent from the wire entirely.
 *
 * Asserted at the WIRE, below the mode, for the same reason `leak.test.ts` is: a
 * client-side filter would satisfy "the screen never showed it", and the claim
 * is about the bytes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import {
  network,
  readRadius,
  withNetwork,
  type NetworkHandle,
} from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkGraphOf } from "../../src/player/view.js";
import { NBHD_KEYS } from "../../src/shared/keys.js";
import { fromEdgeList, type Radius } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type AdminHandle,
} from "../../src/harness/harness.js";

const N = 5;

/**
 * A hub with a triangle under it, plus an isolate.
 *
 *   0-1, 0-2, 0-3, 1-2          4 is tied to nobody
 *
 * Chosen so one run covers every case that behaves differently: seat 0 has a tie
 * BETWEEN two of its neighbors (which is the whole feature), seat 3 has
 * neighbors but no tie among them, seat 4 has no neighbors at all, and seats 0
 * and 4 are non-neighbors so containment has something to exclude. It also
 * leaves seat 0's neighbor LIST unchanged when 2-3 is added later, which is the
 * only way to test the suppression bug below.
 */
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
];

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

/**
 * `onGame` receives the game SCOPE, which is the only handle `readRadius` and
 * its siblings accept — they read the batch the scope hangs off. Captured the
 * same way `test/e2e/reproducibility.test.ts` captures it, rather than through
 * `inspect()`, because the point of those accessors is that they read STORAGE
 * and `inspect()` reads memory.
 */
function makeListeners(
  radius: Radius,
  capture: (net: NetworkHandle) => void,
  onGame?: (game: any) => void
) {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    if (onGame) _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) onGame(game);
    });
    // Stands in for a real experiment's onStageStart. See `addTie` below for why
    // a mutation cannot be driven straight from test code.
    _.on("game", ADD_TIE, (_ctx: any, { game }: any) => {
      const cmd = game.get(ADD_TIE) as { a: string; b: string } | undefined;
      if (!cmd) return;
      network(game).addEdge(cmd.a, cmd.b);
    });
    capture(
      withNetwork(_, {
        topology: () => fromEdgeList(N, EDGES),
        project: (neighbor: any) => ({ id: neighbor.id }),
        graph: { radius },
      })
    );
  };
}

const ADD_TIE = "addTieCmd";

/**
 * Add a tie from inside the server's own callback.
 *
 * NOT `network(gameID).addEdge(...)` from here. The runloop flushes the `set()`
 * calls made while it is processing a callback, so a mutation driven from test
 * code updates server state correctly and then reaches nobody until something
 * else happens to flush — which under load is never, and under no load is soon
 * enough to look like it worked. `test/e2e/rewiring.test.ts` carries the same
 * note, having been written the obvious way first; this test was too, and it
 * passed alone and failed in a full run for exactly this reason.
 */
async function addTie(admin: AdminHandle, gameID: string, a: string, b: string): Promise<void> {
  await admin.taj.setAttribute({
    key: ADD_TIE,
    val: JSON.stringify({ a, b }),
    nodeID: gameID,
  });
}

/** Every GRAPH payload that reached this participant, oldest first. */
function graphFrames(frames: string[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of frames) {
    if (!raw.includes(NBHD_KEYS.GRAPH)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const change = parsed?.change ?? parsed?.data?.change ?? parsed;
    if (change?.key !== NBHD_KEYS.GRAPH || typeof change?.val !== "string") continue;
    try {
      out.push(JSON.parse(change.val));
    } catch {
      out.push(change.val);
    }
  }
  return out;
}

async function play(participants: { mode: unknown }[]): Promise<void> {
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => Boolean(modeOf(p).game.getValue())), {
    label: "game visible",
  });
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

test("a participant is shown the ties among their own connections, and no others", async () => {
  let net!: NetworkHandle;
  await withScenario(
    {
      n: N,
      kinds: networkKinds,
      recordWire: true,
      listeners: makeListeners(1.5, (h) => (net = h)),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      // Subscribed AFTER the batch is running. An extra `changes()` subscription
      // opened while Classic is still registering participants correlates with a
      // participant never getting a player scope at all (`ISSUES.md` O8), and
      // nothing that could carry a network has been sent this early anyway.
      const wires = new Map<number, string[]>();
      const subs = participants.map((p, i) => {
        const frames: string[] = [];
        wires.set(i, frames);
        return p.wireStream().subscribe((c: unknown) => frames.push(JSON.stringify(c)));
      });

      try {
        await play(participants);

        const gameID = modeOf(participants[0]!).player.getValue()!.get("gameID") as string;
        const snapshot = net.inspect(gameID)!;
        // The truth, in player ids rather than seats.
        const real = new Set(
          snapshot.edges.map(([i, j]) => {
            const a = snapshot.order[i]!;
            const b = snapshot.order[j]!;
            return a < b ? `${a}|${b}` : `${b}|${a}`;
          })
        );

        let beyondStarTotal = 0;
        let isolated = 0;

        for (const [i, p] of participants.entries()) {
          const nbhd = modeOf(p).nbhd.getValue()!;
          const me = nbhd.playerID!;
          const neighbors = (nbhd.neighbors as { id: string }[]).map((n) => n.id);

          const delivered = graphFrames(wires.get(i)!);
          assert.ok(
            delivered.length > 0,
            `${me} received no structure at all — every check here would be vacuous`
          );

          const structure = networkGraphOf(nbhd);
          assert.ok(structure, `${me}'s structure is present and usable`);
          assert.equal(structure.radius, 1.5, "the payload declares what it is");
          assert.equal(
            structure.positions.length,
            neighbors.length + 1,
            `${me}: one position per delivered node, plus their own`
          );

          // Local 0 is the viewer; 1..d are the neighbor views in order. This
          // join is the feature: the payload never names a seat.
          const idAt = (k: number) => (k === 0 ? me : neighbors[k - 1]);
          const visible = new Set([me, ...neighbors]);

          for (const [a, b] of structure.edges) {
            const x = idAt(a);
            const y = idAt(b);
            assert.ok(x && y, `${me}: a tie referenced local index ${a}/${b}, which was not sent`);

            // CONTAINMENT, half one: both ends are people this participant can
            // see. A tie to anyone else is a fact about a stranger.
            assert.ok(
              visible.has(x) && visible.has(y),
              `${me} was told about a tie involving somebody outside their neighborhood`
            );
            // CONTAINMENT, half two: the tie is real. A drawn tie that does not
            // exist is not a leak, it is a lie, and it fails the same way.
            assert.ok(
              real.has(x < y ? `${x}|${y}` : `${y}|${x}`),
              `${me} was shown a tie between ${x} and ${y} that does not exist`
            );
            if (a !== 0 && b !== 0) beyondStarTotal++;
          }

          // COMPLETENESS: everything inside the radius is there. Without this a
          // study could pass by sending an empty structure, which is exactly the
          // vacuous result the non-vacuity arm below also guards.
          const expected = new Set<string>();
          for (const x of visible) {
            for (const y of visible) {
              if (x >= y) continue;
              if (real.has(`${x}|${y}`)) expected.add(`${x}|${y}`);
            }
          }
          const got = new Set(
            structure.edges.map(([a, b]) => {
              const x = idAt(a)!;
              const y = idAt(b)!;
              return x < y ? `${x}|${y}` : `${y}|${x}`;
            })
          );
          assert.deepEqual(
            [...got].sort(),
            [...expected].sort(),
            `${me}: the structure must be the whole induced subgraph, not part of it`
          );

          if (neighbors.length === 0) {
            isolated++;
            assert.deepEqual(structure.edges, [], "an isolated participant has nothing to draw");
            assert.equal(structure.positions.length, 1, "and is drawn alone");
          }
        }

        // NON-VACUITY. A run where this is zero published the extra channel and
        // put nothing in it, and every screen would look correct.
        assert.ok(
          beyondStarTotal > 0,
          "no participant received a tie beyond their own star, so this run proves nothing " +
            "about radius 1.5"
        );
        assert.equal(isolated, 1, "the isolate case was exercised, not skipped");
      } finally {
        for (const s of subs) s.unsubscribe();
      }
    }
  );
});

test("a tie forming BETWEEN two of my connections reaches me, though my list never changes", async () => {
  // The suppression bug, and the reason the byte-identical key covers the
  // structure as well as the neighbor views. Seat 0 is tied to 1, 2 and 3
  // throughout; adding 2-3 changes seat 0's picture and leaves seat 0's neighbor
  // list byte-identical. Keyed on the views alone, this publish is skipped and
  // the drawing freezes while every other part of the screen keeps updating.
  let net!: NetworkHandle;
  await withScenario(
    {
      n: N,
      kinds: networkKinds,
      listeners: makeListeners(1.5, (h) => (net = h)),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();
      await play(participants);

      const gameID = modeOf(participants[0]!).player.getValue()!.get("gameID") as string;
      const order = net.inspect(gameID)!.order;

      const hub = participants.find((p) => modeOf(p).nbhd.getValue()?.playerID === order[0])!;
      const before = networkGraphOf(modeOf(hub).nbhd.getValue())!;
      const listBefore = JSON.stringify(modeOf(hub).nbhd.getValue()!.neighbors);
      assert.equal(before.edges.length, 4, "hub, three spokes, and the 1-2 tie");

      await addTie(admin, gameID, order[2]!, order[3]!);

      await waitFor(
        () => (networkGraphOf(modeOf(hub).nbhd.getValue())?.edges.length ?? 0) === 5,
        {
          label: "the new tie between two of the hub's connections reaches the hub",
          // 30s, matching the first-publish waits elsewhere in this tier rather
          // than the shorter default: the tier runs serially and `ISSUES.md` O8
          // is about exactly this — a timeout tight enough to pass alone and
          // fail under the load of a full run says nothing about the code.
          timeoutMs: 30_000,
        }
      );

      assert.equal(
        JSON.stringify(modeOf(hub).nbhd.getValue()!.neighbors),
        listBefore,
        "the hub's neighbor list really was unchanged, so nothing but the structure " +
          "could have carried this"
      );
    }
  );
});

test("at the default radius nothing extra is sent, and the key is absent from the wire", async () => {
  // The claim that keeps radius 1 free. If this ever fails, every study using
  // the default is paying for a feature it did not ask for and telling its
  // participants something it did not intend to.
  let net!: NetworkHandle;
  await withScenario(
    {
      n: N,
      kinds: networkKinds,
      recordWire: true,
      listeners: makeListeners(1, (h) => (net = h)),
      modeFunc: EmpiricaNetwork,
    },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      const frames: string[] = [];
      const sub = participants[0]!.wireStream().subscribe((c: unknown) =>
        frames.push(JSON.stringify(c))
      );
      try {
        await play(participants);

        const nbhd = modeOf(participants[0]!).nbhd.getValue()!;
        assert.ok(nbhd.published, "a view did arrive, so the absence below means something");
        assert.equal(
          networkGraphOf(nbhd),
          undefined,
          "absent is 'this study draws a star', and must not be confused with unusable"
        );
        assert.deepEqual(graphFrames(frames), [], "no structure was ever put on the wire");
        assert.equal(
          net.stats().cachedLayouts,
          0,
          "and no layout was computed for anybody"
        );
      } finally {
        sub.unsubscribe();
      }
    }
  );
});

test("a radius between the steps is refused, not rounded", async () => {
  const make = (radius: unknown) =>
    withNetwork({ on: () => {} } as any, {
      topology: () => fromEdgeList(N, EDGES),
      graph: { radius: radius as 1.5 },
    });

  // 2 and 2.5 are now both legal and are DIFFERENT studies — 2.5 additionally
  // delivers the ties between two people who are each two hops away. Anything
  // between them is refused rather than rounded to either, for the reason the
  // old refusal gave about 2: rounding shows participants something other than
  // what the design asked for, and nothing anywhere would say so.
  assert.throws(() => make(1.2), /multiple of 0\.5/);
  assert.throws(() => make(2.7), /multiple of 0\.5/);
  assert.throws(() => make(0.5), /at least 1/);
  assert.throws(() => make(0), /at least 1/);
  // "whole" is the one spelling for the entire network. Infinity would have to
  // be translated on the wire anyway, and two spellings of one setting invites
  // an author to think they differ.
  assert.throws(() => make(Infinity), /"whole" is the one spelling/);
  assert.throws(() => make("all"), /multiple of 0\.5/);

  for (const ok of [1, 1.5, 2, 2.5, 3, "whole"]) {
    assert.doesNotThrow(() => make(ok), `radius ${JSON.stringify(ok)} should be accepted`);
  }
});


/**
 * Radius 2: people in the picture who are not in the view that names them.
 *
 * The fixture earns its keep here without changing. From seat 3 the ball at
 * radius 2 is {3} ∪ {0} ∪ {1, 2}: seat 0 is a neighbor and arrives in the view
 * carrying its id, while 1 and 2 are two hops away, appear in the drawing, and
 * have no entry in `neighbors` at all. They are exactly what the positional
 * naming scheme cannot address, and what `far` exists for.
 *
 * THE HALF-STEP, AT THE WIRE. Seat 3 is two hops from both 1 and 2, and 1-2 is a
 * real tie. At radius 2 it must NOT be delivered — a tie between two people who
 * are each at the outer edge is what 2.5 adds. This is the one assertion that
 * distinguishes the two settings from outside the server, and without it a build
 * that induced the whole ball would look correct at every other check.
 */
for (const [radius, fringeTieDelivered] of [
  [2, false],
  [2.5, true],
] as Array<[Radius, boolean]>) {
  test(`radius ${radius}: distant people are named, and the fringe tie ${
    fringeTieDelivered ? "arrives" : "does not"
  }`, async () => {
    await withScenario(
      {
        n: N,
        kinds: networkKinds,
        listeners: makeListeners(radius, () => {}),
        modeFunc: EmpiricaNetwork,
      },
      async ({ admin, participants }) => {
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        await play(participants);

        const bySeat = new Map<string, ReturnType<typeof modeOf>>();
        for (const p of participants) {
          const nbhd = modeOf(p).nbhd.getValue()!;
          bySeat.set(nbhd.playerID!, modeOf(p));
        }

        let sawFar = false;
        let checkedFringe = false;

        for (const p of participants) {
          const nbhd = modeOf(p).nbhd.getValue()!;
          const me = nbhd.playerID!;
          const neighbors = (nbhd.neighbors as { id: string }[]).map((n) => n.id);
          const structure = networkGraphOf(nbhd);

          // The isolate has nobody at any radius and draws nothing.
          if (neighbors.length === 0) {
            assert.ok(
              !structure || structure.far === undefined,
              `${me} is isolated and should have been given no distant people`
            );
            continue;
          }

          assert.ok(structure, `${me}'s structure is present and usable`);
          const far = structure.far ?? [];
          assert.equal(
            structure.positions.length,
            1 + neighbors.length + far.length,
            `${me}: one position per node in the picture`
          );

          for (const f of far) {
            sawFar = true;
            assert.ok(f.d >= 2, `${me}: a "far" node at distance ${f.d} belongs in the view`);
            assert.match(f.ref, /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/, `${me}: malformed name`);
            // The disclosure that must not happen: a name that is somebody's id,
            // or a seat. Either would be a stable handle on a stranger.
            assert.ok(!bySeat.has(f.ref), `${me} was handed a real player id as a name`);
            assert.ok(Number.isNaN(Number(f.ref)) || f.ref.length === 8, `${me}: seat-like name`);
          }
          assert.equal(
            new Set(far.map((f) => f.ref)).size,
            far.length,
            `${me}: two distant people share a name`
          );

          // Seat 3 in the fixture: one neighbor, two people at distance 2, and a
          // real tie between those two.
          if (neighbors.length === 1 && far.length === 2) {
            checkedFringe = true;
            const fringe = new Set(
              far.map((f) => 1 + neighbors.length + far.indexOf(f))
            );
            const tieAmongFringe = structure.edges.some(
              ([a, b]) => fringe.has(a) && fringe.has(b)
            );
            assert.equal(
              tieAmongFringe,
              fringeTieDelivered,
              fringeTieDelivered
                ? `${me}: radius 2.5 must deliver the tie between the two outermost people`
                : `${me}: radius 2 must withhold it — that tie is what 2.5 adds`
            );
          }
        }

        assert.ok(sawFar, "nobody was shown anybody beyond their own neighbors");
        assert.ok(checkedFringe, "the fringe-tie case never ran, so the half step is untested");
      }
    );
  });
}

// ------------------------------------------------- the record a run leaves
//
// The graph a study ran on is recorded so a finished run is reproducible from
// its own data. What it SHOWED people is the other half of that, and it is not
// derivable from anything else: two studies on one graph, one at each radius,
// leave identical edge lists and identical attribute exports.

test("the radius a game ran at is recorded, at both radii", async () => {
  for (const radius of [1, 1.5] as const) {
    let net!: NetworkHandle;
    let gameRef: any;
    await withScenario(
      {
        n: N,
        kinds: networkKinds,
        listeners: makeListeners(radius, (h) => (net = h), (g) => (gameRef = g)),
        modeFunc: EmpiricaNetwork,
      },
      async ({ admin, participants }) => {
        const batch = await createBatch(admin, batchConfig(N, 1));
        await batch.running();
        await play(participants);

        const gameID = modeOf(participants[0]!).player.getValue()!.get("gameID") as string;

        assert.equal(
          readRadius(gameRef),
          radius,
          `a run at radius ${radius} must say so in its own data`
        );
        assert.equal(
          net.inspect(gameID)!.radius,
          radius,
          "and the live snapshot must agree with the record"
        );
      }
    );
    resetChannels();
  }
});

test("an unrecorded radius reads back as undefined, never as 1", async () => {
  // The distinction the accessor exists to keep. A dataset from before this key
  // existed and a dataset from a study that deliberately drew a star are
  // different facts, and defaulting would assert the second about the first.
  assert.equal(readRadius({ id: "g", batch: { get: () => undefined } }), undefined);
  assert.equal(readRadius({ id: "g", batch: { get: () => "1.5" } }), undefined, "a string is not a record");
  assert.equal(readRadius({ id: "g" }), undefined, "no batch at all is not a record");
  assert.equal(readRadius({ id: "g", batch: { get: () => 1 } }), 1, "a recorded 1 is a real answer");
});
