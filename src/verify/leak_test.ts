import { randomUUID } from "node:crypto";
import { networkKinds } from "../admin/kinds.js";
import { resetChannels } from "../admin/provision.js";
import { withNetwork, type NetworkConfig } from "../admin/with_network.js";
import { EmpiricaNetwork } from "../player/mode.js";
import { adjacency, type Edge } from "../topology/index.js";
import { NBHD_KEYS } from "../shared/keys.js";
import { CLI_TOPOLOGIES, accountVacuity } from "./topologies.js";
import { batchConfig, createBatch, gameInit, waitFor, withScenario } from "../harness/harness.js";

/**
 * The leak check: does a participant ever receive a non-neighbor's state?
 *
 * This is the module's central claim, so the check is built to be hard to fool:
 *
 * 1. ASSERTED AT THE WIRE. It subscribes to the raw participant stream, below
 *    the mode and below React. A client-side filter would satisfy "the UI never
 *    showed it"; the claim being made is that the bytes never arrived.
 *
 * 2. SENTINEL VALUES. Each participant is assigned a high-entropy token held
 *    SERVER-SIDE ONLY and injected into projections. Nothing writes it to a
 *    scope, so if it appears on a non-neighbor's wire it got there through the
 *    projection path. Substring matching over raw frames also catches leaks via
 *    channels nobody thought to enumerate.
 *
 * 3. FIVE ARMS, ALL REQUIRED:
 *      candidate    - non-neighbor sentinels must NOT appear
 *      control      - a player-scope value MUST appear on everyone's wire,
 *                     proving the detector can see a leak at all
 *      non-vacuity  - neighbor sentinels MUST appear, proving the projection
 *                     actually ran rather than sending nothing
 *      containment  - every tie in the structure payload must join two people
 *                     the viewer can see, and must actually exist
 *      structure    - at radius 1.5 the ties between a participant's neighbors
 *                     must all arrive; at radius 1 NONE of them may, which is
 *                     the claim that keeps the default free
 *    A "pass" with a silent control, or with nothing delivered, is a FAILED run.
 *    Most privacy tests are wrong in exactly one of those two ways.
 *
 *    THE LAST TWO EXIST BECAUSE THE FIRST THREE CANNOT SEE STRUCTURE. A sentinel
 *    is somebody's attribute; the bytes radius 1.5 adds are integers. A payload
 *    naming ties to strangers, or naming ties that do not exist, carries no
 *    sentinel at all, so arms 1-3 stay perfectly clean while the participant is
 *    shown a network nobody is in. They are read from the RAW wire rather than
 *    through `networkGraphOf`, which drops out-of-range edges by design and
 *    would make the containment arm assert nothing.
 *
 * WHICH TOPOLOGY, AND WHAT IT COSTS THE CHECK. Any graph can be checked, either by
 * name or by handing over the same generator function a study gives `withNetwork`
 * — the point being to verify the graph the study actually runs rather than a
 * stand-in for it. But the shape decides what the run can establish, and that is
 * a property of the REALIZED GRAPH rather than of `n`:
 *
 *   - A participant adjacent to everybody (a star's hub, every node of a complete
 *     graph) has no non-neighbor, so arm 1 examines nothing for them.
 *   - A participant adjacent to nobody (`empty()`, or a random generator below its
 *     percolation threshold) receives no neighbor sentinel, so arm 3 expects
 *     nothing from them.
 *
 * Neither is a fault — both are legitimate shapes — so they are counted and
 * reported rather than failed. What IS a failure is a run where NO participant had
 * a non-neighbor, or where nothing was expected to arrive at all: that is a
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
  /**
   * The radius the study under check runs at. Defaults to 1.
   *
   * At 1 the structural arms assert an ABSENCE — that no structure is on the
   * wire at all — which is the claim that keeps the default free. At 1.5 they
   * assert the structure that IS sent is contained and complete.
   */
  radius?: 1 | 1.5;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface LeakCheckResult {
  pass: boolean;
  n: number;
  topology: string;
  /** Non-neighbor sentinels seen. Must be 0. */
  crossParticipantLeaks: number;
  /** Neighbor sentinels seen vs expected. Guards against a vacuous pass. */
  delivered: number;
  expectedDeliveries: number;
  /** Player-scope control values observed across participants. Must be > 0. */
  controlLeaks: number;
  /**
   * Non-neighbor pairs arm 1 actually examined — the DENOMINATOR under
   * `crossParticipantLeaks`.
   *
   * Without it, "0 non-neighbor sentinels received" is unfalsifiable: it reads
   * identically whether six pairs were checked and none leaked, or the graph was
   * complete and nothing was checked at all. A numerator printed without its
   * denominator is the same class of mistake as the `--topology` flag that was
   * reported as honored while being ignored.
   */
  candidatePairs: number;
  /** Participants adjacent to everyone, who arm 1 cannot speak to. */
  saturated: number;
  /** Participants adjacent to nobody, who arm 3 expects nothing from. */
  isolated: number;
  /** The radius this run was made at. */
  radius: number;
  /**
   * Ties delivered that join two people the viewer cannot both see, or that do
   * not exist. Must be 0. The denominator is `structureTies`.
   */
  structureViolations: number;
  /** Ties delivered in the structure payloads, across participants. */
  structureTies: number;
  /**
   * Delivered ties NOT incident to the viewer, against what the graph says to
   * expect. This is the pair that makes a radius 1.5 run mean something: equal
   * and non-zero is the only passing answer.
   */
  beyondStarDelivered: number;
  expectedBeyondStar: number;
  /**
   * Structure payloads seen at radius 1, which must be zero.
   *
   * The default's whole claim is that it costs nothing, and an absence is only
   * worth asserting where its presence is also demonstrable — which the radius
   * 1.5 run does.
   */
  structureFramesAtRadius1: number;
  failures: string[];
  notes: string[];
}

/**
 * Every structure payload that reached one participant, oldest first, RAW.
 *
 * Deliberately parsed off the wire rather than read through
 * `networkGraphOf`, and that is not a stylistic preference: the client-side
 * reader DROPS edges that name a node outside the delivered neighborhood, which
 * is right for a renderer and would make the containment arm below assert
 * nothing at all. The claim is about the bytes the server sent.
 */
function structureFrames(frames: string[]): unknown[] {
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

export async function runLeakCheck(opts: LeakCheckOptions = {}): Promise<LeakCheckResult> {
  const n = opts.n ?? 4;
  const radius = opts.radius ?? 1;
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
  // realized and catches everything this cannot — a complete graph at any n, a
  // wheel of 4, an empty graph.
  if (n < 4) {
    throw new Error(
      `leak check needs n >= 4: below that every shipped topology makes every ` +
        `participant everyone's neighbor, so there is no non-neighbor to leak ` +
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
  /** Times the topology was built. More than once means a realization was replaced. */
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
      project: (neighbor: any) => ({
        id: neighbor.id,
        // The sentinel reaches a client ONLY through this projection.
        secret: sentinelFor(neighbor.id),
      }),
      graph: { radius },
    });
  };

  const failures: string[] = [];
  const notes: string[] = [];
  let crossParticipantLeaks = 0;
  let delivered = 0;
  let expectedDeliveries = 0;
  let controlLeaks = 0;
  /** Filled from `accountVacuity` once the graph is realized. */
  let candidatePairs = 0;
  let saturated = 0;
  let isolated = 0;
  let structureViolations = 0;
  let structureTies = 0;
  let beyondStarDelivered = 0;
  let expectedBeyondStar = 0;
  let structureFramesAtRadius1 = 0;

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
       * loosening. Arm 1 scans MORE wire for non-neighbor sentinels, so a leak
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
      // both for "not published yet" and for "genuinely has no neighbors", and an
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
      // counted and excused; a run where NO participant had a non-neighbor, or
      // where nothing was expected to arrive, is a failure.
      const account = accountVacuity(playerIDs.length, edges, radius);
      failures.push(...account.failures);
      notes.push(...account.notes);
      expectedDeliveries = account.expectedDeliveries;
      expectedBeyondStar = account.expectedBeyondStar;
      candidatePairs = account.candidatePairs;
      saturated = account.saturated.length;
      isolated = account.isolated.length;
      if (builds !== 1) {
        notes.push(`the topology was built ${builds} times, so a realization was replaced mid-run`);
      }

      for (const [i, p] of participants.entries()) {
        const mode = p.mode as any;
        const playerID = mode.player.getValue()!.id as string;
        const idx = playerIDs.indexOf(playerID);
        const wire = wires[i]!.join("\n");

        const neighborIDs = (adj[idx] ?? []).map((j) => playerIDs[j]!);
        const nonNeighborIDs = playerIDs.filter(
          (id) => id !== playerID && !neighborIDs.includes(id)
        );

        // ARM 1 — candidate: no non-neighbor sentinel may appear.
        for (const otherID of nonNeighborIDs) {
          const secret = sentinels.get(otherID);
          if (secret && wire.includes(secret)) {
            crossParticipantLeaks++;
            failures.push(
              `LEAK: participant ${i} received the sentinel of non-neighbor ${otherID}`
            );
          }
        }

        // ARM 3 — non-vacuity: neighbor sentinels must actually arrive. The
        // denominator comes from `account`, not from counting here, so the figure
        // the run is judged against is the one computed from the graph.
        for (const neighborID of neighborIDs) {
          const secret = sentinels.get(neighborID);
          if (secret && wire.includes(secret)) delivered++;
        }

        // ARM 2 — control: player-scope values must be visible across participants.
        for (const [otherPlayerID, control] of controls) {
          if (otherPlayerID !== playerID && wire.includes(control)) controlLeaks++;
        }

        // ARMS 4 and 5 — the structure, which the sentinel arms cannot see.
        //
        // Nothing above would notice if radius 1.5 were wrong in any way: the
        // extra bytes are integers, not anybody's attribute, so a payload full
        // of ties to strangers carries no sentinel and arm 1 stays clean.
        const payloads = structureFrames(wires[i]!);

        if (radius === 1) {
          // The default's whole claim is that it costs nothing.
          structureFramesAtRadius1 += payloads.length;
          continue;
        }

        const latest = payloads[payloads.length - 1] as
          | { edges?: unknown; positions?: unknown }
          | undefined;
        if (!latest || !Array.isArray(latest.edges)) {
          failures.push(
            `STRUCTURE MISSING: participant ${i} received no usable structure at radius ` +
              `1.5, so nothing about them can be checked`
          );
          continue;
        }

        // Local 0 is the viewer; 1..d are the neighbor views IN ORDER. Resolving
        // through the delivered list is the whole identity scheme, and an index
        // it cannot resolve is a violation rather than something to skip.
        const localToPlayer = [playerID, ...(mode.nbhd.getValue()?.neighbors ?? []).map(
          (v: any) => v?.id as string | undefined
        )];

        for (const edge of latest.edges as unknown[]) {
          structureTies++;
          if (!Array.isArray(edge) || edge.length !== 2) {
            structureViolations++;
            failures.push(`STRUCTURE: participant ${i} received a malformed tie`);
            continue;
          }
          const [a, b] = edge as [number, number];
          const x = localToPlayer[a];
          const y = localToPlayer[b];
          if (!x || !y || a === b) {
            structureViolations++;
            failures.push(
              `STRUCTURE LEAK: participant ${i} received a tie naming local index ` +
                `${a}/${b}, which is outside the neighborhood they were sent`
            );
            continue;
          }
          // The tie must be real. A drawn tie that does not exist is not a leak,
          // it is a fabrication, and it fails this tool for the same reason.
          const xi = playerIDs.indexOf(x);
          const yi = playerIDs.indexOf(y);
          if (xi === -1 || yi === -1 || !(adj[xi] ?? []).includes(yi)) {
            structureViolations++;
            failures.push(
              `STRUCTURE: participant ${i} was told ${x} and ${y} are connected, and ` +
                `they are not`
            );
            continue;
          }
          if (a !== 0 && b !== 0) beyondStarDelivered++;
        }
      }

      if (delivered < expectedDeliveries) {
        failures.push(
          `NON-VACUITY FAILED: only ${delivered}/${expectedDeliveries} neighbor sentinels ` +
            `arrived. A clean result means nothing if the projection did not run.`
        );
      }
      if (controlLeaks === 0) {
        failures.push(
          `CONTROL FAILED: no player-scope value crossed between participants, so this ` +
            `check cannot detect a leak at all. Treat the candidate result as unproven.`
        );
      }
      if (radius === 1 && structureFramesAtRadius1 > 0) {
        failures.push(
          `DEFAULT NOT FREE: ${structureFramesAtRadius1} structure payload(s) were sent at ` +
            `radius 1, where the client draws a star from the neighbor views alone. Every ` +
            `study using the default is paying for a feature it did not ask for.`
        );
      }
      if (radius > 1 && beyondStarDelivered !== expectedBeyondStar) {
        // Both directions are failures and they mean opposite things: short is a
        // participant not being shown something the design says they see; over
        // is a tie delivered that the graph does not contain, which arm 4 has
        // already named individually.
        failures.push(
          `STRUCTURE INCOMPLETE: ${beyondStarDelivered}/${expectedBeyondStar} ties between ` +
            `neighbors were delivered. ` +
            (beyondStarDelivered < expectedBeyondStar
              ? `Participants are being shown less than radius 1.5 promises.`
              : `More arrived than the graph contains.`)
        );
      }
      // Degree range rather than node 0's degree, which was only ever
      // representative on a regular graph and silently wrong on a star.
      const degs = adj.map((a) => a.length);
      notes.push(
        `${topologyName} of ${n}: degree ${Math.min(...degs)}-${Math.max(...degs)}, ` +
          `${account.candidatePairs} non-neighbor pairs examined`
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
    radius,
    structureViolations,
    structureTies,
    beyondStarDelivered,
    expectedBeyondStar,
    structureFramesAtRadius1,
    failures,
    notes,
  };
}

export function formatLeakResult(r: LeakCheckResult): string {
  const lines = [
    "",
    `  empirica-networks verify — neighbor-limited visibility`,
    `  topology: ${r.topology} of ${r.n}   ·   radius: ${r.radius}`,
    "",
    // Every arm is printed as a figure against what it was measured over. Arm 1
    // used to print a bare `0`, which reads identically whether six non-neighbor
    // pairs were examined and none leaked or the graph was complete and none
    // existed — the second being a check that proves nothing while announcing a
    // PASS. The denominator is what makes the line falsifiable.
    `  non-neighbor sentinels received : ${r.crossParticipantLeaks}/${r.candidatePairs} pairs  (must be 0)`,
    `  neighbor sentinels delivered    : ${r.delivered}/${r.expectedDeliveries}  (non-vacuity)`,
    `  control values observed          : ${r.controlLeaks}  (must be > 0, proves detection works)`,
  ];

  // The structural arms, which the three above cannot see: the extra bytes at
  // radius 1.5 are integers rather than anybody's attribute, so a sentinel
  // check stays clean however wrong they are.
  if (r.radius > 1) {
    lines.push(
      `  ties outside the neighborhood  : ${r.structureViolations}/${r.structureTies} ties  (must be 0)`,
      `  ties between neighbors shown   : ${r.beyondStarDelivered}/${r.expectedBeyondStar}  (non-vacuity)`
    );
  } else {
    lines.push(
      `  structure payloads sent        : ${r.structureFramesAtRadius1}  (must be 0 at radius 1)`
    );
  }
  lines.push("");
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
