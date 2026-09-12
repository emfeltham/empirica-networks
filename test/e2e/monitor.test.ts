/**
 * The monitor against a real, running study.
 *
 * Everything about the endpoint itself — the token, the loopback bind, what it
 * refuses — is unit-tier in test/unit/monitor_http.test.ts, where it needs no
 * server. What can ONLY be established here is the pair of claims that involve
 * a live Empirica:
 *
 *   1. The monitor shows the network participants are actually in, and keeps
 *      showing it as the study rewires — including a history the scrubber can
 *      replay.
 *   2. Turning the monitor on changes NOTHING about what a participant
 *      receives. Asserted against the raw wire, below the mode, the same way
 *      PLATFORM-NOTES §4c measured scope visibility — because a leak through a
 *      channel nobody enumerated still counts as a leak.
 *
 * The second is the one that matters. The monitor holds the complete graph and
 * every participant's private state at once; if enabling it moved any of that
 * into the scope graph, every study using it would be silently confounded.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { networkKinds } from "../../src/admin/kinds.js";
import { monitor } from "../../src/admin/monitor/index.js";
import type { MonitorServer } from "../../src/admin/monitor/http.js";
import { resetChannels } from "../../src/admin/provision.js";
import {
  network,
  withNetwork,
  type NetworkHandle,
} from "../../src/admin/with_network.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";
import { networkStateOf } from "../../src/player/state.js";
import { ring } from "../../src/topology/index.js";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type AdminHandle,
} from "../../src/harness/harness.js";

const N = 4;

test.beforeEach(() => resetChannels());

const modeOf = (p: { mode: unknown }) => p.mode as EmpiricaNetworkContext;
const stateOf = (p: { mode: unknown }) => networkStateOf(modeOf(p).nbhd.getValue())!;

// ------------------------------------------------------------------ plumbing

/** node:http rather than fetch: undici's pooled dispatcher outlives the request. */
function getJSON(m: MonitorServer, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: m.host,
        port: m.port,
        path: `${path}${path.includes("?") ? "&" : "?"}t=${m.token}`,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`non-JSON from ${path}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Ties as sorted `a|b` player-id strings, so two representations can be compared. */
function tieSet(pairs: Array<[string, string]>): string[] {
  return pairs.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)).sort();
}

function snapshotTies(snapshot: any): string[] {
  return tieSet(
    snapshot.edges.map(([i, j]: [number, number]) => [snapshot.order[i], snapshot.order[j]]),
  );
}

async function startGame(admin: AdminHandle, participants: { mode: unknown }[]): Promise<void> {
  const batch = await createBatch(admin, batchConfig(N, 1));
  await batch.running();
  await waitFor(() => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")), {
    label: "gameID assigned",
    timeoutMs: 90_000,
  });
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: "first publish",
    timeoutMs: 30_000,
  });
}

// ----------------------------------------------------- 1. it shows the study

test("the monitor shows the real network, follows a rewire, and keeps a scrubbable history", async () => {
  let gameRef: any;
  let handle!: NetworkHandle;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    // Stands in for a real experiment's onStageStart. Mutations must run inside
    // a listener or they reach nobody, silently — see with_network.ts.
    _.on("game", "dropTie", (_ctx: any, { game }: any) => {
      const cmd = game.get("dropTie") as { a: string; b: string } | undefined;
      if (cmd) network(game).removeEdge(cmd.a, cmd.b);
    });
    handle = withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      project: (neighbor: any) => ({ id: neighbor.id }),
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await startGame(admin, participants);

      const m = await monitor(handle, { pollMs: 50, log: () => {} });
      try {
        const games = await getJSON(m, "/api/games");
        assert.deepEqual(games.games, [gameRef.id], "the monitor must find the running game");
        assert.equal(games.stats.games, 1);

        const before = await getJSON(m, "/api/state");
        const net = network(gameRef);

        // The graph on screen is the graph participants are in. Compared as
        // player-id ties rather than indices, because the seating is exactly
        // the thing that could silently disagree.
        assert.deepEqual(
          snapshotTies(before.snapshot),
          tieSet(net.edges()),
          "the monitor's graph must be the server's graph",
        );
        assert.equal(before.snapshot.n, N);
        assert.equal(before.positions.length, N, "every seat gets a coordinate");
        assert.ok(before.snapshot.seq > 0, "publish counts are visible to the operator");
        assert.deepEqual(before.snapshot.pendingChannels, [], "a healthy game stalls nobody");
        assert.equal(before.snapshot.metrics.components, 1, "a ring of 4 is connected");
        assert.equal(before.snapshot.metrics.edgeCount, 4);

        // The initial graph is in the history as a `start` event, so the
        // scrubber covers the whole run rather than beginning mid-story.
        assert.equal(before.snapshot.history.frames.length, 1);
        assert.equal(before.snapshot.history.frames[0].op, "start");
        assert.equal(before.snapshot.history.consistent, true);
        assert.equal(before.snapshot.history.dropped, 0);

        // --- now rewire, and watch the monitor follow it -------------------
        const [a, b] = net.edges()[0]!;
        await admin.taj.setAttribute({
          key: "dropTie",
          val: JSON.stringify({ a, b }),
          nodeID: gameRef.id,
        });

        let after: any;
        await waitFor(
          async () => {
            after = await getJSON(m, "/api/state");
            return after.snapshot.edges.length === 3;
          },
          { label: "the monitor saw the tie drop", timeoutMs: 30_000 },
        );

        assert.deepEqual(
          snapshotTies(after.snapshot),
          tieSet(net.edges()),
          "and still agrees with the server after the change",
        );

        // The scrubber's material: two frames, and the earlier one still shows
        // the tie that has since gone. This is `snapshotRows`' replay reaching
        // the browser, not a second implementation.
        const frames = after.snapshot.history.frames;
        assert.equal(frames.length, 2);
        assert.equal(frames[0].edges.length, 4, "scrubbing back shows the graph as it was");
        assert.equal(frames[1].edges.length, 3);
        assert.equal(frames[1].op, "remove");
        assert.equal(frames[1].removed.length, 1, "the dropped tie is nameable, so it can be drawn");
        assert.equal(after.snapshot.history.consistent, true);

        // A dropped tie on a ring of 4 leaves a path: still one component, but
        // two participants now have degree 1. Asserted so the metrics panel is
        // known to track reality rather than the initial topology.
        assert.equal(after.snapshot.metrics.edgeCount, 3);
        assert.equal(after.snapshot.metrics.minDegree, 1);
      } finally {
        await m.stop();
      }
    },
  );
});

// ------------------------------------- 2. it changes nothing for participants

test("running the monitor leaks nothing to participants, and reads their private state", async () => {
  let handle!: NetworkHandle;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    handle = withNetwork(_, {
      topology: ({ playerCount }) => ring(playerCount),
      // Reads PRIVATE state, never a player attribute — so a non-neighbor's
      // secret has no legitimate route to anyone's browser.
      project: (neighbor: any, _viewer: any, ctx: any) => ({
        id: neighbor.id,
        secret: ctx.stateOf(neighbor).get("secret"),
      }),
      watch: ["secret"],
    });
  };

  await withScenario(
    { n: N, kinds: networkKinds, recordWire: true, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      await startGame(admin, participants);

      const m = await monitor(handle, { pollMs: 50, log: () => {} });
      try {
        // Record every participant's raw wire BEFORE any secret exists, so a
        // later absence is meaningful rather than a matter of timing.
        const wires = participants.map((p) => {
          const frames: string[] = [];
          p.wireStream().subscribe({
            next: (msg: unknown) => {
              try {
                frames.push(JSON.stringify(msg));
              } catch {
                /* unserialisable */
              }
            },
          });
          return frames;
        });

        const secrets = new Map<string, string>();
        for (const [i, p] of participants.entries()) {
          const playerID = modeOf(p).player.getValue()!.id;
          const secret = `MONITOR-SECRET-${i}-${playerID.slice(-6)}`;
          secrets.set(playerID, secret);
          stateOf(p).set("secret", secret);
        }

        // THE U3 WITNESS. A participant's own write only reaches this process
        // because `withNetwork` issues an explicit `ctx.scopeSub({ kinds })`;
        // `subscribeAttribute` subscribes the admin to nothing on its own
        // (PLATFORM-NOTES §12). Without that call every value below is
        // `undefined` and nothing errors — so this assertion is what stops the
        // monitor from being a silent victim of U3 if it ever regresses.
        let seen: any;
        await waitFor(
          async () => {
            seen = await getJSON(m, "/api/state");
            return seen.snapshot.nodes.every(
              (node: any) => typeof node.state?.secret === "string",
            );
          },
          { label: "every participant's private state reached the monitor", timeoutMs: 30_000 },
        );

        for (const node of seen.snapshot.nodes) {
          assert.equal(
            node.state.secret,
            secrets.get(node.playerID),
            "the monitor must show each participant's OWN value, not a neighbor's",
          );
        }

        // Let the wire settle, so anything that was going to be delivered has
        // been. Without this the absence checks could pass by being early.
        await new Promise((r) => setTimeout(r, 1_500));

        // (a) Nothing the monitor authenticates with may exist in the scope
        //     graph. It never should: it is not an Empirica value at all.
        let checkedAbsent = 0;
        for (const [i, frames] of wires.entries()) {
          const blob = frames.join("\n");
          assert.equal(
            blob.includes(m.token),
            false,
            `participant ${i} received the monitor token`,
          );

          // (b) The claim that actually protects a study: with the monitor
          //     running and reading every secret, a participant still receives
          //     only their neighbors'.
          const meID = modeOf(participants[i]!).player.getValue()!.id;
          const visible = new Set(
            ((modeOf(participants[i]!).nbhd.getValue()?.neighbors ?? []) as { id: string }[]).map(
              (nb) => nb.id,
            ),
          );
          for (const [playerID, secret] of secrets) {
            if (playerID === meID || visible.has(playerID)) continue;
            assert.equal(
              blob.includes(secret),
              false,
              `participant ${i} received non-neighbor ${playerID}'s private state`,
            );
            checkedAbsent++;
          }
        }
        // On a ring of 4 each participant has exactly one non-neighbor, so a
        // run that checked nothing would mean the topology was not what we
        // think — and a vacuous pass here is worse than a failure.
        assert.equal(checkedAbsent, N, "each participant must have had one non-neighbor to check");

        // (c) The full edge list, which the monitor holds and renders, must not
        //     have reached anyone. This is the seating plan — the thing §4c
        //     moved to the batch scope to hide.
        const allTies = snapshotTies(seen.snapshot);
        for (const [i, frames] of wires.entries()) {
          const blob = frames.join("\n");
          for (const tie of allTies) {
            const [x, y] = tie.split("|");
            assert.equal(
              blob.includes(`${x}","${y}`) || blob.includes(JSON.stringify([x, y])),
              false,
              `participant ${i} received a rendered tie`,
            );
          }
        }
      } finally {
        await m.stop();
      }
    },
  );
});
