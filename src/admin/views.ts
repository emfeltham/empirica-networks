/**
 * Capture what each participant was actually shown.
 *
 * Off unless asked for. When it is on, the cost is genuinely small: `publish()`
 * already serializes every view to compare it against the last one, so the row
 * content exists whether or not anybody keeps it.
 *
 * NDJSON rather than CSV, and that is not a detail. A view is a variable-length
 * array of whatever `project()` returned — length varies with degree, shape
 * varies with the author — and CSV is rectangular. Writing CSV at capture time
 * would mean fixing the columns before knowing them. So the wire shape is kept
 * as-is here and `viewRows()` in ./export.ts flattens it offline, where the
 * whole log is available and the columns can be read off it.
 *
 * The writer itself lives in `./sink.ts` and is shared with `net.log`. This file
 * is now the views-specific configuration and nothing else.
 */
import { makeNdjsonSink, type NdjsonSink } from "./sink.js";
import type { ViewRecord } from "../shared/keys.js";

export interface ViewsConfig {
  /**
   * Called once per delivered view, inside the publish callback.
   *
   * Keep it cheap and non-throwing: it runs in Empirica's runloop, and a throw
   * here would take the publish with it. Anything slow (a database, a network
   * call) should be queued, not awaited.
   *
   * Named `onView` rather than the shared sink's `onRecord` deliberately: at this
   * call site the record IS a view, and `views: { onView }` says what arrives.
   * The mapping costs one line below.
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
   *
   * Higher than `log`'s default of 1, because these two have opposite
   * priorities: this one is on the publish path and pays per delivery per
   * participant, while the run log exists precisely so that a killed study still
   * has data. See `SinkOptions.defaultBatch`.
   */
  batch?: number;
}

export type ViewSink = NdjsonSink<ViewRecord>;

export function makeViewSink(config: ViewsConfig | undefined): ViewSink | undefined {
  return makeNdjsonSink<ViewRecord>(
    config && { onRecord: config.onView, file: config.file, batch: config.batch },
    {
      label: "views.onView",
      describe: (r) => `viewer ${r.viewer}`,
      defaultBatch: 256,
    }
  );
}
