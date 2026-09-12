/**
 * Condition-based waiting. Zero dependencies — deliberately.
 *
 * These were originally inside harness/harness.ts, which imports
 * @empirica/core/admin and therefore cannot be loaded without bundling (see
 * docs/PLATFORM-NOTES.md §3a). That meant these pure functions could not be
 * unit-tested at all. Pure utilities do not belong behind an unloadable import.
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface WaitOptions {
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll until `cond` holds, or throw TimeoutError.
 *
 * A throwing `cond` counts as "not yet" rather than propagating: callers poll
 * on state that legitimately does not exist yet (a scope before it is created,
 * a getter on an undefined mode). The cost is that a genuine programming error
 * inside `cond` surfaces as a timeout rather than the real stack — so the last
 * error is attached to the TimeoutError message.
 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: WaitOptions = { label: "condition" }
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    let ok = false;
    try {
      ok = await cond();
    } catch (e) {
      lastError = e;
      ok = false;
    }
    if (ok) return;

    if (Date.now() > deadline) {
      const suffix =
        lastError instanceof Error
          ? ` (last error from the condition: ${lastError.message})`
          : "";
      throw new TimeoutError(
        `timed out after ${timeoutMs}ms waiting for: ${opts.label}${suffix}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Wait for an rxjs BehaviorSubject (or anything with getValue) to hold a value. */
export function waitForValue<T>(
  subject: { getValue: () => T },
  value: T,
  label: string,
  timeoutMs = 30_000
): Promise<void> {
  return waitFor(() => subject.getValue() === value, { label, timeoutMs });
}
