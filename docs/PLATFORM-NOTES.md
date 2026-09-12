# Platform constraints, verified

Everything here was checked at runtime against `@empirica/core@1.12.5` and
`@empirica/tajriba@1.7.3` on 2026-08-14, rather than read from documentation. The checks should
be re-run when either dependency is updated, since several of these are the kind of thing that
changes silently.

`SPIKE-REPORT.md`, cited below and in a few error messages, is the measurement record from the
investigation that preceded this package. It is not published with it, so those citations name
where a number came from rather than a file you can open; the numbers themselves, and what each
one does and does not license, are reproduced here and in `docs/TESTING.md`.

## 1. `@empirica/core/player` imports cleanly under bare Node (confirmed)

There is no CSS problem. The source has `import "./index.css"` in `player/index.ts`, but tsup
emits CSS as separate files (`dist/player.css` etc.) and strips the import from the JavaScript.
A Node-side import of `@empirica/core/player` works with no loader or stub.

Confirmed available from `@empirica/core/player`: `TajribaProvider`, `Scopes`, `Scope`,
`Attributes`, `Steps`.

## 2. All seven client Scope classes are public (confirmed)

`@empirica/core/player/classic` exports `EmpiricaClassic` plus `Game`, `Player`, `PlayerGame`,
`PlayerRound`, `PlayerStage`, `Round`, `Stage`.

The `kinds` object itself is not exported, but it is an eight-line reconstruction from these
classes. This is what makes composing a custom participant mode possible without vendoring the
package.

## 3. `@empirica/tajriba` cannot be imported under bare Node ESM (caution)

This is the most consequential finding for this package's build.

```
node ESM     -> ERR_UNSUPPORTED_DIR_IMPORT
tsx          -> works
esbuild CJS  -> works
```

Cause: `@empirica/tajriba/dist/index.js` does `import "cross-fetch/polyfill"`, and
`cross-fetch@4.0.0` ships `polyfill/` as a bare directory with a `package.json` `main` and no
`exports` map. Directory imports are not resolvable in ESM.

`cross-fetch@4.1.0` still has no `exports` map, so an npm `overrides` update does not fix it.

This propagates to everything that depends on tajriba: `@empirica/core/admin` and
`@empirica/core/admin/classic` both fail to import under bare Node ESM.

Two consequences follow, both already encoded in the build:

- Development and tests run under tsx, not bare `node`. This is a requirement, not a preference.
- The shipped `verify` CLI is bundled as CJS with `@empirica/tajriba` inlined (`noExternal`).
  Shipping it as plain ESM would fail on the consumer's machine exactly as it fails here.

Normal consumers are unaffected in their own experiments, because the Empirica CLI bundles the
server with esbuild.

## 3a. The published `@empirica/core` cannot be loaded from raw Node at all (significant risk)

This is a stronger failure than the one in §3, and it was discovered only by running it. Both
module systems fail:

| path | failure |
|---|---|
| ESM (`import`) | `tmp` does `require("fs")`; tsup inlined it behind its `__require` shim, which throws `Dynamic require of "fs" is not supported` |
| CJS (`require`) | core's nested `@empirica/tajriba@1.7.0` has no `exports` main → `ERR_PACKAGE_PATH_NOT_EXPORTED` |

Note that the ESM failure is triggered by importing anything at all from
`@empirica/core/admin/classic`: the module that re-exports everything eagerly loads `connection_test_helper`, which pulls
in `tmp`. There is no need to call `withTajriba` to encounter it.

The fix is to bundle the package, which resolves both failures. This is not a workaround: it is
how consumers already run, since the Empirica CLI bundles their server with esbuild.
`scripts/e2e.mjs` therefore bundles tests to CJS before running them, and `tsup.config.ts`
bundles the `verify` CLI the same way.

The exploratory prototype never encountered any of this because it imported Empirica source from a clone rather
than the published package.

A corollary: `node --test` needs `--test-force-exit`. `TajribaConnection` leaves websocket
handles open, so without it the suite passes and then hangs indefinitely. The spawned tajriba
child process also needs `unref()` plus explicit `stdout`/`stderr` destruction on stop.

## 4. `withTajriba` is public, but unusable (caution)

`@empirica/core/admin/classic` exports `withTajriba` (plus the `StartTajribaOptions` and
`TajServer` types), and it spawns `empirica tajriba` correctly, but it is unusable in practice,
for two independent reasons:

1. It is what drags `tmp` into the import graph (§3a), so it cannot run unbundled.
2. Its port autodetection parses `"Started Tajriba server"` out of stderr, and that line is
   only emitted at `trace` level, so quiet logging and port autodetection are mutually
   exclusive. At n·d attributes per tick, trace logging dominates CPU and any measurement
   becomes a benchmark of Tajriba's logger instead.

`src/harness/server.ts` therefore spawns `empirica tajriba` directly on an explicitly chosen
free port and polls `/query` for readiness, around 60 lines, with no `tmp` dependency and no
stderr parsing.

`startTajriba` itself appears in the shipped chunk but is not in the public `.d.ts`; only the
`withTajriba` wrapper is. Its `tmp` usage is inlined by tsup, so the fact that `tmp` is not a
declared dependency of `@empirica/core` does not break it.

Note that the sibling helper in `admin/classic/e2e_test_helpers.ts` is not exported and is
broken in any case: it spawns a bare `tajriba` binary the CLI does not install, and hardcodes
`--log.level trace` and `--store.mem`.

## 4a. There is no write access control; `protected` does not protect (critical)

Measured 2026-08-14 (`test/e2e/participant_write.test.ts`). A participant that knows a node
id can set attributes on it, and the owner receives them:

| attempt by participant A on participant B's scope | result |
|---|---|
| create a new key on B's `nbhd` channel | accepted, B received it |
| overwrite an unprotected attribute | accepted, B received it |
| overwrite an attribute created with `protected: true` | accepted, B received it |
| write into B's player scope | accepted, B received it |

The last row is the exploitable one: no id has to leak, because Classic cross-links every
participant to every player node, so every participant already knows every other
participant's player scope id.

Tajriba documents `protected` as "the Attribute will not be updatable by other Participants".
In practice it is not enforced, at least not for attributes created server-side via
`addScopes`. This is the second attribute flag whose documented meaning does not hold, after
`private` (see `SPIKE-REPORT.md` §2).

This has three consequences for the module:

- Server-side code may never trust the provenance of a participant-written value. If a
  projection reads participant input, it must attribute that input to the writer by
  construction (one channel per participant, server-assigned) and treat the contents as
  untrusted.
- Read privacy and write integrity are separate properties. The module can honestly claim the
  first (verified: zero cross-participant delivery) and must not claim the second.
- This is an Empirica-wide property, not specific to this module: any Empirica experiment
  where a participant benefits from altering another's state is exposed. It is worth reporting
  upstream.

The characterization test asserts the current behavior, so if upstream ever adds enforcement
it fails loudly rather than leaving the project defending a threat that no longer exists.

## 4b. The game scope is participant-visible; do not place indexes there (caution)

This was obvious in hindsight, but it was caught by an end-to-end test rather than by
reasoning. Provisioning briefly stored its `playerID -> channel scope id` map on the game
scope. Every participant is linked to the game, so every participant received the whole map.

That is not a cosmetic leak. Combined with §4a (no write access control), a channel id is
exactly the capability needed to write into somebody else's private channel. The one thing
protecting other participants' channels is that their ids are not known.

The index therefore lives in server memory only (`src/admin/provision.ts`). Its cost, that a
restart loses it, is now paid for by the recovery path in §4d rather than left as a gap.

The general rule for this module is to ask, before writing anything to a scope, who is linked
to it. `game`, `player`, `round`, `stage` and `playerGame` are all cross-linked to every
participant in the game by `classic.ts:304-324`.

## 4c. The batch scope is the one place participants cannot read (confirmed)

Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/scope_visibility.test.ts` and
`test/e2e/topology_visibility.test.ts`.

`withNetwork` records the seed and realized edge list so a finished run is reproducible from
stored data. These records started on the game scope, which broke the rule stated above, and
measurement confirmed the cost: every participant received the full edge list and the seed.

```
  participant-readable topology : YES        <- before
  participant-readable seed     : YES
  value: [[0,1],[1,2],[2,3],[3,0]]
```

State was never affected; the package's guarantee held throughout. What leaked was the seating
plan. The edge list is indexed by position in `game.players`, and Classic broadcasts every
player scope, so a determined participant had most of what they needed to reconstruct who was
tied to whom. For a design where the network is the manipulation, that is a confound, and the
premise of the package invites the opposite assumption.

The batch scope is not delivered to participants. This was measured with a sentinel on each
scope and a game-scope control in the same run, so a clean result cannot mean that nothing was
being delivered:

```
  game-scope sentinel  reached : 3/3 participants   (control, must be 3)
  batch-scope sentinel reached : 0/3 participants
```

So the record moved there, keyed by game id (`network:<gameID>`, `networkSeed:<gameID>`) since
one batch holds many games. It stays durable, stays available for analysis and for restart
recovery, and is not sent to anyone inside the experiment. It should be read with
`readNetwork(game)` and `readSeed(game)` rather than by key, since the location is a privacy
decision and may move.

`GAME_KEYS` is deliberately empty. Two things would naturally sit on the game scope, and
neither may: the channel index (§4b) and the realized network (this note). The empty record is
kept so the reason survives.

## 4d. A restart re-fires `game.start` (critical)

Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/restart.test.ts`.

Attribute listeners replay attributes the admin already holds (§11), and `start` is one of
them, so `collector.on("game", "start", …)` fires again for an already-running game every time
the callbacks process starts. That behavior is useful, since it is how recovery gets its
chance, but it is destructive in two compounding ways unless the handler is written for it.

The first problem is that everyone is silently reseated. The seed is stable, so `topology()`
returns the same edge list. But the edge list consists of index pairs, and re-deriving the
index-to-person mapping from `game.players` order gives a different answer, because that order
is not stable across processes. It is the same ring, but with different people at each node.
Measured: an actor's neighbor set changed across a restart with nothing logged. For a network
experiment this corrupts the independent variable for the rest of the run.

The second problem is that every participant gets a second channel. Provisioning sees an empty
index and creates one, and Tajriba cannot unlink, so both links are permanent. The client keeps
the channel it first selected while the server writes the new one, so the view freezes
permanently. Measured as a 30-second timeout waiting for a post-restart change that never
arrived.

Both failures are silent, and they present as the experiment having gone quiet.

What answers both problems is that each channel is self-describing: `gameID`, `playerID` and
`topologyIndex` are all immutable at creation, so a fresh process rebuilds the index by reading
the channels rather than re-deriving it. `game.start` discriminates on
`game.get("networkSeed") !== undefined`: already set means a previous process networked this
game, so it recovers instead of provisioning again.

The seat lives on the channel rather than the game scope deliberately: a participant learns
only their own index, which tells them nothing they could not already infer, whereas the game
scope would hand everyone the entire seating plan (§4b, §4c).

Recovery refuses rather than guesses. If a seat is missing, `tryRecover` declines to publish
instead of closing the gap, because a guessed assignment would yield a plausible network in
which the wrong people are neighbors, and the run would look normal for the rest of its life.

A caveat on what is verified: the test restarts the callbacks against a still-running Tajriba,
which isolates the in-memory loss. A full `empirica` restart is a different and worse story;
see §4e, which measured it and found that recovery usually never gets the chance.

## 4e. A full restart does not put participants back in their game (critical)

Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/restart_full.test.ts`.

Restarting the whole `empirica` process, whether from a crash, a deploy, or `^C`, reloads the
store without difficulty. The batch, the players, the private channels and their links all come
back. The players are not re-assigned to their game. `gameID` is never restored, so no game
resumes and every participant sits on a screen that will not advance.

Classic assigns a reloaded player only if that participant is already online at the moment the
player scope replays:

```js
_.on("player", async (ctx, { player }) => {
  …
  if (online.has(participantID)) { await assignplayer(ctx, player); }
});
```

That is a race between the store replay and participants reconnecting, and it is one no
operator can win deliberately. Measured: 0 out of 5 when participants returned after the replay
had settled, 1 out of 5 when they raced it.

As a consequence, the channel recovery described in §4d is correct and is exercised by
`restart.test.ts`, but on a full restart it mostly never runs, because there is no game to
recover into. The working assumption should be that a full restart mid-study ends the games in
progress, whatever this package does. That is an Empirica property, not one this module
introduces or can fix from outside.

`restart_full.test.ts` therefore asserts neither outcome: it reports which way the race went,
and asserts the recovery only in the runs where the platform cooperated. Demanding either
result would be flaky by construction.

This behavior was hidden for a time by a bug in the project's own test harness. `server.stop()`
killed the `empirica` CLI wrapper, which execs the real server as a child process, so the server
was orphaned rather than stopped, and the "restart" reconnected to the process that had never
died. 379 orphaned processes had accumulated across one session. This was fixed with
`detached: true` plus a process-group kill, and is guarded by a test in `harness.test.ts`, since a
leak of this kind is invisible in continuous integration and shows up locally as a flake in
whatever test runs next.

## 5. `EventContext` has no `setAttributes` (caution)

It exposes only `scopeSub`, `addScopes` and `addLinks` (`admin/events.ts:414-440`).

The only write path available inside a listener is `scope.set()`, which requires the `nbhd`
kind to be registered in `AdminContext.init(..., kinds)` and subscribed via
`ctx.scopeSub({ kinds: ["nbhd"] })`.

Batching is not lost: the runloop coalesces every `set()` call made in a callback into a
single `setAttributes` remote call (`admin/runloop.ts:199-226`).

The exploratory prototype reached `setAttributes` directly via `(ctx.admin as any).admin`, a private field its
harness happened to own. That path does not exist for a consumer.

## 6. Kind registration is a mandatory consumer edit (caution)

`AdminContext.init(url, …, classicKinds)` lives in the user's `server/src/index.js`, not inside
the CLI. Consumers must change it to `{ ...classicKinds, nbhd: Nbhd }`.

This is a two-line change, and skipping it fails silently, so `withNetwork` must assert on
`"ready"` and throw with the exact diff.

This was addressed on 2026-08-16, but not in the way the paragraph above describes, and it had
been treated as addressed for four milestones before it actually was. The paragraph above states
a requirement in the future tense; `assertKindsRegistered` was built to satisfy it and was never
actually called, while the trap was filed under "impossible to skip
silently" on the strength of it.

`withNetwork` cannot assert on `"ready"`: it holds the collector, not the kind map, and reaching
the map needs an `@internal` field plus a `protected` member of `Scopes`. So the shipped check
instead observes the consequence (channels created by `addScopes` that never materialise as
modeled scopes) and warns after 5 seconds. See `ISSUES.md` O14; witness
`test/e2e/kind_registration.test.ts`.

## 7. A headless participant needs no non-public API (confirmed)

`ParticipantContext` builds its provider as:

```js
new TajribaProvider(part.changes(), taj.globalAttributes(), part.setAttributes.bind(part))
```

Every piece is public. `@empirica/tajriba` exports `Tajriba.connect`, `registerParticipant`,
`sessionParticipant`, and `TajribaParticipant.{changes, setAttributes, globalAttributes}`.

So the test harness needs no `ParticipantModeContext` (which is exported by no single re-export module), no
`e2e_test_helpers`, and no `MemStorage` shim.

## 8. Hooks cannot be rendered against a synthetic mode (caution)

Measured 2026-08-14, `@empirica/core@1.12.5`, `react@18.3.1`.

`usePartModeCtx` reads its data from `ParticipantCtx`, a React context created at module load
in `player/react/EmpiricaParticipant.tsx`. It is not exported from any single re-export module; only the
`<EmpiricaParticipant>` component that provides it is exported.

Two approaches were tried and both are dead ends:

1. Rendering `<EmpiricaParticipant>` with a fake URL. Its constructor eagerly builds a
   `ParticipantContext`, which opens a retrying Tajriba connection. Measured: with
   `url="http://127.0.0.1:9/query"` the Node process never exits, and the context is cached
   module-globally in a `contexts[ns]` map, so it cannot be discarded between tests.
2. Taking the provider off the element that `EmpiricaParticipant(...)` returns, then rendering
   it with a value of our own. This works structurally, since `usePartModeCtx` only ever
   touches `ctx.mode.getValue()` and `ctx.mode.subscribe()`, both satisfied by a
   `BehaviorSubject`, but obtaining the element still requires constructing the live connection
   from the first approach.

As a consequence, all hook behavior that depends on a populated mode is untestable in Node
with public API alone. So the derivation logic lives in `src/player/view.ts` as plain functions
(`neighborsOf`, `networkSelfOf`, `assertNetworkMode`), tested against real `Nbhd` instances
from the synthetic provider, and `src/player/react/` is delegation with nothing left to get
wrong.

There remains a residual risk not covered by any test. `usePartModeCtxKey` calls
`setVal({data: val2})`, a fresh wrapper object on every emission, so React never bails out even
though the `BehaviorSubject` re-emits the same `Nbhd` instance on every publish. If upstream
ever simplifies that call to `setVal(val2)`, `Object.is` equality would make React skip the
re-render and neighborhoods would silently freeze at their first value. Only a browser test
catches this; it is the main reason for the deferred M2 Playwright smoke test.

## 9. `ephemeral` attributes still survive a reconnect (confirmed)

Measured 2026-08-14, `@empirica/core@1.12.5`.

Neighborhood views are written with `{ephemeral: true}`, since they are derived data,
republished on demand, and persisting them would grow the store on every tick for no benefit.

The expectation was that a reconnecting participant would therefore arrive to an empty channel
and need an explicit republish. That is not what happens. Tajriba replays current attribute
values to a returning participant, whether ephemeral or not.

This was established as follows: `test/e2e/publisher.test.ts`, "a reconnecting participant gets
its view back", was run with the `ParticipantConnect` handler short-circuited. It still passed:
the returning participant received both its own channel and a view carrying the current value
of a neighbor's attribute set after the original session had already connected.

As a consequence, the `ParticipantConnect` republish in `with_network.ts` is not load-bearing.
It is kept as a hedge, because this replay is observed behavior rather than a documented
guarantee, and if it changed, the failure would be silent: every reconnecting participant would
go blank with nothing in the logs.

One case is not covered. A participant who first connects after game start is a different
case: `provisionChannels` skips players with no `participantID` and is not re-run on connect,
so a late joiner gets no channel at all. That is a real gap, tracked for M2, and not something
this handler currently fixes.

## 10. A `file:` link to this package loads two copies of `@empirica/core` (significant risk)

Measured 2026-08-15, `@empirica/core@1.12.5`, esbuild 0.14.47 (the scaffold's bundler).

`examples/minimal` originally depended on this package with `"empirica-networks": "file:../../.."`.
npm creates a symbolic link to the repository root, and the repository root has its own
`node_modules/@empirica/core` (a devDependency of the project). So when the example's server
was bundled:

- `server/src/index.js` resolved `@empirica/core` to the example's own copy
- `dist/admin/index.js` (this package's, reached through the symbolic link) resolved to the
  repository root's copy

Both were inlined. This was proven directly rather than inferred:

```
classicKinds.game === networkKinds.game : false
classicKinds.game name: Game | networkKinds.game name: Game2
```

esbuild renamed the second class `Game2`. `networkKinds` therefore carried a `Game` class that
was not the one `Classic()` checks against, and `isGame(player.currentGame)`, a
`z.instanceof` check, threw on every `introDone`. The visible symptom was every participant
stuck on "Waiting for other players" with a full game, along with roughly a hundred zod stack
traces in the server log that named neither this package nor the real cause.

Counting strings in the bundle did not reveal it: shared modules appeared once, so the
duplication looked absent. Comparing class identity is the check that works.

`esbuild --preserve-symlinks` did not fix it.

The fix, and the reason it is the right one, is that the example installs a packed tarball
(`npm run example:install`) instead of linking. That produces a real directory with no nested
core, so `@empirica/core` resolves once, which is also exactly what a published consumer gets,
since core is a peerDependency. The example now exercises the real published artifact.

This does not affect published consumers. It is a hazard of developing against a linked build,
and it is why `tsup.config.ts` keeps `@empirica/core` external.

## 11. Attribute listeners do not subscribe the admin to anything (significant risk)

Measured 2026-08-15, `@empirica/core@1.12.5`.

`_.on(kind, key, cb)` looks as though it subscribes to that attribute. It does not.
`subscribeAttribute(kind, key)` (`admin/attributes.ts`) only creates a local `ReplaySubject`
and replays attributes the admin already holds; it adds nothing to the wire subscription.

This is invisible for scopes the admin created itself: attributes set at creation come back
inside the `addScopes` response, so they populate `attrsByKind` and the listener fires. That is
why the `nbhd` owner listener worked, and why publishing worked for four milestones without any
explicit subscription.

It breaks the moment the code needs to read what a participant writes. The write reaches the
server and is echoed back to its author, so from the client everything looks correct, but the
admin's listener never fires. There is no error, no warning, nothing in the log.

The fix is:

```js
_.on("start", (ctx) => ctx.scopeSub({ kinds: ["nbhd"] }));
```

`withNetwork` does this. If it is ever removed, the symptom is that
`test/e2e/private_state.test.ts` times out on "every neighbor's secret arrived" while the
author's own read-back succeeds; that split is the signature of this bug.

Classic does not encounter it because `ClassicLoader` subscribes broadly for the built-in kinds.

A second consumer now depends on this line, verified 2026-08-15, M4. The monitor
(`admin/monitor`) reads participants' private channel state to label nodes, and it does so
through the same subscription rather than opening one of its own. That is deliberate: a second
admin connection would need a credential, and under §4a a credential grants unlimited write
access over every participant's data. But it means the one `scopeSub` call above is now
load-bearing for two features instead of one, and the monitor's failure mode is the quieter of
the two: every node simply shows blank state, which is indistinguishable from a study where
nobody has written anything yet.

So the removal symptom is now a pair. `test/e2e/monitor.test.ts` times out on "every
participant's private state reached the monitor"; `test/e2e/private_state.test.ts` times out on
"every neighbor's secret arrived". This was confirmed by deleting the `scopeSub` call and
re-running: each test fails on exactly its own wait, and every other assertion in the monitor
test, the graph, the rewire, the history, still passes, which is what makes the blank-state
failure so easy to miss by eye.

## 12. `EmpiricaClassic` never stops its animation-frame loop (caution)

Measured 2026-08-15, `@empirica/core@1.12.5`, Node 20.

Instantiating the participant mode starts a self-rescheduling frame loop that has no teardown.
Under Node there is no `requestAnimationFrame`, so core polyfills it with `setTimeout` and
reschedules from inside the callback:

```
at timeout (@empirica/core/src/player/steps.ts:75:5)
at scheduleFrame (steps.ts:266:5)
at root.requestAnimationFrame (steps.ts:238:51)
```

This leaves 68 uncleared timers after a single mode test file, and the process never exits.
Nothing in the public API stops it; the loop is owned by the stepper that drives stage timers.

The consequence for anyone testing a Classic-derived mode under Node is that
`--test-force-exit` is required, and this is upstream's fault rather than a leak in the
project's own code. It is worth knowing because the obvious diagnosis is the opposite one: a
hanging test suite reads as a forgotten cleanup step.

It is applied per tier here rather than globally (`scripts/test.mjs`): the unit tier never
touches the mode and exits cleanly, so forcing exit there would hide a handle leak introduced
by the project's own code. Which files need it was determined by measuring each one, not by
assumption.

## 13. Memory: what grows, and what does not (confirmed)

Measured 2026-08-15, `@empirica/core@1.12.5`, by `npm run soak` (file store, not the harness
default of `--tajriba.store.mem`; with the memory store everything is resident by construction
and the measurement would mean nothing).

The exploratory prototype named server memory as its top remaining unknown, on the grounds that `ephemeral`
views live in Tajriba's memory for the lifetime of a game. That concern turned out to be
unfounded. Tajriba holds current values, not per-write history:

```
  n=20, d=8, ~2 writes/sec, file store
  tajriba RSS  11.2MB flat across 240 publishes    PLATEAU
```

The publisher rewrites the same two keys on every publish, so per-write accumulation would have
shown as linear growth. It does not appear.

The real retention problem was in this project's own code, and it had nothing to do with
ephemerality. `withNetwork` kept nine structures keyed by game or channel, including one
Empirica `Scope` object per participant per game, and released none of them when a game ended.
A server running a study of many sequential games accumulated all of it. This was fixed with a
`game.status` listener that releases on `hasEnded`; `NetworkHandle.stats()` reports what is
held, so the fix is asserted exactly rather than inferred from a heap graph
(`test/e2e/retention.test.ts`).

A second, subtler problem surfaced in the same run: channels outlive their game (Tajriba
cannot delete scopes), and the kind subscription replays every channel a batch ever created to
any process that subscribes. A fresh process adopted all of them. Soak arm B showed
`channelScopes` climbing 8, 16, 24, 32 across sequential games while `games` stayed at 0. Ended
games are now skipped on adoption and released on replay.

Not yet measured are n of 200 or more, and sessions longer than the soak's default. The soak is
one run, and `SPIKE-REPORT.md` §5–6 asks for three with fresh servers before any number is
published.

## 14. Writes only count inside a callback (caution)

Measured 2026-08-15 while building the rewiring handle in `src/admin/with_network.ts`.

The runloop flushes the `scope.set()` calls made while it is processing a callback. A write
issued from anywhere else, such as a timer, an HTTP handler, test code, or a `queueMicrotask`
scheduled from inside a callback, updates the admin's own copy and is never sent. There is no
error and no log entry.

Two consequences follow, both learned the hard way:

- The rewiring API documents that mutations must run inside a listener. Reads are unaffected.
- The obvious optimization of batching several mutations into one publish, by deferring the
  flush to a microtask, moves the writes outside the callback and silently breaks them. It is
  also unnecessary: the runloop already coalesces a callback's `set()` calls into one
  `setAttributes` remote call, so publishing synchronously per mutation still costs only one
  round trip.

## 15. Game start corrupts the websocket stream at scale (significant risk)

Measured 2026-08-15, `@empirica/core@1.12.5`, by `npm run bench` and `test/bench/ceiling.ts`.

Above roughly n=150, participants intermittently fail to reach the game at all. The client
dies on a malformed frame from the server:

```
RangeError: Invalid WebSocket frame: invalid status code 1006
  code: 'WS_ERR_INVALID_CLOSE_CODE'
```

Close status 1006 is reserved and must never appear on the wire (RFC 6455 §7.4.1); it is the
code a client synthesizes locally for an abnormal close. Receiving it means the frame stream
itself is wrong, not that the server closed for a reason. The received close frame was also
marked compressed, which control frames may not be. Both facts point at interleaved writes to
one connection rather than at a deliberate close, the classic symptom of two processes writing
to a websocket that permits only one writer.

Measured rates, sharded bench, 25 participants per shard process, "reached first publish":

```
  n=100   5/5
  n=150   3/3
  n=200   1/6      <- 5 of 6 runs lost a participant at game start
```

Three things make this worth reporting rather than working around:

- It is not caused by this package. Stock Classic with no `withNetwork` registered, using the
  same harness and the same sizes, fails the same way, and did so at n=125 and n=150 where the
  network path succeeded. `CEILING_PLAIN=1 node scripts/ceiling.mjs` reproduces it with nothing
  of this package's own code involved.
- The server logs nothing. At `--log.level info` the only line is `tajriba: started`. From the
  operator's side, a study simply loses participants at the moment everyone joins.
- It is a burst, not a load level. It strikes at game start, when Classic cross-links every
  participant to every player scope, an O(n²) volume of deliveries, and not during the steady
  2 Hz publishing that follows, which n=200 sustains at 26.7 ms p50 once it starts.

What is not established is whether a browser survives it. The failure is fatal here because
Node's `ws` validates frames strictly and throws; a browser's native WebSocket would see a
closed socket and Empirica would reconnect. So the accurate statement is that the Node harness
cannot reliably start a game at n=200, and the consequence for real participants is untested.
Filed as `docs/upstream/ISSUES.md` U7.

### 15a. The same burst delays channel materialisation, measured 2026-08-16

Measured with `npm run bench -- --repeats 3`, sparse d=8, 25 participants per shard, `@empirica/core@1.12.5`.

Section 15 is about the participants the burst loses. This is about what it makes everyone else
wait for. The figure is the time from the first `addScopes` request to the first `nbhd` scope
arriving back through the admin's subscription, `net.stats().firstChannelMs`, which is the
window that anything watching for the channels to come back is competing against.

```
  n= 25      83    84    86 ms
  n= 50     394   463   491 ms
  n=100    1590  2285  2320 ms
  n=150    2343  3324  4287 ms      <- inside the supported envelope
  n=200    4813  5022  5870 ms      <- the 5022ms run delivered 760/760 receipts
```

The growth spans two orders of magnitude across the range, and it is not a straight line. It
steepens up to n=150 (roughly n squared) and then flattens: n=150 to 200 is a 1.37-fold increase
for a 1.33-fold increase in participants. That shape matches the mechanism described in section
15, since the cost is Classic's O(n²) cross-linking at game start and the channel replay queues
behind it, and it is why the curve cannot be extrapolated past the table.

This matters for the registration check. A flat five-second deadline, justified by the claim
that channels materialise in milliseconds at every size in the envelope, is a statement about
small n only: at n=150 a healthy server has 14 percent of it left, and at n=200 it fires on a
run that goes on to deliver every one of its 760 receipts (`ISSUES.md` O15). So the deadline
scales with the channels created, and the warning retracts itself if it turns out to have been
impatient.

No upstream issue is filed for this finding. Delivery costing time proportional to work is
ordinary; the fault lay in reading a small-n measurement as a property of the platform. It is
recorded here because it is a platform behavior anyone building on Empirica will meet, and
because the number did not exist anywhere until it was needed.

## 16. There is no artificial-player facility (caution)

Measured 2026-08-15, `@empirica/core@1.12.5`, by searching the shipped bundles.

Empirica v2 ships no bots, agents, or simulated participants of any kind. A search of
`node_modules/@empirica/core/dist/*.{js,cjs}` for `bot`, `virtual`, `simulat`, `agent`,
`artificial` and `robot` found only `bottom`, `both` and `borderBot` (a CSS property). Nothing
in the `exports` map offers one either; the subpaths are `.`, `./console`, `./player`,
`./player/react`, `./player/classic`, `./player/classic/react`, `./user`, `./admin` and
`./admin/classic`.

This is worth recording rather than assuming, because assuming bots exist is the natural
mistake: Empirica v1 had them, and a substantial share of network-experiment designs needs
them. The brief for this milestone assumed it too, in the parenthetical "Empirica ships
artificial players — reuse, do not port". It does not.

What a bot has to be here is not a server-side object: this package's topology is defined over
`game.players`, Empirica creates a player only for a connected participant, and provisioning
skips players without a `participantID`, so a node with no participant behind it has neither a
seat nor a private channel (`ISSUES.md` O4). The approach that works is a headless participant
process: a real `TajribaConnection`, a real session, and `EmpiricaNetwork` as the mode, reading
its neighborhood off the mode and writing its choice with `networkStateOf(...).set(...)`. That
is indistinguishable from a human at the wire, which is also the right property for a study that
does not tell participants which of their neighbors are software.

This was built on 2026-08-16. `empirica-networks/bots` is that process (`ISSUES.md` O10,
`docs/BOTS.md`), and `examples/shirado2017` now reconstructs both arms of Shirado & Christakis
(2017), including the 3-by-3 agent conditions that are the paper's contribution. Two things the
original estimate got wrong are worth keeping in mind:

- The estimate of "about thirty lines of public API" was right about the connection and wrong
  about the facility as a whole. The connection is thirty lines, but the lifecycle a participant
  has to traverse before it can act has six named phases, and every way of getting them wrong is
  silent: a bot that never plays throws nothing and times nothing out; it simply leaves a study
  waiting for a game that will never reach its player count. `src/bots/lifecycle.ts` is that
  state machine, and it is larger than the socket code.
- The claim that a bot is "indistinguishable from a human at the wire" is true of everything the
  bot does and false of what it is called. See §21: every participant receives every co-player's
  `participantIdentifier`, so the naming of a bot is a participant-visible fact.

## 17. An `onStageEnded`-style listener can only be registered once (significant risk)

Measured 2026-08-15, `@empirica/core@1.12.5`, while building `examples/rand2011`; the mechanism
was then read directly off `dist/admin.cjs` rather than inferred.

`ClassicListenersCollector`'s lifecycle helpers (`onGameStart`, `onRoundStart`, `onStageStart`,
`onStageEnded`, `onRoundEnded`, `onGameEnded`) all register through `this.unique.on(...)`, and
the `unique` wrapper is:

```js
function unique(kind, placement, callback) {
  return async (ctx, props) => {
    const attr = props.attribute;
    const scope = props[kind];
    if (!attr.id || scope.get(`ran-${PlacementString(placement)}-${props.attrId}`)) {
      return;                       // <- already ran
    }
    await callback(ctx, props);
    scope.set(`ran-${PlacementString(placement)}-${props.attrId}`, true);
  };
}
```

The `ran-on-<attrId>` marker lives on the scope, so it is shared by every listener registered
for that `(kind, key)` pair. The first callback to run sets it; every later one sees it and
returns. A second `onStageEnded` therefore never executes, not for a different stage, and not
ever.

Registrations are not deduplicated (`attributeListeners.push`), so nothing warns: each callback
is registered, wrapped, and then silently skipped at dispatch. Plain `.on(kind, key, cb)` is not
affected, since `registerListerner` applies the wrapper only when `uniqueCall` is set, which is
why `withNetwork`'s own listeners and the `Empirica.on(NBHD_KIND, stateKey("color"), …)` in
`examples/shirado2017` coexist without conflict.

This is how it presents in practice. Writing two `onStageEnded` handlers, one per stage, is the
obvious structure, and the second never runs. Measured in `examples/rand2011`: rewiring answers
were never applied, the network never changed in the condition whose entire point is that it
changes, no feedback was delivered, and nothing produced an error anywhere. It presents as "the
participants' answers do not seem to do anything," which is several wrong hypotheses away from
the actual cause. It was caught only because `test/e2e/rand2011.test.ts` asserts that the graph
actually changes.

The same wrapper explains why an extra `Empirica.onGameStart(...)` registered from a test file
against a collector imported from an example never fires: the example had already registered
one.

The workaround is to register each helper exactly once and dispatch inside it, on
`stage.get("name")` or equivalent. Both reconstructions do this and explain why at the call
site. Filed as `docs/upstream/ISSUES.md` U8.

### 17a. It is detectable from outside, measured 2026-08-16

`withNetwork` warns about this at server start (`src/admin/listeners.ts`). Everything the
detector rests on was read directly off `@empirica/core@1.12.5` rather than inferred, and each
fact rules out a naive version of the check:

- `collector.attributeListeners` is a plain array of `{ placement, kind, key, callback }`,
  marked `/** @internal */` but readable on the instance. It is not a map, and not keyed; a
  probe that reports it as `{"stage/ended/placement=1": 2}` is showing its own grouping, not the
  underlying field.
- `unique()` returns `async (ctx, props) => {…}`: anonymous, of arity 2, and an `AsyncFunction`.
  A named, synchronous, or differently-arity callback therefore cannot be a wrapper, which is
  what lets a plain `.on("stage", "ended", function scoreRound() {})` be told apart from a
  duplicated helper. The residual collision is an anonymous two-argument async callback passed
  to a plain `.on`, which is indistinguishable, rare, and named explicitly in the warning.
- An arrow function assigned to a `const` takes the const's name. `unique`'s arrow is returned
  from a function, which is why it stays anonymous; `withNetwork`'s own `game/start` listener is
  assigned to a `const` and so is not anonymous. That is a side effect of readable code rather
  than a guarantee, so the detector also excludes the project's own listener by identity.
- `ctx.register(fn)` gives the function a plain `ListenersCollector`, which has no
  `onStageEnded` at all (`chunk-LPBU7J6R.js`: `listeners = new ListenersCollector()`). The
  detector is correctly inert for the function form, since there is no lifecycle helper to
  duplicate, and active for the `new ClassicListenersCollector()` form every real experiment
  uses. It also means each `register()` call gets its own collector, so Classic's internals are
  never on the consumer's array.
- Classic's own lifecycle registrations use `unique.before` and `unique.after` (placement 0 and
  2) on `game/start` and `game/ended`; the six helpers use `unique.on` (placement 1). Its
  placement-1 attribute listeners are all on other keys (`game/status`, `stage/gameID`,
  `player/introDone`, `player/ended`, `batch/status`, `stage/timerID`). Filtering on placement
  makes the previous point moot in any case.

Because this reads an internal field, every unrecognised shape switches the detector off rather
than guessing, and the expected wrapper shape is calibrated at startup from a throwaway
`new collector.constructor()` rather than hardcoded, so a change to `unique` upstream retunes
the detector instead of silently disabling it. `test/e2e/duplicate_listeners.test.ts` asserts
both the warning and the underlying defect, so if the defect is ever fixed upstream, the test
indicates that the warning should be withdrawn.

### 17b. `warn()` writes to `console.log`, not `console.warn`

Measured 2026-08-16, `dist/chunk-TIKLWCJI.js`.

Every level in `@empirica/core/console` goes through one `createLogger` that calls
`console.log(...)`. So a test that swaps `console.warn` to capture a warning captures nothing,
and an assertion that the warning is absent passes vacuously. `test/e2e/envelope.test.ts` had
exactly that dead capture; it went unnoticed because it did not assert on what it collected.

Two further details cost time during investigation: a multi-line message is emitted as one
`console.log` call per line (`for (const line of args[0].split("\n"))`), each with its own
timestamp prefix, so captures must be reassembled before matching; and `currentLevel` defaults
to 2 while `warn` is 3, so warnings are never suppressed by the default level.
`@empirica/core/console` also exports `captureLogs` and `mockLogging`, which are cleaner but
divert all output and hide the harness's own diagnostics on a failure.

## 18. Degree costs less than the envelope assumed, measured 2026-08-16

Measured with `npm run bench -- --dense`, `@empirica/core@1.12.5`, 60 rounds per cell, participants sharded
across child processes, macOS, loopback. One run per cell.

The default `maxDegree` was 16 and was documented as measured. It was, but the measurement behind it
(SPIKE-REPORT §4) swept sparse graphs while varying n, so it constrains n, not degree. The
cells that would have constrained degree did not exist. They do now:

| n | d | topology | p50 | p95 | max | receipts |
|---|---|---|---|---|---|---|
| 20 | 8 | ring lattice | 4.1 ms | 9.8 ms | 13.3 ms | 440/440 |
| 20 | 19 | complete | 7.5 ms | 13.9 ms | 16.5 ms | 1045/1045 |
| 50 | 8 | ring lattice | 10.1 ms | 30.3 ms | 35.5 ms | 440/440 |
| 50 | 49 | complete | 16.1 ms | 24.6 ms | 30.4 ms | 2695/2695 |
| 100 | 16 | ring lattice | 9.9 ms | 11.6 ms | 13.4 ms | 880/880 |

A complete graph at n=20 is faster than a degree-8 ring at n=50, and faster than the cell the
old limit was set from (n=100, d=16). No receipt was dropped and no round was silent at any
density. Clock spread across shards was 0.3 ms or less in every cell.

Degree is a second-order term. What these cells track is participants per client process: n=50
over 2 shards and n=100 over 4 both put 25 per process and both land near 10 ms, while n=20
over 2 puts 10 per process and lands at 4 ms. That is the bench's standing caveat about its own
numbers (the README's "Supported envelope", `ISSUES.md` O1), and it is also why the degree
limit was wrong.

It is worth stating explicitly what this does not establish, because the limit it replaced was
over-read in exactly this way. The projection here is two fields, so these numbers describe
degree at small view sizes. Degree times view size is a different quantity: it is what a
participant's uplink carries, and it is what SPIKE-REPORT §4's client-bandwidth finding was
about: an n=100 complete graph at 24.9 KB per tick per participant is roughly 204 ms of
transmission on a 1 Mbps uplink before any server cost. Nothing here contradicts that, and
`maxNeighborhoodBytes` exists to guard it, since degree alone does not.

Also unmeasured, and worth naming rather than leaving implied, are real browsers (React
reconciles on every published view), real WAN latency, and any dense cell above n=50.

## 19. Degree by view size, measured, and what a bench figure is worth

Measured 2026-08-16, `npm run bench -- --bytes --repeats 2`, `@empirica/core@1.12.5`,
100 rounds per run, participants sharded across processes.

There are two results here. The first replaces a guess with a number; the second concerns the
first result's own reliability, and is the more important of the two.

### The payload cost

`maxNeighborhoodBytes` (64 KiB) was documented as not measured: a safeguard standing in for the
quantity the degree sweep (§18) deliberately did not cover. Each degree was run twice in one
sweep, differing only in payload:

| cell | neighborhood / publish | p50 | p95 | receipts |
|---|---|---|---|---|
| n=20 d=19, 2 fields | 1.4 KiB | 11.5 ms | 14.4 ms | 1805/1805 |
| n=20 d=19, +1 KiB/view | 20.6 KiB | 21.4 ms | 24.5 ms | 1805/1805 |
| n=50 d=49, 2 fields | 3.7 KiB | 22.8 ms | 27.4 ms | 4655/4655 |
| n=50 d=49, +1 KiB/view | 53.1 KiB | 67.0 ms | 72.0 ms | 4655/4655 |

Payload costs, and it costs more at higher degree: roughly 14.5 times the bytes buys 1.9 times
the latency at d=19 and 2.9 times at d=49. So degree times view size behaves like a product,
which is what §18 said it had not established, and it is the possibility `maxNeighborhoodBytes`
guards against.

The 64 KiB default has a number behind it. A design sitting just under the limit, 53 KiB per
participant per publish, the densest realistic case in the n ≤ 50 regime, delivers at 67 ms p50
rather than the 10–25 ms a small-view design sees. Nothing was dropped: every expected receipt
arrived at every size. So the limit is not a cliff but a slope, and 64 KiB is roughly where
publish latency reaches three times baseline while staying under 100 ms on this hardware. That
is a defensible place for a safeguard, and it is a measured statement rather than a plausible
one. One run showed a p99 of 258 ms against a 72 ms p95, so the tail at that size deserves more
attention than the median.

### The sweep-level offset is caused by the machine's power management, and idle is the slow case

Measured 2026-08-16. `ISSUES.md` O1 carried an unexplained offset of roughly fivefold: the
same cell (n=25, d=8) measured between 3.3 ms and 18.3 ms across the session, while repeats
within any one sweep agreed to under 17 percent. Six hypotheses were eliminated by measurement
(see O1). The seventh was tested by imposing known CPU load: 14 cores, three conditions, three
runs each:

| busy-loop processes | 1-min load at start | p50 | coordinator CPU per 32 s window |
|---|---|---|---|
| 0 | 1.2–1.7 | 10.2 ms | 0.9–1.1 s |
| 8 | 5.4–7.4 | 4.5 ms | 0.5–0.7 s |
| 20 | 11–26.6 | 7.3 ms | 0.7–0.9 s |

A busier machine is faster, and the relationship is not monotonic: the minimum occurs at
moderate load. Contention is therefore not the mechanism; if it were, the ordering would run the
other way and 20 competing processes would be the worst cell rather than the middle one.

The CPU-time column is what identifies the cause. The coordinator does the same work in every
condition, at roughly a 2–3 percent duty cycle throughout, so nothing is saturated, yet it
consumed 1.1 CPU-seconds when the machine was idle against 0.7 under load. Identical
instructions taking 57 percent more CPU time is a clock-frequency signature: the cores were
running slower. On Apple Silicon that points to dynamic voltage and frequency scaling, plausibly
compounded by the scheduler placing a nearly idle workload on efficiency cores and promoting it
to performance cores once the machine is busy.

This was not isolated further: distinguishing frequency scaling from core placement needs
`powermetrics` (which requires root), and neither changes the conclusion. Timer coalescing on an
idle system may add to the delivery latency as well, but it cannot explain the CPU-time
difference, so it is at most a secondary factor.

The following points follow for anyone quoting a number from this bench.

- An absolute latency figure from a laptop with heterogeneous cores and aggressive power
  management is not reproducible, and more repeats do not fix it, since every run in a sweep
  sits at whatever clock the machine happened to choose. This is the concrete form of O1's
  "upper bounds" caveat, and it is worse than "upper bounds" suggests, because the error is not
  one-directional.
- Comparisons paired inside one sweep are still sound, since both arms see the same clock. That
  is why the payload table above is designed that way and why its conclusions stand while the
  absolute numbers around them vary.
- A quiet continuous-integration runner may well measure slower than a busy one. This is another
  reason `perf.yml` gates on delivery and retention rather than latency (`ISSUES.md` O6).

### What a single bench figure is worth, measured

The same cell (n=25, d=8, 100 rounds) was run across four sweeps on the same afternoon:

| sweep | p50 median | spread of repeats within it |
|---|---|---|
| A, as the first cell | 18.3 ms | 4% |
| control, 20 rounds | 7.3 ms | 9% |
| control, 100 rounds | 7.3 ms | 3% |
| drift check | 10.9 ms | — |

Repeats within a sweep agree to within 3–9 percent and disagree across sweeps by a factor of
2.5. Whatever produces that offset is shared by everything in a sweep, so `--repeats` measures
precision rather than accuracy, and a tight spread is not evidence that a number is correct. The
cause is not identified. It is not orphaned servers (checked: 2 live processes), not accumulated
writes (the 20-versus-100-round control is the refutation: a plausible mechanism existed, since
Tajriba is append-only per attribute, and it turned out to be wrong), and not within-run drift
(the first-third-versus-last-third comparison is flat in every cell above).

Two consequences follow, both adopted:

- Any paired comparison must have both arms inside one sweep. The payload table above is
  designed that way, so the offset cancels. Comparing a padded sweep against §18's numbers from
  another day would have measured the difference between the days rather than anything else.
- Published latency figures should be read as a scale, not a single value. The README says so.

Also seen once, and worth noting as new: a run died with `tajriba exited early (code 1)` at
n=25, a server failing to start, which is neither U6 (orphaned processes) nor U7 (participant
loss at n≥200). This was a single occurrence and has not been characterized further.

## 20. `game.players` and `player.participantID` come from two different mechanisms

Read directly off `@empirica/core@1.12.5` `dist/admin-classic.cjs` on 2026-08-16. Not
measured at runtime, and the difference matters for what it licenses; see the last paragraph.

```js
get players() {                                                    // :4488
  return this.scopesByKindMatching("player", "gameID", this.id);
}
scopesByKindMatching(kind, key, val) {                             // admin.cjs:992
  return Array.from(this.scopes.byKind(kind).values()).filter((s) => s.get(key) === val);
}

_.on("player", async (ctx, { player }) => {                        // :5474
  const participantID = isString2(player.get("participantID"));
  player.participantID = participantID;                            // :5476
  …
});
```

So membership of `game.players` is a live filter over the `gameID` attribute, evaluated fresh on
every access, while `player.participantID` is a field assigned by a listener callback. A player
scope is in `game.players` the moment the admin holds it with a matching `gameID`, whether or
not that callback has run for it.

That is the whole of the claim. It does not establish that Classic produces a player in
`game.players` with the field unset: on the normal path the attribute is written at player
creation and the callback runs long before any game starts. What it does establish is that
nothing structural prevents it, so the usual argument that Classic sets `participantID` in its
own player listener, and therefore that players in `game.players` have one, does not hold as
stated. The two facts concern different things.

The suspect window is the subscription replay at process start, where player scopes arrive
already carrying a `gameID` from a previous run. That is U2's territory, it has not been
reproduced, and `ISSUES.md` O4 stays open on the reproduction rather than being closed on this
reading.

This has a practical consequence for the package. `withNetwork` re-provisions on
`ParticipantConnect` as a safeguard under that path, and the repaired channel carries a seat
index like any other; without one, the game is unrecoverable at the next restart, which is what
`test/unit/late_joiner.test.ts` holds down. The transferable part is the method rather than the
finding: reading the platform's own source settles in minutes questions that otherwise would be
left open indefinitely, and it costs nothing.

## 21. Every participant receives every co-player's recruitment identifier (significant risk)

Measured 2026-08-16, `@empirica/core@1.12.5`, at the wire. Witness: `test/e2e/bots.test.ts`,
"a co-player's recruitment identifier is on the wire". Filed as `docs/upstream/ISSUES.md` U10.

`participantIdentifier`, the raw value of `?participantKey=`, is delivered to every other
participant in the game. Two upstream lines put it there, and neither is doing anything unusual:

```js
// PARTICIPANT_CONNECT: the identifier is written on the player scope, immutably
ctx.addScopes([{ kind: "player", attributes: attrs([
  { key: "participantID",         value: participant.id,         immutable: true },
  { key: "participantIdentifier", value: participant.identifier, immutable: true },
])}]);

// startGame: every participant is linked to every player node
for (const player of players) { nodeIDs.push(player.id); participantIDs.push(player.participantID); }
ctx.addLinks([{ link: true, participantIDs, nodeIDs }]);
```

The first line is how Classic remembers who a player is; the second is how a Classic client can
render `players`. Together they mean the identifier is broadcast, reaching the wire of a
participant who never asked for it and has no interface that shows it.

This was measured directly rather than read off the source: four participants in one game, with
each participant's own namespace string searched for in every other participant's received
frames. All were present, in both directions, along with the key `participantIdentifier`.

This matters in two unrelated ways.

The first is participant privacy. In a deployed study, `participantKey` carries the recruitment
identity, such as a Prolific participant ID, or whatever the recruitment URL put there. Co-players
learn it. Such identifiers are stable across studies, so this is a cross-study re-identification
handle passed between strangers. It affects every Empirica Classic
study, not only networked ones, and is independent of this package: the same two lines run
whether or not `withNetwork` is installed.

The second concerns bots. There is no naming scheme an artificial participant can use that
subjects cannot read. This is why `runBots` requires an identifier list rather than generating
one from a count, why the default generator matches the shape Empirica's own client produces,
and why the server-side half of `examples/shirado2017` recognizes its agents by holding the list
rather than by matching a prefix. For a design that does not tell subjects which of their
neighbors are software, a recognisable identifier discloses the manipulation rather than merely
leaking metadata. See `docs/BOTS.md` §1.

This is not fixable from within this package. Nothing this package controls writes the attribute
or creates the link, and the read guarantee is unaffected: `project()` is still the only path by
which one participant's state reaches another. What leaks is who is in the room, under the name
that the recruitment process gave them.

A workaround, pending any change upstream, is to make `participantKey` an opaque per-study token
and keep the mapping to the recruitment identity outside Empirica. That is worth doing in any
case.

## 22. Miscellaneous

- `Player.participantID` is a public field on the admin classic model, and no cast is needed.
  Note that it is a field set by a listener, not an attribute read: see §20 above, and
  `ISSUES.md` O4.
- `usePartModeCtx` and `usePartModeCtxKey` are public and generic, so `useNeighbors()` is a
  three-line delegation.
- The unknown-scope-kind warning fires once per scope creation, not per update, so composing two
  scope trees costs one log line rather than per-tick repetition.
- `@empirica/core/player/classic/react` imports cleanly under bare Node (there is no residual
  `.css` import in the shipped `dist`), so hooks can at least be mounted in the mode tier.
