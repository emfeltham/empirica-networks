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

## 4c. We break our own §4b rule: the topology is participant-readable ⚠️

*Measured 2026-08-15, `@empirica/core@1.12.5`, by `test/e2e/topology_visibility.test.ts`.*

`withNetwork` records the seed and realised edge list on the **game** scope, for reproducibility
(§7.1 of `MODULE-DESIGN.md`). By the rule directly above, that means every participant gets both.
They do — measured, not inferred:

```
  participant-readable topology : YES
  participant-readable seed     : YES
  value: [[0,1],[1,2],[2,3],[3,0]]
```

**This is a disclosure, not a state leak.** The package's guarantee — a participant never
receives a non-neighbour's projected state — is unaffected, and the same test asserts it still
holds. What a participant additionally learns is the *shape* of the graph: edges as index
pairs, plus the seed, which regenerates the same shape.

Why it still matters for a study: the edge list is indexed by position in `game.players`, and
Classic broadcasts every player scope, so a determined participant has most of what they need
to reconstruct who is tied to whom. For designs where the network is the manipulation, that is
a confound a researcher would not expect — the whole premise of the package invites the
assumption that structure is server-side.

Not yet fixed, because the fix is a design choice rather than a bug fix: the value is on the
game scope *precisely so it survives into stored data* for analysis, and moving it means
choosing another home (a scope participants are not linked to, or an admin-side export path)
and re-testing what analysis can still read. Recorded here, asserted by a test that fails if
the storage location changes silently, and left for that decision.

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
Tajriba, which isolates the in-memory loss. A full `empirica` restart also drops Tajriba's
memory, and views are written `ephemeral` — recovery republishes, so the outcome should be the
same, but that has not been measured.

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

## 9. Misc

- `Player.participantID` is a public field on the admin classic model — no cast needed.
- `usePartModeCtx` / `usePartModeCtxKey` are public and generic, so `useNeighbors()` is a
  three-line delegation.
- The unknown-scope-kind warning fires once per scope *creation*, not per update, so composing
  two scope trees costs one log line, not per-tick spam.
- `@empirica/core/player/classic/react` imports cleanly under bare Node (no residual `.css`
  import in the shipped `dist`), so hooks can at least be *mounted* in the mode tier.
