# minimal — a network experiment in ~40 lines

Participants sit on a ring and pick a color. Each participant sees only their two neighbors' choices, and not merely because the interface hides the rest: a non-neighbor's color is never sent to the browser at all.

This is a stock `empirica create` project with four files changed. The diff is the documentation.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && node scripts/example-install.mjs minimal

cd examples/minimal
empirica
```

`example:install` installs a packed tarball rather than linking the repository. This is necessary because a `file:` link makes npm create a symbolic link to the repository root, whose own `node_modules` directory has a second copy of `@empirica/core`, and two copies break every `instanceof` check inside Empirica. The symptom is every participant stuck on "Waiting for other players" with a full game. Details in `docs/PLATFORM-NOTES.md` §11. Re-run `npm run example:install` after changing the package.

Then open four browser windows at the printed URL, each with a different `?participantKey=`:

```
http://localhost:3000/?participantKey=one
http://localhost:3000/?participantKey=two
http://localhost:3000/?participantKey=three
http://localhost:3000/?participantKey=four
```

Enter a name in each, then pick colors.

## What to look for

Four is the smallest ring where the guarantee is visible: every participant has 2 neighbors and exactly 1 non-neighbor. On a ring of 3 everyone is everyone's neighbor, and the example does not demonstrate the neighbor-only effect.

So in each window you should see 2 of the other 3 participants — and the pair you can see differs from window to window. Change a color and it appears in exactly two other windows, live.

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
