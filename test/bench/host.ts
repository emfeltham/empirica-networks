/**
 * The client host: run the participants on a machine that is not the server's.
 *
 *   # on the client machine
 *   npm run bench -- --agent --port 7411
 *
 *   # on the server machine
 *   npm run bench -- --clients CLIENT-HOST:7411 --repeats 3
 *
 * WHY THIS EXISTS. `ISSUES.md` O1's remaining half asks for an absolute latency
 * figure, and its specification has two clauses. Fixed clocks is one
 * (`clocks.ts`); the other is hosting the clients off the server host, and until
 * this file there was no way to express it: `envelope.ts` forked its shards, so
 * "sharded" meant "more processes on the same machine". Every published number
 * therefore includes the participants competing with the server for the same
 * cores, and the bench's own caveat says so — the dominant term is participants
 * per PROCESS, and p50 at n=100 fell 43.1 -> 10.1 -> 8.0 ms purely by spreading
 * the harness thinner. That is a property of the harness, not of the package.
 *
 * WHY THE SPLIT DOES NOT BREAK THE MEASUREMENT, which is the thing to check
 * before believing any of it. The bench times a one-way delivery with no clock
 * protocol: the writer stamps `absNow()` inside the value and the recipient
 * subtracts it on flush (`shard.ts`). Across two machines that would be
 * nonsense — the difference would carry the unknown offset between two clocks,
 * and NTP on a LAN is worth about a millisecond against a quantity that is
 * often under ten. It survives here for a specific reason: **both endpoints of
 * every sample are participants**, and every participant is on THIS host. The
 * server is the only thing on the other machine and it never timestamps
 * anything. So the split moves the confound out and leaves the clock alone —
 * but only while all shards share one host, which is why this agent spawns them
 * all locally rather than letting the coordinator address several agents.
 *
 * The control channel is deliberately not on that path either. The coordinator
 * sends `{t:"write"}` and the shard stamps the value immediately before `set()`,
 * so a slow or jittery link delays a round without contaminating it.
 *
 * TRANSPORT. Newline-delimited JSON over one TCP connection, with every frame
 * tagged by shard index — the same messages `fork()` IPC carried, multiplexed.
 * One coordinator at a time: a second is refused rather than queued, because two
 * sweeps sharing a client host would measure each other.
 *
 * NOT HARDENED, and this is a deliberate limit. There is no authentication and
 * no encryption; the frames are trusted because the intended deployment is two
 * hosts on a private network for the duration of one sweep. Do not expose the
 * port to anything else.
 */
import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import { clockFacts, describeClocks } from "./clocks.js";
import { frames } from "./wire.js";

const argv = process.argv.slice(2);
const flag = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};

const PORT = flag("port", 7411);
const SHARD_ENTRY = process.env.BENCH_SHARD;

function main(): void {
  if (!SHARD_ENTRY) {
    console.error("BENCH_SHARD is not set — run this through `npm run bench -- --agent`");
    process.exit(1);
  }
  const facts = clockFacts();
  let busy = false;

  const server = net.createServer((sock) => {
    if (busy) {
      // Refused with a reason on the wire, so the coordinator can say which
      // machine turned it away rather than reporting a bare ECONNRESET.
      sock.end(JSON.stringify({ t: "busy" }) + "\n");
      return;
    }
    busy = true;
    sock.setNoDelay(true);
    const shards = new Map<number, ChildProcess>();
    const write = (v: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(v) + "\n");
    };

    console.log(`  coordinator connected from ${sock.remoteAddress}`);
    write({ t: "hello", facts });

    sock.on(
      "data",
      frames((f) => {
        if (f?.t === "kill") {
          const proc = shards.get(f.i);
          if (proc) {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* already gone */
            }
            shards.delete(f.i);
          }
          return;
        }
        if (f?.t === "spawn") {
          // Defensive: a cell is torn down before the next one spawns, so an
          // index that is still occupied means the previous teardown was lost.
          // Reusing the slot silently would leave a participant connected to a
          // server that no longer exists, and it would rejoin the next cell.
          const stale = shards.get(f.i);
          if (stale) {
            try {
              stale.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
          const proc = fork(SHARD_ENTRY, [], {
            env: {
              ...process.env,
              BENCH_URL: f.url,
              BENCH_INDEX: String(f.i),
              BENCH_COUNT: String(f.count),
            },
            stdio: ["ignore", "inherit", "inherit", "ipc"],
          });
          // Same reason as the coordinator's own handler: `.send()` to a dead
          // channel raises an asynchronous `error` EVENT, and an unhandled one
          // is fatal. Here it would take the whole agent down mid-sweep.
          proc.on("error", () => {});
          proc.on("message", (m) => write({ i: f.i, m }));
          proc.on("exit", (code) => write({ i: f.i, exit: code }));
          shards.set(f.i, proc);
          return;
        }
        if (typeof f?.i === "number" && f.m !== undefined) {
          const proc = shards.get(f.i);
          if (proc && proc.exitCode === null) {
            try {
              proc.send(f.m);
            } catch {
              /* the exit frame is what reports this */
            }
          }
        }
      })
    );

    const done = () => {
      if (!busy) return;
      busy = false;
      // A coordinator that died mid-sweep must not leave participants holding
      // connections to a server that is also gone — that is the orphan failure mode
      // with the roles reversed, and it would poison the next sweep.
      for (const proc of shards.values()) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      shards.clear();
      console.log("  coordinator disconnected; shards killed\n");
    };
    sock.on("close", done);
    sock.on("error", done);
  });

  server.listen(PORT, () => {
    console.log("\n  empirica-networks — bench client host\n");
    console.log(`  ${describeClocks(facts)}`);
    console.log(`  listening on :${PORT} — waiting for a coordinator\n`);
    console.log(
      "  The server must be reachable from here, and this host must be\n" +
        "  reachable from it: the coordinator advertises an address for the\n" +
        "  participants to dial (`--advertise`), and it defaults to a guess.\n"
    );
  });
}

main();
