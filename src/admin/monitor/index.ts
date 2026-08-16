/**
 * `monitor(handle)` — a live view of a running study's network.
 *
 * Registered in the researcher's own callbacks process, beside `withNetwork`:
 *
 * ```js
 * const net = withNetwork(Empirica, { topology, project, watch: ["color"] });
 * if (process.env.MONITOR) await monitor(net);   // prints a loopback URL
 * ```
 *
 * WHY IT LIVES IN THE CALLBACKS PROCESS, which is the whole design in one
 * paragraph. That process already holds everything the monitor draws — the
 * realised edge list, the seat order, the authoritative in-memory history log,
 * the materialised channel scopes, the publish counters. A standalone monitor
 * would fetch all of it back over the wire and would need an admin credential
 * to do so; and because there is NO write access control (ISSUES.md U1), an
 * admin credential is not "read access with a login", it is the ability to write
 * any attribute on any node including every participant's player scope. So the
 * monitor is not an Empirica client at all. It is a read-only window onto memory
 * one scope away, and `serveMonitor` is never given a token to leak.
 *
 * Full reasoning, including what this rules out structurally versus by
 * convention: MODULE-DESIGN §15.
 */
import type { NetworkHandle } from "../with_network.js";
import { serveMonitor, type MonitorOptions, type MonitorServer } from "./http.js";

export { serveMonitor } from "./http.js";
export type { MonitorOptions, MonitorServer, MonitorSource } from "./http.js";
export { layout } from "./layout.js";
export type { LayoutOptions, Point } from "./layout.js";
export { buildPayload, payloadChanged } from "./payload.js";
export type { BuildOptions, MonitorPayload } from "./payload.js";

export async function monitor(
  handle: NetworkHandle,
  opts: MonitorOptions = {},
): Promise<MonitorServer> {
  // Loud rather than empty. A handle from a build predating `inspect` would
  // otherwise serve a monitor that renders nothing, and "the graph is blank"
  // reads as a study problem rather than a version mismatch — the exact
  // confusion this package keeps designing against.
  if (typeof handle?.inspect !== "function" || typeof handle?.activeGames !== "function") {
    throw new Error(
      "empirica-networks: monitor() needs the handle returned by withNetwork(). " +
        "The value passed has no inspect()/activeGames(), so there is nothing to observe.",
    );
  }

  return serveMonitor(
    {
      // `serveMonitor` still takes ids. It is deliberately free of this package's
      // types, so a `{ id, startedAt }` payload shape would be a decision taken in
      // the wrong file. The newest-first ordering carries over, which is what the
      // game picker wanted from this list anyway.
      games: () => handle.activeGames().map((g) => g.id),
      inspect: (gameID: string) => handle.inspect(gameID),
      // Copied into a plain object rather than passed through: `serveMonitor`
      // takes no Empirica types at all, which is what lets it be tested — and
      // read — without any of this package's server half.
      stats: () => {
        const s = handle.stats();
        return {
          games: s.games,
          channels: s.channels,
          channelScopes: s.channelScopes,
          cachedViews: s.cachedViews,
        };
      },
    },
    opts,
  );
}
