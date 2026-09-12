/**
 * Read recording.
 *
 * Republishing is driven by a declared `watch` list: `withNetwork` registers one
 * attribute listener per key at setup, and a change to any of them republishes
 * the affected views. Empirica has no wildcard attribute listener —
 * `on(kind, cb)` fires on scope CREATION only — so the list has to be static.
 *
 * That makes an incomplete list the obvious failure: forget `"score"` and
 * neighbors simply never see scores change. Nothing errors. The experiment runs
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
 * The message thrown when the server reads a private key it never declared.
 *
 * The counterpart to `unwatchedKeysMessage` at the other boundary. That one is a
 * warning, because a stale projection still publishes something; this one throws,
 * because there is no honest value to return. An undeclared key has no listener
 * and no entry in `inspect()`'s payload, so the only answer available is
 * `undefined` — which is also the answer for "the participant has not written it
 * yet", and a caller cannot tell the two apart. That confusion is the whole bug
 * this accessor exists to remove (`ISSUES.md` O11), so returning `undefined` here
 * would reproduce it one layer up.
 *
 * Names both fields, because which one the author wants is a real decision:
 * `watch` if `project()` reads the key, `read` if only the server does.
 */
export function unlistedKeyMessage(
  key: string,
  watched: Iterable<string>,
  readable: Iterable<string>
): string {
  const w = [...watched];
  const r = [...readable];
  const declared = [...new Set([...w, ...r])].sort();
  return (
    `empirica-networks: stateOf() was asked for private key "${key}", which is in ` +
    `neither \`watch\` nor \`read\`.\n\n` +
    `  Declared: ${declared.length ? declared.map((k) => `"${k}"`).join(", ") : "(none)"}\n\n` +
    `  A private key with no listener cannot be read back: the answer would be\n` +
    `  undefined, which is indistinguishable from "the participant has not written\n` +
    `  it yet". Declare it and this works:\n\n` +
    `    withNetwork(Empirica, { read: [${[...new Set([...r, key])]
      .map((k) => `"${k}"`)
      .join(", ")}], ... })\n\n` +
    `  Use \`read\` for keys only the server consumes, and \`watch\` for keys\n` +
    `  \`project()\` reads — a change to a watched key republishes the views that\n` +
    `  can see it. Both are readable here; the difference is what it says to the\n` +
    `  next person.\n`
  );
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
    `neighbors will NOT see them change.\n\n` +
    `  Views are republished when a watched key changes, and there is no way to\n` +
    `  observe every attribute — so an unwatched key is stale for the whole run,\n` +
    `  silently. If these are meant to be live, watch them:\n\n` +
    `    withNetwork(Empirica, { watch: [${full.map((k) => `"${k}"`).join(", ")}], ... })\n\n` +
    `  If they are set once and never change, this is safe to ignore.\n`
  );
}
