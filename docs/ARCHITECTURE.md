# Architecture — how the package works

This document describes the source architecture for contributors and reviewers. It is organized
by mechanism and traces a value from a participant's browser to a neighbor's screen. The separate
`MODULE-DESIGN.md`, retained with the investigation that produced it, records design decisions and
their rationale.

Each claim identifies its implementation file and, where applicable, the test that establishes the
behavior. These references make it possible to detect and correct drift between the documentation
and implementation.

Written 2026-08-16, against the post-M6 surface (`@empirica/core` 1.12.5).

---

## 1. The model, in one paragraph

Participants occupy nodes in a graph. Each participant owns a private channel, implemented as a
modeled scope of custom kind `nbhd` and linked exclusively to that participant. The server writes
the participant's projected view of their neighbors to this channel, while information about the
rest of the graph remains absent from the client. The batch scope records the realized graph, its
seed, and its mutation history. Measurements in `test/e2e/scope_visibility.test.ts` show that this
durable scope remains hidden from participants, making completed runs reproducible while
preserving the privacy of the network structure.

Two facts about Empirica make everything else follow. Classic cross-links every participant to
every player node, so anything on a player scope is broadcast to everyone, which is why private
state needs its own scope kind. And `EventContext` has no `setAttributes`
(`docs/PLATFORM-NOTES.md` §5), so the only write path available inside a listener is `.set()` on
a modeled scope, which is why the `nbhd` kind must be registered by the consumer, in their own
`server/src/index.js`. Without the registration there is nothing to call `.set()` on.

## 2. Module map

```
src/
  index.ts            root entry point — environment-independent ONLY, no @empirica/core imports
  shared/
    keys.ts           every scope kind and attribute key, in one place
    wait.ts           polling helpers used by tests and the harness
  admin/              server side; imports @empirica/core/admin — never import from client code
    with_network.ts   the core. Config, lifecycle wiring, publish path, GameNetwork  (1808 lines)
    kinds.ts          networkKinds, assertKindsRegistered, the registration diff
    provision.ts      one channel per participant: batched, idempotent, order-independent
    projection.ts     validateProjection, projectionBytes — what a view may contain
    envelope.ts       degree / view-bytes / neighborhood-bytes limits
    reads.ts          recording proxies; the unwatched-key report
    listeners.ts      the duplicate-lifecycle-listener detector
    registration.ts   the O14 kind-registration check: constants and messages, zero imports
    retention.ts      the bound on what a long-running process keeps (O5), zero imports
    seed.ts           hashSeed, makeRng — deterministic realization
    sink.ts           the shared NDJSON writer behind views: and log:
    views.ts          view capture config on top of the sink
    export.ts         pure row builders: edgeRows, snapshotRows, viewRows, toCSV
    inspect.ts        GameSnapshot and the pure builders behind it
    layout.ts         Fruchterman-Reingold, seeded and warm-startable. Pure.
                      Shared by the monitor and by participants at radius 1.5
    subgraph.ts       the closed neighborhood in LOCAL indices. Pure, zero imports
    monitor/          the live view. Separate subpath so opting out is structural
  player/             client side; imports @empirica/core/player* ONLY
    mode.ts           EmpiricaNetwork — EmpiricaClassic composed with an nbhd context
    view.ts           neighborsOf / networkSelfOf / networkToldOf, usable headless
    state.ts          networkStateOf — the write path for a participant's own private state
    chat.ts           neighborChatOf
    graph.ts          the neighborhood as a drawable model: ring geometry, edge
                      shortening, attribute filtering. Pure, zero imports
    react/index.ts    the hooks, which are thin wrappers over the above
    react/NetworkGraph.tsx  the SVG. Decides nothing; see §8 of PLATFORM-NOTES
    react/styles.tsx  the stylesheets, as strings for the reason monitor/ui.ts is
  bots/               artificial participants; a PARTICIPANT process, not a server-side object
    runner.ts         runBots: sessions, the poll loop, hook dispatch. Reuses harness/compat.ts
    lifecycle.ts      the six phases as a pure function, and the stall reasons. Zero imports
    identity.ts       identifier generation and the identifier warnings. Zero imports
    policy.ts         the BotPolicy / BotContext types. Type-only imports, so it bundles to nothing
  topology/
    index.ts          14 generators + 6 measures (adjacency, degrees, meanDegree, maxDegree,
                      components, isConnected). Pure, index-based, zero imports
    graphology.ts     the graphology bridge, kept behind its own subpath
  verify/             the `verify` CLI: sentinel leak test, topology preflight, the ndjson audit
  harness/            shared Tajriba harness: spawn+probe a real server, session compat shims,
                      a TCP-cut chaos utility — used by `verify`, `simulate` and every e2e test
  simulate/           the `simulate` tool: batch-run simulated sessions for the evaluation paper
```

The entry-point rule is stated first because breaking it fails silently. `src/index.ts` re-exports
only `shared/`. `admin`, `player`, `player/react` and `topology` are deliberately not pulled
into a single module that re-exports everything, which is the mistake in `@empirica/core`'s own
`index.ts`, dragging server-only code (and its `tmp` → `require("fs")` problem) into client
bundles. Each is its own `exports` subpath in `package.json`. `monitor` is a further subpath off
`admin` for the same reason plus one more: a server that never opts in never pulls `node:http` or
the served page into its bundle, and whether a given deployment exposes the whole graph stays
answerable with one grep.

`bots` breaks the ESM rule deliberately, and the export map records that fact. It reaches
`@empirica/core/admin` for `TajribaConnection`, whose connection class lives there even though a
bot is a participant, and that cannot be loaded from bare Node ESM (§3a). So it ships as a bundled
CJS artifact under a single `default` condition, rather than as an `import` entry that would
resolve cleanly and then fail on the researcher's machine. The cost is a second copy of
`@empirica/core` inside that bundle; nothing crosses the boundary, because a policy is handed
plain JSON and plain accessors rather than scope objects. `src/bots/runner.ts` is built on
`src/harness/compat.ts` rather than on its own copy of the same three calls, so a version bump that
breaks a bot breaks it in the one file where every upstream contract lives.

## 3. The lifecycle, end to end

Numbered because the order is the mechanism. Everything here is in `with_network.ts` unless
noted.

1. Module evaluation. The consumer's `callbacks.js` runs. `withNetwork(Empirica, config)`
executes as one statement inside it, registering its listeners; the consumer's own listeners are
typically registered below that call.

2. `collector.on("start")`. Fires once the admin connects, after module evaluation is complete.
Two things happen, and the timing of both is deliberate:

- `ctx.scopeSub({ kinds: ["nbhd"] })` subscribes the admin to channel scopes. This is
  load-bearing specifically for reading what participants write: attribute listeners subscribe
  nothing on their own (`docs/PLATFORM-NOTES.md` §11). Publishing worked without
  it for a long time, because creation-time attributes arrive inside the `addScopes` response, but
  a participant's later write is never delivered, and the listener waiting for it simply never
  runs.
- The duplicate-lifecycle-listener check runs (`listeners.ts`). This happens here rather than at
  `withNetwork()` time, because counting during module evaluation would miss every listener
  declared below the call, which in both shipped examples is most of them.

3. Kind registration. Two checks, and neither is the obvious one. If `networkKinds` was not
passed to `AdminContext.init`, no channels are modeled, nothing errors, and participants sit with
empty neighborhoods forever: the one mandatory consumer edit, and the package's most consequential
silent failure.

- `assertKindsRegistered(kinds)` (`kinds.ts`) is eager, throws, and is opt-in, for the consumer's
  own `server/src/index.js`, the one place that holds the kind map. `withNetwork` cannot call it:
  it is handed the collector, and reaching the map from a listener context needs an `@internal`
  field plus a `protected` member of `Scopes`.
- The automatic check (`registration.ts`, armed at step 7) observes the consequence instead:
  channels created, none materialised, and warns. See §3 step 7.

4. Game start. `collector.on("game", "start", onGameStartAttribute)`. The handler is held in a
named `const` so the duplicate detector can exclude it by identity: as an inline arrow its shape
was exactly a `unique` wrapper's, and the detector would have cried wolf on its own package's
examples. Three branches:

- `game.hasEnded` leads to `releaseGame()` and return. This listener re-fires for already-started
  games on restart, and without the guard a restarted process would revive state it had correctly
  released.
- `readSeed(game) !== undefined` means the game was networked by a previous process; go to the
  recovery path (step 9).
- Otherwise, the normal path below.

5. Realize the topology. `seed = config.seed ?? hashSeed(String(game.id))`, `rng =
makeRng(seed)`, `edges = topology({ game, playerCount, rng })`, `adj = adjacency(...)`. Then
`checkDegrees()` runs before provisioning and before anything is recorded, so an out-of-envelope
topology fails while the experiment is still abandonable rather than after participants have been
committed to a game that will run badly.

6. Record the realization on the batch scope. `batch.set(NETWORK_KEYS.seed(gameID), seed)` and
`NETWORK_KEYS.network(gameID)`, plus a `start` event appended to `NETWORK_KEYS.history(gameID)`,
plus `NETWORK_KEYS.radius(gameID)` — what the study showed people, which is not a property of the
graph and which nothing else in the record implies. These are suffixed by game id because one
batch holds many games. A game with no batch throws,
since without it the run is neither reproducible nor restart-survivable, and that is worth failing
loudly for.

The `start` event is why `edges.csv` describes the whole run: without it the export would begin
mid-story, and a study that never rewires would export an empty history.

7. Provision channels. `provisionChannels(ctx, game, indexOf)` (`provision.ts`). One `addScopes`
and one `addLinks` regardless of n. Four properties, each learned the hard way: batched;
idempotent (keyed on an immutable owner attribute, which matters more than usual because Tajriba
cannot unlink, so a re-link bug accumulates permanently); order-independent (results are mapped
back by reading the owner attribute off each payload, since nothing documents that `addScopes`
preserves input order); and the channel map is never participant-visible, living in server memory
only, keyed by game id.

That last property is functionally necessary, not merely a matter of tidiness. Empirica has no
write access control, so a channel id is precisely the capability needed to inject
into someone else's private channel. It was briefly on the game scope, and an end-to-end test
caught every participant receiving every channel id.

Each channel carries four immutable attributes, set at creation: `ownerParticipantID`,
`playerID`, `gameID`, and `topologyIndex`. The last is the participant's seat number, and it is
on the channel rather than the game scope on purpose: a participant learns only their own index,
which tells them nothing they cannot already see, whereas the game scope would hand everybody the
seating plan.

A player with no `participantID` gets no channel, and `publish` refuses to send a partial view,
so one unprovisioned player blocks every view in the game. That is the right call, since a partial
publish leaves participants stale with no signal, but it must not be silent, so it warns.

Provisioning is also where the kind-registration check is armed (`armRegistrationCheck`). It is
one-shot per process, because registration cannot change while the process runs, and a per-game
timer would re-accuse every game of a broken batch. `provisionChannels` throws if a returned
payload carries no owner attribute, so `created > 0` establishes that the scopes exist in Tajriba;
if none of them has come back as a modeled scope by `registrationWaitMs(created)` (5 s, plus
100 ms per channel past fifty), the check warns. It names both causes and diagnoses neither, and
retracts itself if a channel arrives afterwards: the deadline is sized from measured first-channel
latency (`ISSUES.md` O15, `docs/PLATFORM-NOTES.md` §15a), and a measurement can be beaten by a
slower machine. Witnesses: `test/e2e/kind_registration.test.ts` against a real server, and
`test/unit/registration.test.ts` for the arithmetic and for the retraction, which needs a deadline
that expires while healthy channels are in flight, a race no real server can be asked to lose on
demand.

8. Channels materialise, asynchronously. `collector.on(NBHD_KIND, NBHD_KEYS.OWNER, …)` fires once
per channel (the owner attribute is immutable, so exactly once). It captures the scope object, the
thing `.set()` can be called on, re-adopts the channel into the index, records the seat, and
drains `awaitingPublish`. Channels belonging to an ended game are dropped immediately: Tajriba
cannot delete scopes, so every channel a batch ever created is replayed to any process that
subscribes to the kind, and adopting them all means a fresh process loads every historical channel
before doing any work. Measured by `npm run soak` arm B: `channelScopes` climbed 8, 16, 24, 32
across sequential games while `games` stayed 0.

9. Recovery, if a previous process networked this game. `tryRecover()` needs two durable things in
two different places: the edge list from the batch scope, and each channel's `topologyIndex`.
Both are required. It also reads the recorded radius, not because recovery needs it — the live
config supplies that — but to notice when the two disagree, which is the one thing a restart can
change about what participants see without changing anything a later reader could detect. The edge list alone is index pairs: it describes the shape without saying who
sits where, and reconstructing seats from anything else is exactly how a restart silently
reassigns everyone to different nodes while looking like it worked (`test/e2e/restart.test.ts`).
A missing seat makes recovery refuse rather than guess: guessing produces a plausible network in
which the wrong people are neighbors, and the run looks normal for the rest of its life.

Called on every channel arrival, because channels stream in from the subscription with no
completion signal. Idempotent, and gives up quietly until the last seat is filled.

This recovery mechanism preserves the seating of a game that survives a callback-process restart.
A full server restart has a different outcome: the upstream platform fails to restore `gameID`,
so participants cannot rejoin their game and the study cannot resume.

10. First publish, or `awaitingPublish` until the last channel arrives. See §4.

11. The participant connects. `EmpiricaNetwork` installs client-side (§6), the `nbhd` scope
resolves, `useNeighbors()` returns a view. `TajribaEvent.ParticipantConnect` drops the publish
cache for that participant and republishes. This is not load-bearing today, and that is measured
rather than assumed: with the handler disabled, `test/e2e/publisher.test.ts`'s reconnect case
still passes, because Tajriba replays current attribute values to a returning participant even
though views are `ephemeral`. It is kept because that replay is undocumented behavior found by
experiment, and if it ever stops, every reconnecting participant silently goes blank.

12. Game end. `collector.on("game", "status")` calls `releaseGame()` when `hasEnded` (which
covers `ended`, `terminated` and `failed`). It flushes both sinks first, since a game ending is
the last moment its records are certainly still wanted, then drops nine structures keyed by game
or channel, including one Empirica `Scope` object per participant, and the chat relay's per-player
deduplication marks. One thing, `endedGames`, is deliberately kept rather than released per game: a
set of ids that stops a finished game's channels being re-adopted when the kind subscription
replays them. It is a few dozen bytes per game against one scope object per participant, and since
`ISSUES.md` O5 it is capped rather than unbounded (`src/admin/retention.ts`). Forgetting the oldest
is safe because the replay that would re-adopt an evicted game's channels also replays that game's
own `start` attribute, and this step runs again behind it.

## 4. The publish path

One function, `publish(game, only?)`. `only` limits which participants are recomputed;
completeness is still checked for everyone.

```
for each viewer in topology order
  ├─ channel not materialised?  → return false, publish NOTHING
  ├─ for each neighbor j in adj[viewer]
  │    ├─ project(recordReads(neighbor), recordReads(viewer), ctx)   ← the only path
  │    ├─ throws?    → rethrow, naming the (viewer, neighbor) pair
  │    ├─ undefined? → skip this neighbor
  │    ├─ validateProjection(view, label)      ← BEFORE anything is written
  │    └─ projectionBytes(view) → sizes
  ├─ JSON.stringify(neighbors) === lastPublished?  → skip this viewer
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

The publish is all-or-nothing: a channel that has not materialised returns `false` having
published nothing. A partial publish leaves some participants with a stale view and no signal
that they are stale, which is this package's characteristic failure mode.

Validation happens before the write. A publish is one batched RPC: the runloop coalesces every
`set()` made during one callback into a single `setAttributes` (`admin/runloop.ts`), so throwing
during validation means nothing is sent, and no participant gets a partial or unsafe view.
Publishing to n participants costs one round trip, not n.

If `project()` returns a scope, that value is refused. `validateProjection` (`projection.ts`)
rejects it, along with cycles, `BigInt` and `NaN`. A scope holds a reference to the global
attribute store, so publishing one would ship every attribute of every participant to that
client, the exact inverse of the guarantee.

Both arguments are wrapped by recording proxies, `recordReads` (`reads.ts`), and `ctx.stateOf()`
records too. Whatever `project()` reads is what the view depends on, and therefore what must be
in `watch` for it to stay live. Empirica has no wildcard attribute listener, so the list cannot
be inferred, but anything read and not listed is reported rather than silently going stale.

Byte-identical views are suppressed. Without that, one player changing one attribute rewrites
every neighbor's whole neighborhood on the wire, and the client sees a change event for a value
that did not change. It also makes the deliberate over-reach in `republishAround` free: a change
to P republishes P's neighbors and P itself, because a projection may key off the viewer's own
state.

Views are published `ephemeral`, so nothing durable holds them. That is why view capture exists
and why it is opt-in, and it is the difference between what a participant was told and what they
could have known, which is all an edge log plus an attribute export can give afterwards.

### What triggers a republish

| Trigger | Wiring |
|---|---|
| A watched key changes on a player scope | `collector.on("player", key, …)`, one listener per key in `watch ∪ read` |
| A watched key changes on a private channel | `collector.on("nbhd", stateKey(key), …)`, same list |
| The graph is mutated | `network(game).addEdge / removeEdge / rewire` |
| Explicitly | `net.publishAll()`, `network(game).publish()`, `publishFor(playerID)` |
| A participant reconnects | `TajribaEvent.ParticipantConnect` |
| The server tells one participant something | `network(game).tell(playerID, key, value)` |

One list covers both scopes deliberately: which scope a key lives on is the author's choice and
can change, and making them remember two lists would turn a moved key into silently frozen
neighborhoods. A listener for a key nobody uses costs nothing.

`watch` and `read` are unioned: mechanically identical, both get a listener, both appear in
`inspect()`, both are readable through `stateOf()`. The distinction is declarative: it records
what the author meant and gives `stateOf()` something to check against. A distinction that also
changed behavior would be a new way to be silently wrong, which is the thing being fixed.

## 5. Where every value lives, and why

The table the examples each write for themselves, generalised. This is the whole design.

| Location | Who can read it | What belongs there |
|---|---|---|
| Player scope (`player.set`) | Everyone (Classic cross-links every participant) | Nothing that the network is supposed to restrict. Non-secret UI state |
| Game scope | Everyone in the game (§4b) | Nothing of ours: `GAME_KEYS` is a named, empty record so the reason survives |
| Batch scope | Server only, measured (`scope_visibility.test.ts`) | The realized network, the seed, the edge history, the authoritative record of account (payoffs) |
| Private channel (`nbhd`), `state:` prefix | Its owner, and the server | What a participant writes about themselves. `networkStateOf().set()` |
| Private channel, `told:` prefix | Its owner, and the server | What the server tells one participant. `network(game).tell()` |
| Private channel, `neighbors` | Its owner, and the server | The projected views. Written `ephemeral`; server-written only |
| Run log (`log: { file }`) | Nobody in the experiment; a file on the server | Whatever your analysis needs, written as the study happens |
| View sink (`views: { file }`) | Same | Exactly what each participant was delivered, per delivery |

There are two prefixes on one scope rather than one for a functional reason, not a stylistic one:
a participant can write anything to their own channel, since it is the one scope they can
certainly write to, so a shared namespace would let `state.set("offer", …)` overwrite a value the
server authored, with no way for the server to tell. Separated, that collision is impossible.
Both are prefixed rather than raw so a participant cannot overwrite `neighbors` or `_seq`.

The batch scope is used because it is the one durable place participants cannot read. The
realized network started on the game scope, where every participant received the full edge list
and the seed: state stayed neighbor-limited but the structure did not, and for a design where
the topology is the manipulation, that is a confound rather than a nicety (`PLATFORM-NOTES` §4b,
§4c).

The history is kept as a log rather than a snapshot because the two answer different questions,
and only one is answerable from a snapshot. `network:<gameID>` is what the graph is;
`networkHistory:<gameID>` is how it got there. For a rewiring study the sequence is the
independent variable, so overwriting a single edge list as ties change would destroy the thing
being measured.

The in-memory log, rather than the attribute, is treated as authoritative. Appending by reading
the batch attribute back would be a read-modify-write against a value the server also echoes; two
mutations in quick succession can interleave so the second reads a stale copy and overwrites the
first, losing an event silently. This was measured as an intermittent failure in one run out of
six before the in-memory log was made the source of truth. The attribute is a projection of it,
not the other way round.

## 6. The client half

`EmpiricaNetwork` (`player/mode.ts`) is composed with `EmpiricaClassic`, rather than being a
reimplementation of it:

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

The `dones` protocol is the fragile part of this arrangement. `Attributes` and `Scopes` resolve
values only when their dones subjects are fed the set of updated node ids. Get it wrong and every
scope materialises correctly while every `.get()` returns `undefined`, with no error: the single
most confusing failure in this codebase. `networkContext` mirrors Classic's own wiring, and then
self-checks: if updates arrived for our scope but `ownerParticipantID` is still unreadable, it
throws `DonesWiringError` rather than serving empty views. The probe is `ownerParticipantID`, not
`_seq`, because owner is immutable and present from the moment the scope exists, while `_seq`
only appears at the first publish.

Channel selection works by matching the owner, rather than by taking the first channel seen. The
dones subjects are flushed first, and only then does selection happen, because selection depends
on the owner attribute, which is only resolved by that flush. Selecting beforehand meant owner
was still `undefined`, so with two channels present (a stale one plus ours) neither the owner
match nor the single-channel fallback applied, and the mode silently kept serving the stale
channel. This is invisible in end-to-end testing, where a participant only ever sees one channel.

`undefined` and `[]` are different answers. `Nbhd.published` exists because `neighbors`
returns `[]` both for "not published yet" and for "genuinely isolated". The hooks return
`undefined` until a real view has arrived. Rendering an isolated node during startup is a silent
data-validity bug rather than a cosmetic one.

The derivations are kept separable from React. `neighborsOf`, `networkSelfOf`, `networkToldOf`,
`networkStateOf`, `neighborChatOf` all live in `player/` and take a context; the hooks in
`player/react/` are thin wrappers. Headless clients and bots need the same derivations, and the
`verify` harness uses them.

## 7. Determinism, and its limits

```
game.id ──hashSeed──▶ seed ──makeRng──▶ rng ──topology(…)──▶ edges
                       │                                      │
                       └─────── batch: networkSeed:<id> ◀──────┘  batch: network:<id>
```

`config.seed` overrides the derivation. Both the seed and the realized edge list are written to
the batch scope, so the graph a run actually used is recoverable from stored data, rather than
re-derived and hoped to match. `makeRng` and `shuffle` are exported so a design's own randomness
can hang off the same seed. Pinned by `test/e2e/reproducibility.test.ts`.

Seat assignment cannot be re-derived, because `game.players` order is not stable; that is why the
seat lives on each channel as `topologyIndex` (§3 step 9).

## 8. The four version-fragile upstream contracts

This package is built on public API, but four contracts are fragile across `@empirica/core`
versions, and three of them fail silently. They are enumerated in
`.github/workflows/drift.yml`, which runs the suite against `@empirica/core@latest` every Monday
and is expected to be the first thing that fails after an upstream release. That failure is the
intended signal, rather than an intermittent test failure.

| Contract | Failure mode | Witness |
|---|---|---|
| `TajribaProvider` constructor shape | Silent | mode tier |
| The `dones` protocol | Silent: every `.get()` returns `undefined` | `test/mode/*`, and the `DonesWiringError` self-check |
| `AdminContext.init` parameter count | Loud | end-to-end tests |
| `ListenersCollector.attributeListeners` and the `unique` wrapper shape | Silent: the duplicate-listener detector switches off and consumers stop being warned | `test/unit/listeners.test.ts`, `test/e2e/duplicate_listeners.test.ts` |

The fourth is the only one that depends on an `@internal` field. The detector calibrates the
wrapper shape at startup rather than hardcoding it, so it retunes itself rather than going quiet,
but if the field moves or is renamed, it switches off. If `duplicate_listeners.test.ts` ever fails
saying the second handler did run, upstream has fixed the dispatcher and the warning should be
withdrawn.

## 9. What is held in memory, per process

Whether a process leaks memory is a question this package can answer directly, and `net.stats()`
exists so that the answer does not depend on inspecting a heap graph by eye. `npm run soak` prints
these alongside RSS.

| Structure | Keyed by | Released at |
|---|---|---|
| `networks`, `games`, `startedAt`, `seqByGame`, `historyByGame`, `recoveredOrder`, `gameNetworks` | game id | `releaseGame` |
| `channelScopes`, `lastPublished` | channel scope id | `releaseGame`, via the channel map |
| the channel index (`provision.ts`) | game id | `releaseChannels` |
| `lastOutbox` (chat deduplication) | player id | `releaseGame`, via the seating order |
| `endedGames` | game id | never per game, deliberately; capped at `MAX_ENDED_GAMES` |
| `reportedMissing` | key name | never; bounded by the key list |

`net.stats()` reports the two that are easy to get wrong, `endedGames` and `chatSeqs`, because
they are the two that outlive a game, and everything else in that record should return to zero
between games (`test/e2e/retention.test.ts` asserts the whole shape).

`lastOutbox` requires particular care. Its player-based key placed it outside every game-based
cleanup operation. This produced a correctness failure: Classic reuses a participant's player scope across sequential games while the
client's message counter restarts with each new channel, so a stale mark made the relay's
duplicate guard swallow the opening messages of the next game, silently (`ISSUES.md` O5). When
When adding state here, identify both the entity used as its key and the lifecycle event that
should release it.

## 10. Reading further

| | |
|---|---|
| [`GETTING-STARTED.md`](GETTING-STARTED.md) | the ordered path for someone using the package |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | symptom → cause, for when one of these mechanisms misfires |
| [`PLATFORM-NOTES.md`](PLATFORM-NOTES.md) | the measurements every claim here rests on, dated and versioned |
| [`GLOSSARY.md`](GLOSSARY.md) | channel, projection, view, seat, envelope, told |
| [`../ISSUES.md`](../ISSUES.md) | what is known to be broken, ours and upstream's |
| `MODULE-DESIGN.md` | why each of these shapes was chosen. Not in this repository |
