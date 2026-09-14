# minimal — a network experiment in ~40 lines

Participants occupy a ring and choose a color. Each participant receives the choices of their two neighbors, while a non-neighbor's color remains absent from the browser's network traffic.

This example modifies four files in a stock `empirica create` project. The changes themselves provide a concise implementation guide.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && node scripts/example-install.mjs minimal

cd examples/minimal
empirica
```

`example:install` installs a packed tarball. An npm `file:` dependency instead creates a symbolic link to the repository root, whose `node_modules` directory contains a second copy of `@empirica/core`. The duplicate package causes Empirica's `instanceof` checks to fail and leaves every participant on “Waiting for other players” despite a full game. See `docs/PLATFORM-NOTES.md` §10 for details. Run `npm run example:install` again after changing the package.

Then open four browser windows at the printed URL, each with a different `?participantKey=`:

```
http://localhost:3000/?participantKey=one
http://localhost:3000/?participantKey=two
http://localhost:3000/?participantKey=three
http://localhost:3000/?participantKey=four
```

Enter a name in each, then pick colors.

## What to look for

Four is the smallest ring that demonstrates the guarantee: every participant has two neighbors and one non-neighbor. A three-person ring is a complete graph, so it provides no non-neighbor against which to test restricted delivery.

Each window should therefore display a different pair among the other three participants. A color change should appear immediately in exactly two other windows.

This is automated. From the repository root:

```sh
npm run test:browser
```

It starts this project, drives four real Chromium windows through consent, identifier and intro, and checks the websocket frames each browser received:

```
    alpha sees: name-bravo, name-delta
    bravo sees: name-alpha, name-charlie
    charlie sees: name-bravo, name-delta
    delta sees: name-alpha, name-charlie

    alpha: sees {name-bravo, name-delta} · charlie's color absent from wire ·
           charlie's name present (public player attribute)
```

### Seeing the ties among your own neighbors

By default each participant sees themselves and their connections — a star. Start the server with

```sh
NBHD_RADIUS=1.5 empirica
```

and they additionally see which of their connections are connected to **each other**. Nothing in
the client changes; the same component draws whatever the server sends.

The flag switches the topology too, and that is the instructive part rather than a convenience. A
ring has no ties among anyone's neighbors at all — your two neighbors sit on opposite sides of you
— so radius 1.5 on a ring draws exactly the same star. Whether a design has anything to show at
this radius is a property of its graph, not of the setting. Under the flag this example uses a ring
lattice, which is full of triangles, and needs `playerCount` of at least 5.

Decide about it rather than switching it on. It tells a participant a fact about two *other*
people, and on a coordination task it makes the problem easier — see `docs/API.md`.

### Two kinds of data

The example carries one of each, because the difference is the whole point:

| Field | Written with | Who can read it |
|---|---|---|
| `name` | `player.set("name", …)` | everyone — Empirica broadcasts every player scope |
| `color` | `state.set("color", …)` | only neighbors, via `project()` |

Colors are private because they are written to the participant's own channel, not to the player scope. If the example had used `player.set("color", …)`, as it did at first, the color would have been broadcast to every participant, and the promise on screen would have been false while looking exactly the same.

The browser test asserts both: a non-neighbor's color appears nowhere in the frames a tab received, and their name does. `docs/PLATFORM-NOTES.md` §4b has the underlying behavior.

You can also check the projection guarantee without a browser:

```sh
node ../../dist/verify/cli.cjs verify --n 4   # from this clone, after `npm run build`
npx empirica-networks verify --n 4            # once published
```

Options and exit codes: [`docs/API.md`](../../docs/API.md#the-verify-cli).

## The four changes

| File | Change |
|---|---|
| `server/src/index.js` | `classicKinds` → `networkKinds` |
| `server/src/callbacks.js` | add `withNetwork(...)` |
| `client/src/App.jsx` | `modeFunc={EmpiricaClassic}` → `modeFunc={EmpiricaNetwork}` |
| `client/src/Game.jsx` | read `useNeighbors()`, write with `useNetworkState()` |

The `index.js` edit is mandatory and fails silently if skipped: without the `nbhd` kind registered, the private channels are never modeled, there is nothing to write views to, and nothing errors — participants just sit with empty neighborhoods forever.

`EmpiricaNetwork` is a superset of `EmpiricaClassic`, so `usePlayer`, `useGame`, `useStage` and the rest of the intro/exit flow keep working untouched.

## Notes

`useNeighbors()` returns `undefined` until the first publish and `[]` only for a genuinely isolated node, so `Game.jsx` branches on it before rendering. Conflating the two would show a loading participant as isolated — which looks completely normal.

`watch: ["name", "color"]` is what keeps the view live. Anything `project()` reads that is missing from that list is reported in the server log rather than silently going stale.

## What is covered by tests

`test/e2e/example.test.ts` in the repository root imports this example's `callbacks.js` unmodified and runs it against a real server, so the server half cannot degrade without being noticed. The client half is compiled by `cd client && npm run build`, which catches import and JSX errors. The four-window confirmation is automated too, by `npm run test:browser`, using real Chromium against a real development server. What is not covered anywhere is the hooks in isolation: they cannot be mounted against a synthetic mode, for the reason given in `docs/PLATFORM-NOTES.md` §8.
