# Architecture — how the package works

For someone reading the source: a contributor, a reviewer, or the author in six months. It is
organised by **mechanism**, walking the path a value takes from a participant's browser to their
neighbour's screen. `MODULE-DESIGN.md` — kept with the investigation that produced it, not in
this repo — is organised by *decision and its reasoning*, and is the place to find out why a
shape was chosen rather than what it does.

Every claim below names the file it lives in, and where a behaviour is pinned by a test, the
test. An architecture document that drifts is worse than none, and pointing at the witness is
the only defence available.

Written 2026-08-16, against the post-M6 surface (`@empirica/core` 1.12.5).

---

## 1. The model, in one paragraph

Participants are nodes in a graph. Each participant owns one **private channel** — a modelled
scope of custom kind `nbhd`, linked to that participant alone — and the server writes their
projected view of their neighbours there and nowhere else. Not "the interface hides the rest":
the bytes never arrive. The realised graph, its seed, and its mutation history are recorded on
the **batch** scope, which is the only durable scope measured not to be delivered to participants
(`test/e2e/scope_visibility.test.ts`), so a finished run is reproducible from stored data without
handing the seating plan to the people inside it.

Two facts about Empirica make everything else follow. Classic cross-links every participant to
every player node, so **anything on a player scope is broadcast to everyone** — which is why
private state needs its own scope kind. And `EventContext` has no `setAttributes`
(`docs/PLATFORM-NOTES.md` §5), so the only write path available inside a listener is `.set()` on
a modelled scope — which is why the `nbhd` kind must be registered by the consumer, in *their*
`server/src/index.js`. Without the registration there is nothing to call `.set()` on.

## 2. Module map

```
src/
  index.ts            root barrel — isomorphic ONLY, no @empirica/core imports
  shared/
    keys.ts           every scope kind and attribute key, in one place
    wait.ts           polling helpers used by tests and the harness
  admin/              server side; imports @empirica/core/admin — never import from client code
    with_network.ts   the core. Config, lifecycle wiring, publish path, GameNetwork  (1808 lines)
    kinds.ts          networkKinds, assertKindsRegistered, the registration diff
    provision.ts      one channel per participant: batched, idempotent, order-independent
    projection.ts     validateProjection, projectionBytes — what a view may contain
    envelope.ts       degree / view-bytes / neighbourhood-bytes limits
    reads.ts          recording proxies; the unwatched-key report
    listeners.ts      the U8 duplicate-lifecycle-listener detector
    registration.ts   the O14 kind-registration check: constants and messages, zero imports
    retention.ts      the bound on what a long-running process keeps (O5), zero imports
    seed.ts           hashSeed, makeRng — deterministic realisation
    sink.ts           the shared NDJSON writer behind views: and log:
    views.ts          view capture config on top of the sink
    export.ts         pure row builders: edgeRows, snapshotRows, viewRows, toCSV
    inspect.ts        GameSnapshot and the pure builders behind it
    monitor/          the live view. Separate subpath so opting out is structural
  player/             client side; imports @empirica/core/player* ONLY
    mode.ts           EmpiricaNetwork — EmpiricaClassic composed with an nbhd context
    view.ts           neighborsOf / networkSelfOf / networkToldOf, usable headless
    state.ts          networkStateOf — the write path for a participant's own private state
    chat.ts           neighborChatOf
    react/index.ts    the hooks, which are thin wrappers over the above
  bots/               artificial participants; a PARTICIPANT process, not a server-side object
    runner.ts         runBots: sessions, the poll loop, hook dispatch. Reuses verify/compat.ts
    lifecycle.ts      the six phases as a pure function, and the stall reasons. Zero imports
    identity.ts       identifier generation and the U10 warnings. Zero imports
    policy.ts         the BotPolicy / BotContext types. Type-only imports, so it bundles to nothing
  topology/
    index.ts          15 generators + adjacency/degrees/components/isConnected
    graphology.ts     the graphology bridge, kept behind its own subpath
  verify/             the `verify` CLI: harness, server, sentinel leak test, tcp cut
```

**The entry-point rule, stated first because breaking it is silent.** `src/index.ts` re-exports
only `shared/`. `admin`, `player`, `player/react` and `topology` are deliberately *not* pulled
into one barrel — that is the mistake in `@empirica/core`'s own `index.ts`, which drags
server-only code (and its `tmp` → `require("fs")` problem) into client bundles. Each is its own
`exports` subpath in `package.json`. `monitor` is a further subpath off `admin` for the same
reason plus one more: a server that never opts in never pulls `node:http` or the served page into
its bundle, and *"does this deployment expose the whole graph"* stays answerable with one grep.

**`bots` breaks the ESM rule deliberately, and the export map says so.** It reaches
`@empirica/core/admin` for `TajribaConnection` — the connection class lives there even though a
bot is a participant — and that cannot be loaded from bare Node ESM (§3a). So it ships as a
bundled CJS artefact under a single `default` condition, rather than as an `import` entry that
would resolve cleanly and then fail on the researcher's machine. The cost is a second copy of
`@empirica/core` inside that bundle; nothing crosses the boundary, because a policy is handed
plain JSON and plain accessors rather than scope objects. `src/bots/runner.ts` is built on
`src/verify/compat.ts` rather than on its own copy of the same three calls, so a version bump that
breaks a bot breaks it in the one file where every upstream contract lives.

## 3. The lifecycle, end to end

Numbered because the order is the mechanism. Everything here is in `with_network.ts` unless
noted.

**1 — Module evaluation.** The consumer's `callbacks.js` runs. `withNetwork(Empirica, config)`
executes as one statement inside it, registering its listeners; the consumer's own listeners are
typically registered *below* that call.

**2 — `collector.on("start")`.** Fires once the admin connects, after module evaluation is
complete. Two things happen, and the timing of both is deliberate:

- `ctx.scopeSub({ kinds: ["nbhd"] })` — subscribes the admin to channel scopes. This is
  load-bearing specifically for reading what participants *write*: attribute listeners subscribe
  nothing on their own (`docs/PLATFORM-NOTES.md` §12, `ISSUES.md` U3). Publishing worked without
  it for a long time, because creation-time attributes arrive inside the `addScopes` response —
  but a participant's later write is never delivered and the listener waiting for it simply never
  runs.
- The duplicate-lifecycle-listener check runs (`listeners.ts`). Here rather than at
  `withNetwork()` time, because counting during module evaluation would miss every listener
  declared below the call — which in both shipped examples is most of them.

**3 — Kind registration.** Two checks, and neither can be the obvious one. If `networkKinds` was
not passed to `AdminContext.init`, no channels are modelled, nothing errors, and participants sit
with empty neighbourhoods forever — the one mandatory consumer edit, and the package's most
consequential silent failure.

- `assertKindsRegistered(kinds)` (`kinds.ts`) — **eager, throws, opt-in.** For the consumer's own
  `server/src/index.js`, the one place that holds the kind map. `withNetwork` cannot call it: it
  is handed the collector, and reaching the map from a listener context needs an `@internal`
  field plus a `protected` member of `Scopes`.
- The **automatic** check (`registration.ts`, armed at step 7) observes the *consequence* instead
  — channels created, none materialised — and warns. See §3 step 7.

Until 2026-08-16 there was only the first, and **nothing called it** while three documents recorded
the trap as "impossible to skip silently" on the strength of it (`ISSUES.md` O14).

**4 — Game start.** `collector.on("game", "start", onGameStartAttribute)`. The handler is held in
a named `const` so the duplicate detector can exclude it *by identity* — as an inline arrow its
shape was exactly a `unique` wrapper's, and the detector would have cried wolf on its own
package's examples. Three branches:

- `game.hasEnded` → `releaseGame()` and return. This listener re-fires for already-started games
  on restart, and without the guard a restarted process would revive state it had correctly
  released.
- `readSeed(game) !== undefined` → the game was networked by a previous process; go to the
  recovery path (step 9).
- Otherwise, the normal path below.

**5 — Realise the topology.** `seed = config.seed ?? hashSeed(String(game.id))`, `rng =
makeRng(seed)`, `edges = topology({ game, playerCount, rng })`, `adj = adjacency(...)`. Then
`checkDegrees()` — before provisioning and before anything is recorded, so an out-of-envelope
topology fails while the experiment is still abandonable rather than after participants have been
committed to a game that will run badly.

**6 — Record the realisation, on the batch scope.** `batch.set(NETWORK_KEYS.seed(gameID), seed)`
and `NETWORK_KEYS.network(gameID)`, plus a `start` event appended to
`NETWORK_KEYS.history(gameID)`. Suffixed by game id because one batch holds many games. A game
with no batch **throws** — without it the run is neither reproducible nor restart-survivable, and
that is worth failing loudly for.

The `start` event is why `edges.csv` describes the whole run: without it the export would begin
mid-story, and a study that never rewires would export an empty history.

**7 — Provision channels.** `provisionChannels(ctx, game, indexOf)` (`provision.ts`). One
`addScopes` and one `addLinks` regardless of *n*. Four properties, each learned the hard way:
batched; **idempotent** (keyed on an immutable owner attribute — and this matters more than usual
because Tajriba cannot *unlink*, so a re-link bug accumulates permanently); order-independent
(results are mapped back by reading the owner attribute off each payload, since nothing documents
that `addScopes` preserves input order); and **the channel map is never participant-visible** —
it lives in server memory only, keyed by game id.

That last one is not tidiness. Empirica has no write access control (`ISSUES.md` U1), so a
channel id is precisely the capability needed to inject into someone else's private channel. It
was briefly on the game scope, and an e2e test caught every participant receiving every channel
id.

Each channel carries four immutable attributes, set at creation: `ownerParticipantID`,
`playerID`, `gameID`, and `topologyIndex`. The last is the participant's seat number, and it is
on the channel rather than the game scope on purpose — a participant learns only their own index,
which tells them nothing they cannot already see, whereas the game scope would hand everybody the
seating plan.

A player with no `participantID` gets no channel, and `publish` refuses to send a partial view,
so **one unprovisioned player blocks every view in the game.** That is the right call — a partial
publish leaves participants stale with no signal — but it must not be silent, so it warns.

Provisioning is also where the **kind-registration check** is armed (`armRegistrationCheck`). It
is one-shot per process, because registration cannot change while the process runs and a per-game
timer would re-accuse on every game of a broken batch. `provisionChannels` throws if a returned
payload carries no owner attribute, so `created > 0` establishes that the scopes exist in Tajriba;
if none of them has come back as a *modelled* scope by `registrationWaitMs(created)` — 5 s, plus
100 ms per channel past fifty — the check warns. It **names both causes and diagnoses neither**,
and retracts itself if a channel arrives afterwards: the deadline is sized from measured
first-channel latency (`ISSUES.md` O15, `docs/PLATFORM-NOTES.md` §16a), and a measurement can be
beaten by a slower machine. Witnesses: `test/e2e/kind_registration.test.ts` against a real server,
`test/unit/registration.test.ts` for the arithmetic and for the retraction — which needs a
deadline that expires while healthy channels are in flight, a race no real server can be asked to
lose on demand.

**8 — Channels materialise, asynchronously.** `collector.on(NBHD_KIND, NBHD_KEYS.OWNER, …)` fires
once per channel (the owner attribute is immutable, so exactly once). It captures the scope
object — the thing `.set()` can be called on — re-adopts the channel into the index, records the
seat, and drains `awaitingPublish`. Channels belonging to an ended game are dropped immediately:
Tajriba cannot delete scopes, so every channel a batch ever created is replayed to any process
that subscribes to the kind, and adopting them all means a fresh process loads every historical
channel before doing any work. Measured by `npm run soak` arm B — `channelScopes` climbed 8, 16,
24, 32 across sequential games while `games` stayed 0.

**9 — Recovery, if a previous process networked this game.** `tryRecover()` needs two durable
things in two different places: the edge list from the batch scope, and each channel's
`topologyIndex`. **Both are required.** The edge list alone is index pairs — it describes the
shape without saying who sits where, which is precisely how a restart used to silently reassign
everyone to different nodes while looking like it had worked (`test/e2e/restart.test.ts`). A
missing seat makes recovery **refuse** rather than guess: guessing produces a plausible network
in which the wrong people are neighbours, and the run looks normal for the rest of its life.

Called on every channel arrival, because channels stream in from the subscription with no
completion signal. Idempotent, and gives up quietly until the last seat is filled.

**Note what this does *not* fix.** A full server restart still does not put participants back in
their game — `gameID` is never restored, upstream (`ISSUES.md` U2). Recovery here is about not
*corrupting* a game that survives, not about resuming a crashed study. Nothing here can make a
crashed study resumable.

**10 — First publish**, or `awaitingPublish` until the last channel arrives. See §4.

**11 — The participant connects.** `EmpiricaNetwork` installs client-side (§6), the `nbhd` scope
resolves, `useNeighbors()` returns a view. `TajribaEvent.ParticipantConnect` drops the publish
cache for that participant and republishes — *not load-bearing today*, and that is measured
rather than assumed: with the handler disabled, `test/e2e/publisher.test.ts`'s reconnect case
still passes, because Tajriba replays current attribute values to a returning participant even
though views are `ephemeral`. Kept because that replay is undocumented behaviour found by
experiment, and if it ever stops, every reconnecting participant silently goes blank.

**12 — Game end.** `collector.on("game", "status")` → `releaseGame()` when `hasEnded` (which
covers `ended`, `terminated` *and* `failed`). Flushes both sinks first — a game ending is the
last moment its records are certainly still wanted — then drops nine structures keyed by game or
channel, including one Empirica `Scope` object per participant, **and** the chat relay's
per-player dedupe marks. One thing is deliberately *not* released per game: `endedGames`, a set
of ids, which is what stops a finished game's channels being re-adopted when the kind
subscription replays them. It is a few dozen bytes per game against one scope object per
participant, and since `ISSUES.md` O5 it is **capped** rather than unbounded
(`src/admin/retention.ts`). Forgetting the oldest is safe because the replay that would re-adopt
an evicted game's channels also replays that game's own `start` attribute, and this step runs
again behind it.

## 4. The publish path

One function, `publish(game, only?)`. `only` limits which participants are *recomputed*;
completeness is still checked for everyone.

```
for each viewer in topology order
  ├─ channel not materialised?  → return false, publish NOTHING
  ├─ for each neighbour j in adj[viewer]
  │    ├─ project(recordReads(neighbour), recordReads(viewer), ctx)   ← the only path
  │    ├─ throws?    → rethrow, naming the (viewer, neighbour) pair
  │    ├─ undefined? → skip this neighbour
  │    ├─ validateProjection(view, label)      ← BEFORE anything is written
  │    └─ projectionBytes(view) → sizes
  ├─ JSON.stringify(neighbours) === lastPublished?  → skip this viewer
  └─ → targets
reportUnwatchedKeys(readKeys)
checkViewBytes(sizes, envelope)
seq += 1
for each target
  ├─ scope.set("neighbors", view, { ephemeral: true })
  ├─ scope.set("_seq", seq, { ephemeral: true })
  └─ viewSink?.record({ gameID, viewer, seq, at, view })
```

Six properties worth naming:

**All-or-nothing.** A channel that has not materialised returns `false` having published nothing.
A partial publish leaves some participants with a stale view and no signal that they are stale,
which is this package's characteristic failure mode.

**Validate before write.** A publish is one batched RPC — the runloop coalesces every `set()`
made during one callback into a single `setAttributes` (`admin/runloop.ts`) — so throwing during
validation means nothing is sent, and no participant gets a partial or unsafe view. Publishing to
*n* participants costs one round trip, not *n*.

**`project()` returning a scope is refused.** `validateProjection` (`projection.ts`) rejects it,
along with cycles, `BigInt` and `NaN`. A scope holds a reference to the global attribute store,
so publishing one would ship every attribute of every participant to that client — the exact
inverse of the guarantee.

**Recording proxies.** Both arguments are wrapped by `recordReads` (`reads.ts`), and
`ctx.stateOf()` records too. Whatever `project()` reads is what the view depends on, and
therefore what must be in `watch` for it to stay live. Empirica has no wildcard attribute
listener, so the list cannot be inferred — but anything read and not listed is *reported* rather
than silently going stale.

**Byte-identical suppression.** Without it, one player changing one attribute rewrites every
neighbour's whole neighbourhood on the wire, and the client sees a change event for a value that
did not change. It also makes the deliberate over-reach in `republishAround` free: a change to P
republishes P's neighbours *and* P itself, because a projection may key off the viewer's own
state.

**Views are `ephemeral`.** Nothing durable holds them. That is why view capture exists and why it
is opt-in — and it is the difference between *what a participant was told* and *what they could
have known*, which is all an edge log plus an attribute export can give you afterwards.

### What triggers a republish

| Trigger | Wiring |
|---|---|
| A watched key changes on a **player** scope | `collector.on("player", key, …)`, one listener per key in `watch ∪ read` |
| A watched key changes on a **private channel** | `collector.on("nbhd", stateKey(key), …)`, same list |
| The graph is mutated | `network(game).addEdge / removeEdge / rewire` |
| Explicitly | `net.publishAll()`, `network(game).publish()`, `publishFor(playerID)` |
| A participant reconnects | `TajribaEvent.ParticipantConnect` |
| The server tells one participant something | `network(game).tell(playerID, key, value)` |

One list covers both scopes deliberately: which scope a key lives on is the author's choice and
can change, and making them remember two lists would turn a moved key into silently frozen
neighbourhoods. A listener for a key nobody uses costs nothing.

`watch` and `read` are **unioned** — mechanically identical, both get a listener, both appear in
`inspect()`, both are readable through `stateOf()`. The distinction is declarative: it records
what the author meant and gives `stateOf()` something to check against. A distinction that also
changed behaviour would be a new way to be silently wrong, which is the thing being fixed.

## 5. Where every value lives, and why

The table the examples each write for themselves, generalised. **This is the whole design.**

| Location | Who can read it | What belongs there |
|---|---|---|
| **Player scope** (`player.set`) | **Everyone.** Classic cross-links every participant | Nothing that the network is supposed to restrict. Non-secret UI state |
| **Game scope** | **Everyone** in the game (§4b) | Nothing of ours — `GAME_KEYS` is a named, empty record so the reason survives |
| **Batch scope** | Server only, measured (`scope_visibility.test.ts`) | The realised network, the seed, the edge history, the authoritative record of account (payoffs) |
| **Private channel** (`nbhd`), `state:` prefix | Its owner, and the server | What a participant writes about themselves. `networkStateOf().set()` |
| **Private channel**, `told:` prefix | Its owner, and the server | What the server tells *one* participant. `network(game).tell()` |
| **Private channel**, `neighbors` | Its owner, and the server | The projected views. Written `ephemeral`; server-written only |
| **Run log** (`log: { file }`) | Nobody in the experiment — a file on the server | Whatever your analysis needs, written as the study happens |
| **View sink** (`views: { file }`) | Same | Exactly what each participant was delivered, per delivery |

Two prefixes on one scope rather than one, and that is not tidiness either: a participant can
write anything to their own channel — it is the one scope they can certainly write to — so a
shared namespace would let `state.set("offer", …)` overwrite a value the server authored, with no
way for the server to tell. Separated, that collision is impossible. Both are prefixed rather
than raw so a participant cannot overwrite `neighbors` or `_seq`.

**Why the batch scope.** It is the one durable place participants cannot read. The realised
network started on the game scope, where every participant received the full edge list and the
seed: state stayed neighbour-limited but the *structure* did not, and for a design where the
topology is the manipulation, that is a confound rather than a nicety (`PLATFORM-NOTES` §4b, §4c).

**Why the history is a log and not a snapshot.** They answer different questions and only one is
answerable from a snapshot. `network:<gameID>` is what the graph *is*; `networkHistory:<gameID>`
is how it got there. For a rewiring study the sequence *is* the independent variable, so
overwriting a single edge list as ties change would destroy the thing being measured.

**And the in-memory log is authoritative, not the attribute.** Appending by reading the batch
attribute back would be a read-modify-write against a value the server also echoes; two mutations
in quick succession can interleave so the second reads a stale copy and overwrites the first —
losing an event silently. Measured as a 1-in-6 flake before the in-memory log was made the source
of truth. The attribute is a projection of it, not the other way round.

## 6. The client half

`EmpiricaNetwork` (`player/mode.ts`) is **composed with `EmpiricaClassic`, not a reimplementation
of it**:

```js
export function EmpiricaNetwork(participantID, provider) {
  const classic = EmpiricaClassic(participantID, provider);
  const net = networkContext(participantID, provider);
  return { ...classic, ...net };
}
```

Classic's body is ~150 lines of subscription wiring that upstream keeps editing and this package
does not own. Composition works because `TajribaProvider`'s streams are multicast rxjs Subjects,
so two consumers each receive everything. The returned object is a superset, which is why
`usePlayer`, `useGame`, `useStage` and the whole intro/exit flow keep working. A guard asserts
that Classic still returns each of the six keys it merges, so a removal upstream is a loud error
rather than a silently stripped key.

**The `dones` protocol is the fragile part.** `Attributes` and `Scopes` resolve values only when
their dones subjects are fed the set of updated node ids. Get it wrong and every scope
materialises correctly and **every `.get()` returns `undefined`, with no error** — the single most
confusing failure in this codebase. `networkContext` mirrors Classic's own wiring, and then
self-checks: if updates arrived for our scope but `ownerParticipantID` is still unreadable, it
throws `DonesWiringError` rather than serving empty views. The probe is `ownerParticipantID`, not
`_seq`, because owner is immutable and present from the moment the scope exists, while `_seq`
only appears at the first publish.

**Channel selection is by owner, not first-wins.** Flush the dones subjects *first*, then select:
selection depends on the owner attribute, which is only resolved by that flush. Selecting
beforehand meant owner was still `undefined`, so with two channels present (a stale one plus
ours) neither the owner match nor the single-channel fallback applied, and the mode silently kept
serving the **stale channel**. Invisible in e2e, where a participant only ever sees one channel.

**`undefined` and `[]` are different answers.** `Nbhd.published` exists because `neighbors`
returns `[]` both for "not published yet" and for "genuinely isolated". The hooks return
`undefined` until a real view has arrived. Rendering an isolated node during startup is a silent
data-validity bug, not a cosmetic one.

**The derivations are separable from React.** `neighborsOf`, `networkSelfOf`, `networkToldOf`,
`networkStateOf`, `neighborChatOf` all live in `player/` and take a context — the hooks in
`player/react/` are thin wrappers. Headless clients and bots need the same derivations, and the
`verify` harness uses them.

## 7. Determinism

```
game.id ──hashSeed──▶ seed ──makeRng──▶ rng ──topology(…)──▶ edges
                       │                                      │
                       └─────── batch: networkSeed:<id> ◀──────┘  batch: network:<id>
```

`config.seed` overrides the derivation. Both the seed and the realised edge list are written to
the batch scope, so the graph a run actually used is recoverable from stored data — not
re-derived and hoped to match. `makeRng` and `shuffle` are exported so a design's own randomness
can hang off the same seed. Pinned by `test/e2e/reproducibility.test.ts`.

Seat assignment is *not* re-derivable: `game.players` order is not stable, which is why the seat
lives on each channel as `topologyIndex` (§3 step 9).

## 8. The four version-fragile upstream contracts

This package is built on public API, but four contracts are fragile across `@empirica/core`
versions and **three of them fail silently**. They are enumerated in
`.github/workflows/drift.yml`, which runs the suite against `@empirica/core@latest` every Monday
and is *expected* to be the first thing that goes red after an upstream release — that is the
signal, not a flake.

| Contract | Failure mode | Witness |
|---|---|---|
| `TajribaProvider` constructor shape | Silent | mode tier |
| The **`dones` protocol** | Silent — every `.get()` returns `undefined` | `test/mode/*`, and the `DonesWiringError` self-check |
| `AdminContext.init` arity | Loud | e2e |
| `ListenersCollector.attributeListeners` and the `unique` wrapper shape | Silent — the U8 detector switches off and consumers stop being warned | `test/unit/listeners.test.ts`, `test/e2e/duplicate_listeners.test.ts` |

The fourth is the only one that depends on an `@internal` field. The detector *calibrates* the
wrapper shape at startup rather than hardcoding it, so it retunes itself rather than going quiet
— but if the field moves or is renamed, it switches off. If `duplicate_listeners.test.ts` ever
fails saying the second handler **did** run, upstream fixed U8 and the warning should be
withdrawn.

## 9. What is held in memory, per process

Because "does it leak" is a question with an answer here, and `net.stats()` exists so that answer
is not "watch a heap graph and squint". `npm run soak` prints these alongside RSS.

| Structure | Keyed by | Released at |
|---|---|---|
| `networks`, `games`, `startedAt`, `seqByGame`, `historyByGame`, `recoveredOrder`, `gameNetworks` | game id | `releaseGame` |
| `channelScopes`, `lastPublished` | channel scope id | `releaseGame`, via the channel map |
| the channel index (`provision.ts`) | game id | `releaseChannels` |
| `lastOutbox` (chat dedupe) | **player id** | `releaseGame`, via the seating order |
| `endedGames` | game id | never per game — deliberately; **capped** at `MAX_ENDED_GAMES` |
| `reportedMissing` | key name | never; bounded by the key list |

`net.stats()` reports the two that are easy to get wrong — `endedGames` and `chatSeqs` — because
they are the two that outlive a game, and everything else in that record should return to zero
between games (`test/e2e/retention.test.ts` asserts the whole shape).

The `lastOutbox` row is the one worth reading twice. Being keyed by player rather than by game is
what put it outside every game-keyed delete, and the cost of that was not memory: Classic reuses
a participant's player scope across sequential games while the client's message counter restarts
with each new channel, so a stale mark made the relay's duplicate guard swallow the opening
messages of the next game, silently (`ISSUES.md` O5). When adding state here, the question that
finds this class of bug is *what is this keyed by, and is that the thing that ends?*

## 10. Reading further

| | |
|---|---|
| [`GETTING-STARTED.md`](GETTING-STARTED.md) | the ordered path for someone using the package |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | symptom → cause, for when one of these mechanisms misfires |
| [`PLATFORM-NOTES.md`](PLATFORM-NOTES.md) | the measurements every claim here rests on, dated and versioned |
| [`GLOSSARY.md`](GLOSSARY.md) | channel, projection, view, seat, envelope, told |
| [`../ISSUES.md`](../ISSUES.md) | what is known to be broken, ours and upstream's |
| `MODULE-DESIGN.md` | why each of these shapes was chosen. Not in this repo |
