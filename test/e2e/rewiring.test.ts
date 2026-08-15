/**
 * Rewiring during play.
 *
 * The capability that motivated this module: Breadboard can manipulate ties
 * mid-game, and a contagion or tie-formation study is not expressible without
 * it.
 *
 * The mechanism rests on a property of the architecture rather than anything
 * new: Tajriba cannot unlink (`LinkInput`: "UNLINKING NOT CURRENTLY SUPPORTED"),
 * but it does not need to. The link grants a persistent private CHANNEL; the
 * server decides what goes in it. Dropping a tie just means that neighbour is
 * absent from the next view written there. So every assertion here is about what
 * participants can SEE, never about links.
 *
 * MUTATIONS MUST RUN INSIDE A LISTENER. The runloop flushes the `set()` calls
 * made while it is processing a callback; a mutation driven from anywhere else
 * updates server state correctly and then reaches nobody, silently. This test
 * was first written the obvious way — calling the handle straight from test
 * code — and every client assertion timed out while the server-side ones passed.
 * The tests therefore drive mutations through a command attribute, which is a
 * faithful stand-in for `Empirica.onStageStart(() => net.addEdge(...))`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { resetChannels } from "../../src/admin/provision.js";
import { network, withNetwork, type GameNetwork } from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type AdminHandle,
} from "../../src/verify/harness.js";

const N = 4;
const CMD_KEYS = ["rewireCmd0", "rewireCmd1", "rewireCmd2"] as const;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;

/** The ids this participant can currently see. */
function seen(p: { mode: unknown }): string[] {
  return ((modeOf(p).nbhd.getValue()?.neighbors ?? []) as { id: string }[])
    .map((n) => n.id)
    .sort();
}

interface Cmd {
  op: "add" | "remove" | "rewire";
  a?: string;
  b?: string;
  edges?: Array<[string, string]>;
}

function makeListeners(capture: (game: any) => void) {
  return (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) capture(game);
    });
    // Stands in for a real experiment's onStageStart / onRoundEnd.
    for (const key of CMD_KEYS) {
      _.on("game", key, (_ctx: any, { game }: any) => {
        const cmd = game.get(key) as Cmd | undefined;
        if (!cmd) return;
        const net = network(game);
        if (cmd.op === "add") net.addEdge(cmd.a!, cmd.b!);
        else if (cmd.op === "remove") net.removeEdge(cmd.a!, cmd.b!);
        else net.rewire(cmd.edges!);
      });
    }
    withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbour: any) => ({ id: neighbour.id }),
    });
  };
}

/** Run a mutation inside the server's own callback. `nth` picks a fresh key. */
async function command(
  admin: AdminHandle,
  gameID: string,
  cmd: Cmd,
  nth = 0
): Promise<void> {
  await admin.taj.setAttribute({
    key: CMD_KEYS[nth]!,
    val: JSON.stringify(cmd),
    nodeID: gameID,
  });
}

/** Boot a game and wait until everyone holds a neighbourhood. */
async function running(
  admin: AdminHandle,
  participants: { mode: unknown }[]
): Promise<void> {
  const batch = await createBatch(admin, batchConfig(N, 1));
  await batch.running();
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

test("dropping a tie removes it from both views, and only theirs", async () => {
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await running(admin, participants);

      // Reads do not have to be inside a callback — only writes do.
      const net = network(gameRef);
      const byID = new Map(participants.map((p) => [modeOf(p).player.getValue()!.id, p]));

      const [a, b] = net.edges()[0]!;
      const pa = byID.get(a)!;
      const pb = byID.get(b)!;
      assert.ok(seen(pa).includes(b), "precondition: they can see each other");
      assert.ok(seen(pb).includes(a));

      const untouched = participants.filter((p) => p !== pa && p !== pb);
      const before = new Map(untouched.map((p) => [p, seen(p).join(",")]));

      await command(admin, gameRef.id, { op: "remove", a, b });

      await waitFor(() => !seen(pa).includes(b) && !seen(pb).includes(a), {
        label: "both ends stopped seeing each other",
        timeoutMs: 30_000,
      });

      assert.equal(net.hasEdge(a, b), false, "and the server agrees");
      assert.equal(net.degree(a), 1, "a ring node that loses one tie keeps the other");

      for (const p of untouched) {
        assert.equal(seen(p).join(","), before.get(p), "a bystander's view must not change");
      }
    }
  );
});

test("adding a tie makes two strangers visible to each other", async () => {
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await running(admin, participants);
      const net = network(gameRef);
      const byID = new Map(participants.map((p) => [modeOf(p).player.getValue()!.id, p]));

      // On a ring of 4 everyone has exactly one non-neighbour.
      const someone = participants[0]!;
      const meID = modeOf(someone).player.getValue()!.id;
      const strangerID = [...byID.keys()].find(
        (id) => id !== meID && !seen(someone).includes(id)
      )!;
      assert.ok(strangerID, "a ring of 4 has a non-neighbour");
      const stranger = byID.get(strangerID)!;

      await command(admin, gameRef.id, { op: "add", a: meID, b: strangerID });

      await waitFor(
        () => seen(someone).includes(strangerID) && seen(stranger).includes(meID),
        { label: "the new tie became visible both ways", timeoutMs: 30_000 }
      );

      // A ring of 4 plus one chord: the two joined nodes now have degree 3.
      assert.equal(net.degree(meID), 3);
      assert.equal(net.degree(strangerID), 3);
      assert.deepEqual(net.neighbors(meID).sort(), seen(someone), "server and client agree");
    }
  );
});

test("the history log records every mutation, and the snapshot stays current", async () => {
  // The snapshot alone cannot answer "how did it get here", and for a rewiring
  // study the sequence IS the independent variable. Both are recorded, on the
  // batch scope where participants cannot read them (PLATFORM-NOTES §4c).
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await running(admin, participants);
      const net = network(gameRef);
      assert.deepEqual(net.history(), [], "a static network logs nothing");

      const [a, b] = net.edges()[0]!;
      await command(admin, gameRef.id, { op: "remove", a, b });
      await waitFor(() => net.history().length === 1, { label: "the drop was logged" });

      // Must be someone `a` is NOT already tied to. On a ring a-b-c-d-a,
      // dropping (a,b) leaves a still adjacent to d — so "any id that is not a
      // or b" picks an existing neighbour half the time, addEdge correctly
      // returns false, and nothing is logged. That was a bug in this test, and
      // it presented as a 3-in-8 flake because it depended on participant order.
      const aNeighbours = new Set(net.neighbors(a));
      const stranger = participants
        .map((p) => modeOf(p).player.getValue()!.id)
        .find((id) => id !== a && id !== b && !aNeighbours.has(id))!;
      assert.ok(stranger, "a ring of 4 minus one tie leaves a non-neighbour to add");
      await command(admin, gameRef.id, { op: "add", a, b: stranger }, 1);
      await waitFor(() => net.history().length === 2, { label: "the add was logged" });

      const log = net.history();
      assert.equal(log[0]!.op, "remove");
      assert.deepEqual([log[0]!.a, log[0]!.b].sort(), [a, b].sort());
      assert.equal(log[0]!.size, N - 1, "edge count after the drop");
      assert.equal(log[1]!.op, "add");
      assert.equal(log[1]!.size, N, "and after the add");
      assert.ok(log[1]!.at >= log[0]!.at, "ordered in time");

      // The snapshot must track the mutations, or a restart would recover the
      // graph as it stood at game start.
      assert.equal(net.hasEdge(a, b), false);
      assert.equal(net.hasEdge(a, stranger), true);
    }
  );
});

test("rewire replaces the whole graph in one step", async () => {
  let gameRef: any;
  await withScenario(
    { n: N, kinds: networkKinds, listeners: makeListeners((g) => (gameRef = g)), modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await running(admin, participants);
      const net = network(gameRef);
      const ids = participants.map((p) => modeOf(p).player.getValue()!.id);
      const byID = new Map(participants.map((p) => [modeOf(p).player.getValue()!.id, p]));

      // A star: nothing like the ring it replaces, so a partial application
      // would be obvious rather than plausible.
      const hub = ids[0]!;
      await command(admin, gameRef.id, {
        op: "rewire",
        edges: ids.slice(1).map((id) => [hub, id] as [string, string]),
      });

      await waitFor(
        () =>
          seen(byID.get(hub)!).length === N - 1 &&
          ids.slice(1).every((id) => seen(byID.get(id)!).length === 1),
        { label: "the star replaced the ring for everyone", timeoutMs: 30_000 }
      );

      for (const id of ids.slice(1)) {
        assert.deepEqual(seen(byID.get(id)!), [hub], `spoke ${id} sees only the hub`);
      }
      assert.deepEqual(seen(byID.get(hub)!), ids.slice(1).sort(), "the hub sees every spoke");
      assert.equal(net.history().at(-1)!.op, "rewire");
    }
  );
});

test("network() on a game that never started throws rather than doing nothing", () => {
  assert.throws(() => network({ id: "no-such-game" }), /no network for game/);
});
