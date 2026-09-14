import React from "react";

/**
 * The base stylesheet, as a string.
 *
 * A string rather than a `.css` file for the reason `src/admin/monitor/ui.ts`
 * gives for the same choice: a file would have to be copied into `dist` by a
 * build step tsup does not do by default, and then resolved at runtime — two
 * ways to ship a component whose styling is missing only on the consumer's
 * machine. It also means a Vite app needs no CSS import and no bundler plugin.
 *
 * COLOR AND THE RELIEF RULE. The palettes below are Breadboard's own, taken
 * from the stylesheets shipped inside its experiment archives. `DARK2` is
 * ColorBrewer Dark2, which Shirado & Christakis state in their SI was chosen to
 * be color-blind safe — which matters far more here than in the operator's
 * monitor, because in a coloring game the fill IS the task: a participant who
 * cannot separate two fills cannot play. Any substitute palette must clear the
 * same bar, and a design carrying state in fill should also pass `describe` to
 * `<NetworkGraph>` so the state exists in text as well.
 */
export const NETWORK_GRAPH_CSS = `
/*
 * The two-pane screen: neighborhood on the left, instructions and choices on
 * the right, stacking below 800px. Breadboard's own proportions and colors.
 *
 * Shipped here as plain CSS rather than left to the consumer's utility
 * framework, and that is not tidiness. Built with utility classes it depended on
 * the ORDER the framework emitted them in, and the order differed between the
 * dev server and the production build: a \`md:flex-row\` that won in \`vite build\`
 * lost to \`flex-col\` under \`vite dev\`, so the screen researchers develop
 * against and the screen their participants get were laid out differently, with
 * nothing failing in either. The manuscript figure is captured from the dev
 * server, which is how it was found.
 */
.nbhd-split { display: flex; flex-direction: row; height: 100%; min-height: 0; }
.nbhd-split > .nbhd-pane-graph {
  width: 50%; min-width: 0; background: #fff; padding: 16px; box-sizing: border-box;
}
.nbhd-split > .nbhd-pane-side {
  width: 50%; min-width: 0; overflow: auto; box-sizing: border-box;
  background: #eee; border-left: 2px solid #ddd; padding: 24px;
}
@media (max-width: 800px) {
  .nbhd-split { flex-direction: column; }
  .nbhd-split > .nbhd-pane-graph { width: 100%; height: 30%; }
  .nbhd-split > .nbhd-pane-side { width: 100%; height: 70%; border-left: 0; border-top: 2px solid #ddd; }
}

/*
 * TWO SCOPES, deliberately. \`.nbhd\` says how a mark LOOKS; \`.nbhd-graph\` says
 * how the canvas is SIZED, and carries both. Folding them into one is the
 * obvious thing and it is wrong: a design that draws a single node inline — a
 * rewiring offer about somebody who is not on your graph, which is exactly when
 * one is needed — would then inherit \`width: 100%\` and fill its container. It
 * did, and the screen still looked like a screen.
 */
.nbhd-graph { position: relative; width: 100%; height: 100%; min-height: 0; }
.nbhd-graph > svg { width: 100%; height: 100%; display: block; }

/* Breadboard's own values: alters r=30, ego r=50, 3px #333 strokes. */
.nbhd .nbhd-edge { stroke: #333; stroke-width: 3px; }
.nbhd circle { stroke: #333; stroke-width: 3px; fill: #999; }
.nbhd .nbhd-label {
  font-family: 'Open Sans', system-ui, sans-serif;
  font-weight: 700;
  font-size: 14px;
  fill: #000;
  user-select: none;
}
.nbhd .nbhd-node-self .nbhd-label { font-size: 18px; }
`;

/**
 * The coordination palette: ColorBrewer Dark2, as Shirado & Christakis used it.
 *
 * Matched on an attribute rather than a class so the value the SERVER published
 * is the value the CSS selects on — the pattern that let Breadboard's
 * researchers restyle an experiment without touching its client. `nodeAttrs`
 * puts it there.
 */
export const DARK2_CSS = `
.nbhd circle[color="green"]  { fill: #1b9e77; }
.nbhd circle[color="orange"] { fill: #d95f02; }
.nbhd circle[color="purple"] { fill: #7570b3; }
.nbhd circle[color="pink"]   { fill: #e7298a; }
.nbhd circle[color="yellow"] { fill: #e6ab02; }
.nbhd circle[color="lime"]   { fill: #66a61e; }
.nbhd circle[color="brown"]  { fill: #a6761d; }
.nbhd circle[color="grey"]   { fill: #666666; }

/* A tie between two nodes that share a color. Thick and red because it is the
   one thing on the screen the participant is being asked to remove. */
.nbhd line[conflict="1"] { stroke: #d62728; stroke-width: 12px; }
`;

/**
 * The cooperation palette, from Breadboard's public-goods experiment.
 *
 * Faded until a choice exists, which is load-bearing rather than decorative: it
 * distinguishes "chose to defect" from "has not chosen", and those are
 * different facts about a neighbor that a single grey fill would merge.
 */
export const COOPERATION_CSS = `
.nbhd circle[action="C"] { fill: #DD6E00; }
.nbhd circle[action="D"] { fill: #5C9CCC; }
.nbhd-graph circle:not([action]) { fill: #999; fill-opacity: 0.5; }

/* A rewiring decision: everything recedes except the tie under consideration. */
.nbhd line[focal="0"] { stroke-opacity: 0.3; }
.nbhd line[breaking="1"] { stroke: #d62728; stroke-dasharray: 5 5; stroke-width: 5px; }
.nbhd line[making="1"]   { stroke: #2ca02c; stroke-dasharray: 5 5; stroke-width: 5px; }
`;

/**
 * Drop the stylesheet into the page.
 *
 *     <NetworkGraphStyles extra={DARK2_CSS} />
 *
 * Rendered as a plain `<style>` rather than injected into `document.head`, so
 * it unmounts with the component and two screens cannot fight over it.
 */
export function NetworkGraphStyles({ extra }: { extra?: string }): React.ReactElement {
  return <style>{extra ? `${NETWORK_GRAPH_CSS}\n${extra}` : NETWORK_GRAPH_CSS}</style>;
}
