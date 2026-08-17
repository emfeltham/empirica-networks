# Getting started

The ordered path from nothing to a running network experiment whose privacy guarantee you have verified on your own machine. Read it once, top to bottom; each step names the trap that bites at that step rather than collecting them all at the end.

If you only want to see it work, skip to [§8](#8-run-a-reconstruction-of-a-published-experiment).

**Before anything else, read [the write-access warning in the README](../README.md#read-this-before-running-a-study-on-empirica).**
It affects every Empirica study, whether or not you use this package, and it is the one thing here that changes whether some designs should be run at all.

## 1. What this package does

Participants are nodes in a graph, and each participant receives only their neighbours' projected state. Not "the interface hides the rest" — the bytes never arrive. Each participant gets a private channel scope linked to them alone, and the server writes projections only there. The realised network and its seed are recorded on the batch scope, which participants cannot read, so a finished run is reproducible from stored data without handing the seating plan to the people inside it.

## 2. Install

Requires **Node 20+** and the Empirica CLI (`curl https://install.empirica.dev | sh`).

Start from a stock Empirica project — `empirica create my-study` — and add this package to *both* halves, because it ships server code and client code separately:

```sh
npm --prefix server install empirica-networks
npm --prefix client install empirica-networks
```

> **Not published yet.** The package is `"private": true` at `0.0.0` while an unpatched upstream
> vulnerability goes through disclosure (`docs/upstream/DISCLOSURE.md`, `PUBLICATION-PLAN.md`).
> Until then, install from a packed tarball: `npm pack` in this repo, then
> `npm --prefix server install /path/to/empirica-networks-0.0.0.tgz`. Commands below that show
> `npx empirica-networks` are what they become on publish; the from-a-clone form is given
> alongside.

> ### Trap: do NOT install with a `file:` link
>
> `"empirica-networks": "file:../empirica-networks"` makes npm create a **symlink**, and if the
> linked directory has its own `node_modules/@empirica/core` you end up with **two copies of
> Empirica** in one bundle. Every `instanceof` inside Empirica then fails against the other
> copy's classes.
>
> The symptom names nothing: **every participant stuck on "Waiting for other players" with a
> full game**, and a hundred zod stack traces mentioning neither this package nor the real cause.
> Counting strings in the bundle does not reveal it; comparing class identity does
> (`classicKinds.game === networkKinds.game` → `false`).
>
> Use a packed tarball instead. Measured and written up in `docs/PLATFORM-NOTES.md` §11.

## 3. The one mandatory edit — silently fatal if skipped

`AdminContext.init` takes the scope-kind map, and it lives in **your** `server/src/index.js`, not
inside the CLI. The private channel is a custom kind, so it has to be registered there:

```diff
  // server/src/index.js
- import { Classic, classicKinds, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { Classic, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { networkKinds } from "empirica-networks/admin";

  const ctx = await AdminContext.init(
    argv["url"], argv["sessionTokenPath"], "callbacks", argv["token"], {},
-   classicKinds
+   networkKinds
  );
```

`networkKinds` is `classicKinds` plus one entry. Skip this and the channels are never modelled, there is nothing to write views to, nothing errors, and participants simply sit with empty neighbourhoods forever.

> ### If you skip it, you get told — a few seconds into the first game
>
> ```
> empirica-networks: 2 private channels were created 5s ago and none has materialised. Two
> things do this, and this process cannot tell them apart.
>
> 1. THE "nbhd" SCOPE KIND IS NOT REGISTERED — the likely one, and silently fatal: …
> 2. The subscription is only slow. …
> ```
>
> To fail *before* the server starts instead, call the eager check where you build the map:
>
> ```js
> import { assertKindsRegistered, networkKinds } from "empirica-networks/admin";
> assertKindsRegistered(networkKinds);   // throws, with the diff above
> ```
>
> Worth knowing why this is two checks rather than one: `withNetwork` is handed the listeners
> collector, not the kind map, so it cannot verify the registration directly — it detects the
> *consequence*. And for four milestones neither check ran at all, while this document claimed
> one did (`ISSUES.md` O14).
>
> The wait is 5 s for a small study and grows with the participant count, because channel
> delivery queues behind Classic's game-start burst — at n=150 the first channel has been
> measured taking 4.3 s on a healthy server (`ISSUES.md` O15). If the warning turns out to have
> been impatient, the package retracts it in the same log rather than leaving you with an
> accusation it cannot support.

`docs/PLATFORM-NOTES.md` §6.

## 4. Declare the network

```js
// server/src/callbacks.js
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
import { topology, withNetwork } from "empirica-networks/admin";

export const Empirica = new ClassicListenersCollector();

export const net = withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),
  project: (neighbour, viewer, ctx) => ({
    id: neighbour.id,
    choice: ctx.stateOf(neighbour).get("choice"),
  }),
  watch: ["choice"],
  read: ["submission"],
});
```

`project()` is the only path by which one participant's data reaches another. Return plain
data — returning the scope itself is refused, because a scope holds a reference to the global
attribute store and publishing one would ship every attribute of every participant to that
client.

**Declare every private key, in one of the two lists.** `watch` is for keys `project()` reads —
a change republishes the views that can see it. `read` is for keys only your server consumes: a
submitted answer, a decision. They behave identically, so putting a key in the wrong one is
harmless; leaving it out of both is not.

Read a declared key back with `net.stateOf(gameID, playerID, key)`:

```js
Empirica.onStageEnded(({ stage }) => {
  const answer = net.stateOf(stage.currentGame.id, playerID, "submission");
  // `undefined` here means exactly one thing: they did not submit.
});
```

> ### Trap: the read that returns `undefined` instead of failing
>
> `net.inspect().nodes[i].state[key]` gives you the same values, and returns `undefined` for an
> undeclared key, an ended game, a player outside the graph, and a participant whose channel has
> not materialised — all of which look identical to "they have not written it yet".
>
> That is how the Rand 2011 reconstruction ran a whole study in which the manipulation did
> nothing: `rewireAnswers` was undeclared, every answer read back as "not submitted", and the
> network never changed in the condition whose defining feature is that it changes. Every screen
> looked right and nothing errored. `ISSUES.md` O11.
>
> `stateOf()` throws for all four, naming the fix. Use `inspect()` for the seating plan and for
> the monitor; use `stateOf()` for anything a listener acts on.

To act the *moment* a participant writes one of those keys, add `onPrivateState`:

```js
withNetwork(Empirica, {
  watch: ["color"],
  onPrivateState: ({ gameID, playerID, key, value }) => {
    if (key !== "color") return;
    // …decide whether the round is over
  },
});
```

Player ids and values, never scopes. It arrives after the republish that write triggered, so a
handler that ends the stage does it with everyone's view already current — and it must be
**synchronous**, because a write after an `await` inside it lands outside the runloop's flush and
reaches nobody.

## 5. Write participant state to the right place

This is the step that decides whether your manipulation is real.

```jsx
// client/src/Game.jsx
import { useNeighbors, useNetworkState } from "empirica-networks/player/react";

const state = useNetworkState();

state.set("choice", "A");    // ✓ private: goes to this participant's own channel
player.set("choice", "A");   // ✗ BROADCAST to every participant, whatever your topology
```

Empirica cross-links every participant to every player node, so **anything written with
`player.set()` is readable by everyone**. Projecting such a value restricts nothing — the raw
attribute is already out, and the experiment runs, the screens look right, and the network has
stopped being the manipulation.

The mirror of this on the server: read neighbour state through `ctx.stateOf(neighbour)`, not
`neighbour.get(...)`.

And install the mode, or none of the hooks have anything to read:

```jsx
// client/src/App.jsx
import { EmpiricaNetwork } from "empirica-networks/player";
<EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>
```

`EmpiricaNetwork` is a superset of `EmpiricaClassic`, so `usePlayer`, `useGame`, `useStage` and
the whole intro/exit flow keep working.

> ### Trap: `useNeighbors()` returns `undefined` before the first publish
>
> And `[]` **only** for a genuinely isolated node. Those are not the same, and the hook refuses
> to conflate them: returning `[]` while loading would render a participant as isolated, look
> entirely normal, and quietly corrupt the data. Branch on it the way you already branch on
> `usePlayer()`.

## 6. Your own listeners

Two constraints, both of which fail silently.

**Register each lifecycle helper exactly once.** `onGameStart`, `onRoundStart`, `onStageStart`,
`onStageEnded`, `onRoundEnded` and `onGameEnded` are wrapped in a `unique` guard whose "already
ran" marker is stored on the *scope*, so it is shared by every listener for that event. **The
first callback to run sets it and every later one silently returns.** Splitting handlers by
concern is the obvious structure and it does not work:

```js
// ✗ the second one never runs, ever
Empirica.onStageEnded(({ stage }) => { if (stage.get("name") === "decide") … });
Empirica.onStageEnded(({ stage }) => { if (stage.get("name") === "rewire") … });

// ✓ one registration, dispatch inside
Empirica.onStageEnded(({ stage }) => {
  const name = stage.get("name");
  if (name === "decide") scoreRound(stage);
  else if (name === "rewire") applyRewireRound(stage);
});
```

Plain `Empirica.on(kind, key, cb)` is **not** affected. `docs/PLATFORM-NOTES.md` §18.

Empirica itself gives you nothing here, so `withNetwork` counts your registrations when the server
starts and warns if it finds a duplicate:

```
empirica-networks: a lifecycle listener is registered more than once, and ONLY THE FIRST WILL EVER RUN.

    onStageEnded()  registered 2 times  (stage/ended)
```

**Read the warning rather than trusting it blindly.** It cannot tell a duplicated helper from two
plain `Empirica.on("stage", "ended", cb)` calls when both callbacks are anonymous 2-argument async
functions — those are legitimate and all of them run. The message says so. And it can only detect
what it can see, so treat it as a net under the rule above, not a replacement for it.

**Writes only count inside a callback.** The runloop flushes the `set()` calls made while it is
processing one. A mutation driven from a timer, an HTTP handler or a test updates the server's
own state correctly and then **reaches nobody**, with no error. Reads are safe anywhere.

```js
Empirica.onStageStart(({ stage }) => {
  network(stage.currentGame).addEdge(a, b);   // ✓
});
setInterval(() => network(game).addEdge(a, b), 1000);   // ✗ silently reaches nobody
```

## 7. Verify the guarantee, rather than believing this document

The read guarantee ships as a command:

```sh
npx empirica-networks verify --n 4        # once published
node dist/verify/cli.cjs verify --n 4     # from a clone today
```

It boots a real Tajriba, connects four headless participants on a ring, and checks the raw wire:

```
  non-neighbour sentinels received : 0   (must be 0)
  neighbour sentinels delivered    : 8/8 (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)

  PASS
```

Three arms, all required. A clean result with a silent control means the check is blind; a clean
result with nothing delivered means the projection never ran. Most privacy tests are wrong in
exactly one of those two ways.

## 8. Run a reconstruction of a published experiment

Two complete designs ship in this repository, both rebuilt from their papers and both covered by the test suite. Start here if you want to see what a real study looks like rather than a demo:

- **[`examples/rand2011`](../examples/rand2011)** — Rand, Arbesman & Christakis (2011), PNAS. Cooperation in dynamic networks: rewiring during play, private cooperation decisions, four conditions.
- **[`examples/shirado2017`](../examples/shirado2017)** — Shirado & Christakis (2017), Nature. The colour coordination game: a static scale-free network, continuous play, and a global objective participants cannot see.
- **[`examples/minimal`](../examples/minimal)** — the smallest thing that demonstrates the guarantee. Four files changed from a stock project.

`docs/EXPERIMENTS.md` says what each one demonstrates, what was left out, and — importantly — what "reconstruction" means and why it is not "replication".

## 9. Get the data out

```js
// In your callbacks (server-side, inside the Empirica CLI):
import { network } from "empirica-networks/admin";
// In an analysis script you run yourself with plain `node`:
import { edgeRows, snapshotRows, toCSV, viewRows } from "empirica-networks/export";

const history = network(game).history();
toCSV(edgeRows(game.id, history));       // game_id, t, event, player_a, player_b
toCSV(snapshotRows(game.id, history));   // the full edge list at each event
```

These take a game id and an event log, not Empirica objects, so the same functions run offline over data collected months ago. `edges.csv` includes the initial graph, so a study that never rewires still exports its network rather than an empty file.

**Turn on view capture if `project()` does anything beyond passing values through** — bucketing, adding noise, reading `stateOf()`. Views are published `ephemeral`, so nothing durable holds them, and what a participant was *actually told* cannot be reconstructed afterwards from the edge log plus an attribute export. Those give what someone *could* have known.

```js
withNetwork(Empirica, { …, views: { file: "data/views.ndjson" } });
```

Then flatten offline with `viewRows()`, reading the file back with `parseNdjson()`. Both reconstructions do this; see their READMEs for the table layouts.

**And turn on the run log, because your CSVs are written when the game ENDS.** A study that is killed, crashes, or is stopped never gets there — and after `ISSUES.md` U2 a crash mid-study is the *normal* shape of something going wrong, since a restarted server cannot resume a game anyway. Measured: a green run of the Rand 2011 reconstruction's own tests left a views log and not one CSV.

```js
withNetwork(Empirica, { …, log: { file: "data/run.ndjson" } });

Empirica.onStageEnded(({ stage }) => {
  net.log(stage.currentGame, { type: "round", round, rows });   // gameID and at are stamped on
});
```

One file for the whole study — every record carries its `gameID` — and every record is on disk as it is written, with no buffer, because a log whose purpose is surviving a kill should not be holding its newest rows in memory. `net.log` throws if you never configured a log, so a study cannot quietly record nothing. Both reconstructions ship a `recover.mjs` that rebuilds their CSVs from it, byte-identically to a clean finish.

## 10. Know the limits before you commit to a design

| | |
|---|---|
| **Target regime** | **n ≤ 50, at any density.** Everything is measured with margin here, including complete graphs |
| Sparse (d ≤ 16), n ≤ 150 | measured on this implementation; see the README's envelope table |
| n ≥ 200 | **games do not reliably start** — 1 run in 6. Upstream, reproduces with stock Classic (`ISSUES.md` U7) |
| Dense graphs above n = 50 | unmeasured, and capped at degree 16 by default. Per-participant payload is O(degree), so this is where client bandwidth binds |
| Sessions beyond ~10 minutes | unverified |

Degree is not the thing to watch — **degree × how much you project per neighbour** is. That product
is what a participant's connection carries, and `maxNeighbourhoodBytes` (64 KiB) caps it, because
many individually reasonable views can add up while every other limit stays happy.

**A crashed study cannot be resumed.** A full server restart never reassigns participants to their game — the store reloads, but `gameID` is never restored and no game resumes. It can also leave two player scopes for one participant. This is upstream (`ISSUES.md` U2) and no amount of documentation or configuration changes it, so plan for a crash mid-study to end the games in progress.

## Where to go next

| | |
|---|---|
| [`README.md`](../README.md) | the API reference, with the reasoning behind each decision |
| [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | when something is silently wrong. Indexed by symptom rather than by cause |
| [`docs/DATA-AND-ANALYSIS.md`](DATA-AND-ANALYSIS.md) | §9 above in full: every table's columns, and reproducing a finished run |
| [`docs/DEPLOYING.md`](DEPLOYING.md) | **before you plan a real study** — the pre-flight checklist, and what is not yet documented |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | how it works inside, if you want to know why any of the above is true |
| [`docs/EXPERIMENTS.md`](EXPERIMENTS.md) | the two reconstructions: what they show, and what they are not |
| [`docs/PLATFORM-NOTES.md`](PLATFORM-NOTES.md) | every platform constraint, with the date and version it was measured against |
| [`docs/GLOSSARY.md`](GLOSSARY.md) | channel, projection, view, seat, told, envelope, U-numbers |
| [`ISSUES.md`](../ISSUES.md) | what is known to be broken, ours and upstream's |
| `MODULE-DESIGN.md` | why the package is shaped the way it is. Not in this repo — it is kept with the investigation that produced it |
