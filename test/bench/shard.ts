/**
 * One bench shard: a process that hosts a slice of the participants.
 *
 * Why a separate process at all. The bench's standing caveat was that every
 * participant ran in the SAME Node process as the server callbacks and the admin
 * connection, all sharing one event loop — which real participants in separate
 * browsers do not. At n=100 that meant 100 mode instances contending with the
 * thing being measured, so the tail described the harness. SPIKE-REPORT §5-6
 * asks for sharding before any number is published, and n >= 200 was unmeasured
 * for exactly this reason.
 *
 * Two things make cross-process measurement work without a clock protocol:
 *
 * 1. The send time travels INSIDE the value (`round:sentAt`), so a receipt is
 *    self-describing and no shard needs to be told what to time.
 * 2. `performance.timeOrigin + performance.now()` is an absolute high-resolution
 *    clock shared by every process on the host. The coordinator checks the
 *    agreement across shards rather than assuming it (see `clockRef`).
 *
 * Receipts are taken from the mode's own subscription, NOT by polling. Polling
 * at 25ms quantises every measurement to a 25ms bin: measured 2026-08-15, the
 * polled p50 at n=25 was 52.4ms against a true 33.3ms, with 49 of 55 samples
 * landing on the same bin edge. The tight distribution the README used to
 * highlight was the bin, not the transport.
 */
import { connectParticipant, waitFor, type Participant } from "../../src/harness/harness.js";
import { EmpiricaNetwork, type EmpiricaNetworkContext } from "../../src/player/mode.js";

const modeOf = (p: Participant<unknown>) => p.mode as EmpiricaNetworkContext;

/** Absolute ms, high resolution, comparable across processes on this host. */
export function absNow(): number {
  return performance.timeOrigin + performance.now();
}

export interface Sample {
  /** Round the value came from, so warmup rounds can be dropped centrally. */
  round: number;
  /** One-way delivery: writer's `set()` to this watcher's flush, in ms. */
  ms: number;
}

const url = process.env.BENCH_URL!;
const count = Number(process.env.BENCH_COUNT);
const index = Number(process.env.BENCH_INDEX);

const participants: Participant<unknown>[] = [];
const samples: Sample[] = [];

/** Last value seen per watcher per neighbor, so one delivery counts once. */
const seen = new Map<string, string>();

function send(msg: unknown): void {
  process.send!(msg);
}

function view(p: Participant<unknown>): { id: string; tick?: unknown }[] {
  return (modeOf(p).nbhd.getValue()?.neighbors ?? []) as { id: string; tick?: unknown }[];
}

/**
 * Record every newly-delivered tick this participant can see.
 *
 * Runs on the mode's flush, which is the moment a real client could first render
 * the value — the same boundary a React re-render would hang off.
 */
function harvest(p: Participant<unknown>, self: string): void {
  const at = absNow();
  for (const n of view(p)) {
    const tick = n.tick;
    if (typeof tick !== "string") continue;
    const key = `${self}>${n.id}`;
    if (seen.get(key) === tick) continue;
    seen.set(key, tick);
    const sep = tick.indexOf(":");
    if (sep < 0) continue;
    const round = Number(tick.slice(0, sep));
    const sentAt = Number(tick.slice(sep + 1));
    if (!Number.isFinite(round) || !Number.isFinite(sentAt)) continue;
    samples.push({ round, ms: at - sentAt });
  }
}

async function connect(): Promise<void> {
  for (let i = 0; i < count; i++) {
    participants.push(
      await connectParticipant({ url }, `bench-${index}-${i}`, EmpiricaNetwork)
    );
  }
  // `clockRef` lets the coordinator verify that timeOrigin really is comparable
  // across processes instead of taking it on faith. Reported, not asserted.
  send({ t: "ready", clockRef: Date.now() - absNow() });
}

async function play(): Promise<void> {
  await waitFor(
    () => participants.every((p) => modeOf(p).player.getValue()?.get("gameID")),
    { label: `shard ${index}: gameID assigned`, timeoutMs: 300_000 }
  );
  for (const p of participants) modeOf(p).player.getValue()!.set("introDone", true);
  await waitFor(() => participants.every((p) => modeOf(p).nbhd.getValue()?.published), {
    label: `shard ${index}: first publish`,
    timeoutMs: 300_000,
  });

  // Subscribe only once the first view exists, so channel materialisation does
  // not register as a delivery.
  for (const p of participants) {
    const self = modeOf(p).player.getValue()!.id;
    harvest(p, self);
    modeOf(p).nbhd.subscribe(() => harvest(p, self));
  }

  send({
    t: "playing",
    degrees: participants.map((p) => view(p).length),
  });
}

process.on("message", (msg: any) => {
  switch (msg?.t) {
    case "play":
      play().catch(fail);
      break;
    case "write": {
      const p = participants[msg.local]!;
      // Timestamp as late as possible: inside the value, immediately before the
      // set that carries it.
      modeOf(p).player.getValue()!.set("tick", `${msg.round}:${absNow()}`);
      break;
    }
    case "collect":
      send({ t: "samples", samples });
      break;
    case "bye":
      for (const p of participants) {
        try {
          p.stop();
        } catch {
          /* best effort */
        }
      }
      process.exit(0);
  }
});

function fail(e: unknown): void {
  send({ t: "failed", message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}

connect().catch(fail);
