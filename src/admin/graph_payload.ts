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
import { inducedEdges, type LocalEdge } from "./subgraph.js";

/** The value written to a participant's channel at radius 1.5. */
export interface GraphPayload {
  /** Declared so the client can tell "radius 1" from "the subgraph is missing". */
  radius: number;
  /** Pairs of LOCAL indices: 0 is the viewer, 1..d are their neighbors in order. */
  edges: LocalEdge[];
  /** Index-aligned with those local indices. Integers; see `round`. */
  positions: Point[];
}

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
  const key = `${nodes.length}:${edges
    .map(([a, b]) => `${a}-${b}`)
    .sort()
    .join(" ")}`;

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
    return { payload: { radius, edges, positions: round(centerOnEgo(known)) }, cache };
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
    payload: { radius, edges, positions: round(centerOnEgo(raw)) },
    cache: { key, positions: carried },
  };
}

/**
 * Put the viewer in the middle and use the whole box.
 *
 * A similarity transform — translate, then one uniform scale — so it moves the
 * picture without changing its shape. The viewer at the centre is Breadboard's
 * arrangement and it is worth keeping for a plain reason: it is the one node
 * whose position carries no information, so pinning it spends nothing, and it
 * makes "which of these is me" answerable at a glance rather than by reading.
 *
 * Applied on the way out, never to the positions carried forward. Transforming
 * the remembered ones too would re-centre and re-scale a layout that had already
 * been re-centred and re-scaled, compounding on every publish.
 */
function centerOnEgo(points: Point[]): Point[] {
  const center = SIZE / 2;
  const ego = points[0];
  if (!ego) return [];

  const shifted = points.map((p) => ({ x: p.x - ego.x, y: p.y - ego.y }));
  let far = 0;
  for (const p of shifted) far = Math.max(far, Math.hypot(p.x, p.y));

  // A lone viewer, or a degenerate layout: nothing to scale against.
  const scale = far < 1e-6 ? 1 : (center - MARGIN) / far;
  return shifted.map((p) => ({ x: center + p.x * scale, y: center + p.y * scale }));
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
