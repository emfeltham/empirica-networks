/**
 * The hooks, actually rendered.
 *
 * Scope of what this can prove is limited, and the limit is structural: the
 * hooks read `ParticipantCtx`, which @empirica/core does not export, and the
 * only public way to provide it — `<EmpiricaParticipant>` — eagerly opens a
 * retrying websocket in its constructor (measured 2026-08-14: the process never
 * exits). So a mounted hook cannot be fed a synthetic mode without reaching into
 * internals, which would defeat the point of a public-API-only test suite.
 *
 * What IS covered here is the state every session actually starts in — mounted,
 * no participant context yet — where a crash would take down the whole app on
 * first paint. Plus that the hooks obey the rules of hooks at all, which is not
 * checked anywhere else.
 *
 * Behaviour after a publish is covered by view.test.ts against real Nbhd
 * instances. Confirming that a publish repaints the DOM needs a browser and is
 * deferred to the M2 Playwright smoke test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  useNbhd,
  useNeighbors,
  useNetworkSelf,
} from "../../src/player/react/index.js";

/** Render `el` and return what it rendered, or the error it threw. */
function render(el: ReactElement): { output: unknown; error?: Error } {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = TestRenderer.create(el);
    });
    const output = renderer!.toJSON();
    act(() => renderer!.unmount());
    return { output };
  } catch (e) {
    return { output: undefined, error: e as Error };
  }
}

function probe(hook: () => unknown) {
  const seen: unknown[] = [];
  const Probe = () => {
    seen.push(hook());
    return null;
  };
  return { Probe, seen };
}

for (const [name, hook] of [
  ["useNbhd", useNbhd],
  ["useNeighbors", useNeighbors],
  ["useNetworkSelf", useNetworkSelf],
] as const) {
  test(`${name}: mounts and returns undefined before a participant context exists`, () => {
    const { Probe, seen } = probe(hook);
    const { error } = render(createElement(Probe));

    assert.equal(error, undefined, `${name} threw on mount: ${error?.message}`);
    assert.ok(seen.length > 0, "the hook ran");
    assert.equal(
      seen[seen.length - 1],
      undefined,
      "not-ready is undefined — a component can branch on it, as with usePlayer()"
    );
  });
}

test("hooks are legal to call more than once in one component", () => {
  // useNeighbors and useNetworkSelf each call useNbhd internally, so any
  // component using both calls the underlying hooks twice. React only tolerates
  // that if the call order is unconditional, which is why useNbhd's
  // mode-not-installed guard is a render-time throw rather than an early return.
  const Probe = () => {
    useNbhd();
    useNeighbors();
    useNetworkSelf();
    useNeighbors();
    return null;
  };

  const { error } = render(createElement(Probe));
  assert.equal(error, undefined, `hook order violation: ${error?.message}`);
});

test("re-rendering does not throw or change the not-ready answer", () => {
  const { Probe, seen } = probe(useNeighbors);
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  act(() => {
    renderer!.update(createElement(Probe));
  });
  act(() => renderer!.unmount());

  assert.ok(seen.length >= 2, "rendered more than once");
  assert.ok(
    seen.every((v) => v === undefined),
    "stays undefined while there is no context, rather than flipping to []"
  );
});
