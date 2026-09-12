/**
 * A TCP relay whose connections can be severed without a close handshake.
 *
 * `participant.stop()` is a POLITE disconnect: the websocket sends a close
 * frame, so both ends agree the session is over. A dropped wifi connection,
 * a laptop lid, or a NAT timeout is not polite — the socket simply stops, and
 * the server learns about it late, from a timeout, if at all.
 *
 * Those are different code paths, and the difference matters for this package:
 * views are ephemeral and republished on ParticipantConnect, so a reconnection
 * the server never realised was a reconnection is exactly the case where a
 * participant could come back to a blank neighbourhood.
 *
 * Reaching the underlying socket through `@empirica/tajriba` means depending on
 * its internals. Interposing a relay does not: point the participant at the
 * relay, then `destroy()` the sockets to produce a drop with no close frame.
 */
import net from "node:net";

export interface TcpCut {
  /** URL to hand to a participant instead of the real server's. */
  url: string;
  port: number;
  /** Sever every live connection, abruptly. New connections still work. */
  cut: () => number;
  /** Number of connections currently relayed. */
  live: () => number;
  stop: () => void;
}

/**
 * Relay `localhost:<port>` to `target`, with a switch to cut live connections.
 */
export async function tcpCut(targetPort: number, targetHost = "127.0.0.1"): Promise<TcpCut> {
  const pairs = new Set<{ from: net.Socket; to: net.Socket }>();

  const server = net.createServer((from) => {
    const to = net.connect(targetPort, targetHost);
    const pair = { from, to };
    pairs.add(pair);

    from.pipe(to);
    to.pipe(from);

    const forget = () => pairs.delete(pair);
    // A relay whose halves die independently would leak the survivor, and a
    // half-open socket looks like a working connection from one side.
    const bothDown = () => {
      forget();
      from.destroy();
      to.destroy();
    };
    from.on("close", bothDown);
    to.on("close", bothDown);
    // Errors are expected here: cutting a connection makes both ends throw
    // ECONNRESET/EPIPE, which is the point rather than a fault.
    from.on("error", bothDown);
    to.on("error", bothDown);
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr !== "object") {
    server.close();
    throw new Error("tcpCut: could not determine the relay port");
  }
  const port = addr.port;

  return {
    url: `http://127.0.0.1:${port}/query`,
    port,
    cut: () => {
      const n = pairs.size;
      for (const pair of [...pairs]) {
        // destroy(), not end(): end() sends FIN and lets the peer close
        // gracefully, which is the polite path we already test.
        pair.from.destroy();
        pair.to.destroy();
        pairs.delete(pair);
      }
      return n;
    },
    live: () => pairs.size,
    stop: () => {
      for (const pair of [...pairs]) {
        pair.from.destroy();
        pair.to.destroy();
      }
      pairs.clear();
      server.close();
    },
  };
}
