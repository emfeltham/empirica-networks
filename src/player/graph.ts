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
 */

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
}

/** One endpoint, as handed to the attribute callbacks. */
export interface NodeRef {
  index: number;
  self: boolean;
  data: unknown;
}

export interface GraphOptions {
  /** Square viewBox. Default 600, which is Breadboard's. */
  size?: number;
  /** Default 50, Breadboard's `egoNodeR`. */
  egoRadius?: number;
  /** Default 30, Breadboard's `alterNodeR`. */
  alterRadius?: number;
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
  const center = size / 2;

  const positions = subgraph?.positions;
  const ring = positions ? positions.slice(1) : egoRingLayout(neighbors.length, opts);
  const egoAt = positions?.[0] ?? { x: center, y: center };

  const refs: NodeRef[] = [
    { index: 0, self: true, data: self },
    ...neighbors.map((data, i) => ({ index: i + 1, self: false, data })),
  ];

  const nodes: GraphNode[] = refs.map((ref, i) => ({
    index: ref.index,
    self: ref.self,
    data: ref.data,
    // A projection longer than the layout cannot happen through the hooks, but
    // `graphModelOf` is also called with hand-built inputs in tests and by
    // headless clients, and a missing point would otherwise produce NaN
    // coordinates, which SVG renders as nothing at all — an empty picture that
    // looks like a study with no ties.
    at: ref.self ? egoAt : (ring[i - 1] ?? { x: center, y: center }),
    r: ref.self ? egoRadius : alterRadius,
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
