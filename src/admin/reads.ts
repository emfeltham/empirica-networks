/**
 * Read recording.
 *
 * Republishing is driven by a declared `watch` list: `withNetwork` registers one
 * attribute listener per key at setup, and a change to any of them republishes
 * the affected views. Empirica has no wildcard attribute listener —
 * `on(kind, cb)` fires on scope CREATION only — so the list has to be static.
 *
 * That makes an incomplete list the obvious failure: forget `"score"` and
 * neighbours simply never see scores change. Nothing errors. The experiment runs
 * to completion and the data is quietly wrong, which is the same shape as the
 * `private`-flag trap this whole module exists because of.
 *
 * So `project()` is handed a recording proxy instead of the raw scope, and every
 * key it reads is compared against the watch list. A missing key becomes a
 * message naming exactly what to add.
 *
 * The proxy stays transparent on purpose: it still looks like a scope, so
 * `validateProjection` still refuses `project: (n) => n`. Losing that would
 * trade one silent leak for another.
 */

/**
 * Wrap a scope so every `.get(key)` is recorded in `seen`.
 *
 * Methods are bound to the target rather than the proxy, so a method that
 * internally calls `this.get(...)` does not record keys the author never asked
 * for — the list is meant to reflect what `project()` actually depends on.
 */
export function recordReads<T extends object>(scope: T, seen: Set<string>): T {
  return new Proxy(scope, {
    get(target, prop) {
      // Two-argument Reflect.get: the receiver defaults to `target`, so getters
      // like `id` and `participantID` resolve against the real object. Passing
      // the proxy as receiver would break any accessor reaching for internals.
      const value = Reflect.get(target, prop);

      if (prop === "get" && typeof value === "function") {
        return function (key: unknown) {
          if (typeof key === "string") seen.add(key);
          return (value as (k: unknown) => unknown).call(target, key);
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Keys `project()` read that are not in the watch list, sorted. */
export function unwatchedKeys(read: Set<string>, watched: Iterable<string>): string[] {
  const w = new Set(watched);
  return [...read].filter((k) => !w.has(k)).sort();
}

/**
 * The message shown when a projection depends on keys nobody is watching.
 *
 * Deliberately quotes a ready-to-paste `watch` array: a warning that describes a
 * problem without giving the fix gets skimmed past.
 */
export function unwatchedKeysMessage(missing: string[], watched: Iterable<string>): string {
  const full = [...new Set([...watched, ...missing])].sort();
  return (
    `empirica-networks: project() reads player attribute(s) ` +
    `${missing.map((k) => `"${k}"`).join(", ")} that are not in \`watch\`, so ` +
    `neighbours will NOT see them change.\n\n` +
    `  Views are republished when a watched key changes, and there is no way to\n` +
    `  observe every attribute — so an unwatched key is stale for the whole run,\n` +
    `  silently. If these are meant to be live, watch them:\n\n` +
    `    withNetwork(Empirica, { watch: [${full.map((k) => `"${k}"`).join(", ")}], ... })\n\n` +
    `  If they are set once and never change, this is safe to ignore.\n`
  );
}
