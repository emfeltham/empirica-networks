/**
 * Force-directed layout, computed on the SERVER.
 *
 * Putting the layout here rather than in the browser looks backwards for about
 * a second. It is the direct consequence of PLATFORM-NOTES §8: this codebase
 * cannot test anything that only exists once a component is mounted, so the
 * established response is to move every decision into a pure function and leave
 * the rendering surface with nothing to get wrong. A layout is the only real
 * decision the monitor makes; running it here makes it a pure function of
 * `(n, edges, opts)` that unit tests in milliseconds, and leaves the page with
 * `document.createElementNS`.
 *
 * The cost is a recompute per topology change instead of an animation loop. At
 * the target regime — n <= 50 (MODULE-DESIGN §8) — a few hundred iterations over
 * 50 nodes is microseconds, and it happens only when the graph actually changes,
 * not per frame. This would be the wrong trade at n = 10,000; the package does
 * not go there, and U7 means the platform does not either.
 *
 * Deterministic by construction. Same seed and same graph give the same
 * coordinates on every process, which is what makes the unit tests assertions
 * rather than tolerances — and means two people watching the same study see the
 * same picture.
 */
import { adjacency, type Edge } from "../../topology/index.js";
import { makeRng, type Rng } from "../seed.js";

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /**
   * Seeded placement. Defaults to 1.
   *
   * Pass the game's own seed so the picture is reproducible from stored data
   * alongside the graph it draws.
   */
  seed?: number;
  /** Simulation steps. Default 300, which converges well below n = 50. */
  iterations?: number;
  /** Layout box. Coordinates come back inside [0, size] on both axes. */
  size?: number;
  /**
   * Previous positions, to warm-start from.
   *
   * This is what makes rewiring legible. A cold layout after every edge change
   * produces a completely different arrangement of the same people, so the
   * operator sees the whole graph teleport and cannot tell which tie moved —
   * the one thing a live monitor of a rewiring study exists to show. Warm
   * starting keeps everybody roughly where they were and lets the changed ties
   * pull their endpoints.
   *
   * Entries beyond `n`, or a shorter array, are fine: missing seats get a
   * seeded initial position like any other.
   */
  initial?: Point[];
}

/**
 * Lay out a graph.
 *
 * Fruchterman-Reingold: repulsion between every pair, attraction along edges,
 * with a linearly decaying step limit. Chosen because it is ~40 lines, has no
 * parameters a researcher has to understand, and is stable under warm start —
 * not because it is the best force model. At n <= 50 the differences between
 * force models are aesthetic.
 */
export function layout(n: number, edges: Edge[], opts: LayoutOptions = {}): Point[] {
  const size = opts.size ?? 1000;
  const iterations = opts.iterations ?? 300;
  const rng = makeRng(opts.seed ?? 1);

  if (n <= 0) return [];
  if (n === 1) return [{ x: size / 2, y: size / 2 }];

  const pos = seedPositions(n, size, rng, opts.initial);

  // adjacency() rather than the raw edge list: it dedupes, drops self-loops and
  // validates range, so the drawing is of the same graph the publisher uses.
  // Laying out the raw list would let a duplicated edge silently double an
  // attraction and pull two nodes closer than the graph says they are.
  const adj = adjacency(n, edges);

  // The classic k: the radius each node would own if the box were divided
  // equally between them.
  const k = Math.sqrt((size * size) / n);
  const disp: Point[] = Array.from({ length: n }, () => ({ x: 0, y: 0 }));

  for (let step = 0; step < iterations; step++) {
    for (const d of disp) {
      d.x = 0;
      d.y = 0;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
          // Coincident nodes have no direction to push apart along. Nudge
          // deterministically rather than randomly: a random jitter here would
          // make the whole layout non-reproducible for the one input where two
          // seats happen to land on the same point.
          dx = (i - j) * 1e-3;
          dy = 1e-3;
          dist = Math.hypot(dx, dy);
        }
        const force = (k * k) / dist;
        const ux = (dx / dist) * force;
        const uy = (dy / dist) * force;
        disp[i]!.x += ux;
        disp[i]!.y += uy;
        disp[j]!.x -= ux;
        disp[j]!.y -= uy;
      }
    }

    for (let i = 0; i < n; i++) {
      for (const j of adj[i] ?? []) {
        if (j <= i) continue;
        const dx = pos[i]!.x - pos[j]!.x;
        const dy = pos[i]!.y - pos[j]!.y;
        const dist = Math.max(Math.hypot(dx, dy), 1e-6);
        const force = (dist * dist) / k;
        const ux = (dx / dist) * force;
        const uy = (dy / dist) * force;
        disp[i]!.x -= ux;
        disp[i]!.y -= uy;
        disp[j]!.x += ux;
        disp[j]!.y += uy;
      }
    }

    // Temperature: cool linearly to zero so late steps only polish.
    const temp = (size / 10) * (1 - step / iterations);
    for (let i = 0; i < n; i++) {
      const d = disp[i]!;
      const mag = Math.max(Math.hypot(d.x, d.y), 1e-6);
      const limited = Math.min(mag, temp);
      pos[i]!.x = clamp(pos[i]!.x + (d.x / mag) * limited, 0, size);
      pos[i]!.y = clamp(pos[i]!.y + (d.y / mag) * limited, 0, size);
    }
  }

  return pos;
}

/**
 * Initial placement: a seeded ring with jitter, or the warm-start positions.
 *
 * A ring rather than uniform random. Random placement occasionally starts two
 * components interleaved and the simulation cannot separate them within a fixed
 * iteration budget, which shows up as an unreadable picture on maybe one graph
 * in twenty — a flake in the one part of the system a human is looking at.
 */
function seedPositions(n: number, size: number, rng: Rng, initial?: Point[]): Point[] {
  const centre = size / 2;
  const radius = size * 0.35;
  return Array.from({ length: n }, (_, i) => {
    const prev = initial?.[i];
    if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
      return { x: clamp(prev.x, 0, size), y: clamp(prev.y, 0, size) };
    }
    const angle = (2 * Math.PI * i) / n;
    return {
      x: clamp(centre + radius * Math.cos(angle) + (rng() - 0.5) * size * 0.02, 0, size),
      y: clamp(centre + radius * Math.sin(angle) + (rng() - 0.5) * size * 0.02, 0, size),
    };
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
