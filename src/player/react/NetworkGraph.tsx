import React from "react";
import type { GraphModel, GraphNode } from "../graph.js";

/**
 * The participant's neighborhood, drawn.
 *
 * Deliberately has nothing to decide. Geometry, identity, and which attributes
 * reach the DOM are all settled in `src/player/graph.ts`, which is pure and
 * therefore actually tested (PLATFORM-NOTES §8 — a hook cannot be rendered
 * against a synthetic mode in this codebase, so anything decided in here would
 * be held by nothing). What is left is `<line>`, `<circle>` and `<text>`, the
 * same division `src/admin/monitor/ui.ts` makes for the operator's view.
 *
 * NO DRAG, NO ZOOM, NO PAN, NO TOOLTIPS. Not an omission: Breadboard's client
 * has none of them either, and each one is a way for a participant to spend the
 * session exploring an interface instead of playing the game being measured.
 */

export interface NetworkGraphProps {
  /** From `useNetworkGraph()`. `undefined` means not ready — see `fallback`. */
  model: GraphModel | undefined;
  /**
   * Rendered instead of the graph while `model` is `undefined`.
   *
   * There is no default picture, on purpose. `undefined` covers both "the
   * server has not published yet" and "this study is above radius 1 and its
   * subgraph has not arrived", and drawing anything for either would show a
   * participant a network that is not theirs.
   */
  fallback?: React.ReactNode;
  /** Inside the viewer's circle. Breadboard's experiments set this to "You". */
  selfLabel?: React.ReactNode;
  /** Inside a neighbor's circle. Breadboard shows a score, or nothing. */
  label?: (node: GraphNode) => React.ReactNode;
  /**
   * One line of text per node, for the accessible summary.
   *
   * Worth supplying. The graph is a single `role="img"`, and in a design where
   * the state is carried by fill — which is most of them — a participant using
   * a screen reader has otherwise been handed a picture with no content. This
   * is the same relief rule `src/admin/monitor/ui.ts` applies to the operator's
   * view, and it matters more here, because this one is the task.
   */
  describe?: (node: GraphNode) => string;
  className?: string;
  ariaLabel?: string;
}

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function NetworkGraph({
  model,
  fallback = null,
  selfLabel = "You",
  label,
  describe,
  className,
  ariaLabel = "Your connections.",
}: NetworkGraphProps): React.ReactElement | null {
  if (!model) return <>{fallback}</>;

  const { nodes, edges, size } = model;

  return (
    <div className={className ? `nbhd nbhd-graph ${className}` : "nbhd nbhd-graph"}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Edges first so a circle always sits on top of the lines that reach
            it. They are already shortened to the circle boundaries, so this is
            layering for the stroke, not to hide bad geometry. */}
        <g className="nbhd-edges">
          {edges.map((e) => (
            <line
              key={`${e.source}-${e.target}`}
              className="nbhd-edge"
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              {...e.attrs}
            />
          ))}
        </g>

        <g className="nbhd-nodes">
          {nodes.map((n) => {
            const text = n.self ? selfLabel : label?.(n);
            return (
              <g
                key={n.index}
                className={n.self ? "nbhd-node nbhd-node-self" : "nbhd-node"}
                transform={`translate(${n.at.x},${n.at.y})`}
              >
                <circle r={n.r} {...n.attrs} />
                {text === null || text === undefined || text === "" ? null : (
                  <text
                    className="nbhd-label"
                    textAnchor="middle"
                    dominantBaseline="central"
                    // Not an event target: a label is decoration over a circle
                    // that may itself be one, and a click landing on the glyph
                    // instead of the node is the kind of intermittent failure
                    // nobody reproduces.
                    pointerEvents="none"
                  >
                    {text}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {describe ? (
        <ul style={VISUALLY_HIDDEN}>
          {nodes.map((n) => (
            <li key={n.index}>{describe(n)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
