/**
 * One append-only NDJSON writer, shared by everything in the package that keeps
 * a record of a run.
 *
 * It exists because M5 built the same thing twice more, by hand, in the two
 * shipped examples — `mkdirSync` plus `appendFileSync` plus a try/catch,
 * duplicated, inside the copied surface a consumer cannot patch. `views`
 * already had the careful version; the
 * examples got the quick one, and in `examples/shirado2017` the quick one ran on
 * the callback path on every participant colour change.
 *
 * NDJSON rather than CSV for the reason `./views.ts` gives: these logs are
 * append-only records of variable-shaped events, and CSV wants its columns
 * decided before the first row. Flattening happens offline, in `./export.ts`,
 * where the whole log is in hand.
 *
 * Two callers, two different defaults, and the difference is the point — see
 * `defaultBatch` below.
 */
import fs from "node:fs";
import path from "node:path";

export interface NdjsonSinkConfig<T> {
  /**
   * Called once per record, synchronously, wherever the record was produced.
   *
   * Keep it cheap and non-throwing: for `views` this is inside the publish
   * callback and for `log` it is wherever the author called `net.log`, which is
   * usually a listener. Both run in Empirica's runloop. Anything slow (a
   * database, a network call) should be queued, not awaited.
   */
  onRecord?: (r: T) => void;
  /**
   * Append NDJSON to this path. Created if absent, appended to if present.
   *
   * Appended rather than truncated on purpose: a server restart mid-study must
   * not silently delete the record of everything before it.
   */
  file?: string;
  /**
   * Records buffered before a write.
   *
   * `1` writes every record immediately — one syscall per record, and nothing is
   * ever in memory waiting. Higher values trade that durability for throughput:
   * a hard kill (SIGKILL, power loss) then loses up to this many records. A clean
   * shutdown, a game ending and a 2-second idle all flush, so the window is
   * bounded rather than open-ended either way.
   *
   * The default depends on the caller, because the two have opposite priorities.
   */
  batch?: number;
}

export interface NdjsonSink<T> {
  record(r: T): void;
  /** Write out whatever is buffered. Called when a game ends. */
  flush(): void;
  /** Flush and release the file descriptor. */
  close(): void;
}

export interface SinkOptions<T> {
  /**
   * Which config field this sink is, for error messages: `views.onRecord`,
   * `log.onRecord`. A report that does not say which sink threw sends the reader
   * to the wrong callback.
   */
  label: string;
  /** How to name the record in that report — `viewer p1`, `game g1`. */
  describe?: (r: T) => string;
  /**
   * Records buffered by default.
   *
   * Deliberately per-caller rather than one number. `views` records one entry per
   * delivery per participant on the publish path, so it defaults to 256 and buys
   * throughput. `log` is called by hand a few dozen times a session and exists
   * SPECIFICALLY so that a killed run still has data, so it defaults to 1 — a
   * facility whose purpose is durability must not default to holding the most
   * recent records in memory. Both are overridable, and raising `log`'s is a
   * legitimate choice for a high-volume design; it is just not the default that
   * matches why the field exists.
   */
  defaultBatch: number;
}

/**
 * One line of a run log: what the package stamps, plus whatever the author sent.
 *
 * `gameID` is stamped rather than asked for, which is what makes ONE file per
 * study workable — the alternative, a file per game, is what both examples were
 * doing by hand and it meant a directory had to exist before anything could be
 * recorded. `at` is stamped for the same reason `views` records carry one: a log
 * whose entries cannot be ordered against each other is not much of a log.
 */
export interface LogRecord {
  gameID: string;
  at: number;
  [field: string]: unknown;
}

export type LogConfig = NdjsonSinkConfig<LogRecord>;

/**
 * The run log's sink.
 *
 * Here beside the views sink so the two defaults sit next to each other: the
 * contrast between 256 and 1 is a decision about what each log is FOR, and
 * splitting them across files is how it would drift into looking arbitrary.
 */
export function makeLogSink(config: LogConfig | undefined): NdjsonSink<LogRecord> | undefined {
  return makeNdjsonSink<LogRecord>(config, {
    label: "log.onRecord",
    describe: (r) => `game ${r.gameID}`,
    defaultBatch: 1,
  });
}

/** Idle flush, so a slow study does not leave records in memory indefinitely. */
const IDLE_FLUSH_MS = 2_000;

export function makeNdjsonSink<T>(
  config: NdjsonSinkConfig<T> | undefined,
  options: SinkOptions<T>
): NdjsonSink<T> | undefined {
  if (!config || (!config.onRecord && !config.file)) return undefined;

  const onRecord = config.onRecord;
  const batch = config.batch ?? options.defaultBatch;
  let fd: number | undefined;
  let buffer: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  if (config.file) {
    // Create the containing directory first. `views: { file: "data/views.ndjson" }`
    // is the natural thing to write, and without this `openSync` fails with a bare
    // `ENOENT: no such file or directory, open 'data/views.ndjson'` thrown from
    // inside `withNetwork` — naming neither the option that caused it nor the fix,
    // and arriving at game start, after participants have already joined. Found by
    // running the Rand 2011 reconstruction, which is the kind of thing a consumer
    // hits on their first study.
    const dir = path.dirname(config.file);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(config.file, "a");
    // No idle timer when every record is written as it arrives: there is never
    // anything buffered for it to find, so it would wake twice a second for the
    // life of the process to do nothing.
    if (batch > 1) {
      // `unref` so an idle flush timer never holds the process open. Without it
      // every consumer's server would hang on shutdown, and the diagnosis would
      // land on Empirica rather than on us (cf. PLATFORM-NOTES §13, where exactly
      // that confusion cost a real investigation).
      timer = setInterval(flush, IDLE_FLUSH_MS);
      timer.unref?.();
    }
  }

  function flush(): void {
    if (fd === undefined || buffer.length === 0) return;
    const chunk = Buffer.from(buffer.join(""), "utf8");
    buffer = [];
    // Loop on the byte count rather than trusting one call. `write(2)` is
    // permitted to write fewer bytes than asked, and `fs.writeSync` reports that
    // by returning the count rather than by throwing — so ignoring the return
    // value would silently truncate a record MID-FILE, which is worse than
    // losing the tail: the tail is expected of a killed run and
    // `parseNdjson` counts it, while a hole in the middle is a corrupted log
    // that still parses.
    //
    // Not an observed failure. Short writes are effectively unheard of for a
    // regular file, and a consumer pointing `file` at a FIFO is the case this
    // guards. Four lines against a class of silent data corruption.
    let written = 0;
    while (written < chunk.length) {
      const n = fs.writeSync(fd, chunk, written, chunk.length - written);
      // A zero-length write would spin forever. Give up and keep the study
      // running rather than hang the runloop.
      if (n <= 0) break;
      written += n;
    }
  }

  const sink: NdjsonSink<T> = {
    record(r: T): void {
      if (onRecord) {
        try {
          onRecord(r);
        } catch (e) {
          // An author's sink throwing must not abort what produced the record —
          // the study is more important than its telemetry. Reported once per
          // occurrence rather than swallowed, since a sink that never runs looks
          // exactly like a study where nothing happened.
          console.error(
            `empirica-networks: ${options.label} threw for ` +
              `${options.describe?.(r) ?? "a record"}: ` +
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
