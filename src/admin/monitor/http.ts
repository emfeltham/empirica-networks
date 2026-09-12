/**
 * The monitor's HTTP surface.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE. This file serves the complete
 * network — every tie, every seat assignment, and every participant's private
 * state — which is precisely what the rest of the package exists to keep away
 * from the people inside the study. Three properties hold
 * it together, and two of them are structural:
 *
 *   1. NO EMPIRICA CREDENTIAL EVER REACHES THIS FILE. `serveMonitor` takes a
 *      snapshot function, not a connection and not an srtoken. There is no code
 *      path from here to `setAttribute`, so the worst a reachable endpoint can
 *      do is let somebody OBSERVE. That matters more than it sounds: with no
 *      (PLATFORM-NOTES §4a) there is no write access control at all, so an
 *      srtoken in a browser is a total write capability over every
 *      participant's data. This surface cannot become that by accident, because
 *      it never holds the token to begin with.
 *
 *   2. NOTHING HERE ENTERS EMPIRICA'S SCOPE GRAPH. The transport is plain
 *      HTTP/SSE on its own port. No participant's wire subscription can carry
 *      it, whatever a listener does — asserted against the raw wire in
 *      test/e2e/monitor.test.ts, the same way PLATFORM-NOTES §4c was measured.
 *
 *   3. Loopback bind plus a per-run bearer token. This one is CONVENTION, and
 *      is labeled as such in the design: an operator can override both, and a
 *      package cannot stop them. What it can do is make the safe thing the
 *      default and make the override say what it costs.
 *
 * The token goes in the query string as well as the `Authorization` header,
 * which is not laziness: `EventSource` cannot set request headers, so the SSE
 * stream has no other way to authenticate. Same pattern Jupyter uses, same
 * caveat — the URL carrying it should be treated as the secret it contains.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildPayload, payloadChanged, type MonitorPayload } from "./payload.js";
import type { GameSnapshot } from "../inspect.js";
import { PAGE } from "./ui.js";

export interface MonitorSource {
  /** Ids of games currently networked. */
  games(): string[];
  /** One game's state, or undefined if this process is not networking it. */
  inspect(gameID: string): GameSnapshot | undefined;
  /** Process-wide counts, for the operational panel. */
  stats(): Record<string, number>;
}

export interface MonitorOptions {
  /**
   * Port. Default 0, i.e. the OS picks a free one and `MonitorServer.url` tells
   * you which — so two studies on one machine do not collide by default.
   */
  port?: number;
  /**
   * Bind address. Defaults to `127.0.0.1`.
   *
   * Changing this publishes the complete graph to whatever can reach the
   * interface, and is logged loudly for that reason rather than refused: a
   * researcher running the study on a remote machine has a legitimate need, and
   * a package that forbade it would just be routed around.
   */
  host?: string;
  /**
   * Bearer token. Generated per run if absent, which is the intended use — a
   * fixed token in a config file outlives the study it was written for.
   */
  token?: string;
  /** How often to re-read state, ms. Default 500. */
  pollMs?: number;
  /** Where to print the URL. Defaults to `console.log`. Pass `() => {}` in tests. */
  log?: (message: string) => void;
}

export interface MonitorServer {
  /** Full URL including the token — this is what to open. */
  url: string;
  port: number;
  host: string;
  token: string;
  stop(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export async function serveMonitor(
  source: MonitorSource,
  opts: MonitorOptions = {},
): Promise<MonitorServer> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? crypto.randomBytes(24).toString("hex");
  const pollMs = opts.pollMs ?? 500;
  const log = opts.log ?? ((m: string) => console.log(m));

  /** gameID -> last payload sent, for warm start and change suppression. */
  const payloads = new Map<string, MonitorPayload>();
  /** Open SSE responses, by game. */
  const streams = new Map<string, Set<http.ServerResponse>>();
  /** Reported once per game, so a broken inspect() does not spam the study log. */
  const reportedErrors = new Set<string>();
  /** Games already announced as gone, so the announcement is made once. */
  const reportedGone = new Set<string>();

  function snapshotFor(gameID: string): MonitorPayload | undefined {
    let snapshot: GameSnapshot | undefined;
    try {
      snapshot = source.inspect(gameID);
    } catch (e) {
      // An observer must not be able to take the study down. Reported once and
      // then swallowed — but reported, because a monitor that silently showed
      // nothing would be indistinguishable from a study where nothing happened,
      // which is this package's characteristic failure.
      if (!reportedErrors.has(gameID)) {
        reportedErrors.add(gameID);
        console.error(
          `empirica-networks: monitor could not inspect game ${gameID}: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return undefined;
    }
    if (!snapshot) {
      payloads.delete(gameID);
      return undefined;
    }
    const next = buildPayload(snapshot, { previous: payloads.get(gameID) });
    payloads.set(gameID, next);
    return next;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    if (!authorised(req, url, token)) {
      // 401 with no hint about what a correct token looks like. The body is for
      // an operator who opened the bare URL, not for anything guessing.
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("empirica-networks monitor: missing or invalid token.\n");
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // The page holds the complete graph. Nothing about it should be cached
        // to disk by a browser that will outlive the study.
        "cache-control": "no-store",
        // No third-party anything is loaded, and saying so means an accidental
        // CDN import fails visibly rather than silently phoning out with a page
        // that contains the seating plan.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(PAGE);
      return;
    }

    if (url.pathname === "/api/games") {
      json(res, { games: source.games(), stats: source.stats() });
      return;
    }

    if (url.pathname === "/api/state") {
      const gameID = url.searchParams.get("game") ?? source.games()[0];
      if (!gameID) {
        json(res, { gone: true, reason: "no game is currently networked" });
        return;
      }
      const payload = snapshotFor(gameID);
      if (!payload) {
        // Explicitly gone, not an empty graph. A restart loses games
        // outright, and an empty picture would misreport that as a study where
        // nothing happened.
        json(res, { gone: true, gameID, reason: "this process is not networking that game" });
        return;
      }
      json(res, payload);
      return;
    }

    if (url.pathname === "/api/stream") {
      const gameID = url.searchParams.get("game") ?? source.games()[0];
      if (!gameID) {
        res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        res.end("no game is currently networked\n");
        return;
      }
      openStream(gameID, res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  function openStream(gameID: string, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Proxies that buffer will hold a monitor's frames indefinitely and the
      // symptom is "the graph stopped updating", which reads as our bug.
      "x-accel-buffering": "no",
    });
    const set = streams.get(gameID) ?? new Set();
    set.add(res);
    streams.set(gameID, set);

    const payload = snapshotFor(gameID);
    // Answer immediately either way. A stream that opens silently on a game
    // this process does not hold leaves the page waiting forever on a poll that
    // will never say anything new, which looks exactly like a quiet study.
    if (payload) send(res, "state", payload);
    else send(res, "gone", { gameID });

    res.on("close", () => {
      set.delete(res);
      if (set.size === 0) streams.delete(gameID);
    });
  }

  /**
   * Re-read state and push to anyone watching.
   *
   * POLLED, deliberately, rather than hooked into the publish path. Nothing in
   * `withNetwork`'s hot path calls into the monitor, so monitor latency cannot
   * become publish latency and a bug here cannot throw inside Empirica's
   * runloop. The cost is up to one interval of lag for a human watching a
   * graph, which is not a cost.
   */
  const timer = setInterval(() => {
    for (const [gameID, set] of streams) {
      if (set.size === 0) continue;
      const previous = payloads.get(gameID);
      const next = snapshotFor(gameID);
      if (!next) {
        // Once, not twice a second forever. A game that has ended stays ended,
        // and an SSE stream still firing at the poll rate after it is over is a
        // busy loop that also makes the browser look like it is still working.
        if (!reportedGone.has(gameID)) {
          reportedGone.add(gameID);
          for (const res of set) send(res, "gone", { gameID });
        }
        continue;
      }
      reportedGone.delete(gameID);
      if (!payloadChanged(previous, next)) continue;
      for (const res of set) send(res, "state", next);
    }
  }, pollMs);
  // The monitor must never be the reason a finished process stays alive. An
  // open browser tab still holds its own socket, so watching keeps it up;
  // nothing else does. PLATFORM-NOTES §13 is what happens when this is missed —
  // the hang gets diagnosed as somebody else's bug.
  timer.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();

  const port = (server.address() as AddressInfo).port;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}/?t=${token}`;

  if (!LOOPBACK.has(host)) {
    log(
      `\n  !! empirica-networks monitor is bound to ${host}, NOT loopback.\n` +
        `     It serves the COMPLETE network: every tie, every seat assignment,\n` +
        `     and every participant's private state. Anyone who can reach this\n` +
        `     address and holds the token can read all of it.\n` +
        `     The token is the only thing protecting it now.\n`,
    );
  }
  log(`  empirica-networks monitor: ${url}`);

  return {
    url,
    port,
    host,
    token,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        for (const set of streams.values()) {
          for (const res of set) {
            try {
              res.end();
            } catch {
              /* already gone */
            }
          }
        }
        streams.clear();
        server.close(() => resolve());
        // An SSE client holds its socket open forever by design, so close()
        // alone would never fire its callback. Node 18.2+ has this; guarded
        // because a missing method here would hang `stop()` rather than error.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Constant-time token check.
 *
 * Length is compared first and non-constant-time, which is fine: the token
 * length is fixed by us and printed in the URL, so it is not a secret. The
 * bytes are not.
 */
export function authorised(
  req: Pick<http.IncomingMessage, "headers">,
  url: URL,
  token: string,
): boolean {
  const header = req.headers?.authorization;
  const bearer = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : undefined;
  // Query parameter as well as header, because `EventSource` cannot set
  // headers — without it the SSE stream could not authenticate at all.
  const presented = bearer ?? url.searchParams.get("t") ?? "";
  if (presented.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function send(res: http.ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // A client that vanished mid-write is normal and not the study's problem.
  }
}
