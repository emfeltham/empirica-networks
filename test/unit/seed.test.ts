import assert from "node:assert/strict";
import test from "node:test";
import { hashSeed, makeRng, randInt, shuffle } from "../../src/admin/seed.js";

test("hashSeed is deterministic and salt-sensitive", () => {
  assert.equal(hashSeed("game-abc"), hashSeed("game-abc"));
  assert.notEqual(hashSeed("game-abc"), hashSeed("game-abd"));
  assert.notEqual(hashSeed("game-abc", 1), hashSeed("game-abc", 2));
});

test("the same seed replays the same sequence", () => {
  // This is the property the whole reproducibility argument rests on: a stored
  // seed must reconstruct the exact graph participants saw.
  const a = makeRng(12345);
  const b = makeRng(12345);
  const seqA = Array.from({ length: 50 }, () => a());
  const seqB = Array.from({ length: 50 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test("different seeds diverge", () => {
  const a = makeRng(1);
  const b = makeRng(2);
  assert.notDeepEqual(
    Array.from({ length: 20 }, () => a()),
    Array.from({ length: 20 }, () => b())
  );
});

test("values stay in [0, 1)", () => {
  const rng = makeRng(hashSeed("bounds"));
  for (let i = 0; i < 5_000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("is not obviously biased", () => {
  // Not a serious statistical test — just enough to catch a generator that is
  // stuck, constant, or confined to part of the range.
  const rng = makeRng(hashSeed("bias"));
  const buckets = new Array(10).fill(0);
  const n = 20_000;
  for (let i = 0; i < n; i++) buckets[Math.floor(rng() * 10)]!++;
  for (const [i, count] of buckets.entries()) {
    const share = count / n;
    assert.ok(share > 0.07 && share < 0.13, `bucket ${i} share ${share.toFixed(3)} looks skewed`);
  }
});

test("randInt covers the full range and stays inside it", () => {
  const rng = makeRng(7);
  const seen = new Set<number>();
  for (let i = 0; i < 2_000; i++) {
    const v = randInt(rng, 5);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 5);
    seen.add(v);
  }
  assert.equal(seen.size, 5, "every value in [0,5) occurs");
});

test("shuffle is a permutation, and deterministic for a given seed", () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = shuffle([...original], makeRng(99));
  const b = shuffle([...original], makeRng(99));

  assert.deepEqual(a, b, "same seed, same permutation");
  assert.deepEqual([...a].sort((x, y) => x - y), original, "no elements lost or duplicated");
});

test("shuffle actually reorders", () => {
  const original = Array.from({ length: 30 }, (_, i) => i);
  const shuffled = shuffle([...original], makeRng(hashSeed("reorder")));
  assert.notDeepEqual(shuffled, original);
});
