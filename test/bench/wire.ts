/**
 * The frame format the coordinator and the client host speak (`host.ts`).
 *
 * Its own file for a mechanical reason: `host.ts` starts a TCP listener as its
 * module body, so importing the reader from there would make the coordinator
 * open a port merely by loading it.
 *
 * Newline-delimited JSON, and the reader has no line-length cap on purpose — a
 * cell's `samples` frame is one object carrying every receipt the shard took,
 * which at n=200 with degree 8 over 100 rounds is on the order of a hundred
 * thousand of them.
 */

/** Feed TCP chunks in; whole JSON objects come out, in order. */
export function frames(onFrame: (v: any) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        onFrame(JSON.parse(line));
      } catch {
        /* a truncated or foreign frame; the sweep fails on the reply that never comes */
      }
    }
  };
}
