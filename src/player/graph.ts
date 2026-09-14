/**
 * The participant's node-link view of their own neighborhood.
 *
 * Pure, and for the same reason everything else in `player/` is: PLATFORM-NOTES
 * §8 means nothing mounted can be tested in this codebase, so a component that
 * decided anything would be a component nothing holds. Every decision is here —
 * geometry, identity, which attributes reach the DOM, and what "not known yet"
 * looks like — and `player/react/NetworkGraph.tsx` is left with `<circle>` and
 * `<line>`.
 *
 * WHAT THIS DRAWS, AND WHY THAT IS THE WHOLE DESIGN. At the default radius the
 * picture is a STAR: the viewer at the center, one node per neighbor, one line
 * to each. Not an aesthetic choice — it is what Breadboard's participants saw,
 * enforced there by `Client.java::updateGraph`, which sends the ego, its direct
 * neighbors, and only ego-incident edges. Ties BETWEEN two of your neighbors are
 * not in it. So the display this module reproduces costs the neighbor-limited
 * guarantee nothing at all: `useNetworkSelf()` and `useNeighbors()` already
 * carry every byte it needs, and no new data crosses the wire to draw it.
 *
 * A star's force layout is not worth simulating. Repulsion between equidistant
 * alters and equal attraction along identical edges converges on an even ring,
 * so the ring IS the converged answer — closed form, deterministic, no seed, no
 * `d3-force`, and no dependency added to a client bundle.
 *
 * Radii above 1 are a different thing and are NOT drawn from local data: they
 * need a subgraph the server computed and sent. See `subgraph` below, and note
 * `expectSubgraph` — the one place where getting this wrong would look right.
 *
 * Above 1.5 the picture also contains people the viewer is not connected to, and
 * the node list therefore comes from the PAYLOAD rather than from `neighbors`.
 * That distinction is the whole of it: built from `neighbors`, a radius 2 payload
 * rendered as a complete, internally consistent radius 1.5 picture — outer ring
 * gone, every edge touching it dropped by the guard in `graphModelOf`, and
 * nothing anywhere saying so.
 */

// `import type` and nothing else, so this module still contributes no runtime
// import to a client bundle. Declared in `shared/keys.ts` and imported rather
// than restated, because a structural copy of a wire type is what caused O21:
// `graph` was added to the canonical one and not to the duplicate, and the
// checker that should have caught it did not have the field in scope.
import type { FarNode } from "../shared/keys.js";

export interface Point {
  x: number;
  y: number;
}

/**
 * A node's local identity.
 *
 * `0` is always the viewer; `1..d` are `neighbors[0..d-1]`, in order. Positional
 * on purpose. The server's topology indices are a seating plan and must never
 * reach a participant (PLATFORM-NOTES §4b, locked by
 * `test/e2e/topology_visibility.test.ts`), whereas a local index discloses
 * nothing: it names the k-th entry of an array this browser was already sent.
 * It also needs no cooperation from the author's `project()`, whose shape the
 * author chooses and this module cannot assume.
 */
export interface GraphNode {
  index: number;
  /** True for exactly one node: the viewer. */
  self: boolean;
  /** The projected view for this neighbor. `undefined` on the viewer's node. */
  data: unknown;
  /** Hops from the viewer. `0`, `1`, or more. */
  distance: number;
  /** This viewer's private name for a person beyond distance 1. */
  ref?: string;
  /** Center, in view units. */
  at: Point;
  r: number;
  /** Values safe to spread onto an SVG element. See `svgAttrs`. */
  attrs: Record<string, string | number>;
}

export interface GraphEdge {
  /** Local indices, as above. */
  source: number;
  target: number;
  /**
   * Endpoints already pulled back to the circle boundaries.
   *
   * Computed here rather than in CSS because it depends on both radii, and a
   * line drawn center-to-center under a translucent fill is visibly wrong in a
   * way that looks like a rendering bug rather than a geometry one.
   */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  attrs: Record<string, string | number>;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The square viewBox these coordinates are in. */
  size: number;
}

/**
 * A server-computed subgraph, for radii above 1.
 *
 * `edges` are pairs of LOCAL indices, in the same space as `GraphNode.index`.
 * `positions` are index-aligned with those local indices and are computed
 * server-side, warm-started, so the picture does not re-settle every time a
 * neighbor changes a watched attribute.
 */
export interface Subgraph {
  edges: Array<[number, number]>;
  positions?: Point[];
  /**
   * People in the picture with no entry in `neighbors`, above radius 1.5.
   *
   * Local indices `1 + neighbors.length` onward, in this array's order, so the
   * three groups concatenate: viewer, neighbors, these.
   */
  far?: FarNode[];
}

/** One endpoint, as handed to the attribute callbacks. */
export interface NodeRef {
  index: number;
  self: boolean;
  data: unknown;
  /**
   * Hops from the viewer: `0` for the viewer, `1` for a neighbor, more beyond.
   *
   * Worth styling on. A design that draws the second ring like the first is
   * telling a participant that somebody they cannot interact with is somebody
   * they can.
   */
  distance: number;
  /**
   * What this viewer calls a person they are not connected to.
   *
   * Present only beyond distance 1. It is not an id and not a seat — it is a
   * name that is this viewer's alone for that person, so two participants
   * comparing screens cannot line them up. Stable for the session, which is what
   * makes "the same stranger as last round" a question a design can ask.
   */
  ref?: string;
}

export interface GraphOptions {
  /** Square viewBox. Default 600, which is Breadboard's. */
  size?: number;
  /** Default 50, Breadboard's `egoNodeR`. */
  egoRadius?: number;
  /** Default 30, Breadboard's `alterNodeR`. */
  alterRadius?: number;
  /**
   * Radius of a node beyond distance 1. Default 18.
   *
   * Smaller than an alter by default, and deliberately so: a participant can act
   * on a neighbor and cannot act on anybody further out, so drawing the two the
   * same size would invite them to try. Breadboard has no value for this because
   * Breadboard never drew one.
   */
  farRadius?: number;
  /** Clearance between the outermost circle and the box. Default 10. */
  padding?: number;
  /**
   * Angle of the first alter, radians. Default `-Math.PI / 2`: straight up.
   *
   * Fixed rather than derived from anything, so a participant's own screen does
   * not rearrange itself between publishes.
   */
  rotation?: number;
  /**
   * Extra SVG attributes per node, from its data.
   *
   * This is the styling hook, and it is Breadboard's one genuinely good idea:
   * the server's value becomes an attribute, and the experiment is restyled in
   * CSS without touching the component.
   *
   *     nodeAttrs: (node) => ({ color: node.data?.color })
   *     // circle[color="green"] { fill: #1b9e77 }
   *
   * Called for the VIEWER's node too, with `self: true` and whatever was passed
   * as `self`. The viewer's own node is not decoration: in Shirado & Christakis
   * the participant's own circle carries their own chosen color, and a screen
   * that showed everyone's color but theirs would be a different task.
   */
  nodeAttrs?: (node: NodeRef) => Record<string, unknown> | undefined;
  /**
   * The same, per edge, given both endpoints.
   *
   * Both rather than "the far one" because above radius 1 an edge can join two
   * neighbors and have no far end to speak of. At the default radius one
   * endpoint is always the viewer, so the common case reads plainly:
   *
   *     edgeAttrs: (_, target) => ({ conflict: target.data?.color === mine })
   */
  edgeAttrs?: (source: NodeRef, target: NodeRef) => Record<string, unknown> | undefined;
  /**
   * Whether a server-sent subgraph is REQUIRED.
   *
   * Set it whenever the study is configured above radius 1. Without it, a
   * subgraph that fails to arrive degrades to a star — which is a correct,
   * ordinary-looking picture of a DIFFERENT study, and nothing anywhere would
   * say so. With it, `graphModelOf` returns `undefined` and the caller renders
   * its loading branch, exactly as it already does for `neighbors`.
   */
  expectSubgraph?: boolean;
}

const DEFAULTS = {
  size: 600,
  egoRadius: 50,
  alterRadius: 30,
  farRadius: 18,
  padding: 10,
  rotation: -Math.PI / 2,
};

/**
 * Where the alters sit.
 *
 * Exported because it is the geometry claim worth testing on its own: `degree`
 * evenly spaced points on a circle whose radius leaves both the alters and the
 * padding inside the box.
 *
 * `degree === 0` returns `[]` rather than throwing. An isolated node is a
 * legitimate state in a rewiring design — a defector can be abandoned — and it
 * is drawn as the viewer alone.
 */
export function egoRingLayout(degree: number, opts: GraphOptions = {}): Point[] {
  const size = opts.size ?? DEFAULTS.size;
  const alterRadius = opts.alterRadius ?? DEFAULTS.alterRadius;
  const padding = opts.padding ?? DEFAULTS.padding;
  const rotation = opts.rotation ?? DEFAULTS.rotation;

  const center = size / 2;
  const ring = center - alterRadius - padding;

  if (degree <= 0) return [];
  // A single alter is placed on the ring like any other rather than special
  // cased, so a degree-1 node looks like a degree-2 node with one tie dropped —
  // which, in a rewiring study, is exactly what it is.
  return Array.from({ length: degree }, (_, i) => {
    const angle = rotation + (2 * Math.PI * i) / degree;
    return { x: center + ring * Math.cos(angle), y: center + ring * Math.sin(angle) };
  });
}

/**
 * Build the whole picture.
 *
 * `neighbors` is what `useNeighbors()` returned, and the `undefined`/`[]`
 * distinction it carries is preserved rather than collapsed: `undefined` means
 * the server has not published, and returning a model for it would render the
 * viewer as isolated during startup, which looks entirely normal and is a data
 * validity bug rather than a cosmetic one (`src/player/view.ts`).
 */
export function graphModelOf(
  input: { neighbors: unknown[] | undefined; self?: unknown; subgraph?: Subgraph },
  opts: GraphOptions = {}
): GraphModel | undefined {
  const { neighbors, self, subgraph } = input;
  if (!neighbors) return undefined;
  // Above radius 1 the structure is the server's to send. Degrading to a star
  // here is the silent failure this flag exists to prevent.
  if (opts.expectSubgraph && !subgraph) return undefined;

  const size = opts.size ?? DEFAULTS.size;
  const egoRadius = opts.egoRadius ?? DEFAULTS.egoRadius;
  const alterRadius = opts.alterRadius ?? DEFAULTS.alterRadius;
  const farRadius = opts.farRadius ?? DEFAULTS.farRadius;
  const center = size / 2;

  const positions = subgraph?.positions;
  const ring = positions ? undefined : egoRingLayout(neighbors.length, opts);

  /**
   * The three groups, concatenated in the order the local indices name them.
   *
   * Built from the PAYLOAD and not from `neighbors` alone. That was the whole
   * bug this had to lose: with the node list taken from `neighbors`, a radius 2
   * payload produced a complete, internally consistent radius 1.5 picture, its
   * outer ring dropped and every edge touching it discarded by the guard below —
   * correct-looking, and about a study nobody was running.
   */
  const refs: NodeRef[] = [
    { index: 0, self: true, data: self, distance: 0 },
    ...neighbors.map((data, i) => ({ index: i + 1, self: false, data, distance: 1 })),
    ...(subgraph?.far ?? []).map((f, i) => ({
      index: 1 + neighbors.length + i,
      self: false,
      // `undefined` unless the study projected at distance, which is the
      // default. A far node is a shape and a name, not a person's data.
      data: f.view,
      distance: f.d,
      ref: f.ref,
    })),
  ];

  const nodes: GraphNode[] = refs.map((ref, i) => ({
    index: ref.index,
    self: ref.self,
    data: ref.data,
    distance: ref.distance,
    ...(ref.ref === undefined ? {} : { ref: ref.ref }),
    // A projection longer than the layout cannot happen through the hooks, but
    // `graphModelOf` is also called with hand-built inputs in tests and by
    // headless clients, and a missing point would otherwise produce NaN
    // coordinates, which SVG renders as nothing at all — an empty picture that
    // looks like a study with no ties.
    at: positions?.[i] ?? (ref.self ? { x: center, y: center } : ring?.[i - 1]) ?? {
      x: center,
      y: center,
    },
    r: ref.self ? egoRadius : ref.distance > 1 ? farRadius : alterRadius,
    attrs: svgAttrs(opts.nodeAttrs?.(ref)),
  }));

  const pairs: Array<[number, number]> = subgraph
    ? subgraph.edges
    : neighbors.map((_, i) => [0, i + 1] as [number, number]);

  const edges: GraphEdge[] = [];
  for (const [a, b] of pairs) {
    const from = nodes[a];
    const to = nodes[b];
    // A subgraph naming a node outside the delivered set is a server bug, and
    // drawing a line to (0,0) would hide it behind a picture that still looks
    // like a network. Dropped instead, and the loss is detectable by comparing
    // `edges.length` against what was sent.
    if (!from || !to || a === b) continue;
    edges.push({
      source: a,
      target: b,
      ...shorten(from.at, to.at, from.r, to.r),
      attrs: svgAttrs(opts.edgeAttrs?.(refs[a]!, refs[b]!)),
    });
  }

  return { nodes, edges, size };
}

/**
 * Pull a segment back to the two circle boundaries.
 *
 * Coincident centers have no direction to shorten along, so the segment is left
 * as the degenerate point rather than producing NaN — same reasoning as the
 * nudge in `admin/layout.ts`, and the case is reachable whenever a
 * server-sent layout has not separated two nodes yet.
 */
function shorten(
  from: Point,
  to: Point,
  fromR: number,
  toR: number
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  const ux = dx / dist;
  const uy = dy / dist;
  return {
    x1: from.x + ux * fromR,
    y1: from.y + uy * fromR,
    x2: to.x - ux * toR,
    y2: to.y - uy * toR,
  };
}

/**
 * Attribute names this module sets itself, or that mean something to the DOM.
 *
 * `id` is in here and it is the one worth explaining: every projection in this
 * repository's own examples carries `id: neighbor.id`, so passing it through
 * would put the SAME DOM id on several elements on the majority of real
 * screens. Nothing throws; `getElementById` simply starts answering with
 * whichever one came first.
 */
const RESERVED = new Set([
  "id",
  "class",
  "classname",
  "style",
  "transform",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "d",
  "points",
  "width",
  "height",
  "viewbox",
  "xmlns",
  "href",
  "key",
  "ref",
  "dangerouslysetinnerhtml",
]);

/**
 * Narrow an author-supplied object to what may be spread onto an SVG element.
 *
 * Deliberately a whitelist of shapes rather than a sanitiser. An attribute name
 * is restricted to lowercase, digits and dashes, which excludes every event
 * handler (`onClick` is not lowercase) and every namespaced name; a value is
 * restricted to a primitive, which excludes the object that would otherwise be
 * stringified to `[object Object]` and matched by nobody's CSS.
 *
 * Booleans become "1"/"0" rather than being dropped, because `line[conflict="1"]`
 * is the shipped Breadboard idiom and `conflict: true` is what an author writes.
 */
export function svgAttrs(
  source: Record<string, unknown> | undefined
): Record<string, string | number> {
  if (!source) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    if (RESERVED.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") out[key] = value ? "1" : "0";
    else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "string") out[key] = value;
  }
  return out;
}
