/**
 * The layout, which is the only real decision the monitor makes.
 *
 * It lives on the server precisely so that it can be tested like this:
 * PLATFORM-NOTES §8 rules out mounting anything, so a layout computed in the
 * browser would be a decision nothing in this repo could assert on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { layout, type Point } from "../../src/admin/layout.js";
import { complete, ring } from "../../src/topology/index.js";

const SIZE = 1000;

test("same seed and same graph give byte-identical coordinates", () => {
  // Determinism is what makes every other assertion here exact rather than a
  // tolerance, and it means two people watching one study see one picture.
  const a = layout(12, ring(12), { seed: 7 });
  const b = layout(12, ring(12), { seed: 7 });
  assert.deepEqual(a, b);
});

test("a different seed gives a different arrangement", () => {
  // Otherwise the seed is decorative and the "reproducible from stored data"
  // claim in payload.ts is about a constant.
  const a = layout(12, ring(12), { seed: 7 });
  const b = layout(12, ring(12), { seed: 8 });
  assert.notDeepEqual(a, b);
});

test("every coordinate stays inside the box", () => {
  // 50 is the top of the target regime; 3 is the smallest
  // ring that exists.
  for (const n of [3, 5, 20, 50]) {
    for (const p of layout(n, ring(n), { seed: 3 })) {
      assert.ok(p.x >= 0 && p.x <= SIZE, `x ${p.x} out of range at n=${n}`);
      assert.ok(p.y >= 0 && p.y <= SIZE, `y ${p.y} out of range at n=${n}`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "no NaN escapes the simulation");
    }
  }
});

test("degenerate sizes do not throw or divide by zero", () => {
  assert.deepEqual(layout(0, []), []);
  assert.deepEqual(layout(1, []), [{ x: 500, y: 500 }]);
});

test("tied nodes end up closer than untied ones", () => {
  // The one property that makes the picture worth looking at. Two triangles with
  // a single bridge: within-triangle distances must beat across-triangle ones,
  // or the layout is decorative.
  const edges: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [0, 2],
    [3, 4],
    [4, 5],
    [3, 5],
  ];
  const pos = layout(6, edges, { seed: 11 });
  const within = Math.max(d(pos, 0, 1), d(pos, 1, 2), d(pos, 0, 2));
  const across = Math.min(d(pos, 0, 3), d(pos, 1, 4), d(pos, 2, 5));
  assert.ok(
    within < across,
    `worst within-triangle ${within.toFixed(1)} should beat best across ${across.toFixed(1)}`,
  );
});

test("no two nodes land on the same point", () => {
  // Coincident nodes are indistinguishable on screen, and the repulsion term has
  // a special case for them precisely because it can happen.
  const pos = layout(20, complete(20), { seed: 2 });
  const seen = new Set(pos.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  assert.equal(seen.size, pos.length);
});

test("a warm start keeps nodes near where they already were", () => {
  // This is what makes rewiring legible: after one tie changes, the operator
  // must be able to see WHICH tie changed, which is impossible if the whole
  // picture rearranges. Measured as displacement rather than asserted.
  const before = layout(16, ring(16), { seed: 5 });
  const rewired = ring(16).filter(([a, b]) => !(a === 0 && b === 1));
  rewired.push([0, 8]);

  const cold = layout(16, rewired, { seed: 5 });
  const warm = layout(16, rewired, { seed: 5, initial: before });

  assert.ok(
    meanShift(before, warm) < meanShift(before, cold),
    `warm ${meanShift(before, warm).toFixed(1)} should move less than cold ${meanShift(
      before,
      cold,
    ).toFixed(1)}`,
  );
});

test("a warm start with missing or corrupt entries still produces a full layout", () => {
  // `initial` comes from a previous payload, and a game that gained a seat has a
  // shorter one. Falling back per node rather than per call means a longer game
  // does not lose its whole arrangement to one new participant.
  const partial: Point[] = [
    { x: 100, y: 100 },
    { x: Number.NaN, y: 20 },
  ];
  const pos = layout(6, ring(6), { seed: 1, initial: partial });
  assert.equal(pos.length, 6);
  for (const p of pos) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test("warm start is itself deterministic", () => {
  const before = layout(10, ring(10), { seed: 4 });
  const a = layout(10, complete(10), { seed: 4, initial: before });
  const b = layout(10, complete(10), { seed: 4, initial: before });
  assert.deepEqual(a, b);
});

test("a duplicated edge does not pull its endpoints closer", () => {
  // The layout runs off adjacency(), which dedupes — so the drawing is of the
  // graph the publisher uses, not of the caller's raw list. Without that, a
  // duplicate would double an attraction and misdraw the distance.
  const plain = layout(8, ring(8), { seed: 6 });
  const doubled = layout(8, [...ring(8), [0, 1], [1, 0]], { seed: 6 });
  assert.deepEqual(plain, doubled);
});

function d(pos: Point[], i: number, j: number): number {
  return Math.hypot(pos[i]!.x - pos[j]!.x, pos[i]!.y - pos[j]!.y);
}

function meanShift(a: Point[], b: Point[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y);
  return total / a.length;
}
