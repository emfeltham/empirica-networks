# minimal — a network experiment in ~40 lines

Participants sit on a ring and pick a colour. **Each sees only their two neighbours' choices** — and not because the interface hides the rest: a non-neighbour's colour is never sent to the browser at all.

This is a stock `empirica create` project with four files changed. The diff *is* the documentation.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && node scripts/example-install.mjs minimal

cd examples/minimal
empirica
```

`example:install` installs a **packed tarball** rather than linking the repo. That is not ceremony: a `file:` link makes npm symlink to the repo root, whose own `node_modules` has a second copy of `@empirica/core`, and two copies break every `instanceof` inside Empirica. The symptom is every participant stuck on "Waiting for other players" with a full game. Details in `docs/PLATFORM-NOTES.md` §11. Re-run `npm run example:install` after changing the package.

Then open **four** browser windows at the printed URL, each with a different `?participantKey=`:

```
http://localhost:3000/?participantKey=one
http://localhost:3000/?participantKey=two
http://localhost:3000/?participantKey=three
http://localhost:3000/?participantKey=four
```

Enter a name in each, then pick colours.

## What to look for

Four is the smallest ring where the guarantee is visible: every participant has 2 neighbours and **exactly 1 non-neighbour**. On a ring of 3 everyone is everyone's neighbour and the demo doesn't demonstrate the neighbor-only effect.

So in each window you should see 2 of the other 3 participants — and the pair you can see differs from window to window. Change a colour and it appears in exactly two other windows, live.

This is automated. From the repo root:

```sh
npm run test:browser
```

It boots this project, drives four real Chromium windows through consent, identifier and intro, and checks the websocket frames each browser received:

```
    alpha sees: name-bravo, name-delta
    bravo sees: name-alpha, name-charlie
    charlie sees: name-bravo, name-delta
    delta sees: name-alpha, name-charlie

    alpha: sees {name-bravo, name-delta} · charlie's colour absent from wire ·
           charlie's name present (public player attribute)
```

### Two kinds of data

The demo carries one of each, because the difference is the whole point:

| Field | Written with | Who can read it |
|---|---|---|
| `name` | `player.set("name", …)` | **everyone** — Empirica broadcasts every player scope |
| `color` | `state.set("color", …)` | only neighbours, via `project()` |

Colours are private because they are written to the participant's **own channel**, not to the player scope. Had the demo used `player.set("color", …)` — as it did at first — the colour would have been broadcast to every participant and the promise on screen would have been false, while looking exactly the same.

The browser test asserts both: a non-neighbour's colour appears nowhere in the frames a tab received, and their name does. `docs/PLATFORM-NOTES.md` §4b has the underlying behaviour.

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

The `index.js` edit is **mandatory and silently fatal if skipped**: without the `nbhd` kind registered, the private channels are never modelled, there is nothing to write views to, and nothing errors — participants just sit with empty neighbourhoods forever.

`EmpiricaNetwork` is a *superset* of `EmpiricaClassic`, so `usePlayer`, `useGame`, `useStage` and the rest of the intro/exit flow keep working untouched.

## Notes

`useNeighbors()` returns `undefined` until the first publish and `[]` only for a genuinely isolated node, so `Game.jsx` branches on it before rendering. Conflating the two would show a loading participant as isolated — which looks completely normal.

`watch: ["name", "color"]` is what keeps the view live. Anything `project()` reads that is missing from that list is reported in the server log rather than silently going stale.

## What is covered by tests

`test/e2e/example.test.ts` in the repo root imports **this example's `callbacks.js` unmodified** and runs it against a real server, so the server half cannot rot unnoticed. The client half is compiled by `cd client && npm run build`, which catches import and JSX errors. The four-window confirmation is automated too, by `npm run test:browser` — real Chromium against a real dev server. What is NOT covered anywhere is the hooks in isolation: they cannot be mounted against a synthetic mode, for the reason in `docs/PLATFORM-NOTES.md` §8.
