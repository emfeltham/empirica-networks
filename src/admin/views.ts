/**
 * Capture what each participant was actually shown.
 *
 * Off unless asked for. When it is on, the cost is genuinely small: `publish()`
 * already serialises every view to compare it against the last one, so the row
 * content exists whether or not anybody keeps it.
 *
 * NDJSON rather than CSV, and that is not a detail. A view is a variable-length
 * array of whatever `project()` returned — length varies with degree, shape
 * varies with the author — and CSV is rectangular. Writing CSV at capture time
 * would mean fixing the columns before knowing them. So the wire shape is kept
 * as-is here and `viewRows()` in ./export.ts flattens it offline, where the
 * whole log is available and the columns can be read off it.
 */
import fs from "node:fs";
import type { ViewRecord } from "../shared/keys.js";

export interface ViewsConfig {
  /**
   * Called once per delivered view, inside the publish callback.
   *
   * Keep it cheap and non-throwing: it runs in Empirica's runloop, and a throw
   * here would take the publish with it. Anything slow (a database, a network
   * call) should be queued, not awaited.
   */
  onView?: (record: ViewRecord) => void;
  /**
   * Append NDJSON to this path. Created if absent, appended to if present.
   *
   * Appended rather than truncated on purpose: a server restart mid-study must
   * not silently delete the record of everything before it.
   */
  file?: string;
  /**
   * Records buffered before a write. Default 256.
   *
   * The trade is explicit: a syscall per view would sit in the publish path,
   * and buffering means a hard kill (SIGKILL, power loss) loses at most this
   * many records. A clean shutdown, a game ending, and a 2-second idle all
   * flush, so the window is small and bounded rather than open-ended.
   */
  batch?: number;
}

export interface ViewSink {
  record(r: ViewRecord): void;
  /** Write out whatever is buffered. Called when a game ends. */
  flush(): void;
  /** Flush and release the file descriptor. */
  close(): void;
}

/** Idle flush, so a slow study does not leave records in memory indefinitely. */
const IDLE_FLUSH_MS = 2_000;

export function makeViewSink(config: ViewsConfig | undefined): ViewSink | undefined {
  if (!config || (!config.onView && !config.file)) return undefined;

  const onView = config.onView;
  const batch = config.batch ?? 256;
  let fd: number | undefined;
  let buffer: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  if (config.file) {
    fd = fs.openSync(config.file, "a");
    // `unref` so an idle flush timer never holds the process open. Without it
    // every consumer's server would hang on shutdown, and the diagnosis would
    // land on Empirica rather than on us (cf. PLATFORM-NOTES §13, where exactly
    // that confusion cost a real investigation).
    timer = setInterval(flush, IDLE_FLUSH_MS);
    timer.unref?.();
  }

  function flush(): void {
    if (fd === undefined || buffer.length === 0) return;
    const chunk = buffer.join("");
    buffer = [];
    // Synchronous: this also runs from an `exit` handler, where a callback
    // would never be reached.
    fs.writeSync(fd, chunk);
  }

  const sink: ViewSink = {
    record(r: ViewRecord): void {
      if (onView) {
        try {
          onView(r);
        } catch (e) {
          // An author's sink throwing must not abort the publish — the study is
          // more important than its telemetry. Reported once per occurrence
          // rather than swallowed, since a sink that never runs looks exactly
          // like a study where nothing was published.
          console.error(
            `empirica-networks: views.onView threw for viewer ${r.viewer}: ` +
              `${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      if (fd !== undefined) {
        buffer.push(`${JSON.stringify(r)}\n`);
        if (buffer.length >= batch) flush();
      }
    },
    flush,
    close(): void {
      flush();
      if (timer) clearInterval(timer);
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        fd = undefined;
      }
    },
  };

  if (config.file) {
    // Best-effort: a clean exit should not lose the tail of the log.
    process.once("exit", () => sink.close());
  }

  return sink;
}
