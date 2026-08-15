/**
 * Types for `callbacks.js`.
 *
 * The example is deliberately plain JavaScript — that is what `empirica create`
 * produces and what most researchers will edit. This declaration exists purely
 * so `test/e2e/example.test.ts` can import the example's real callbacks under
 * `tsc --noEmit`; nothing at runtime reads it.
 *
 * Kept next to the file it describes rather than as a shim in `test/`, so it
 * stays true if the example's exports change.
 */
import type { ClassicListenersCollector } from "@empirica/core/admin/classic";

export declare const Empirica: ClassicListenersCollector;
