/**
 * What a participant is sent at radius 1.5, and where the nodes go.
 *
 * Pure: `(adjacency, delivered neighborhood, previous positions) -> payload`.
 * Everything with a decision in it is here so that `with_network.ts` is left
 * assembling arguments, and so the two decisions that would fail SILENTLY are
 * unit tested rather than watched for.
 *
 * WHY THE LAYOUT IS COMPUTED HERE AND NOT IN THE BROWSER. Not orthodoxy —
 * stability. A force layout run on the client would re-settle every time any
 * neighbor changed a watched attribute, so the picture would rearrange itself
 * whenever somebody picked a color. A participant watching their neighborhood
 * for a change would see one that is not there, which is worse than no layout
 * at all. `monitor/payload.ts` solved this for the operator's view and this
 * follows it: recompute only when the SHAPE changes, and warm start from where
 * things already were.
 *
 * WARM STARTING IS KEYED BY PLAYER, NOT BY POSITION IN THE ARRAY. The monitor
 * can key by index because a seat belongs to one person for the whole game. A
 * neighborhood cannot: drop a tie and everybody after the gap shifts down one,
 * so index-keyed warm starting would hand each survivor the coordinates of the
 * person who used to sit there. The nodes would barely move — the picture would
 * look beautifully stable — while the identities underneath it all slid by one.
 * That is the failure this module is shaped around.
 */
import { layout, type Point } from "./layout.js";
import type { ViewGraph } from "../shared/keys.js";
import { edgeKey, inducedEdges, type LocalEdge } from "./subgraph.js";

/**
 * The value written to a participant's channel at radius 1.5.
 *
 * The same shape `ViewRecord.graph` records, and deliberately one declaration
 * rather than two: what is captured must be what was delivered, and two
 * structurally-identical interfaces are two things that can drift. `ViewGraph`
 * is declared in `shared/keys.ts` because the offline export subpath needs it
 * and may not import this module — see the note there.
 *
 * `radius` is inside the payload so the client can tell "radius 1" from "the
 * subgraph is missing"; `edges` are LOCAL indices (0 is the viewer, 1..d are
 * their neighbors in order); `positions` is index-aligned with those and
 * integral (see `round`).
 */
export type GraphPayload = ViewGraph;

export interface BuildArgs {
  adj: number[][];
  /**
   * The DELIVERED neighborhood in delivery order: the viewer's own topology
   * index first, then the neighbors actually published to them.
   */
  nodes: number[];
  /** Player id per entry of `nodes`, so warm starting can follow people. */
  ids: string[];
  radius: number;
  seed: number;
  /** What the last publish to this viewer laid out, if anything. */
  cache?: LayoutCache;
}

/** Raw, untransformed positions by player id, and the shape they belong to. */
export interface LayoutCache {
  key: string;
  positions: Map<string, Point>;
}

export interface BuildResult {
  payload: GraphPayload;
  /** Carry this forward, per viewer. */
  cache: LayoutCache;
}

/** The box the client draws into, and the room a node needs inside it. */
const SIZE = 600;
const MARGIN = 40; // alter radius 30 + padding 10, matching `player/graph.ts`

export function buildGraphPayload(args: BuildArgs): BuildResult {
  const { adj, nodes, ids, radius, seed, cache } = args;
  const edges = inducedEdges(adj, nodes);
  // The node count as well as the ties: a neighborhood can lose a node without
  // losing an edge between the ones that remain, and that is still a different
  // picture to lay out.
  const key = `${nodes.length}:${edgeKey(edges)}`;

  // Remembered positions, in this publish's node order. `undefined` unless
  // EVERY node is remembered: a partial array cannot be index-aligned with the
  // nodes it is seeding, and compacting it would seed each node with the
  // previous occupant's coordinates.
  const remembered = cache
    ? nodes.map((_, at) => cache.positions.get(ids[at] ?? ""))
    : undefined;
  const known =
    remembered && remembered.every((p): p is Point => p !== undefined)
      ? (remembered as Point[])
      : undefined;

  // The shape is unchanged AND the same people are in it: reuse exactly, so a
  // neighbor changing a watched attribute moves nobody. Both halves are
  // required — one rewire can swap two ties and arrive at an identical shape
  // holding different people, and reusing on the shape alone would then place
  // each newcomer where the person they replaced had been.
  if (cache && cache.key === key && known) {
    return { payload: { radius, edges, positions: round(fitToBox(known)) }, cache };
  }

  const raw =
    nodes.length === 0
      ? []
      : layout(nodes.length, edges, { seed, size: SIZE, initial: known });

  const carried = new Map<string, Point>();
  for (const [at, p] of raw.entries()) {
    const id = ids[at];
    if (id) carried.set(id, p);
  }

  return {
    payload: { radius, edges, positions: round(fitToBox(raw)) },
    cache: { key, positions: carried },
  };
}

/**
 * Fit the neighborhood to the canvas.
 *
 * A similarity transform — translate, then one uniform scale — so it moves and
 * resizes the picture without changing its shape.
 *
 * This CENTRES ON THE BOUNDING BOX, not on the viewer, and the difference is
 * not cosmetic. Centring on the viewer and scaling by the distance to the
 * farthest node is the obvious thing and it is what this did first: it works
 * beautifully for a star, where the viewer really is in the middle, and wastes
 * most of the canvas as soon as they are not. A closed neighborhood that is
 * densely connected lays out as a ring with the VIEWER ON IT — in the limit,
 * five mutual connections lay out as a regular pentagon — so the drawing ends
 * up shoved into one corner at about a third of the size it could be. Measured
 * by looking at it.
 *
 * What is given up is Breadboard's "you are always dead centre", which is worth
 * something: a participant should not have to hunt for themselves. Breadboard
 * buys it by pinning the ego and adding a radial force that pushes everyone
 * else onto a ring around it — deliberately distorting the layout to make the
 * centre meaningful. That is a bigger change than it looks, and it is not
 * needed here: the viewer's node is drawn larger than the others and carries
 * their own label, so "which one is me" is answered without spending the
 * geometry on it. For a star, where the ego IS the centre, the two agree
 * anyway.
 */
function fitToBox(points: Point[]): Point[] {
  const center = SIZE / 2;
  if (points.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const half = Math.max((maxX - minX) / 2, (maxY - minY) / 2);
  // A single node, or every node on one point: nothing to scale against, and
  // the answer is the middle of the canvas.
  const scale = half < 1e-6 ? 1 : (center - MARGIN) / half;

  return points.map((p) => ({
    x: center + (p.x - midX) * scale,
    y: center + (p.y - midY) * scale,
  }));
}

/**
 * Integers.
 *
 * Halves the bytes, and removes the only reason two structurally identical
 * publishes would differ: a warm-started layout lands on different float tails
 * for the same graph, so unrounded coordinates would defeat the byte-identical
 * suppression and republish the whole neighborhood on every tick.
 */
function round(points: Point[]): Point[] {
  return points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}
