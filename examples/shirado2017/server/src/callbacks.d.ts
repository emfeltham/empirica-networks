/**
 * Types for `callbacks.js`.
 *
 * The experiment is deliberately plain JavaScript — that is what
 * `empirica create` produces and what most researchers will edit. This
 * declaration exists purely so `test/e2e/shirado2017.test.ts` can import the real
 * callbacks under `tsc --noEmit`; nothing at runtime reads it.
 *
 * Kept next to the file it describes rather than as a shim in `test/`, so it
 * stays true if the experiment's exports change.
 */
import type { ClassicListenersCollector } from "@empirica/core/admin/classic";
import type { NetworkHandle } from "empirica-networks/admin";

export declare const Empirica: ClassicListenersCollector;
/** The handle `withNetwork` returned, so `index.js` can pass it to the monitor. */
export declare const net: NetworkHandle;
