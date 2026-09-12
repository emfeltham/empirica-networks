import { randomUUID } from "node:crypto";
import { networkKinds } from "../admin/kinds.js";
import { resetChannels } from "../admin/provision.js";
import { withNetwork, type NetworkConfig } from "../admin/with_network.js";
import { EmpiricaNetwork } from "../player/mode.js";
import { adjacency, type Edge } from "../topology/index.js";
import { CLI_TOPOLOGIES, accountVacuity } from "./topologies.js";
import { batchConfig, createBatch, gameInit, waitFor, withScenario } from "../harness/harness.js";

/**
 * The leak check: does a participant ever receive a non-neighbour's state?
 *
 * This is the module's central claim, so the check is built to be hard to fool:
 *
 * 1. ASSERTED AT THE WIRE. It subscribes to the raw participant stream, below
 *    the mode and below React. A client-side filter would satisfy "the UI never
 *    showed it"; the claim being made is that the bytes never arrived.
 *
 * 2. SENTINEL VALUES. Each participant is assigned a high-entropy token held
 *    SERVER-SIDE ONLY and injected into projections. Nothing writes it to a
 *    scope, so if it appears on a non-neighbour's wire it got there through the
 *    projection path. Substring matching over raw frames also catches leaks via
 *    channels nobody thought to enumerate.
 *
 * 3. THREE ARMS, ALL REQUIRED:
 *      candidate    - non-neighbour sentinels must NOT appear
 *      control      - a player-scope value MUST appear on everyone's wire,
 *                     proving the detector can see a leak at all
 *      non-vacuity  - neighbour sentinels MUST appear, proving the projection
 *                     actually ran rather than sending nothing
 *    A "pass" with a silent control, or with nothing delivered, is a FAILED run.
 *    Most privacy tests are wrong in exactly one of those two ways.
 *
 * WHICH TOPOLOGY, AND WHAT IT COSTS THE CHECK. Any graph can be checked, either by
 * name or by handing over the same generator function a study gives `withNetwork`
 * — the point being to verify the graph the study actually runs rather than a
 * stand-in for it. But the shape decides what the run can establish, and that is
 * a property of the REALISED GRAPH rather than of `n`:
 *
 *   - A participant adjacent to everybody (a star's hub, every node of a complete
 *     graph) has no non-neighbour, so arm 1 examines nothing for them.
 *   - A participant adjacent to nobody (`empty()`, or a random generator below its
 *     percolation threshold) receives no neighbour sentinel, so arm 3 expects
 *     nothing from them.
 *
 * Neither is a fault — both are legitimate shapes — so they are counted and
 * reported rather than failed. What IS a failure is a run where NO participant had
 * a non-neighbour, or where nothing was expected to arrive at all: that is a
 * vacuous pass, which is the failure mode this file exists to make impossible.
 * `assessVacuity` is where that accounting lives, and it is pure over (n, edges)
 * so it can be tested without a server.
 */

/**
 * The graph to check: a name the CLI can spell, or the study's own generator.
 *
 * The callable is deliberately the type `NetworkConfig.topology` already has, so
 * the function handed to `withNetwork` is the function that can be handed here.
 * That is the point of accepting one at all — a study running `fromEdgeList` over
 * a published graph, or `wattsStrogatz` at its own parameters, can verify THAT
 * rather than a ring standing in for it. Restating the signature instead of
 * referencing it would let the two drift apart silently.
 */
export type LeakTopology = string | NonNullable<NetworkConfig["topology"]>;

export interface LeakCheckOptions {
  n?: number;
  /** A name from `CLI_TOPOLOGIES`, or a generator. Defaults to `"ring"`. */
  topology?: LeakTopology;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface LeakCheckResult {
  pass: boolean;
  n: number;
  topology: string;
  /** Non-neighbour sentinels seen. Must be 0. */
  crossParticipantLeaks: number;
  /** Neighbour sentinels seen vs expected. Guards against a vacuous pass. */
  delivered: number;
  expectedDeliveries: number;
  /** Player-scope control values observed across participants. Must be > 0. */
  controlLeaks: number;
  /**
   * Non-neighbour pairs arm 1 actually examined — the DENOMINATOR under
   * `crossParticipantLeaks`.
   *
   * Without it, "0 non-neighbour sentinels received" is unfalsifiable: it reads
   * identically whether six pairs were checked and none leaked, or the graph was
   * complete and nothing was checked at all. A numerator printed without its
   * denominator is the same class of mistake as the `--topology` flag that was
   * reported as honoured while being ignored.
   */
  candidatePairs: number;
  /** Participants adjacent to everyone, who arm 1 cannot speak to. */
  saturated: number;
  /** Participants adjacent to nobody, who arm 3 expects nothing from. */
  isolated: number;
  failures: string[];
  notes: string[];
}

export async function runLeakCheck(opts: LeakCheckOptions = {}): Promise<LeakCheckResult> {
  const n = opts.n ?? 4;
  const spec = opts.topology ?? "ring";
  const say = opts.onProgress ?? (() => {});

  // A name resolves through the same table the CLI uses, so there is one list of
  // shapes rather than two that can disagree. A function is used as it stands.
  const build: NonNullable<NetworkConfig["topology"]> =
    typeof spec === "string"
      ? (() => {
          const named = CLI_TOPOLOGIES[spec];
          if (!named) {
            throw new Error(
              `leak check: unknown topology "${spec}". Known: ` +
                `${Object.keys(CLI_TOPOLOGIES).sort().join(", ")}. A parameterised ` +
                `generator has no name here — pass the generator itself.`
            );
          }
          return ({ playerCount }) => named(playerCount);
        })()
      : spec;
  const topologyName = typeof spec === "string" ? spec : spec.name || "custom";

  // Kept as a pre-boot refusal because it is the only one that costs nothing, and
  // `n >= 4` is conservative rather than derived: `star(3)` is in fact checkable.
  // The graph-derived rule is `accountVacuity`, which runs below once the shape is
  // realised and catches everything this cannot — a complete graph at any n, a
  // wheel of 4, an empty graph.
  if (n < 4) {
    throw new Error(
      `leak check needs n >= 4: below that every shipped topology makes every ` +
        `participant everyone's neighbour, so there is no non-neighbour to leak ` +
        `and the check is vacuous`
    );
  }

  resetChannels();

  /** playerID -> sentinel. Server-side only; never written to any scope. */
  const sentinels = new Map<string, string>();
  const sentinelFor = (playerID: string) => {
    let s = sentinels.get(playerID);
    if (!s) {
      s = `NBHDSENTINEL${randomUUID().replace(/-/g, "")}`;
      sentinels.set(playerID, s);
    }
    return s;
  };

  let gameRef: any;
  let edges: Edge[] = [];
  /**
   * A generator that throws does so inside the SERVER'S game-start listener, where
   * nothing here can see it. The visible symptom is a 30-second timeout on
   * "participants assigned to a game", because `waitFor` swallows a throwing
   * predicate by design (`src/shared/wait.ts`). Captured here and re-surfaced on
   * that timeout, so `pairs` at an odd n reports what is wrong with it instead of
   * looking like a dead server.
   */
  let topologyError: unknown;
  /** Times the topology was built. More than once means a realisation was replaced. */
  let builds = 0;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    withNetwork(_, {
      topology: (args) => {
        builds++;
        try {
          edges = build(args);
        } catch (e) {
          topologyError = e;
          throw e;
        }
        return edges;
      },
      project: (neighbour: any) => ({
        id: neighbour.id,
        // The sentinel reaches a client ONLY through this projection.
        secret: sentinelFor(neighbour.id),
      }),
    });
  };

  const failures: string[] = [];
  const notes: string[] = [];
  let crossParticipantLeaks = 0;
  let delivered = 0;
  let expectedDeliveries = 0;
  let controlLeaks = 0;
  /** Filled from `accountVacuity` once the graph is realised. */
  let candidatePairs = 0;
  let saturated = 0;
  let isolated = 0;

  await withScenario(
    {
      n,
      kinds: networkKinds,
      listeners,
      modeFunc: EmpiricaNetwork,
      /**
       * Replay every frame since connect, rather than only those arriving after
       * the subscription below.
       *
       * `withScenario`'s own docstring asks for this from "every leak test that
       * looks for a key-shaped absence, because its non-vacuity control has to be
       * present too", and `docs/TESTING.md` §3 says the same. This file was the
       * one that did not, and the omission was a latent spurious FAILURE rather
       * than a missed leak: without it `wireStream()` is a plain `share()`, so
       * the subscription opened below sees nothing published before that line. If
       * the first publish wins the race, arm 3 reads `delivered: 0` and the run
       * fails for a reason that has nothing to do with the guarantee.
       *
       * The race was never impossible and got tighter as this file grew: a
       * sparser graph is less publish work per participant, so a star or a
       * disconnected graph closes the window further than the ring it was
       * written against.
       *
       * It also makes every arm strictly stronger, which is the part worth being
       * explicit about, because "retain more frames" could be read as a
       * loosening. Arm 1 scans MORE wire for non-neighbour sentinels, so a leak
       * that happened before the subscription is now caught rather than missed;
       * arms 2 and 3 gain the same history. No arm is weakened by it.
       *
       * The cost `recordWire` is off by default for — a buffer held for the
       * participant's lifetime, which would corrupt `soak`'s RSS measurement —
       * does not apply here: four participants for a few seconds.
       */
      recordWire: true,
    },
    async ({ admin, participants }) => {
      say(`connected ${participants.length} participants`);
      const batch = await createBatch(admin, batchConfig(n, 1));
      await batch.running();

      try {
        await waitFor(
          () => participants.every((p: any) => p.mode.player.getValue()?.get("gameID")),
          { label: "participants assigned to a game", timeoutMs: opts.timeoutMs }
        );
      } catch (e) {
        // A game that never starts is usually a dead server. When the topology
        // threw, it is not — and that is the message worth having.
        if (topologyError !== undefined) {
          throw new Error(
            `the topology could not be built, so no game ever started: ` +
              `${topologyError instanceof Error ? topologyError.message : String(topologyError)}`
          );
        }
        throw e;
      }

      // Control values go on the PLAYER scope, which Classic cross-links to
      // every participant. These MUST leak.
      const controls = new Map<string, string>();
      for (const p of participants as any[]) {
        const player = p.mode.player.getValue()!;
        const control = `CTRLSENTINEL${randomUUID().replace(/-/g, "")}`;
        controls.set(player.id, control);
        player.set("controlValue", control);
        player.set("introDone", true);
      }

      await waitFor(() => participants.every((p: any) => Boolean(p.mode.game.getValue())), {
        label: "game visible",
        timeoutMs: opts.timeoutMs,
      });

      // Subscribed here for tidiness rather than for correctness: `recordWire`
      // above replays from connect, so an observer may subscribe whenever it
      // likes and the ordering hazard this line used to guard against is gone.
      const wires = participants.map((p) => {
        const frames: string[] = [];
        p.wireStream().subscribe({
          next: (msg: unknown) => {
            try {
              frames.push(JSON.stringify(msg));
            } catch {
              /* unserialisable frame */
            }
          },
        });
        return frames;
      });

      say("waiting for projections to be published");
      // `published`, NOT `neighbors.length > 0`. The mode draws that distinction
      // for exactly this reason (`src/player/mode.ts`): `neighbors` returns `[]`
      // both for "not published yet" and for "genuinely has no neighbours", and an
      // isolated participant is a legitimate result — `erdosRenyi` below its
      // percolation threshold produces one, and `empty()` is a control condition.
      // Waiting on a non-empty list would hang until the timeout on any
      // disconnected graph and then report a dead server.
      await waitFor(
        () => participants.every((p: any) => p.mode.nbhd.getValue()?.published),
        { label: "every participant's channel published", timeoutMs: opts.timeoutMs ?? 30_000 }
      );
      // Let any straggler frames land before judging absence.
      await new Promise((r) => setTimeout(r, 1500));

      const playerIDs: string[] = gameRef.players.map((p: any) => p.id);
      const adj = adjacency(playerIDs.length, edges);

      // What this graph lets the run establish, decided once and from the graph
      // itself rather than from `n`. Saturated and isolated participants are
      // counted and excused; a run where NO participant had a non-neighbour, or
      // where nothing was expected to arrive, is a failure.
      const account = accountVacuity(playerIDs.length, edges);
      failures.push(...account.failures);
      notes.push(...account.notes);
      expectedDeliveries = account.expectedDeliveries;
      candidatePairs = account.candidatePairs;
      saturated = account.saturated.length;
      isolated = account.isolated.length;
      if (builds !== 1) {
        notes.push(`the topology was built ${builds} times, so a realisation was replaced mid-run`);
      }

      for (const [i, p] of participants.entries()) {
        const mode = p.mode as any;
        const playerID = mode.player.getValue()!.id as string;
        const idx = playerIDs.indexOf(playerID);
        const wire = wires[i]!.join("\n");

        const neighbourIDs = (adj[idx] ?? []).map((j) => playerIDs[j]!);
        const nonNeighbourIDs = playerIDs.filter(
          (id) => id !== playerID && !neighbourIDs.includes(id)
        );

        // ARM 1 — candidate: no non-neighbour sentinel may appear.
        for (const otherID of nonNeighbourIDs) {
          const secret = sentinels.get(otherID);
          if (secret && wire.includes(secret)) {
            crossParticipantLeaks++;
            failures.push(
              `LEAK: participant ${i} received the sentinel of non-neighbour ${otherID}`
            );
          }
        }

        // ARM 3 — non-vacuity: neighbour sentinels must actually arrive. The
        // denominator comes from `account`, not from counting here, so the figure
        // the run is judged against is the one computed from the graph.
        for (const neighbourID of neighbourIDs) {
          const secret = sentinels.get(neighbourID);
          if (secret && wire.includes(secret)) delivered++;
        }

        // ARM 2 — control: player-scope values must be visible across participants.
        for (const [otherPlayerID, control] of controls) {
          if (otherPlayerID !== playerID && wire.includes(control)) controlLeaks++;
        }
      }

      if (delivered < expectedDeliveries) {
        failures.push(
          `NON-VACUITY FAILED: only ${delivered}/${expectedDeliveries} neighbour sentinels ` +
            `arrived. A clean result means nothing if the projection did not run.`
        );
      }
      if (controlLeaks === 0) {
        failures.push(
          `CONTROL FAILED: no player-scope value crossed between participants, so this ` +
            `check cannot detect a leak at all. Treat the candidate result as unproven.`
        );
      }
      // Degree range rather than node 0's degree, which was only ever
      // representative on a regular graph and silently wrong on a star.
      const degs = adj.map((a) => a.length);
      notes.push(
        `${topologyName} of ${n}: degree ${Math.min(...degs)}-${Math.max(...degs)}, ` +
          `${account.candidatePairs} non-neighbour pairs examined`
      );
    }
  );

  return {
    pass: failures.length === 0,
    n,
    topology: topologyName,
    crossParticipantLeaks,
    delivered,
    expectedDeliveries,
    controlLeaks,
    candidatePairs,
    saturated,
    isolated,
    failures,
    notes,
  };
}

export function formatLeakResult(r: LeakCheckResult): string {
  const lines = [
    "",
    `  empirica-networks verify — neighbour-limited visibility`,
    `  topology: ${r.topology} of ${r.n}`,
    "",
    // Every arm is printed as a figure against what it was measured over. Arm 1
    // used to print a bare `0`, which reads identically whether six non-neighbour
    // pairs were examined and none leaked or the graph was complete and none
    // existed — the second being a check that proves nothing while announcing a
    // PASS. The denominator is what makes the line falsifiable.
    `  non-neighbour sentinels received : ${r.crossParticipantLeaks}/${r.candidatePairs} pairs  (must be 0)`,
    `  neighbour sentinels delivered    : ${r.delivered}/${r.expectedDeliveries}  (non-vacuity)`,
    `  control values observed          : ${r.controlLeaks}  (must be > 0, proves detection works)`,
    "",
  ];
  if (r.saturated > 0 || r.isolated > 0) {
    lines.push(
      `  not covered: ${r.saturated} adjacent to everyone, ${r.isolated} adjacent to nobody`,
      ""
    );
  }
  for (const note of r.notes) lines.push(`  note: ${note}`);
  for (const f of r.failures) lines.push(`  ✗ ${f}`);
  lines.push("", r.pass ? "  PASS" : "  FAIL", "");
  return lines.join("\n");
}
