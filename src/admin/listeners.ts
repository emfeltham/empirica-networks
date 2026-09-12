/**
 * Detecting the duplicate-lifecycle-listener trap (`ISSUES.md` U8).
 *
 * `onGameStart`, `onRoundStart`, `onStageStart`, `onStageEnded`, `onRoundEnded`
 * and `onGameEnded` all register through Empirica's `unique` wrapper, whose
 * "already ran" marker is `ran-on-<attrId>` stored **on the scope** — so it is
 * shared by every listener for that `(kind, key)`. The first callback to run sets
 * it; every later one returns without running. Registrations are not
 * deduplicated and nothing warns.
 *
 * Splitting handlers by concern — one `onStageEnded` per stage — is the obvious
 * thing to write, and it silently does not work. It cost `examples/rand2011` a
 * dead handler that looked live: rewiring answers were never applied and the
 * network never changed in the condition whose defining feature is that it does.
 *
 * We cannot fix upstream's dispatcher. What we can do is refuse to let a
 * consumer ship it undetected, by counting registrations at server start.
 *
 * Everything here is PURE and free of Empirica imports, so it unit-tests without
 * a server — the same rule ./export.ts and ./inspect.ts follow. The one impure
 * function, `calibrate`, touches only `collector.constructor`.
 */

/** One entry of `ListenersCollector.attributeListeners`. */
export interface ListenerEntry {
  placement?: unknown;
  kind?: unknown;
  key?: unknown;
  callback?: unknown;
}

/**
 * The six `(kind, key)` pairs the lifecycle helpers register, and the helper
 * that produces each.
 *
 * Read off `@empirica/core@1.12.5`'s `ClassicListenersCollector` (dist
 * `chunk-XZHPOD27.js`, 2026-08-16), not guessed. Only these six are checked:
 * every other duplicate `(kind, key)` in the array is a plain `.on`, which is
 * NOT wrapped in `unique` and where duplicates are entirely legitimate — this
 * package itself registers several.
 */
export const LIFECYCLE_HELPERS: ReadonlyArray<readonly [string, string, string]> = [
  ["game", "start", "onGameStart"],
  ["round", "start", "onRoundStart"],
  ["stage", "start", "onStageStart"],
  ["stage", "ended", "onStageEnded"],
  ["round", "ended", "onRoundEnded"],
  ["game", "ended", "onGameEnded"],
];

/**
 * A function's async-ness, anonymity and arity, as one comparable string.
 *
 * This is how a `unique` wrapper is told apart from a callback the author
 * registered directly. `unique()` returns `async (ctx, props) => {…}`, which is
 * `AsyncFunction/""/2`; a named, synchronous, or differently-arity callback
 * cannot be one.
 *
 * Returns `undefined` for a non-function, so a malformed entry drops out of the
 * count rather than throwing inside a startup hook.
 */
export function callbackShape(fn: unknown): string | undefined {
  if (typeof fn !== "function") return undefined;
  const ctor = (fn as { constructor?: { name?: unknown } }).constructor?.name;
  return `${typeof ctor === "string" ? ctor : "?"}/${JSON.stringify(fn.name)}/${fn.length}`;
}

/**
 * What a lifecycle registration looks like on THIS version of Empirica.
 *
 * Measured rather than hardcoded, and that is the point. The detector matches on
 * the shape of an internal wrapper, so a hardcoded `AsyncFunction/""/2` would go
 * silent the day upstream makes `unique` a named or synchronous function —
 * failing in the false-negative direction, which is the worse one for a detector
 * whose whole job is to catch a silent failure.
 *
 * So we build a throwaway collector of the same class, register one lifecycle
 * listener on it, and read back whatever came out. `new collector.constructor()`
 * rather than importing `ClassicListenersCollector`: `withNetwork` takes an
 * untyped collector and does not otherwise depend on Classic, and a detector is
 * not a reason to acquire that dependency.
 *
 * Returns `undefined` if anything about the probe is unfamiliar, which switches
 * the detector off. It reads an `/** @internal *\/` field; going quiet is the
 * correct response to not recognizing what it finds.
 */
export function calibrate(
  collector: unknown
): { shape: string; placement: unknown } | undefined {
  try {
    const Ctor = (collector as { constructor?: unknown })?.constructor;
    if (typeof Ctor !== "function") return undefined;
    const probe = new (Ctor as new () => Record<string, unknown>)();
    const helper = probe["onStageEnded"];
    if (typeof helper !== "function") return undefined;
    (helper as (cb: unknown) => void).call(probe, () => {});

    const entries = probe["attributeListeners"];
    if (!Array.isArray(entries) || entries.length !== 1) return undefined;
    const entry = entries[0] as ListenerEntry;
    if (entry?.kind !== "stage" || entry?.key !== "ended") return undefined;

    const shape = callbackShape(entry.callback);
    return shape ? { shape, placement: entry.placement } : undefined;
  } catch {
    return undefined;
  }
}

export interface DuplicateListener {
  kind: string;
  key: string;
  helper: string;
  count: number;
}

/**
 * Lifecycle helpers registered more than once, from an `attributeListeners`
 * array.
 *
 * Three filters, and each one exists to keep a legitimate registration out of
 * the count:
 *
 *   - **The six pairs only.** A duplicate on any other `(kind, key)` is a plain
 *     `.on`, which escapes `unique` and works fine.
 *   - **Matching placement.** Classic's own internals register on `game/start`
 *     and `game/ended` through `unique.before` / `unique.after`, a different
 *     placement from the helpers' `unique.on`, and they run correctly.
 *   - **Matching callback shape**, and `exclude`. A plain
 *     `.on("stage", "ended", cb)` is not affected by `unique`, and this package
 *     registers exactly one plain listener on a lifecycle pair itself
 *     (`game/start`), which `exclude` removes by identity rather than by guessing.
 *
 * What survives all three is the residual false positive stated in the message:
 * a consumer calling `.on("stage", "ended", async (ctx, props) => …)` directly,
 * twice. Its callback is shaped exactly like a `unique` wrapper and nothing
 * distinguishes them. That is rare, the warning says so, and a false warning is
 * far cheaper than the silent failure it is looking for.
 */
export function duplicateLifecycleListeners(
  entries: unknown,
  opts: { shape: string; placement: unknown; exclude?: ReadonlySet<unknown> }
): DuplicateListener[] {
  if (!Array.isArray(entries)) return [];

  const found: DuplicateListener[] = [];
  for (const [kind, key, helper] of LIFECYCLE_HELPERS) {
    let count = 0;
    for (const entry of entries as ListenerEntry[]) {
      if (entry?.kind !== kind || entry?.key !== key) continue;
      if (entry.placement !== opts.placement) continue;
      if (opts.exclude?.has(entry.callback)) continue;
      if (callbackShape(entry.callback) !== opts.shape) continue;
      count++;
    }
    if (count > 1) found.push({ kind, key, helper, count });
  }
  return found;
}

/**
 * The warning.
 *
 * Gives the working alternative in full rather than describing it: the fix is
 * not obvious from the problem statement, and "dispatch inside one listener" is
 * the sort of instruction that reads as understood and gets implemented as two
 * listeners with an `if` in each.
 *
 * The residual false positive is stated rather than hidden. A reader who is in
 * that case needs to know it in the same breath as the accusation, and a
 * detector that hides its own failure mode is asking to be believed on a
 * question it cannot settle.
 */
export function duplicateListenersMessage(dupes: DuplicateListener[]): string {
  const lines = dupes
    .map((d) => `    ${d.helper}()  registered ${d.count} times  (${d.kind}/${d.key})`)
    .join("\n");
  const example = dupes[0]!;

  return (
    `empirica-networks: ${dupes.length === 1 ? "a lifecycle listener is" : "lifecycle listeners are"} ` +
    `registered more than once, and ONLY THE FIRST WILL EVER RUN.\n\n` +
    `${lines}\n\n` +
    `  Empirica wraps these helpers in a \`unique\` guard whose "already ran" marker is\n` +
    `  stored on the SCOPE, so it is shared by every listener for the same event. The\n` +
    `  first callback to run sets it and every later one returns without running —\n` +
    `  silently, with no error and no log line (ISSUES.md U8).\n\n` +
    `  Register each helper ONCE and dispatch inside it:\n\n` +
    `    Empirica.${example.helper}((props) => {\n` +
    `      const name = props.stage?.get("name");\n` +
    `      if (name === "decide") scoreRound(props);\n` +
    `      else if (name === "rewire") applyRewiring(props);\n` +
    `    });\n\n` +
    `  If you called \`Empirica.on("${example.kind}", "${example.key}", cb)\` directly rather than\n` +
    `  \`${example.helper}()\`, this warning is wrong and your listeners all run: a plain\n` +
    `  \`.on\` is not wrapped in \`unique\`. The two are indistinguishable once registered\n` +
    `  when the callback is an anonymous 2-argument async function.\n`
  );
}
