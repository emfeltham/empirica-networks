/**
 * Projection validation.
 *
 * `project()` is author-supplied and its return value is the ONLY thing that
 * reaches a client. Two mistakes in it are both easy to make and catastrophic,
 * and neither announces itself:
 *
 * 1. RETURNING A SCOPE. `project: (neighbour) => neighbour` looks like the
 *    obvious thing to write. An Empirica scope holds `this.attributes` — the
 *    GLOBAL attribute store — so serialising one would ship every attribute of
 *    every participant to this client. That is precisely the leak this module
 *    exists to prevent, arriving through the one path we cannot lock down,
 *    because the author chooses what goes in it.
 *
 * 2. RETURNING SOMETHING UNSERIALISABLE. A cycle or a BigInt makes
 *    JSON.stringify throw from deep inside Empirica's runloop, with a message
 *    naming neither the participant, the neighbour, nor the field.
 *
 * Zero dependencies on purpose: no `@empirica/core` import means this is unit
 * testable in milliseconds (same reasoning as `seed.ts`). Scope detection is
 * therefore structural rather than `instanceof` — which is also more robust,
 * since it catches player-side scopes and survives two copies of the class being
 * installed.
 */

export class ProjectionError extends Error {
  constructor(message: string) {
    super(`empirica-networks: ${message}`);
    this.name = "ProjectionError";
  }
}

/** Guards against pathological nesting; real projections are 1-2 deep. */
const MAX_DEPTH = 12;

const EXAMPLE =
  "  project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get(\"choice\") })";

/**
 * Structural test for an Empirica scope.
 *
 * `getAttribute` is the discriminator: `get`/`set`/`id` alone appear on plenty
 * of innocent objects (Map, URL, class instances), but the `get` + `getAttribute`
 * + `id` combination is specific to Scope on both the admin and player sides.
 */
function looksLikeScope(v: Record<string, unknown>): boolean {
  return (
    typeof v["get"] === "function" &&
    typeof v["getAttribute"] === "function" &&
    "id" in v
  );
}

function describe(path: string): string {
  return path === "" ? "the projection" : `the projection at ${path}`;
}

/**
 * Throw if `value` is not safe to publish. Called once per neighbour view.
 *
 * Permits `undefined` — `neighbour.get("choice")` returns it for any attribute
 * that has not been set yet, which is entirely normal and would make an
 * over-strict check fire on every healthy experiment's first round.
 */
export function validateProjection(value: unknown, label = ""): void {
  walk(value, label, new Set(), 0);
}

function walk(value: unknown, path: string, seen: Set<object>, depth: number): void {
  if (value === null || value === undefined) return;

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    if (t === "number" && !Number.isFinite(value as number)) {
      throw new ProjectionError(
        `${describe(path)} is ${String(value)}, which JSON turns into null. ` +
          `Send a sentinel you control instead.`
      );
    }
    return;
  }

  if (t === "function") {
    throw new ProjectionError(
      `${describe(path)} is a function. JSON drops it silently, so the client ` +
        `would receive an object with that field missing and no error anywhere.`
    );
  }

  if (t === "bigint") {
    throw new ProjectionError(
      `${describe(path)} is a BigInt, which JSON.stringify refuses to serialise. ` +
        `Convert it to a number or a string in project().`
    );
  }

  if (t === "symbol") {
    throw new ProjectionError(`${describe(path)} is a Symbol, which JSON cannot represent.`);
  }

  if (t !== "object") return;

  const obj = value as Record<string, unknown>;

  if (seen.has(obj)) {
    throw new ProjectionError(
      `${describe(path)} contains a cycle. JSON.stringify would throw from inside ` +
        `Empirica's runloop, where nothing identifies which projection caused it.`
    );
  }

  if (depth > MAX_DEPTH) {
    throw new ProjectionError(
      `${describe(path)} nests more than ${MAX_DEPTH} levels deep. A projection is ` +
        `meant to be a small flat summary of one neighbour.`
    );
  }

  if (looksLikeScope(obj)) {
    throw new ProjectionError(
      `${describe(path)} is an Empirica scope, not plain data.\n\n` +
        `  Scopes hold a reference to the global attribute store, so publishing one\n` +
        `  would send EVERY attribute of EVERY participant to this client — the exact\n` +
        `  leak this module exists to prevent.\n\n` +
        `  Return plain values instead:\n\n` +
        EXAMPLE +
        "\n"
    );
  }

  if (value instanceof Date) return; // JSON gives an ISO string
  if (value instanceof Map || value instanceof Set) {
    throw new ProjectionError(
      `${describe(path)} is a ${value.constructor.name}, which JSON serialises as {}. ` +
        `Convert it with [...value] or Object.fromEntries(value) in project().`
    );
  }

  seen.add(obj);
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`, seen, depth + 1);
  } else {
    for (const [key, item] of Object.entries(obj)) {
      walk(item, path === "" ? key : `${path}.${key}`, seen, depth + 1);
    }
  }
  // Removed after descending: sharing one object in two sibling fields is fine
  // and common. Only a genuine ancestor cycle is an error.
  seen.delete(obj);
}

/** Serialised size of a value in bytes, as it will go over the wire. */
export function projectionBytes(value: unknown): number {
  // stringify returns the JS value `undefined` (not a string) for functions and
  // symbols. validateProjection rejects those first, but this is also called
  // directly, and Buffer.byteLength(undefined) throws.
  const s = JSON.stringify(value ?? null);
  return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}
