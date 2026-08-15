# minimal — a network experiment in ~40 lines

Participants sit on a ring and pick a colour. **Each sees only their two neighbours'
choices** — and not because the interface hides the rest: a non-neighbour's colour is never
sent to the browser at all.

This is a stock `empirica create` project with four files changed. The diff *is* the
documentation.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && npm run example:install

cd examples/minimal
empirica
```

`example:install` installs a **packed tarball** rather than linking the repo. That is not
ceremony: a `file:` link makes npm symlink to the repo root, whose own `node_modules` has a
second copy of `@empirica/core`, and two copies break every `instanceof` inside Empirica. The
symptom is every participant stuck on "Waiting for other players" with a full game. Details in
`docs/PLATFORM-NOTES.md` §11. Re-run `npm run example:install` after changing the package.

Then open **four** browser windows at the printed URL, each with a different
`?participantKey=`:

```
http://localhost:3000/?participantKey=one
http://localhost:3000/?participantKey=two
http://localhost:3000/?participantKey=three
http://localhost:3000/?participantKey=four
```

Enter a name in each, then pick colours.

## What to look for

Four is the smallest ring where the guarantee is visible: every participant has 2 neighbours
and **exactly 1 non-neighbour**. On a ring of 3 everyone is everyone's neighbour and the demo
proves nothing.

So in each window you should see 2 of the other 3 participants — and the pair you can see
differs from window to window. Change a colour and it appears in exactly two other windows,
live.

This is automated. From the repo root:

```sh
npm run test:browser
```

It boots this project, drives four real Chromium windows through consent, identifier and
intro, and checks the websocket frames each browser received:

```
    alpha sees: name-bravo, name-delta
    bravo sees: name-alpha, name-charlie
    charlie sees: name-bravo, name-delta
    delta sees: name-alpha, name-charlie
```

### An important limit this demo makes visible

The **projection** is neighbour-limited: no non-neighbour's projected view is ever sent to a
browser, and the test asserts that against the raw frames.

But this demo stores the colour with `player.set("color", …)`, and Empirica cross-links every
participant to every player node — so **that raw attribute is broadcast to everyone**, whatever
the topology. The browser test asserts this too, deliberately, so nobody discovers it by
accident later.

For a demo of network *structure* that is fine. For an experiment where the value itself must
be private, do not put it on the player scope — see the limits section of the root README.
`docs/PLATFORM-NOTES.md` §4b has the underlying behaviour.

You can also check the projection guarantee without a browser:

```sh
npx empirica-networks verify --n 4
```

## The four changes

| File | Change |
|---|---|
| `server/src/index.js` | `classicKinds` → `networkKinds` |
| `server/src/callbacks.js` | add `withNetwork(...)` |
| `client/src/App.jsx` | `modeFunc={EmpiricaClassic}` → `modeFunc={EmpiricaNetwork}` |
| `client/src/Game.jsx` | read `useNeighbors()` |

The `index.js` edit is **mandatory and silently fatal if skipped**: without the `nbhd` kind
registered, the private channels are never modelled, there is nothing to write views to, and
nothing errors — participants just sit with empty neighbourhoods forever.

`EmpiricaNetwork` is a *superset* of `EmpiricaClassic`, so `usePlayer`, `useGame`, `useStage`
and the rest of the intro/exit flow keep working untouched.

## Notes

`useNeighbors()` returns `undefined` until the first publish and `[]` only for a genuinely
isolated node, so `Game.jsx` branches on it before rendering. Conflating the two would show a
loading participant as isolated — which looks completely normal.

`watch: ["name", "color"]` is what keeps the view live. Anything `project()` reads that is
missing from that list is reported in the server log rather than silently going stale.

## What is covered by tests

`test/e2e/example.test.ts` in the repo root imports **this example's `callbacks.js`
unmodified** and runs it against a real server, so the server half cannot rot unnoticed. The
client half is compiled by `cd client && npm run build`, which catches import and JSX errors.
The visual two-window confirmation above is manual — see `docs/PLATFORM-NOTES.md` §8 for why
the hooks cannot be exercised headlessly.
