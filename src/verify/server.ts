/**
 * Tajriba server control for the test harness.
 *
 * We deliberately do NOT use `withTajriba` from @empirica/core/admin/classic,
 * despite it being public. Two independent reasons, both verified 2026-08-14:
 *
 * 1. It is unusable from the shipped ESM build. It pulls in `tmp`, which does
 *    `require("fs")`; tsup inlined that behind its `__require` shim, which
 *    throws "Dynamic require of \"fs\" is not supported" under ESM. Reproduced
 *    with @empirica/core@1.12.5 under both node and tsx.
 * 2. Its port autodetection parses "Started Tajriba server" out of stderr, and
 *    that line is only emitted at `trace` level. So quiet logging and port
 *    autodetection are mutually exclusive — and at n*d attributes per tick,
 *    trace logging dominates CPU and turns any measurement into a benchmark of
 *    Tajriba's logger.
 *
 * Binding an explicit port and polling the GraphQL endpoint for readiness
 * sidesteps both. Costs ~60 lines and removes a fragile dependency.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface ServerOptions {
  /** Persist to a file instead of memory. Needed to test persistence effects. */
  storeFile?: string;
  /**
   * Bind a specific port instead of picking a free one.
   *
   * Only needed to restart a server in place: participants and admin reconnect
   * by URL, so a restart that moved port would be a different server wearing the
   * same name, and would not test what a real restart does.
   */
  port?: number;
  /** Default "error". Raise only when debugging. */
  logLevel?: string;
  /** Path to the empirica CLI. Default: "empirica" from PATH. */
  binary?: string;
  readyTimeoutMs?: number;
}

export interface Server {
  url: string;
  port: number;
  srtoken: string;
  proc: ChildProcess;
  stop: () => void;
}

const SRTOKEN = "0123456789123456";

/** `empirica tajriba` expects the [tajriba.*]-prefixed config form. */
const CONFIG = `[tajriba.auth]
srtoken = "${SRTOKEN}"

[[tajriba.auth.users]]
name = "Verify"
username = "username"
password = "password"
`;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("could not determine a free port"));
      }
    });
  });
}

export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const logLevel = opts.logLevel ?? "error";
  const binary = opts.binary ?? "empirica";
  const port = opts.port ?? (await freePort());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empirica-networks-"));
  const configFile = path.join(dir, "tajriba.toml");
  fs.writeFileSync(configFile, CONFIG);

  const args = [
    "tajriba",
    "--config", configFile,
    "--log.level", logLevel,
    "--log.json",
    "--tajriba.log.level", logLevel,
    "--tajriba.log.json",
    "--tajriba.server.addr", `:${port}`,
  ];
  args.push(...(opts.storeFile ? ["--tajriba.store.file", opts.storeFile] : ["--tajriba.store.mem"]));

  /**
   * stderr goes to a FILE, not a pipe.
   *
   * Piped stdio leaks handles that cannot be released. Measured on Node 20 with
   * a bare `spawn("sleep")` — no Empirica involved — `{PipeWrap: 4}` after spawn
   * and `{PipeWrap: 2}` still held after removeAllListeners + unref + destroy +
   * SIGKILL. Those two handles keep the event loop alive forever, which is what
   * made the test suite pass and then hang.
   *
   * A file descriptor has no such problem, and we lose nothing: stderr is only
   * ever read for startup diagnostics, which we can slurp from the file on
   * failure.
   */
  const logFile = path.join(dir, "tajriba.log");
  const logFd = fs.openSync(logFile, "a");
  const readLog = () => {
    try {
      return fs.readFileSync(logFile, "utf8");
    } catch {
      return "(no log captured)";
    }
  };

  const proc = spawn(binary, args, { stdio: ["ignore", logFd, logFd] });

  let spawnError: Error | undefined;
  proc.on("error", (e) => {
    spawnError = e;
  });

  // Without this the parent's event loop stays alive after the tests pass.
  proc.unref();

  const url = `http://localhost:${port}/query`;
  const stop = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  for (;;) {
    if (spawnError) {
      stop();
      throw new Error(
        `could not spawn "${binary}": ${spawnError.message}. ` +
          `Install the Empirica CLI: curl https://install.empirica.dev | sh`
      );
    }
    if (proc.exitCode !== null) {
      const log = readLog();
      stop();
      throw new Error(`tajriba exited early (code ${proc.exitCode}):\n${log}`);
    }
    if (Date.now() > deadline) {
      const log = readLog();
      stop();
      throw new Error(`tajriba did not become ready in time:\n${log}`);
    }
    if (await probe(port)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return { url, port, srtoken: SRTOKEN, proc, stop };
}

/**
 * One-shot readiness probe.
 *
 * Deliberately node:http with `agent: false` rather than global fetch. undici's
 * global dispatcher pools connections and arms keep-alive timers that outlive
 * the request, which showed up as a permanent {PipeWrap: 2, Timeout: 2} in
 * process.getActiveResourcesInfo() long after every server and socket was shut
 * down — i.e. the harness appeared to leak when the leak was the health check.
 */
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: "{__typename}" });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/query",
        method: "POST",
        agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      }
    );
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

/** Scope a server to a function, stopping it afterwards. */
export async function withServer<T>(
  fn: (server: Server) => Promise<T>,
  opts: ServerOptions = {}
): Promise<T> {
  const server = await startServer(opts);
  try {
    return await fn(server);
  } finally {
    server.stop();
  }
}
