/**
 * Deterministic seeding for topology generation.
 *
 * Breadboard used an unseeded `new Random()`, which means a network realisation
 * cannot be reconstructed from stored data — you know the generator and its
 * parameters, but not the graph that was actually shown to participants. For a
 * network experiment the realised graph is often the independent variable, so
 * that is a genuine analysis gap rather than a nicety.
 *
 * Here the seed is derived from the game id by default and recorded as a game
 * attribute, so any run is reproducible from its own data file.
 */

/**
 * cyrb53 — a fast, well-distributed 53-bit string hash.
 *
 * Not cryptographic, and deliberately not `Math.random`: reproducibility is the
 * whole point.
 */
export function hashSeed(input: string, salt = 0): number {
  let h1 = 0xdeadbeef ^ salt;
  let h2 = 0x41c6ce57 ^ salt;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export type Rng = () => number;

/**
 * mulberry32 — small, fast, and good enough for shuffling and edge selection.
 * Same seed always yields the same sequence, on any platform.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher–Yates, in place, using the supplied rng. Returns the same array. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return items;
}
