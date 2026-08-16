# Platform constraints, verified

Everything here was checked at runtime against **`@empirica/core@1.12.5`** and
**`@empirica/tajriba@1.7.3`** on **2026-08-14**, not read from documentation. Re-run the
checks when bumping either dependency — several of these are the kind of thing that changes
silently.

Background evidence: `~/breadboard-v2-working/SPIKE-REPORT.md`.

## 1. `@empirica/core/player` imports cleanly under bare Node ✅

No CSS problem. The source has `import "./index.css"` in `player/index.ts`, but tsup emits CSS
as separate files (`dist/player.css` etc.) and strips the import from the JS. A Node-side
import of `@empirica/core/player` works with no loader or stub.

Confirmed available from `@empirica/core/player`: `TajribaProvider`, `Scopes`, `Scope`,
`Attributes`, `Steps`.

## 2. All seven client Scope classes are public ✅

`@empirica/core/player/classic` exports `EmpiricaClassic` plus `Game`, `Player`, `PlayerGame`,
`PlayerRound`, `PlayerStage`, `Round`, `Stage`.

The `kinds` object itself is *not* exported, but it is an eight-line reconstruction from these.
This is what makes composing a custom participant mode possible without vendoring.

## 3. `@empirica/tajriba` cannot be imported under bare Node ESM ⚠️

**The most consequential finding for this package's build.**

```
node ESM     -> ERR_UNSUPPORTED_DIR_IMPORT
tsx          -> works
esbuild CJS  -> works
```

Cause: `@empirica/tajriba/dist/index.js` does `import "cross-fetch/polyfill"`, and
`cross-fetch@4.0.0` ships `polyfill/` as a bare directory with a `package.json` `main` and **no
`exports` map**. Directory imports are not resolvable in ESM.

`cross-fetch@4.1.0` still has no `exports` map, so an npm `overrides` bump does **not** fix it.

This propagates to everything that depends on tajriba: `@empirica/core/admin` and
`@empirica/core/admin/classic` both fail to import under bare Node ESM.

**Consequences, both already encoded in the build:**

- Dev and tests run under **tsx**, not bare `node`. Not a preference — a requirement.
- The shipped `verify` CLI is **bundled as CJS** with `@empirica/tajriba` inlined
  (`noExternal`). Shipping it as plain ESM would fail on the consumer's machine exactly as it
  fails here.

Normal consumers are unaffected in their own experiments, because the Empirica CLI bundles the
server with esbuild.

## 3a. The published `@empirica/core` cannot be loaded from raw Node at all ⚠️⚠️

Stronger than §3, and discovered only by running it. **Both** module systems fail:

| path | failure |
|---|---|
| ESM (`import`) | `tmp` does `require("fs")`; tsup inlined it behind its `__require` shim, which throws `Dynamic require of "fs" is not supported` |
| CJS (`require`) | core's *nested* `@empirica/tajriba@1.7.0` has no `exports` main → `ERR_PACKAGE_PATH_NOT_EXPORTED` |

Note the ESM failure is triggered by importing **anything** from
`@empirica/core/admin/classic` — the barrel eagerly loads `connection_test_helper`, which
pulls in `tmp`. You do not have to call `withTajriba` to hit it.

**The fix is to bundle**, which resolves both. This is not a workaround: it is how consumers
already run, since the Empirica CLI bundles their server with esbuild. `scripts/e2e.mjs`
therefore bundles tests to CJS before running them, and `tsup.config.ts` bundles the `verify`
CLI the same way.

The spike never hit any of this because it imported Empirica **source** from a clone rather
than the published package.

Corollary: `node --test` needs **`--test-force-exit`**. `TajribaConnection` leaves websocket
handles open, so without it the suite passes and then hangs forever. The spawned tajriba child
also needs `unref()` plus explicit `stdout`/`stderr` destruction on stop.

## 4. `withTajriba` is public — and unusable ⚠️

`@empirica/core/admin/classic` exports `withTajriba` (plus the `StartTajribaOptions` and
`TajServer` types), and it spawns `empirica tajriba` correctly — but it is **unusable in
practice**, for two independent reasons:

1. It is what drags `tmp` into the import graph (§3a), so it cannot run unbundled.
2. Its port autodetection parses `"Started Tajriba server"` out of stderr, and that line is
   only emitted at `trace` level — so quiet logging and port autodetection are mutually
   exclusive. At n·d attributes per tick, trace logging dominates CPU and any measurement
   becomes a benchmark of Tajriba's logger.

`src/verify/server.ts` therefore spawns `empirica tajriba` directly on an explicitly chosen
free port and polls `/query` for readiness. ~60 lines, no `tmp`, no stderr parsing.

`startTajriba` itself appears in the shipped chunk but is **not** in the public `.d.ts` — only
the `withTajriba` wrapper is. Its `tmp` usage is inlined by tsup, so the fact that `tmp` is not
a declared dependency of `@empirica/core` does not break it.

Note the sibling helper in `admin/classic/e2e_test_helpers.ts` is *not* exported and is broken
anyway: it spawns a bare `tajriba` binary the CLI does not install, and hardcodes
`--log.level trace` and `--store.mem`.

## 4a. There is NO write access control. `protected` does not protect ⚠️⚠️⚠️

Measured 2026-08-14 (`test/e2e/participant_write.test.ts`). A participant that knows a node
id can set attributes on it, and the owner receives them:

| attempt by participant A on participant B's scope | result |
|---|---|
| create a new key on B's `nbhd` channel | **accepted**, B received it |
| overwrite an unprotected attribute | **accepted**, B received it |
| overwrite an attribute created with `protected: true` | **accepted**, B received it |
| write into B's **player** scope | **accepted**, B received it |

The last row is the exploitable one: no id has to leak, because Classic cross-links every
participant to every player node, so every participant already knows every other
participant's player scope id.

Tajriba documents `protected` as "the Attribute will not be updatable by other Participants".
Empirically it is not enforced — at least not for attributes created server-side via
`addScopes`. This is the second attribute flag whose documented meaning does not hold, after
`private` (see `SPIKE-REPORT.md` §2).

**Consequences for the module:**

- **Server-side code may never trust the provenance of a participant-written value.** If a
  projection reads participant input, it must attribute that input to the writer by
  construction (one channel per participant, server-assigned) and treat the contents as
  untrusted.
- Read privacy and write integrity are separate properties. The module can honestly claim the
  first (verified: zero cross-participant delivery) and must **not** claim the second.
- This is an Empirica-wide property, not specific to this module: any Empirica experiment
  where a participant benefits from altering another's state is exposed. Worth reporting
  upstream.

The characterisation test asserts the *current* behaviour, so if upstream ever adds
enforcement it fails loudly rather than leaving us defending a threat that no longer exists.

## 4b. The game scope is participant-visible — do not put indexes there ⚠️

Obvious in hindsight, caught by an e2e test rather than by reasoning. Provisioning briefly
stored its `playerID -> channel scope id` map on the **game** scope. Every participant is
linked to the game, so every participant received the whole map.

That is not a cosmetic leak. Combined with §4a (no write ACL), a channel id is exactly the
capability needed to write into somebody else's private channel. The one thing protecting
other participants' channels is that their ids are not known.

The index therefore lives in server memory only (`src/admin/provision.ts`). Its cost — a
restart loses it — is now paid for by the recovery path in §4d rather than left as a gap.

General rule for this module: **before writing anything to a scope, ask who is linked to it.**
`game`, `player`, `round`, `stage` and `playerGame` are all cross-linked to every participant
in the game by `classic.ts:304-324`.

## 4c. The batch scope is the one place participants cannot read ✅

*Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/scope_visibility.test.ts` and
`test/e2e/topology_visibility.test.ts`.*

`withNetwork` records the seed and realised edge list so a finished run is reproducible from
stored data. Those started on the **game** scope, which broke the rule directly above — and
measurement confirmed the cost: every participant received the full edge list *and* the seed.

```
  participant-readable topology : YES        <- before
  participant-readable seed     : YES
  value: [[0,1],[1,2],[2,3],[3,0]]
```

State was never affected; the package's guarantee held throughout. What leaked was the
*seating plan*. The edge list is indexed by position in `game.players`, and Classic broadcasts
every player scope, so a determined participant had most of what they needed to reconstruct
who was tied to whom. For a design where the network is the manipulation, that is a confound —
and the premise of the package invites the opposite assumption.

**The batch scope is not delivered to participants.** Measured with a sentinel on each scope
and a game-scope control in the same run, so a clean result cannot mean "nothing was being
delivered":

```
  game-scope sentinel  reached : 3/3 participants   (control, must be 3)
  batch-scope sentinel reached : 0/3 participants
```

So the record moved there, keyed by game id (`network:<gameID>`, `networkSeed:<gameID>`) since
one batch holds many games. It stays durable, stays available for analysis and for restart
recovery, and is no longer sent to anyone inside the experiment. Read it with `readNetwork(game)`
and `readSeed(game)` rather than by key — the location is a privacy decision and may move again.

`GAME_KEYS` is now deliberately empty. Two separate things were kept on the game scope and both
had to leave: the channel index (§4b) and the realised network (this note). The empty record is
kept so the reason survives.

## 4d. A restart re-fires `game.start` — and used to reseat everyone ⚠️⚠️⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/restart.test.ts`.*

Attribute listeners replay attributes the admin already holds (§12), and `start` is one of
them — so `collector.on("game", "start", …)` **fires again for an already-running game** every
time the callbacks process starts. That is useful (it is how recovery gets a chance to run) and
it was, before this was found, destructive in two compounding ways.

**1. Everyone was silently reseated.** The seed is stable, so `topology()` returned the same
edge list. But the edge list is *index pairs*, and the index-to-person mapping came from
`game.players` order — which is not stable across processes. Same ring, different people at
each node. Measured: an actor's neighbour set changed across a restart with nothing logged.
For a network experiment this corrupts the independent variable for the rest of the run.

**2. Every participant got a second channel.** Provisioning saw an empty index and created
one, and Tajriba cannot unlink, so both links are permanent. The client keeps the channel it
first selected while the server writes the new one, so the view **freezes forever**. Measured
as a 30s timeout waiting for a post-restart change that never arrived.

Both failures are silent, and they present as "the experiment got quiet".

The fix makes each channel self-describing — `gameID`, `playerID` and `topologyIndex`, all
immutable at creation — so a fresh process rebuilds the index by *reading* the channels rather
than re-deriving it and getting a different answer. `game.start` discriminates on
`game.get("networkSeed") !== undefined`: already set means a previous process networked this
game, so recover instead of provisioning.

The seat lives on the channel rather than the game scope deliberately: a participant learns
only their own index, which tells them nothing they could not already infer, whereas the game
scope would hand everyone the entire seating plan (§4b, §4c).

**Recovery refuses rather than guesses.** If a seat is missing, `tryRecover` declines to
publish instead of closing the gap — a guessed assignment yields a plausible network in which
the wrong people are neighbours, and the run looks normal for the rest of its life.

Caveat on what is verified: the test restarts the **callbacks** against a still-running
Tajriba, which isolates the in-memory loss. A full `empirica` restart is a different and worse
story — see §4e, which measured it and found that recovery usually never gets the chance.

## 4e. A full restart does not put participants back in their game ⚠️⚠️⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/restart_full.test.ts`.*

Restarting the whole `empirica` process — a crash, a deploy, `^C` — reloads the store fine.
The batch, the players, the private channels and their links all come back. **The players are
not re-assigned to their game.** `gameID` is never restored, so no game resumes and every
participant sits on a screen that will not advance.

Classic assigns a reloaded player only if that participant is *already online at the moment the
player scope replays*:

```js
_.on("player", async (ctx, { player }) => {
  …
  if (online.has(participantID)) { await assignplayer(ctx, player); }
});
```

That is a race between the store replay and participants reconnecting, and it is one no
operator can win deliberately. Measured: **0/5** when participants returned after the replay
had settled, **1/5** when they raced it.

**Consequence.** The channel recovery in §4d is correct and is exercised by
`restart.test.ts`, but on a full restart it mostly never runs, because there is no game to
recover into. Plan on the basis that **a full restart mid-study ends the games in progress**,
whatever this package does. That is an Empirica property, not one this module introduces or can
fix from outside.

`restart_full.test.ts` therefore asserts neither outcome — it reports which way the race went,
and asserts our recovery only in the runs where the platform cooperated. Demanding either
result would be flaky by construction.

**This was hidden by a bug in our own harness.** `server.stop()` killed the `empirica` CLI
wrapper, which execs the real server as a child, so the server was orphaned rather than
stopped and the "restart" reconnected to the process that had never died. 379 orphans had
accumulated across one session. Fixed with `detached: true` plus a process-group kill, and
guarded by a test in `harness.test.ts` — a leak like that is invisible in CI and shows up
locally as a flake in whatever test runs next.

## 5. `EventContext` has no `setAttributes` ⚠️

It exposes `scopeSub`, `addScopes`, `addLinks` only (`admin/events.ts:414-440`).

The only write path available inside a listener is **`scope.set()`**, which requires the
`nbhd` kind to be registered in `AdminContext.init(..., kinds)` *and* subscribed via
`ctx.scopeSub({ kinds: ["nbhd"] })`.

Batching is not lost: the runloop coalesces every `set()` in a callback into a single
`setAttributes` RPC (`admin/runloop.ts:199-226`).

The spike reached `setAttributes` directly via `(ctx.admin as any).admin` — a private field its
harness happened to own. **That path does not exist for a consumer.**

## 6. Kind registration is a mandatory consumer edit ⚠️

`AdminContext.init(url, …, classicKinds)` lives in the user's `server/src/index.js`, not inside
the CLI. Consumers must change it to `{ ...classicKinds, nbhd: Nbhd }`.

Two lines, and **silently fatal if skipped** — so `withNetwork` must assert on `"ready"` and
throw with the exact diff.

## 7. A headless participant needs no non-public API ✅

`ParticipantContext` builds its provider as:

```js
new TajribaProvider(part.changes(), taj.globalAttributes(), part.setAttributes.bind(part))
```

Every piece is public. `@empirica/tajriba` exports `Tajriba.connect`, `registerParticipant`,
`sessionParticipant`, and `TajribaParticipant.{changes, setAttributes, globalAttributes}`.

So the test harness needs **no** `ParticipantModeContext` (which is exported by no barrel), no
`e2e_test_helpers`, and no `MemStorage` shim.

## 8. Hooks cannot be rendered against a synthetic mode ⚠️

*Measured 2026-08-14, `@empirica/core@1.12.5`, `react@18.3.1`.*

`usePartModeCtx` reads its data from `ParticipantCtx`, a React context created at module load
in `player/react/EmpiricaParticipant.tsx`. **It is not exported** from any barrel — only the
`<EmpiricaParticipant>` component that provides it.

Two seams were tried and both are dead ends:

1. **Render `<EmpiricaParticipant>` with a fake URL.** Its constructor eagerly builds a
   `ParticipantContext`, which opens a *retrying* Tajriba connection. Measured: with
   `url="http://127.0.0.1:9/query"` the Node process never exits, and it is cached
   module-globally in a `contexts[ns]` map, so it cannot be discarded between tests.
2. **Grab the Provider off the element** `EmpiricaParticipant(...)` returns, then render it
   with our own value. This works structurally — `usePartModeCtx` only ever touches
   `ctx.mode.getValue()` and `ctx.mode.subscribe()`, both satisfied by a `BehaviorSubject` —
   but getting the element still requires constructing the live connection in (1) first.

**Consequence.** All hook behaviour that depends on a *populated* mode is untestable in Node
with public API only. So the derivation logic lives in `src/player/view.ts` as plain functions
(`neighborsOf`, `networkSelfOf`, `assertNetworkMode`), tested against real `Nbhd` instances
from the synthetic provider, and `src/player/react/` is delegation with nothing to get wrong.

**Residual risk, not covered by any test.** `usePartModeCtxKey` calls `setVal({data: val2})` —
a fresh wrapper object per emission — so React never bails out even though our
`BehaviorSubject` re-emits the *same* `Nbhd` instance on every publish. If upstream ever
simplifies that to `setVal(val2)`, `Object.is` equality would make React skip the re-render and
neighbourhoods would silently freeze at their first value. Only a browser test catches this;
it is the main thing the deferred M2 Playwright smoke test is for.

## 10. `ephemeral` attributes still survive a reconnect ✅

*Measured 2026-08-14, `@empirica/core@1.12.5`.*

Neighbourhood views are written with `{ephemeral: true}` — they are derived data, republished
on demand, and persisting them would grow the store on every tick for no benefit.

The expectation was that a reconnecting participant would therefore arrive to an empty
channel and need an explicit republish. **That is not what happens.** Tajriba replays current
attribute values to a returning participant, ephemeral or not.

How this was established: `test/e2e/publisher.test.ts` "a reconnecting participant gets its
view back" was run with the `ParticipantConnect` handler short-circuited. It still passed —
the returning participant received both its own channel and a view carrying the *current*
value of a neighbour's attribute set after the original session had already connected.

**Consequence.** The `ParticipantConnect` republish in `with_network.ts` is not load-bearing.
It is kept as a hedge, because this replay is observed behaviour rather than a documented
guarantee, and if it changed the failure would be silent: every reconnecting participant goes
blank with nothing in the logs.

**Not covered.** A participant who first connects *after* game start is a different case —
`provisionChannels` skips players with no `participantID` and is not re-run on connect, so a
late joiner gets no channel at all. That is a real gap, tracked for M2, not something this
handler currently fixes.

## 11. A `file:` link to this package loads TWO copies of `@empirica/core` ⚠️⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, esbuild 0.14.47 (the scaffold's bundler).*

`examples/minimal` originally depended on this package with `"empirica-networks": "file:../../.."`.
npm makes that a **symlink to the repo root**, and the repo root has its own
`node_modules/@empirica/core` (our devDependency). So when the example's server was bundled:

- `server/src/index.js` → `@empirica/core` resolved to **the example's** copy
- `dist/admin/index.js` (ours, through the symlink) → resolved to **the repo root's** copy

Both were inlined. Proven directly rather than inferred:

```
classicKinds.game === networkKinds.game : false
classicKinds.game name: Game | networkKinds.game name: Game2
```

esbuild renamed the second class `Game2`. `networkKinds` therefore carried a `Game` class that
was not the one `Classic()` checks against, and `isGame(player.currentGame)` — a
`z.instanceof` — threw on every `introDone`. **The visible symptom was every participant stuck
on "Waiting for other players" with a full game**, and about a hundred zod stack traces in the
server log that named neither this package nor the real cause.

Counting strings in the bundle did NOT reveal it: shared modules appeared once, so the
duplication looked absent. Comparing class identity is the check that works.

`esbuild --preserve-symlinks` did not fix it.

**Fix, and why it is the right one:** the example installs a packed tarball
(`npm run example:install`) instead of linking. That produces a real directory with no nested
core, so `@empirica/core` resolves once — which is also exactly what a published consumer
gets, since core is a peerDependency. The example now exercises the real artifact.

**This does not affect published consumers.** It is a hazard of developing against a linked
build, and it is why `tsup.config.ts` keeps `@empirica/core` external.

## 12. Attribute listeners do NOT subscribe the admin to anything ⚠️⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`.*

`_.on(kind, key, cb)` looks like it subscribes to that attribute. It does not.
`subscribeAttribute(kind, key)` (`admin/attributes.ts`) only creates a local `ReplaySubject`
and replays attributes the admin **already holds** — it adds nothing to the wire subscription.

This is invisible for scopes the admin created itself: attributes set at creation come back
inside the `addScopes` response, so they populate `attrsByKind` and the listener fires. That is
why our `nbhd` OWNER listener worked, and why publishing worked for four milestones without
any explicit subscription.

It breaks the moment you need to read what a **participant** writes. The write reaches the
server and is echoed back to its author — so from the client everything looks correct — but
the admin's listener never fires. No error, no warning, nothing in the log.

**Fix:**

```js
_.on("start", (ctx) => ctx.scopeSub({ kinds: ["nbhd"] }));
```

`withNetwork` does this. Symptom if it is ever removed: `test/e2e/private_state.test.ts` times
out on "every neighbour's secret arrived" while the author's own read-back succeeds — that
split is the signature of this bug.

Classic does not hit it because `ClassicLoader` subscribes broadly for the built-in kinds.

**A second consumer now depends on this line — verified 2026-08-15, M4.** The monitor
(`admin/monitor`) reads participants' private channel state to label nodes, and it does so
through the *same* subscription rather than opening one of its own. That is deliberate — a
second admin connection would need a credential, and under §4a a credential is unlimited write
access over every participant's data — but it means the one `scopeSub` above is now
load-bearing for two features instead of one, and the monitor's failure mode is the quieter of
the two: every node simply shows blank state, which is indistinguishable from a study where
nobody has written anything yet.

So the removal symptom is now a pair. `test/e2e/monitor.test.ts` times out on "every
participant's private state reached the monitor"; `test/e2e/private_state.test.ts` times out on
"every neighbour's secret arrived". Confirmed by deleting the `scopeSub` call and re-running:
each fails on exactly its own wait, and every other assertion in the monitor test — the graph,
the rewire, the history — still passes, which is what makes the blank-state failure so easy to
miss by eye.

## 13. `EmpiricaClassic` never stops its animation-frame loop ⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, Node 20.*

Instantiating the participant mode starts a self-rescheduling frame loop that has no
teardown. Under Node there is no `requestAnimationFrame`, so core polyfills it with
`setTimeout` and reschedules from inside the callback:

```
at timeout (@empirica/core/src/player/steps.ts:75:5)
at scheduleFrame (steps.ts:266:5)
at root.requestAnimationFrame (steps.ts:238:51)
```

**68 uncleared timers after a single mode test file**, and the process never exits. Nothing
in the public API stops it; the loop is owned by the stepper that drives stage timers.

Consequence for anyone testing a Classic-derived mode under Node: `--test-force-exit` is
required, and it is upstream's fault rather than a leak in your own code. Worth knowing
because the obvious diagnosis is the opposite one — a hanging test suite reads as "I forgot to
close something".

It is applied per tier here rather than globally (`scripts/test.mjs`): the unit tier never
touches the mode and exits cleanly, so forcing exit there would hide a handle leak we
introduced ourselves. Which files need it was measured one at a time, not assumed.

## 14. Memory: what grows, and what does not ✅

*Measured 2026-08-15, `@empirica/core@1.12.5`, by `npm run soak` (file store, not the harness
default of `--tajriba.store.mem` — with the memory store everything is resident by
construction and the measurement would mean nothing).*

The spike named server memory as its top remaining unknown, on the grounds that `ephemeral`
views live in Tajriba's memory for the lifetime of a game. **That concern is unfounded.**
Tajriba holds current values, not per-write history:

```
  n=20, d=8, ~2 writes/sec, file store
  tajriba RSS  11.2MB flat across 240 publishes    PLATEAU
```

Our publisher rewrites the same two keys on every publish, so per-write accumulation would have
shown as linear growth. It does not appear.

**The real retention was ours, and it was not about ephemerality at all.** `withNetwork` kept
nine structures keyed by game or channel — including one Empirica `Scope` object per
participant per game — and released none of them when a game ended. A server running a study of
many sequential games accumulated all of it. Fixed by a `game.status` listener that releases on
`hasEnded`; `NetworkHandle.stats()` reports what is held, so the fix is asserted exactly rather
than inferred from a heap graph (`test/e2e/retention.test.ts`).

A second, subtler one surfaced in the same run: channels outlive their game (Tajriba cannot
delete scopes), and the kind subscription replays **every channel a batch ever created** to any
process that subscribes. A fresh process adopted all of them. Soak arm B showed
`channelScopes` climbing 8, 16, 24, 32 across sequential games while `games` stayed 0. Ended
games are now skipped on adoption and released on replay.

Not measured: n ≥ 200, and sessions longer than the soak's default. The soak is one run, and
`SPIKE-REPORT.md` §5–6 asks for three with fresh servers before any number is published.

## 15. Writes only count inside a callback ⚠️

*Measured 2026-08-15 while building `src/admin/with_network.ts`'s rewiring handle.*

The runloop flushes the `scope.set()` calls made while it is processing a callback. A write
issued from anywhere else — a timer, an HTTP handler, test code, a `queueMicrotask` scheduled
from inside a callback — updates the admin's own copy and is **never sent**. No error, no log.

Two consequences, both learned the hard way:

- The rewiring API documents that mutations must run inside a listener. Reads are unaffected.
- The obvious optimisation for batching several mutations into one publish — defer the flush to
  a microtask — moves the writes outside the callback and silently breaks them. It is also
  unnecessary: the runloop already coalesces a callback's `set()` calls into one
  `setAttributes` RPC, so publishing synchronously per mutation still costs one round trip.

## 16. Game start corrupts the websocket stream at scale ⚠️⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, by `npm run bench` and `test/bench/ceiling.ts`.*

Above roughly n=150, participants intermittently fail to reach the game at all. The client dies
on a malformed frame from the server:

```
RangeError: Invalid WebSocket frame: invalid status code 1006
  code: 'WS_ERR_INVALID_CLOSE_CODE'
```

Close status 1006 is reserved and **must never appear on the wire** (RFC 6455 §7.4.1); it is
the code a client synthesises locally for an abnormal close. Receiving it means the frame
stream itself is wrong, not that the server closed for a reason. The received close frame was
also marked compressed, which control frames may not be. Both point at interleaved writes to
one connection rather than at a deliberate close — the classic symptom of two goroutines
writing to a websocket that permits only one writer.

Measured rates, sharded bench, 25 participants per shard process, "reached first publish":

```
  n=100   5/5
  n=150   3/3
  n=200   1/6      <- 5 of 6 runs lost a participant at game start
```

Three things make this worth reporting rather than working around:

- **It is not caused by this package.** Stock Classic with no `withNetwork` registered — same
  harness, same sizes — fails the same way, and did so at n=125 and n=150 where the network
  path succeeded. `CEILING_PLAIN=1 node scripts/ceiling.mjs` is the reproduction with nothing
  of ours in it.
- **The server logs nothing.** At `--log.level info` the only line is `tajriba: started`. From
  the operator's side a study just loses participants at the moment everyone joins.
- **It is a burst, not a load level.** It strikes at game start, when Classic cross-links every
  participant to every player scope — O(n²) deliveries — and not during the steady 2 Hz
  publishing that follows, which n=200 sustains at 26.7ms p50 once it starts.

**What is NOT established:** whether a browser survives it. The failure is fatal here because
Node's `ws` validates frames strictly and throws; a browser's native WebSocket would see a
closed socket and Empirica would reconnect. So the honest statement is that **the Node harness
cannot reliably start a game at n=200**, and the consequence for real participants is untested.
Filed as ISSUES.md U7.

## 17. There is no artificial-player facility ⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, by searching the shipped bundles.*

Empirica v2 ships **no bots, agents, or simulated participants of any kind**. Searched
`node_modules/@empirica/core/dist/*.{js,cjs}` for `bot`, `virtual`, `simulat`, `agent`,
`artificial` and `robot`; the only matches are `bottom`, `both` and `borderBot` (a CSS
property). Nothing in the `exports` map offers one either — the subpaths are `.`, `./console`,
`./player`, `./player/react`, `./player/classic`, `./player/classic/react`, `./user`,
`./admin` and `./admin/classic`.

Worth recording rather than shrugging at, because **assuming bots exist is the natural
mistake**: Empirica v1 had them, and a substantial slice of network-experiment designs needs
them. The brief for this milestone assumed it too, in the parenthetical "Empirica ships
artificial players — reuse, do not port". It does not.

**What a bot would have to be here, if someone builds one.** Not a server-side object: this
package's topology is defined over `game.players`, Empirica creates a player only for a
connected participant, and provisioning skips players without a `participantID` — so a node
with no participant behind it has neither a seat nor a private channel (`ISSUES.md` O4). The
route that does work is a **headless participant process**, which is about thirty lines of
public API and is exactly what `src/verify/harness.ts`'s `connectParticipant` already does: a
real `TajribaConnection`, a real session, and `EmpiricaNetwork` as the mode. Such a bot would
read its neighbourhood off the mode and write its choice with `networkStateOf(...).set(...)`,
indistinguishable from a human at the wire — which is also the right property for a study that
does not tell participants which of their neighbours are software.

Consequence for this repo: `examples/shirado2017` reconstructs the **human-only** arm of
Shirado & Christakis (2017) and says so. Filed as `ISSUES.md` O10.

## 18. An `onStageEnded`-style listener can only be registered ONCE ⚠️⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, while building `examples/rand2011`; the mechanism
then read off `dist/admin.cjs` rather than inferred.*

`ClassicListenersCollector`'s lifecycle helpers — `onGameStart`, `onRoundStart`, `onStageStart`,
`onStageEnded`, `onRoundEnded`, `onGameEnded` — all register through `this.unique.on(...)`, and
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

**The `ran-on-<attrId>` marker lives on the SCOPE, so it is shared by every listener registered
for that `(kind, key)`.** The first callback to run sets it; every later one sees it and
returns. A second `onStageEnded` therefore never executes — not for a different stage, not ever.

Registrations are not deduplicated (`attributeListeners.push`), so nothing warns: each callback
is registered, wrapped, and then silently skipped at dispatch. Plain `.on(kind, key, cb)` is
**not** affected — `registerListerner` applies the wrapper only when `uniqueCall` is set, which
is why `withNetwork`'s own listeners and the `Empirica.on(NBHD_KIND, stateKey("color"), …)` in
`examples/shirado2017` coexist happily.

**How it presented.** `examples/rand2011` was written with two `onStageEnded` handlers, one per
stage — the obvious structure. The second never ran once: rewiring answers were never applied,
the network never changed in the condition whose entire point is that it changes, no feedback
was ever delivered, and nothing errored anywhere. It presented as "the participants' answers do
not seem to do anything", which is several wrong hypotheses away from the cause. Caught only
because `test/e2e/rand2011.test.ts` asserts that the graph actually changes.

The same wrapper is why an extra `Empirica.onGameStart(...)` registered from a *test file*
against a collector imported from an example never fires: the example already registered one.

**Workaround: register each helper exactly once and dispatch inside it**, on
`stage.get("name")` or equivalent. Both reconstructions do this and say why at the call site.
Filed as `ISSUES.md` U8.

### 18a. It is detectable from outside — measured 2026-08-16

`withNetwork` now warns about this at server start (`src/admin/listeners.ts`). Everything the
detector rests on was read off `@empirica/core@1.12.5` rather than inferred, and each fact rules
out a naive version of the check:

- **`collector.attributeListeners` is a plain `Array` of `{ placement, kind, key, callback }`**,
  marked `/** @internal */` but readable on the instance. Not a Map, and not keyed — an earlier
  note in `docs/M6-HARDENING.md` described it as `{"stage/ended/placement=1": 2}`, which was a
  probe's own grouping mistaken for the field's shape.
- **`unique()` returns `async (ctx, props) => {…}`.** Anonymous, arity 2, `AsyncFunction`. A
  named, synchronous or differently-arity callback therefore cannot be a wrapper, which is what
  lets a plain `.on("stage", "ended", function scoreRound() {})` be told apart from a duplicated
  helper. The residual collision is an anonymous 2-argument *async* callback passed to a plain
  `.on` — indistinguishable, rare, and named in the warning.
- **An arrow assigned to a `const` takes the const's name.** `unique`'s arrow is *returned*, which
  is why it is anonymous; `withNetwork`'s own `game/start` listener is a `const` and so is not.
  That is a side effect of readable code, not a guarantee, so the detector excludes our listener
  by identity as well.
- **`ctx.register(fn)` gives the function a plain `ListenersCollector`**, which has no
  `onStageEnded` at all (`chunk-LPBU7J6R.js`: `listeners = new ListenersCollector()`). The
  detector is correctly inert for the function form — there is no lifecycle helper to duplicate —
  and active for the `new ClassicListenersCollector()` form every real experiment uses. It also
  means each `register()` call gets its own collector, so **Classic's internals are not on the
  consumer's array**.
- **Classic's own lifecycle registrations use `unique.before` / `unique.after`** (placement 0 and
  2) on `game/start` and `game/ended`; the six helpers use `unique.on` (placement 1). Its
  placement-1 attribute listeners are all on other keys (`game/status`, `stage/gameID`,
  `player/introDone`, `player/ended`, `batch/status`, `stage/timerID`). Filtering on placement
  makes the previous point moot either way.

Because this reads an internal field, every unrecognised shape switches the detector **off**
rather than guessing, and the expected wrapper shape is *calibrated at startup* from a throwaway
`new collector.constructor()` rather than hardcoded — so a change to `unique` upstream retunes the
detector instead of silently disabling it. `test/e2e/duplicate_listeners.test.ts` asserts both the
warning and the underlying defect, so if the defect is ever fixed upstream the test says the
warning should be withdrawn.

### 18b. `warn()` writes to `console.log`, not `console.warn`

*Measured 2026-08-16, `dist/chunk-TIKLWCJI.js`.*

Every level in `@empirica/core/console` goes through one `createLogger` that calls
`console.log(...)`. So **a test that swaps `console.warn` to capture a warning captures nothing**,
and an assertion that the warning is *absent* passes vacuously. `test/e2e/envelope.test.ts` had
exactly that dead capture; it never showed because it did not assert on what it collected.

Two further details, both of which cost time: a multi-line message is emitted as **one
`console.log` call per line** (`for (const line of args[0].split("\n"))`), each with its own
timestamp prefix, so captures must be reassembled before matching; and `currentLevel` defaults to
2 while `warn` is 3, so warnings are never suppressed by the default level.
`@empirica/core/console` also exports `captureLogs` / `mockLogging`, which are cleaner but divert
all output and hide the harness's own diagnostics on a failure.

## 19. Degree costs less than the envelope assumed — measured 2026-08-16

*`npm run bench -- --dense`, `@empirica/core@1.12.5`, 60 rounds per cell, participants sharded
across child processes, macOS, loopback. One run per cell.*

The default `maxDegree` was 16 and was documented as measured. It was — but the measurement
(SPIKE-REPORT §4) swept **sparse** graphs while varying n, so it constrains n, not degree. The
cells that would have constrained degree did not exist. They do now:

| n | d | topology | p50 | p95 | max | receipts |
|---|---|---|---|---|---|---|
| 20 | 8 | ring lattice | 4.1 ms | 9.8 ms | 13.3 ms | 440/440 |
| 20 | **19** | **complete** | **7.5 ms** | 13.9 ms | 16.5 ms | 1045/1045 |
| 50 | 8 | ring lattice | 10.1 ms | 30.3 ms | 35.5 ms | 440/440 |
| 50 | **49** | **complete** | **16.1 ms** | 24.6 ms | 30.4 ms | 2695/2695 |
| 100 | 16 | ring lattice | 9.9 ms | 11.6 ms | 13.4 ms | 880/880 |

**A complete graph at n=20 is faster than a degree-8 ring at n=50**, and faster than the cell the
old limit was set from (n=100 d=16). No receipt was dropped and no round was silent at any density.
Clock spread across shards was ≤ 0.3 ms in every cell.

Degree is a second-order term. What these cells track is **participants per client process**: n=50
over 2 shards and n=100 over 4 both put 25 per process and both land near 10 ms, while n=20 over 2
puts 10 per process and lands at 4 ms. That was already this bench's standing caveat about its own
numbers (§8 of the README) — it turns out to also be why the degree limit was wrong.

**What this does NOT establish, stated because the limit it replaced was over-read in exactly this
way.** The projection here is two fields, so these numbers are degree at *small view sizes*. Degree
× view size is a different quantity, it is what a participant's uplink carries, and it is what
SPIKE-REPORT §4's client-bandwidth finding was about — an n=100 complete graph at 24.9 KB per tick
per participant is ~204 ms of transmission on a 1 Mbps uplink before any server cost. Nothing here
contradicts that, and `maxNeighbourhoodBytes` exists to guard it now that degree alone no longer
does.

Also unmeasured, and worth naming rather than leaving implied: real browsers (React reconciles on
every published view), real WAN latency, and any dense cell above n = 50.

## 9. Misc

- `Player.participantID` is a public field on the admin classic model — no cast needed.
- `usePartModeCtx` / `usePartModeCtxKey` are public and generic, so `useNeighbors()` is a
  three-line delegation.
- The unknown-scope-kind warning fires once per scope *creation*, not per update, so composing
  two scope trees costs one log line, not per-tick spam.
- `@empirica/core/player/classic/react` imports cleanly under bare Node (no residual `.css`
  import in the shipped `dist`), so hooks can at least be *mounted* in the mode tier.
