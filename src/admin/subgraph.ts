/**
 * The closed neighborhood, in LOCAL indices.
 *
 * What radius 1.5 adds to a participant's screen: the ties BETWEEN their own
 * neighbors. Radius 1 — the default, and what Breadboard drew — is a star built
 * entirely from data the browser already has, so it needs none of this. A tie
 * between two of your neighbors is a fact about two other people, `project()`
 * runs over one neighbor at a time and cannot express it, and so this is a
 * genuine addition to what a participant is told. It is opt-in for that reason
 * and not because it is expensive.
 *
 * IDENTITY IS POSITIONAL, AND THAT IS THE WHOLE TRICK. The edges that go out are
 * pairs of indices into the array the viewer already holds: 0 is the viewer,
 * 1..d are `neighbors[0..d-1]` in order. Nothing else would do. The server's own
 * indices are a SEATING PLAN — PLATFORM-NOTES §4b, locked by
 * `test/e2e/topology_visibility.test.ts` — and sending them would hand every
 * participant a stable name for everybody in the study, which is a larger
 * disclosure than the ties themselves. A local index names the k-th entry of an
 * array this browser was already sent, and tells its holder nothing they did not
 * have. It also needs no cooperation from the author's `project()`, whose shape
 * the author chooses and this module cannot assume.
 *
 * Zero imports, so it is unit tested in milliseconds — same rule as `seed.ts`
 * and `projection.ts`.
 */

/** A pair of LOCAL indices, always `a < b`. */
export type LocalEdge = [number, number];

/**
 * Induce the subgraph on `nodes`, and relabel it to positions within `nodes`.
 *
 * `nodes` is the delivered neighborhood in delivery order: `nodes[0]` is the
 * viewer's own topology index and the rest are the neighbors ACTUALLY PUBLISHED
 * to them, which is not always `adj[viewer]`. A neighbor whose player has gone,
 * or whose `project()` returned `undefined`, is dropped from the view — so
 * deriving the mapping from the adjacency list instead of from the delivered
 * list is off by one for everybody after the gap. That failure draws a complete,
 * well-formed graph connecting the wrong people, which is why the caller passes
 * the list it actually sent rather than the list it started from.
 *
 * Self-loops and repeats in `nodes` are ignored rather than rejected: both are
 * server bugs, and a drawing that silently omits an impossible tie is a better
 * outcome than a throw inside the publish path, which would take the whole
 * game's views down with it.
 */
export function inducedEdges(adj: number[][], nodes: number[]): LocalEdge[] {
  const local = new Map<number, number>();
  for (const [at, node] of nodes.entries()) if (!local.has(node)) local.set(node, at);

  const edges: LocalEdge[] = [];
  for (const [at, node] of nodes.entries()) {
    for (const other of adj[node] ?? []) {
      const there = local.get(other);
      // `there > at` rather than `!== at`: each pair is emitted once, and the
      // comparison also drops the self-loop case without a second test.
      if (there === undefined || there <= at) continue;
      edges.push([at, there]);
    }
  }
  return edges;
}

/**
 * A stable key for "is this the same picture".
 *
 * Sorted, so an edge list that arrives in a different order after a rewire does
 * not count as a shape change — the same reason `monitor/payload.ts` sorts
 * before comparing. Recomputing a layout on a graph that did not change moves
 * every node for no reason, and a participant watching their neighborhood for a
 * change would see one that is not there.
 */
export function edgeKey(edges: LocalEdge[]): string {
  return edges
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(" ");
}

/**
 * How many ties this subgraph carries BEYOND the star.
 *
 * The quantity that says whether radius 1.5 is delivering anything. A run where
 * it is zero everywhere is not a pass — it is a study that published the extra
 * channel and put nothing in it, which looks identical to a working one from
 * every screen. `test/e2e/subgraph.test.ts` fails on it.
 */
export function beyondStar(edges: LocalEdge[]): number {
  return edges.filter(([a, b]) => a !== 0 && b !== 0).length;
}
