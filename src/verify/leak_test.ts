import { randomUUID } from "node:crypto";
import { networkKinds } from "../admin/kinds.js";
import { resetChannels } from "../admin/provision.js";
import { withNetwork } from "../admin/with_network.js";
import { EmpiricaNetwork } from "../player/mode.js";
import { ring, adjacency, type Edge } from "../topology/index.js";
import { batchConfig, createBatch, gameInit, waitFor, withScenario } from "./harness.js";

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
 * A ring of 4 is the smallest topology where every participant has both a
 * neighbour and a non-neighbour, which is what makes arm 1 meaningful.
 */

export interface LeakCheckOptions {
  n?: number;
  /** Only "ring" for now; more topologies land with the M2 generator port. */
  topology?: "ring";
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
  failures: string[];
  notes: string[];
}

export async function runLeakCheck(opts: LeakCheckOptions = {}): Promise<LeakCheckResult> {
  const n = opts.n ?? 4;
  const topologyName = opts.topology ?? "ring";
  const say = opts.onProgress ?? (() => {});

  if (n < 4) {
    throw new Error(
      `leak check needs n >= 4: on a smaller ring every participant is a neighbour ` +
        `of every other, so there is no non-neighbour to leak and the check is vacuous`
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

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "start", (_ctx: any, { game }: any) => {
      if (game.get("start")) gameRef = game;
    });
    withNetwork(_, {
      topology: ({ playerCount }) => {
        edges = ring(playerCount);
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

  await withScenario(
    { n, kinds: networkKinds, listeners, modeFunc: EmpiricaNetwork },
    async ({ admin, participants }) => {
      say(`connected ${participants.length} participants`);
      const batch = await createBatch(admin, batchConfig(n, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p: any) => p.mode.player.getValue()?.get("gameID")),
        { label: "participants assigned to a game", timeoutMs: opts.timeoutMs }
      );

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

      // Record raw wires BEFORE the projection is published.
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
      await waitFor(
        () => participants.every((p: any) => (p.mode.nbhd.getValue()?.neighbors ?? []).length > 0),
        { label: "every participant received a neighbourhood", timeoutMs: opts.timeoutMs ?? 30_000 }
      );
      // Let any straggler frames land before judging absence.
      await new Promise((r) => setTimeout(r, 1500));

      const playerIDs: string[] = gameRef.players.map((p: any) => p.id);
      const adj = adjacency(playerIDs.length, edges);

      for (const [i, p] of participants.entries()) {
        const mode = p.mode as any;
        const playerID = mode.player.getValue()!.id as string;
        const idx = playerIDs.indexOf(playerID);
        const wire = wires[i]!.join("\n");

        const neighbourIDs = (adj[idx] ?? []).map((j) => playerIDs[j]!);
        const nonNeighbourIDs = playerIDs.filter(
          (id) => id !== playerID && !neighbourIDs.includes(id)
        );

        if (nonNeighbourIDs.length === 0) {
          failures.push(`participant ${i} has no non-neighbour — the check would be vacuous`);
        }

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

        // ARM 3 — non-vacuity: neighbour sentinels must actually arrive.
        for (const neighbourID of neighbourIDs) {
          expectedDeliveries++;
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
      notes.push(`ring of ${n}: each participant has ${adj[0]?.length ?? 0} neighbours`);
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
    `  non-neighbour sentinels received : ${r.crossParticipantLeaks}  (must be 0)`,
    `  neighbour sentinels delivered    : ${r.delivered}/${r.expectedDeliveries}  (non-vacuity)`,
    `  control values observed          : ${r.controlLeaks}  (must be > 0, proves detection works)`,
    "",
  ];
  for (const note of r.notes) lines.push(`  note: ${note}`);
  for (const f of r.failures) lines.push(`  ✗ ${f}`);
  lines.push("", r.pass ? "  PASS" : "  FAIL", "");
  return lines.join("\n");
}
