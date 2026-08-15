import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptChannel,
  pendingChannelsMessage,
  provisionChannels,
  readChannels,
  releaseChannels,
  resetChannels,
} from "../../src/admin/provision.js";
import { NBHD_KEYS, NBHD_KIND } from "../../src/shared/keys.js";

// The channel index is process-global (see provision.ts note 4), so each test
// starts from a clean slate.
test.beforeEach(() => resetChannels());

function makePlayer(id: string, participantID?: string) {
  const attrs = new Map<string, unknown>();
  return {
    id,
    participantID,
    get: (k: string) => attrs.get(k),
    set: (k: string, v: unknown) => void attrs.set(k, v),
  };
}

/**
 * Fake EventContext. `scopeOrder` controls the order addScopes returns payloads
 * in, so we can prove the mapping does not depend on it.
 */
function makeCtx(opts: { scopeOrder?: "input" | "reversed" } = {}) {
  const calls = { addScopes: 0, addLinks: 0 };
  const links: any[] = [];
  /** The scope inputs as submitted, so tests can assert what gets recorded. */
  const scopes: any[] = [];
  let counter = 0;

  return {
    calls,
    links,
    scopes,
    addScopes: async (input: any[]) => {
      calls.addScopes++;
      scopes.push(...input);
      const payloads = input.map((scope) => ({
        id: `scope-${++counter}`,
        kind: scope.kind,
        attributes: {
          edges: scope.attributes.map((a: any) => ({
            node: { key: a.key, val: a.val },
          })),
        },
      }));
      return opts.scopeOrder === "reversed" ? payloads.reverse() : payloads;
    },
    addLinks: async (input: any[]) => {
      calls.addLinks++;
      links.push(...input);
      return [];
    },
  };
}

function makeGame(players: ReturnType<typeof makePlayer>[]) {
  const attrs = new Map<string, unknown>();
  return {
    id: "game-1",
    players,
    get: (k: string) => attrs.get(k),
    set: (k: string, v: unknown) => void attrs.set(k, v),
  };
}

test("provisions one channel per player in a single batched round trip", async () => {
  const players = [makePlayer("p1", "part1"), makePlayer("p2", "part2"), makePlayer("p3", "part3")];
  const game = makeGame(players);
  const ctx = makeCtx();

  const res = await provisionChannels(ctx, game);

  assert.equal(ctx.calls.addScopes, 1, "one addScopes call regardless of n");
  assert.equal(ctx.calls.addLinks, 1, "one addLinks call regardless of n");
  assert.deepEqual(res.created.sort(), ["p1", "p2", "p3"]);
  assert.equal(Object.keys(res.channels).length, 3);
});

test("maps channels to owners correctly even when addScopes returns out of order", async () => {
  // The spike assumed input order. Nothing documents that guarantee, and getting
  // it wrong would hand participants each other's channels — a silent, total
  // privacy failure that still looks like it works.
  const players = [makePlayer("p1", "part1"), makePlayer("p2", "part2"), makePlayer("p3", "part3")];
  const game = makeGame(players);
  const ctx = makeCtx({ scopeOrder: "reversed" });

  const res = await provisionChannels(ctx, game);

  for (const link of ctx.links) {
    const participantID = link.participantIDs[0];
    const nodeID = link.nodeIDs[0];
    const playerID = Object.keys(res.channels).find((pid) => res.channels[pid] === nodeID);
    const expected = players.find((p) => p.id === playerID)!.participantID;
    assert.equal(participantID, expected, `channel ${nodeID} linked to its own owner`);
  }
});

test("links one participant to one node — never the cross product", async () => {
  // A single LinkInput carrying both arrays links every participant to every
  // node, which is precisely the leak this module exists to prevent.
  const players = [makePlayer("p1", "part1"), makePlayer("p2", "part2")];
  const ctx = makeCtx();
  await provisionChannels(ctx, makeGame(players));

  assert.equal(ctx.links.length, 2, "one link input per pair");
  for (const link of ctx.links) {
    assert.equal(link.participantIDs.length, 1);
    assert.equal(link.nodeIDs.length, 1);
    assert.equal(link.link, true);
  }
});

test("is idempotent: a second call provisions nothing and issues no writes", async () => {
  const players = [makePlayer("p1", "part1"), makePlayer("p2", "part2")];
  const game = makeGame(players);
  const ctx = makeCtx();

  const first = await provisionChannels(ctx, game);
  const second = await provisionChannels(ctx, game);

  assert.equal(second.created.length, 0, "nothing re-created");
  assert.equal(ctx.calls.addScopes, 1, "no second addScopes");
  assert.equal(ctx.calls.addLinks, 1, "no second addLinks — Tajriba cannot unlink");
  assert.deepEqual(second.channels, first.channels);
});

test("provisions only the newcomer when a player joins later", async () => {
  const players = [makePlayer("p1", "part1")];
  const game = makeGame(players);
  const ctx = makeCtx();
  await provisionChannels(ctx, game);

  players.push(makePlayer("p2", "part2"));
  const res = await provisionChannels(ctx, game);

  assert.deepEqual(res.created, ["p2"]);
  assert.equal(Object.keys(res.channels).length, 2);
  assert.equal(ctx.calls.addScopes, 2);
});

test("skips players with no participantID and reports them as pending", async () => {
  // Creating a channel for a disconnected player would orphan it: no participant
  // to link, and no unlink to correct it later.
  const players = [makePlayer("p1", "part1"), makePlayer("p2", undefined)];
  const game = makeGame(players);
  const ctx = makeCtx();

  const res = await provisionChannels(ctx, game);

  assert.deepEqual(res.created, ["p1"]);
  assert.deepEqual(res.pending, ["p2"]);
  assert.equal(ctx.links.length, 1);
});

test("a pending player is rescued by a later call, not stranded", async () => {
  // The recovery path `withNetwork` runs on ParticipantConnect. Provisioning
  // happens once at game start, so if this did not work a player who arrived
  // without a participantID would have no channel for the rest of the game.
  const late = makePlayer("p2", undefined);
  const players = [makePlayer("p1", "part1"), late];
  const game = makeGame(players);
  const ctx = makeCtx();

  const first = await provisionChannels(ctx, game);
  assert.deepEqual(first.pending, ["p2"], "nothing to link to yet");

  // What connecting does: Classic sets participantID from an immutable
  // attribute in its own `player` listener.
  late.participantID = "part2";
  const second = await provisionChannels(ctx, game);

  assert.deepEqual(second.created, ["p2"], "provisioned on the retry");
  assert.deepEqual(second.pending, [], "and no longer pending");
  assert.equal(Object.keys(second.channels).length, 2);
  // p1 must not have been re-provisioned: Tajriba cannot unlink, so a duplicate
  // channel would be permanent and the second link would be unreachable.
  assert.equal(ctx.calls.addScopes, 2, "one batch per call, not per player");
  assert.equal(ctx.links.length, 2, "exactly one link per participant");
});

test("channels are self-describing, so a restart can rebuild the index from them", async () => {
  // Each channel carries everything needed to reconstruct the server-side index
  // that a restart destroys: which game, which player, and which seat. Without
  // the seat, recovery has to re-derive position from `game.players` order,
  // which is not stable — and silently reseats everyone.
  const players = [makePlayer("p1", "part1"), makePlayer("p2", "part2")];
  const game = makeGame(players);
  const ctx = makeCtx();
  const order = ["p2", "p1"]; // deliberately NOT game.players order

  await provisionChannels(ctx, game, (playerID) => order.indexOf(playerID));

  const seats = new Map<string, number>();
  for (const scope of ctx.scopes) {
    const attrs = Object.fromEntries(
      scope.attributes.map((a: any) => [a.key, JSON.parse(a.val)])
    );
    assert.equal(attrs[NBHD_KEYS.GAME_ID], "game-1", "carries its game");
    seats.set(attrs[NBHD_KEYS.PLAYER_ID], attrs[NBHD_KEYS.INDEX]);
  }

  assert.deepEqual(
    [...seats.entries()].sort(),
    [
      ["p1", 1],
      ["p2", 0],
    ],
    "the seat recorded is the topology index, not the player list position"
  );

  for (const scope of ctx.scopes) {
    for (const key of [NBHD_KEYS.GAME_ID, NBHD_KEYS.INDEX]) {
      const attr = scope.attributes.find((a: any) => a.key === key);
      assert.equal(attr.immutable, true, `${key} cannot be rewritten by anyone`);
    }
  }
});

test("adoptChannel re-adopts an existing channel instead of creating a second", async () => {
  // The restart path. Provisioning with an empty index does not merely repeat
  // work — it creates a duplicate channel, and Tajriba cannot unlink, so the
  // participant stays linked to both while client and server disagree about
  // which one is live.
  const players = [makePlayer("p1", "part1")];
  const game = makeGame(players);
  const ctx = makeCtx();
  await provisionChannels(ctx, game);
  const original = readChannels(game)["p1"]!;

  // What a restart looks like: the in-memory index is gone, but the channel
  // scope still exists and still knows who it belongs to.
  resetChannels();
  assert.deepEqual(readChannels(game), {}, "the index really is empty");

  adoptChannel(game.id, "p1", original);

  const res = await provisionChannels(ctx, game);
  assert.deepEqual(res.created, [], "nothing new was created");
  assert.equal(readChannels(game)["p1"], original, "the original channel is still the one");
  assert.equal(ctx.calls.addScopes, 1, "no second addScopes");
  assert.equal(ctx.links.length, 1, "and no second link, which could never be undone");
});

test("releaseChannels drops one game's index and leaves the others alone", async () => {
  // A study is many sequential games in one process. Releasing the finished one
  // must not disturb the games still running beside it — the index is global,
  // so an over-broad release would blank a live game's channels and, since
  // `publish` refuses partial views, every participant in it.
  const done = makeGame([makePlayer("p1", "part1")]);
  const running = { ...makeGame([makePlayer("p2", "part2")]), id: "game-2" };
  const ctx = makeCtx();

  await provisionChannels(ctx, done);
  await provisionChannels(ctx, running);
  assert.equal(Object.keys(readChannels(done)).length, 1);
  assert.equal(Object.keys(readChannels(running)).length, 1);

  releaseChannels(done.id);

  assert.deepEqual(readChannels(done), {}, "the finished game is forgotten");
  assert.equal(
    Object.keys(readChannels(running)).length,
    1,
    "the running game keeps its channels"
  );
});

test("releasing a game that was never provisioned is harmless", () => {
  // Reachable: a game can end before provisioning completes, and the release
  // path should not need to know whether it did.
  releaseChannels("never-existed");
});

test("the pending message names the players and the consequence", () => {
  // The consequence is disproportionate to the cause — one unprovisioned player
  // blanks the whole game — so the message has to say so rather than just
  // reporting a count.
  const msg = pendingChannelsMessage(["p2", "p7"], 4);

  assert.match(msg, /2 of 4 players/);
  assert.match(msg, /"p2", "p7"/, "names them, so the operator can act");
  assert.match(msg, /NO participant in this game receives a neighbourhood/);
  assert.match(msg, /retried when a participant connects/, "says it self-heals");
});

test("never writes the channel map to a participant-visible scope", async () => {
  // Regression: the map was briefly stored on the game scope, which every
  // participant is linked to. That handed every participant every channel id —
  // and with no write ACL (PLATFORM-NOTES §4a), an id is the capability needed
  // to inject into someone else's channel.
  const players = [makePlayer("p1", "part1")];
  const game = makeGame(players);
  const written: string[] = [];
  game.set = (k: string, _v: unknown) => void written.push(k);

  const res = await provisionChannels(makeCtx(), game);

  assert.deepEqual(written, [], "provisioning writes nothing to the game scope");
  assert.deepEqual(readChannels(game), res.channels, "index is readable server-side");
});

test("readChannels returns an empty map when nothing is provisioned", () => {
  assert.deepEqual(readChannels(makeGame([])), {});
});

test("readChannels returns a copy — callers cannot mutate the index", async () => {
  const game = makeGame([makePlayer("p1", "part1")]);
  await provisionChannels(makeCtx(), game);
  const snapshot = readChannels(game);
  snapshot["p1"] = "tampered";
  assert.notEqual(readChannels(game)["p1"], "tampered");
});

test("throws rather than mis-assign when a payload has no owner attribute", async () => {
  const players = [makePlayer("p1", "part1")];
  const ctx = {
    addScopes: async () => [{ id: "scope-x", attributes: { edges: [] } }],
    addLinks: async () => [],
  };
  await assert.rejects(
    () => provisionChannels(ctx, makeGame(players)),
    new RegExp(`${NBHD_KEYS.OWNER}`)
  );
});

test("creates scopes of the nbhd kind with immutable owner attributes", async () => {
  const players = [makePlayer("p1", "part1")];
  let captured: any[] = [];
  const ctx = {
    addScopes: async (input: any[]) => {
      captured = input;
      return input.map((s, i) => ({
        id: `s${i}`,
        attributes: { edges: s.attributes.map((a: any) => ({ node: { key: a.key, val: a.val } })) },
      }));
    },
    addLinks: async () => [],
  };
  await provisionChannels(ctx, makeGame(players));

  assert.equal(captured[0].kind, NBHD_KIND);
  const owner = captured[0].attributes.find((a: any) => a.key === NBHD_KEYS.OWNER);
  assert.equal(owner.immutable, true, "owner must be immutable — the client selects on it");
});
