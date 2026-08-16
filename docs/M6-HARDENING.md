# M6 — hardening: fixing what the example experiments surfaced

*Written 2026-08-15, immediately after M5. Every claim below was measured against `@empirica/core@1.12.5` while building `examples/rand2011` and `examples/shirado2017`, not
inferred.*

## Context

M5 was supposed to be documentation, a distribution decision, and two ported experiments. It was
also, unintentionally, **the first time this package was used the way a consumer uses it** — two
complete studies written against the public API by someone following the docs.

That found **nine defects and gaps in three days**, after four milestones of tests had found
none of them. Not because the earlier tests were bad: they exercise the mechanism, and every one
of these lives in the space between the mechanism and a study. Four were fixed inline during M5
because they blocked the examples; five are still open, and two of those produce **invalid data
from a study that appears to work** — this codebase's characteristic failure, now appearing in
the *consumer's* code rather than in the package's.

The generalisable point, and the reason this document exists rather than a row in `ISSUES.md`:
**consumer-shaped code is the only thing that finds consumer-shaped bugs, and the trap audit
could not substitute for it.** `docs/M5-ADOPTION.md` §6 audited every documented trap and marked
§3a "named in the docs" — and then the packaging walked straight into §3a when I wrote an offline
analysis script. Naming a trap is not the same as not having one.

**This work is gated by one thing.** `PUBLICATION-PLAN.md` step 2 is "freeze the public API
surface". Everything in Tier 3 below is a *breaking* change after that freeze and free before it.
So Tier 3 is now-or-never, and it should be done before the first publish even though it is less
urgent than Tier 1.

## Inventory

Everything the examples surfaced, with what happened to it.

| # | What | Class | Status |
|---|---|---|---|
| 1 | **A lifecycle listener can only be registered once, silently** — `onStageEnded` and siblings share a `unique` marker stored on the *scope*, so only the first ever runs | upstream, silent | **detected 2026-08-16** (defect still upstream) — `ISSUES.md` U8 · §1.2 |
| 2 | **`watch` silently doubles as the server's read list** — a private key `project()` never touches reads back `undefined` from `inspect()`, indistinguishable from "not written" | ours, silent | **done 2026-08-16** — `ISSUES.md` O11 · §1.1 |
| 3 | **No server→participant private write path** — `project()` cannot express "tell one subject one fact about a non-neighbour" | ours, blocking | **fixed in M5** — `tell()`, `MODULE-DESIGN.md` §17 |
| 4 | **Data written only at game end** — a killed or crashed study produced no CSVs; Shirado's dependent variable was in process memory | ours, data loss | **done 2026-08-16** — `ISSUES.md` O12 · §2.1; the plan's `readNdjson(path)` turned out to be ruled out by an invariant |
| 5 | **The offline export helpers could not be imported offline** — `/admin` drags in `@empirica/core/admin`, unloadable from raw Node (§3a) | ours | **fixed in M5** — `empirica-networks/export` |
| 6 | **`views: { file: "data/…" }` threw a bare `ENOENT`** from inside `withNetwork` at game start | ours | **fixed in M5** |
| 7 | **No first-class hook for "a participant wrote private state"** — Shirado reaches for `NBHD_KIND` + `stateKey()` and depends on U3 one layer down | ours, API gap | **done 2026-08-16** — `ISSUES.md` O13 · §2.2 |
| 8 | **`network(game)` takes an object, `net.inspect(gameID)` takes an id**; `net.games()` is process-global and outlives a game | ours, API coherence | **done 2026-08-16** — §3.1, §3.2 |
| 9 | **`envelope.maxDegree: 16` is too low for a legitimate published design at n=20** — the Rand port raises it to 64 | ours, API coherence | **done 2026-08-16** — §3.3; measured, and the plan's proposed fix was wrong |
| 10 | **No artificial-player facility in Empirica v2**, so Shirado's bots are absent | upstream, scope | open — `ISSUES.md` O10 · **not doing** |
| 11 | **O8's flake rate tracks suite weight**; one case was deterministic (subscriptions opened during game assignment) | ours→upstream, debt | **re-described 2026-08-16, not fixed** — Tier 4. Rates measured per file (`chat` 5/25, `topology_visibility` 2/25 → 0/40 once its subscription moved); the stall's signature is a participant Classic never *registered*, not a player never assigned; sharding the tier — the standing fix since M4 — cannot help, because `node --test` already runs one process per file |

## Tier 1 — silent failure in the consumer's code — **done 2026-08-16**

Both of these produce a study that runs, looks right on every screen, and yields data that
answers a different question. They are the reason this document is not a backlog.

Both are now closed on our side: O11 is fixed outright, and U8 — which is upstream's dispatcher
and not ours to fix — is detected and warned about at server start. Each section keeps its
original plan above a **Done** note recording what the plan got wrong, because in both cases that
is the more useful record: §1.1's plan under-counted the work by half (it named one guard where
four were needed, and forgot that the suite itself had to be migrated to the new path), and §1.2's
plan was wrong about the shape of the field it was reading and too pessimistic about what could be
told apart.

### 1.1 Make an unlisted private key a loud error, not `undefined` — **done 2026-08-16**

**The problem.** `inspect()` fills each node's `state` from the `watch` list and nothing else. A
private key the server needs but `project()` never reads comes back `undefined`, which is
identical to "the participant has not written it yet". In the Rand port the omitted key was the
participants' rewiring answers: every answer was dropped, the network never changed in the
condition whose defining feature is that it changes, and nothing errored anywhere.

**The constraint, measured.** The obvious fix — have `inspect()` enumerate every `state:*`
attribute on the channel — **is not available.** An Empirica `Scope` exposes `get(key)` and
`getAttribute(key)` and nothing else; there is no attribute enumeration in the public API
(checked in `dist/scopes-eb5984a4.d.ts`). That absence is *why* `watch` became the read list, and
any fix has to work with a key-by-key store.

**The change.**

1. Split the two roles by name in `NetworkConfig`. `watch` keeps its meaning — keys whose change
   republishes. Add `read?: string[]` for private keys the server reads but the projection does
   not. Internally they union into one key set, so nothing about the mechanism changes; the point
   is that a consumer writing `read: ["rewireAnswers"]` has said what they meant, and a consumer
   who forgot has a named place to look.
2. Add a **loud accessor** on the handle:
   `net.stateOf(gameID, playerID, key)`, which **throws** when `key` is in neither list, naming
   the two fields and the fix. Experiment code uses this; the plain `inspect()` payload stays
   exactly as it is, because the monitor needs it JSON-serialisable and free of behaviour
   (`MODULE-DESIGN.md` §15.4 — a read API that returns something with methods is how an observer
   acquires a write path).
3. Migrate both examples to `read` + `stateOf`, and delete the long explanatory comment in
   `examples/rand2011/server/src/callbacks.js` that currently substitutes for the API being clear.

**Files.** `src/admin/with_network.ts` (`NetworkConfig`, `inspect`, the `NetworkHandle`
interface), `src/admin/inspect.ts` (`NodeSnapshot` unchanged), both examples' `callbacks.js`.

**Verify.** A unit test that `stateOf` throws for an unlisted key and returns the value for a
listed one. Then the load-bearing one: remove `"rewireAnswers"` from the Rand example's key list
and confirm `test/e2e/rand2011.test.ts` fails **with the new error** rather than by timing out on
a graph that never changed — the whole point is to convert a silent wrong answer into a loud one.

---

**Done, and what it cost.** Shipped as planned: `NetworkConfig.read`, `net.stateOf()`,
`unlistedKeyMessage`, `test/unit/state_of.test.ts` (7 tests), `examples/rand2011` migrated,
O11 closed.

Four things worth recording, because three of them were not in the plan above.

1. **Two guards, not one, and their ORDER is the interesting part.** `stateOf` throws for four
   conditions, and the plan named only the first. If the game lookup ran before the key check, an
   author with a typo would be told their game had ended and would go looking in entirely the
   wrong place — a loud error pointing somewhere else is barely better than a silent one. That
   ordering is asserted by its own test, and breaking it fails two.

2. **The union is what makes the split safe.** `watch` and `read` are unioned for listener
   registration, for `inspect()`, and for the unwatched-key warning. A version where they behaved
   differently would have turned "which list does this go in?" into a new way to be quietly wrong
   — replacing one silent failure with another, one field along. So the fields differ *only* in
   what they say to the reader and to `stateOf`. Also measured: `reportUnwatchedKeys` had to move
   to the union, or a `read` key that a projection legitimately touches would have produced a
   false warning on the one path that catches a stale neighbourhood.

3. **The break test needed the test's own waits moved first.** Deleting `"rewireAnswers"` from
   the example initially failed exactly as it did before the fix — a 30 s timeout on a graph that
   never changed — because `test/e2e/rand2011.test.ts` polled `inspect().state[...]`, where
   `undefined` is a legitimate "not yet". A test that reads through the un-loud path cannot
   observe the loud one. The waits now go through `stateOf`, and the break reports
   `stateOf() was asked for private key "rewireAnswers", which is in neither` `watch` `nor` `read`.
   Still a `waitFor` timeout, because `waitFor` treats a throwing condition as "not yet" and
   appends the last error to its message — so the failure names its cause after 30 s rather than
   at once. Loud, not fast; recorded rather than fixed, since making `waitFor` rethrow would break
   every caller that polls on state which legitimately does not exist yet.

4. **Shirado was not migrated, and should not be.** The plan said "migrate both examples".
   `examples/shirado2017` has one private key, `project()` reads it, so it belongs in `watch` and
   a `read` entry would be a declaration that is not true. Its solution detector also reads
   colours *by index across the whole graph* on every change — one `inspect()` snapshot beats
   twenty accessor calls — so it keeps `inspect()`, with a comment saying which case is which.
   `stateOf` is for a listener consuming one participant's value; bulk structural reads are the
   other case, and pretending there is only one would have made the guidance wrong.

### 1.2 Detect the duplicate-lifecycle-listener trap at startup — **done 2026-08-16**

**The problem.** U8. `onGameStart`, `onRoundStart`, `onStageStart`, `onStageEnded`,
`onRoundEnded` and `onGameEnded` register through `unique`, whose "already ran" marker
(`ran-on-<attrID>`) lives on the **scope** and is therefore shared by every listener for that
`(kind, key)`. The first callback to run sets it; every later one returns without running.
Registrations are not deduplicated and nothing warns. Splitting handlers by concern — one
`onStageEnded` per stage — is the obvious thing to write, and it silently does not work.

We cannot fix Empirica's dispatcher. We can refuse to let a consumer ship it undetected.

**Feasibility, measured.** `collector.attributeListeners` is marked `/** @internal */` but **is
readable from the instance**. Probed 2026-08-15: registering `onStageEnded` twice yields
`{"stage/ended/placement=1": 2}`. So the duplicate is visible from outside.

**The false-positive mode, also measured, and it decides the design.** Plain
`collector.on(kind, key, cb)` is **not** wrapped in `unique`, and duplicates there are entirely
legitimate — the same probe shows `{"nbhd/state:color/placement=1": 2}` for two plain
registrations, which is exactly what `withNetwork` plus `examples/shirado2017` legitimately do.
The stored callbacks are not reliably distinguishable (a `unique` wrapper is an anonymous
2-argument async arrow; so is many a user callback). So a naive "warn on any duplicate
`(kind, key)`" would fire on healthy code, including ours.

**The change.** `withNetwork` already registers a `collector.on("start", …)` hook. Extend it to
check duplicates **only for the six `(kind, key)` pairs the lifecycle helpers use**
(`game/start`, `round/start`, `stage/start`, `stage/ended`, `round/ended`, `game/ended`) and warn
once per pair, naming the dispatch-inside-one-listener fix. Degrade to silence if
`attributeListeners` is absent or not an array, because it is an internal field.

State the residual false positive in the message rather than hiding it: a consumer who calls
`collector.on("stage", "ended", cb)` *directly* is not affected by `unique` and would be warned
wrongly. That is rare, the warning says so, and a false warning is much cheaper than the silent
failure it is looking for.

**Files.** `src/admin/with_network.ts` (the `"start"` hook), a new `src/admin/listeners.ts` for
the pure counting so it unit-tests without a server.

**Verify.** Unit: a fake collector with two `stage/ended` entries warns; with one, silent; with
two plain `nbhd/state:x` entries, silent. e2e: a scenario registering `onStageEnded` twice emits
the warning, and — the non-vacuity arm — a healthy scenario emits nothing. Add
`attributeListeners` to the weekly `@empirica/core@latest` drift job's expectations, since this
depends on an internal field. *(Done: `.github/workflows/drift.yml` now names it as the fourth
version-fragile contract and the only `@internal` one, with what a red run means in each
direction. `MODULE-DESIGN.md` §10's list of three is now four.)*

---

**Done, and the plan above was wrong about two things.** Shipped: `src/admin/listeners.ts`,
the `"start"` hook extension, `test/unit/listeners.test.ts` (11) and
`test/e2e/duplicate_listeners.test.ts` (2). `ISSUES.md` U8 records the detector; PLATFORM-NOTES
§18a records the measurements. U8 itself stays open — it is upstream's dispatcher.

1. **The shape claim above is wrong.** `attributeListeners` is a plain **`Array` of
   `{ placement, kind, key, callback }`** — not a Map, and not keyed by
   `"stage/ended/placement=1"`. That string was a probe's own grouping, written down as though it
   were the field's shape. It survived into a document that then described it as *measured*,
   which is the failure mode the house rule exists to prevent: the measurement was real, the
   transcription was not.

2. **"The stored callbacks are not reliably distinguishable" is too pessimistic**, and it was the
   sentence that shaped the design. Measured: `unique()` returns an anonymous 2-argument
   `AsyncFunction`, so a **named**, **synchronous** or **differently-arity** callback cannot be a
   wrapper. That converts the false-positive surface from "any two plain `.on`s on a lifecycle
   pair" — which would have included this package's own — into the much narrower "two plain `.on`s
   both passing anonymous 2-argument async callbacks". So the shipped detector has four filters,
   not the one the plan describes: the six pairs, matching placement, matching callback shape, and
   an identity exclusion.

Three further things the work turned up:

3. **The shape is calibrated, not hardcoded.** A literal `AsyncFunction/""/2` would go silent the
   day upstream makes `unique` named or synchronous — failing in the **false-negative** direction,
   which is the worse one for a detector whose whole job is catching a silent failure. So it builds
   `new collector.constructor()`, registers one `onStageEnded` on it, and reads back whatever came
   out. That also avoids importing `ClassicListenersCollector`: `withNetwork` takes an untyped
   collector and does not otherwise depend on Classic, and a detector is not a reason to acquire
   that dependency.

4. **The detector nearly fired on this package's own examples.** `withNetwork` registers a plain
   `.on("game", "start", …)` — one of the six pairs — and as an inline arrow its shape was exactly
   a wrapper's. Alongside a single correct `onGameStart` that reads as a duplicate, and both
   shipped examples do exactly that. Fixed by excluding it by identity. Extracting it to a `const`
   also fixes it a second way, because an arrow assigned to a `const` takes the const's name — but
   that is a side effect of readable code, not a guarantee, so the identity exclusion is the one
   that is load-bearing and there is a unit test that constructs the collision deliberately.

5. **The warning fires once per process.** `start` can fire again if the admin reconnects
   (`initOrStop` tears the subscriptions down and rebuilds them) while the registration list
   cannot have changed — so without a guard a flaky connection would repeat the same message,
   which is how a message stops being read.

6. **The e2e test destabilised the tier, and fixing that produced O8's controlled experiment.**
   Its first version ran two full n=3 games and took the e2e tier alone from green 62/62 to 1 and
   then 3 failures in *other* files; removing the file restored green, with orphan count 0
   throughout. The warning fires in the `start` hook, before any participant connects — so the
   warning arms need **no batch, no game and no participants**, which costs 0.27 s instead of two
   games. Written up in `ISSUES.md` O8, because it is the first clean add/remove/re-add sequence
   separating load from orphan contamination, and it promotes Tier 4's sharding item.

7. **The e2e non-vacuity check had to become structural.** The healthy arm asserts an *absence*,
   which a broken capture satisfies perfectly — so it needs a witness that the capture works. The
   obvious one, "at least one line was logged", **fails**: with no participants and no batch a
   healthy server logs literally nothing. Measured, by writing that assertion and watching it fail
   for the right reason. Both arms now run through the same `capture` in one test, so the silence
   means something because the same capture caught the warning moments earlier.

8. **The e2e broken arm asserts the defect as well as the warning.** A warning about upstream
   behaviour that nothing re-checks becomes folklore. The test ends a stage and asserts the second
   handler never ran, so if `unique` is ever fixed the test fails and says the warning should be
   withdrawn — rather than the package going on to mislead every consumer.

**And a bug found in this suite while writing the test.** `warn()` from `@empirica/core/console`
routes every level through **`console.log`**, not `console.warn` (PLATFORM-NOTES §18b). The
capture pattern copied from `test/e2e/envelope.test.ts` therefore collected nothing — and that test
never noticed because it never asserted on what it collected. A capture that is silently blind is
worse than none: it would have passed any assertion that a warning was *absent*. The dead capture
is removed and the working one is documented where the next person will copy it from.

## Tier 2 — the copied surface is holding code the package should own — **done 2026-08-16**

`docs/M5-ADOPTION.md` §2's rule: **anything in the copied surface is code you cannot patch.** M5
then put ~90 lines of infrastructure into that surface, twice, because the package had no home
for it. That is the rule being broken by its own author, which is the most reliable sign the
package is missing something.

### 2.1 Promote the run log into the package — **done 2026-08-16**

**The problem.** Both examples hand-roll `logEvent()` — `mkdirSync` plus `appendFileSync`, no
buffering — and a matching `fromLog()`. Duplicated, unpatchable once copied, and in
`examples/shirado2017` it runs **inside the runloop on every participant colour change**, which
is a synchronous filesystem call on the callback path. The package already avoids exactly this
for views: `makeViewSink` buffers 256 records with a 2-second idle flush, a game-end flush and an
exit flush, so a hard kill costs at most one batch.

**The change.** Generalise `src/admin/views.ts`'s sink into an append-only NDJSON sink and expose
it as a first-class config:

```js
withNetwork(Empirica, {
  …,
  log: { file: "data/run.ndjson" },     // same buffering as `views`
});
// then, from a listener:
net.log(gameID, { type: "round", round, rows });
```

Reuse the flush machinery rather than copying it; `views` becomes one caller of it. Ship a
generic `readNdjson(path)` from `empirica-networks/export` that drops and **counts** unparseable
trailing lines, since a hard kill truncates the last record and both examples currently
re-implement that too.

Keep `fromLog()` in each example: reconstructing *that experiment's* tables is the experiment's
business, and it is already pure and unit-tested. What moves is the plumbing.

**Files.** `src/admin/views.ts` → a shared sink; `src/admin/with_network.ts` (`NetworkConfig.log`,
`NetworkHandle.log`); `src/admin/export.ts` (`readNdjson`); both examples' `callbacks.js` and
`recover.mjs`.

**Verify.** Move the existing nested-directory and flush tests onto the shared sink. Add: a kill
mid-write loses at most one batch (write 300 records with `batch: 256`, `process.exit`-style
teardown, assert ≥256 landed). Keep `test/e2e/rand2011.test.ts`'s "the log is on disk while the
game is still running" assertion pointed at the new path — it is the test that proves the whole
property and it must not be lost in the refactor.

---

**Done, and four things the plan did not have right.**

Shipped as planned: `src/admin/sink.ts` holds the one writer, `views` is a caller of it,
`log: { file }` + `net.log(game, record)` are new, `parseNdjson` ships from
`empirica-networks/export`, both examples and both `recover.mjs` scripts are migrated, `ISSUES.md`
O12 records it.

1. **`readNdjson(path)` cannot exist**, and the plan asked for it by name. Everything reachable from
   `empirica-networks/export` has to load from plain Node with no build step (§3a), and
   `test/unit/export_isolation.test.ts` enforces that by refusing `export.ts` *any* runtime import —
   `node:fs` included. So the function is `parseNdjson(text)` and the caller keeps its one line of
   `readFileSync`. Worth recording because the plan was written by someone who knew about the
   invariant and about the trap that produced it: **naming a constraint in one document does not
   stop you designing against it in the next.** The same sentence appears at the top of this file
   about `M5-ADOPTION` §6, one milestone earlier.

2. **The two sinks must NOT share a default, and copying `views`' 256 would have been the
   silent-failure-shaped mistake.** The plan said "same buffering as `views`". But `views` buffers
   because it is on the publish path and pays per delivery per participant, while the run log exists
   *specifically* so that a killed study still has data. Defaulting it to 256 would have taken a
   facility whose entire purpose is durability and made it hold its newest records in memory —
   worse, it would have *silently reduced* the durability the examples already had, since both were
   appending synchronously by hand. Default is 1. `SinkOptions.defaultBatch` is per-caller so the
   contrast sits in one file where it cannot drift into looking arbitrary.

3. **One log file for the whole study, not one per game.** The examples wrote
   `data/<gameID>/log.ndjson`; the config takes a single `file`, so `net.log` stamps `gameID` and
   `at` instead. Two gains that were not the reason for the change: a batch of concurrent games
   interleaves safely, and `recover.mjs` no longer needs a directory to have been created — under
   the old scheme a game whose directory did not exist was a game with no recoverable data. Verified
   on real output: one `run.ndjson` from a suite run held six games, and `recover.mjs data/run.ndjson`
   rebuilt all six.

4. **A latent short-write bug in the code being moved.** The old `flush()` ignored
   `fs.writeSync`'s return value, and `write(2)` may write fewer bytes than asked, reporting it by
   returning the count rather than by throwing. That would have truncated a record **mid-file**,
   which is worse than losing the tail: a lost tail is expected of a killed run and `parseNdjson`
   counts it, while a hole in the middle is a corrupted log that still parses. Now loops on the byte
   count. Found by reading the code closely enough to move it, which is an argument for the move
   independent of the duplication.

**And one thing the verification did better than the plan asked.** The plan's kill test said
"`process.exit`-style teardown". `process.exit` runs exit handlers, so it would have measured the
flush rather than the loss. `test/unit/sink.test.ts` spawns a child and sends it **SIGKILL**, which
no handler catches: at `batch: 256`, 300 records leave **exactly 256** on disk, and at `batch: 1`
they leave 300. Both numbers are asserted, because the cost of buffering is only believable stated
as a number, and it is the argument for the default in (2).

Separately, the byte-identical claim behind `recover.mjs` was unit-tested and had never been checked
against a real server. It has now been, for a session that ended naturally in both examples: every
recovered CSV matched the clean export byte for byte. The one thing that does *not* match is
Shirado's `edges.csv`, which recovers empty because that graph lives on the batch scope and not in
the log — already Tier 4's item, now confirmed rather than assumed.

### 2.2 A first-class hook for participant private writes — **done 2026-08-16**

**The problem.** Shirado's solution detector needs to run whenever a participant writes their
colour. The only way is:

```js
import { NBHD_KEYS, NBHD_KIND, stateKey } from "empirica-networks/admin";
Empirica.on(NBHD_KIND, stateKey("color"), (_ctx, props) => { … });
```

That reaches past the package's abstraction into its key layout, requires the author to know that
plain `.on` escapes the `unique` guard, and **depends on U3 one layer down** — it only works
because `withNetwork` issued `ctx.scopeSub({ kinds: ["nbhd"] })` at start. A consumer who copies
this into a project that does not call `withNetwork` gets a listener that never fires, silently.

**The change.** Add `onPrivateState?: (event) => void` to `NetworkConfig`, or
`net.onPrivateState(key, cb)`, delivering `{ gameID, playerID, key, value }` — plain data,
player ids not indices, consistent with the rest of the handle. It costs one listener per watched
key, which `withNetwork` already registers, so this is mostly exposing what exists.

**Files.** `src/admin/with_network.ts`; `examples/shirado2017/server/src/callbacks.js` loses its
three package-internal imports.

**Verify.** e2e: a participant write reaches the hook with the right player id and value; a
*non*-participant write (a server `tell`) does not, since the two namespaces are separate. Then
assert the Shirado end-condition test still passes through the new hook — it is the existing
witness that U3 has not regressed (`MODULE-DESIGN.md` §15.2) and must stay one.

---

**Done, as planned, with three decisions the plan left open and one measured surprise.**

`NetworkConfig.onPrivateState` delivers `{ gameID, playerID, key, value }` for any key in `watch` or
`read`. `examples/shirado2017` lost its three package-internal imports and its `Empirica.on` call.
`ISSUES.md` O13.

1. **A config field, not `net.onPrivateState(key, cb)`** — the plan offered either. A method invites
   registration after the admin has started, and a listener registered too late is a listener that
   never fires: exactly the class of bug this item closes. A field is read before anything is wired.

2. **After the republish, not before.** A handler that ends the stage — which is what Shirado's does
   — should do it with every participant's view already current.

3. **A throw is caught and reported with its stack, not propagated.** With twenty participants, one
   handler failing must not stop the other nineteen's events. That is the opposite of `project()`,
   which throws, and the difference is worth stating: there nothing has been sent yet and a bad view
   must not go out, while here the write has already happened and the only question is whether to
   keep going. The report says so explicitly — "the write itself succeeded and everyone's view was
   republished, so what did not happen is whatever your handler does".

**The surprise was in how to test the absence.** The plan's second assertion — a server `tell` must
not arrive as a participant write — is a claim about nothing happening, and M6 had already twice
watched "wait for an absence" push the e2e tier red (`ISSUES.md` O8). Both halves therefore share one
scenario, and the absence is checked at a moment already pinned by a positive assertion: the hook
tells the participant something under **the same key name**, the test waits for that told value to
arrive at the client, and only then asserts the hook never saw it. Sharper as well as cheaper —
`told:secret` and `state:secret` being separate namespaces is the property that matters, and if they
ever merged an author's handler would begin scoring the server's own stimulus as a participant's
decision. The whole file runs in 2.6 s.

Load-bearing, confirmed by breaking it: removing the hook's one call site fails
`test/e2e/private_state.test.ts`'s new arm **and** `test/e2e/shirado2017.test.ts`'s "a proper
colouring ends the session", so the U3 witness is still a witness. Reading the value from the wrong
key namespace fails the value assertion in 0.3 s.

## Tier 3 — API coherence, and it must happen before the freeze — **done 2026-08-16**

Free now; a breaking change after `PUBLICATION-PLAN.md` step 2. None of these caused a bug; all
of them cost time while writing the examples, which is the evidence that matters here.

All three shipped. §3.3 turned out to be the substantial one and the only one where the plan's
proposed fix was arithmetically wrong; each section keeps its original text above a **Done** note.

### 3.1 One argument convention — **done**

`network(game)` takes a game **object** and reads only `.id` off it. `net.inspect(gameID)` takes
an **id**. `net.log()`/`net.stateOf()` as proposed above would take ids too. Writing
`test/e2e/rand2011.test.ts` I passed an id to `network()` and got
`no network for game (no id)` — a correct message for a confusing signature, and the workaround
in the test today is a `{ id }` wrapper that works by accident.

**Change:** accept **either** everywhere — `string | { id: string }` — normalised in one helper,
and say so in the types. Cheap, non-breaking now, and it removes a whole class of call-site
confusion.

**Done.** `GameRef = string | { id?: unknown }` and one `gameIDOf()` in front of `network()`,
`inspect()` and `stateOf()`. `test/e2e/rand2011.test.ts` lost its `{ id }` wrapper.

Two things the normaliser had to get right that the plan did not mention, both about what it
*refuses*:

- **It sits in front of every `Map.get`, so anything it lets through becomes a lookup with a
  nonsense key** — which returns `undefined` and reads as "that game has ended". `{ id: 42 }`,
  `{ id: "" }` and `{}` are all rejected rather than stringified, and there is a unit test per
  case for exactly that reason.
- **`inspect()` still returns `undefined` for an unresolvable reference while `network()` and
  `stateOf()` throw**, and the asymmetry is deliberate rather than an oversight: `inspect` is the
  monitor's read path, called from timers and HTTP handlers, and throwing there takes the observer
  down at the moment something is going wrong. `undefined` is also its honest answer for an ended
  game.

### 3.2 `net.games()` lifetime — **done**

`games()` returns games this *process* is networking, which outlives any one game and any one
test scenario. In a suite it can return a previous test's game or nothing; in production it is
correct but easy to misread as "the current game".

**Change:** rename to `activeGames()` or document the lifetime in the type, and — worth
considering — return `{ id, startedAt }` so "which one is current" is answerable from the return
value rather than by convention.

**Done — both, not either.** `activeGames(): Array<{ id: string; startedAt: number }>`, sorted
newest first so `activeGames()[0]` is at least *defined* rather than insertion-ordered. The
monitor maps it back to ids at its own boundary, because `serveMonitor` is deliberately free of
this package's types and a payload-shape decision does not belong in it.

`startedAt` needed a caveat that only appeared while writing it: **it is when THIS PROCESS picked
the game up, not when the game started.** After a restart the original start time is not
recoverable from anything durable, and synthesising one would have made `activeGames()` report a
lie with an entirely plausible shape. It is recorded on the recovery path too, so it consistently
means the one thing, and the doc comment says which.

### 3.3 Separate the two things `maxDegree` is doing — **done, and it needed the measurement**

The default is 16, and the doc comment calls it **measured** (SPIKE-REPORT §4: sparse graphs
d ≤ 16 at n ≤ 100 ran at ~1× the theoretical floor). Rand 2011 caps degree at nothing, reports a
mean of 8.2 in the fluid condition and a tail to about 20 at n ≈ 19.6 — so a faithful
reconstruction needs degree up to n−1, and `examples/rand2011` raises the limit to 64 with a
paragraph of justification at the call site.

That paragraph is the bug report: **16 conflates a per-participant payload limit with a
latency-at-scale limit, and only the second was measured.** A full neighbourhood at n = 20 is 19
tiny objects; the same degree at n = 200 is a different proposition entirely.

**Change:** either default `maxDegree` to `min(16, n - 1)` — which admits every complete-ish small
graph while keeping the measured ceiling where it was measured — or split it into
`maxDegree` (payload) and a separate scale check, and make the error message say which evidence
each rests on. **Measure before choosing:** the honest input is a bench run at n = 20 with
d = 19, which does not currently exist. Do not raise a limit described as measured without a
measurement.

---

**Done, and "measure before choosing" earned its place — the plan's own first option does not
work.** `min(16, n - 1)` at n = 20 is `min(16, 19)` = **16**, which does not admit the graph it was
proposed to admit. It only ever *lowers* the limit, for n < 17. The sentence reads as though it
had been checked; the arithmetic says it had not. (`max(16, n - 1)` would admit it and would also
hand n = 200 a cap of 199, which is worse than the problem.)

**The measurement.** `npm run bench -- --dense` was added — a `--dense` cell set using
`complete(n)` — and run at 60 rounds per cell, participants sharded across processes,
`@empirica/core@1.12.5`, 2026-08-16:

```
  n= 20  d= 8  shards=2  p50  4.1ms  p95  9.8ms  max 13.3ms   440/440 receipts
  n= 20  d=19  shards=2  p50  7.5ms  p95 13.9ms  max 16.5ms  1045/1045 receipts
  n= 50  d= 8  shards=2  p50 10.1ms  p95 30.3ms  max 35.5ms   440/440 receipts
  n= 50  d=49  shards=2  p50 16.1ms  p95 24.6ms  max 30.4ms  2695/2695 receipts
  n=100  d=16  shards=4  p50  9.9ms  p95 11.6ms  max 13.4ms   880/880 receipts
```

**A complete graph at n=20 is faster than a degree-8 ring at n=50, and faster than the old
limit's own cell (n=100 d=16).** Not one receipt was dropped and no round was silent at any
density. Degree is a second-order term: what the cells track is participants per client process —
n=50 over 2 shards and n=100 over 4 both put 25 per process and both land near 10 ms, while n=20
over 2 puts 10 per process and lands at 4 ms. That is the bench's own standing caveat showing up
again, and it is the reason the old number was wrong: **16 was a number about n, enforced as a
number about degree.**

**The change.** `defaultMaxDegree(n)` is `n - 1` at n ≤ 50 and 16 above it, so within the target
regime there is no degree cap at all and above it the limit stays exactly where its evidence is.
`checkDegrees` reads n off `adj.length`. `resolveEnvelope` only uses the permissive branch when it
is *told* n — omitting n yields 16 — because a helper that inferred a laxer default from missing
information would be lifting a limit on the strength of not knowing. The error message now names
which evidence was hit, and a breach of a limit the *author* set says so rather than blaming our
bench and sending them to read the wrong document.

**And the limit that had to be added, which is the part worth generalising.** The bench projects
two fields, so it established that degree is cheap **at small view sizes** and nothing more.
Degree × view size is what a participant's connection carries, and it is precisely what
SPIKE-REPORT §4's client-bandwidth finding was about — so lifting the degree cap removed a guard
that had been doing that job by accident. `maxNeighbourhoodBytes` (default 64 KiB) now does it on
purpose: 49 views of 1.5 KiB are each well inside `maxViewBytes` and total 73 KiB, on a graph the
new default permits, and neither existing limit can see it. **Removing a limit is only honest if
you work out what it was accidentally guarding and guard that deliberately.**

**One coverage gap found by breaking things.** `publish()` had to start labelling each view with
its viewer for the aggregate check to have anything to group by. Deleting that one word left every
unit test green — the check simply found nothing to sum and passed. `test/e2e/envelope.test.ts`
now has an arm that fails when it goes.

**And that arm immediately proved Tier 4's point on itself.** Its first version threw on the breach
and then waited 8 seconds to confirm nothing had published, plus a second scenario to show the same
views publish under a higher limit: 8.5 s and two servers to assert an *absence*, which took the
e2e tier from green to failing on `topology_visibility`. Rewritten with `onExceed: "warn"`, it
asserts the warning's exact per-viewer total instead — a **positive** claim, a sharper one about the
wiring than "nothing came out", one server, **0.25 s**. The tier went green twice in a row. So the
cheaper test is also the better test, and the O8 pressure is what prompted looking for it
(`ISSUES.md` O8).

**Covered by:** `test/unit/envelope.test.ts` (17, rewritten — the old file asserted that a
complete graph at n=40 was refused, which is now false), `test/unit/game_ref.test.ts` (6),
and the new e2e arm.

## Tier 4 — coverage and hygiene — **done 2026-08-16**

Four of the five items shipped as planned. The fifth — **shard the e2e tier**, this tier's lead item
— was measured first and **abandoned on the measurement**: the tier is already sharded, so the plan's
central item was a fix for a shape the suite does not have. What replaced it is a tool for measuring
a flake rate, one relocated subscription, and a considerably sharper description of O8. Each item
keeps its plan above a **Done** note.

- **Build the example clients.** All three exist; none has had `vite build` run against it. M5
  parse-checked seven `.jsx` files with `@babel/parser`, which catches syntax and JSX errors and
  **not** import-resolution errors — so a wrong import path in `examples/rand2011/client` would
  ship. Add a CI job that runs `node scripts/example-install.mjs <name> && npm --prefix
  examples/<name>/client run build` for each, or accept the cost knowingly and record it.

  **Done.** All three build. Two things the plan did not say. First, CI already *had* an example-build
  job — it built `minimal` only, because that line was written when there was one example, and M5's
  two arrived without it changing. So the gap was not a missing job but a **hard-coded path**, and the
  fix is `scripts/example-build.mjs` iterating `examples/*/client`, wired into CI as
  `npm run example:build`; the next example is covered by existing. Second, the value of the build was
  confirmed by breaking it: importing `empirica-networks/player/reactt` fails with
  `Missing "./player/reactt" specifier in "empirica-networks" package`. That is the **exports map**
  being exercised against a real bundler — the one thing no test in the three tiers does, since all of
  them alias the package to `src`.
- **Shirado recovery leaves `edges.csv` empty.** The network is static and lives on the batch
  scope, not in the run log. Either log the graph once at game start (three fields, and 2.1's
  `net.log` makes it a one-liner) or have `recover.mjs` read it from the store. The script says
  which it did; that is not a substitute for doing it. **Confirmed rather than assumed, 2026-08-16**:
  running the example's own e2e suite and then `recover.mjs data/run.ndjson` reproduced it — the
  recovered `session.csv` and `changes.csv` matched the clean export byte for byte, and `edges.csv`
  came out empty. Note that the graph *is* already logged as a `graph` record (n, edges, maxDegree);
  what is missing is the edge list itself.

  **Done, by logging the package's own events rather than the plan's "three fields".** The `graph`
  record now carries `events: network(game).history()` verbatim, and `fromLog` returns it. Copying the
  events instead of reconstructing an edge list from `snapshot.edges` is what makes recovery
  **byte-identical**: `edgeRows` keys every row's `t` on the event's own `at`, which a reconstruction
  would have had to invent. Verified end to end — the example's e2e suite, then `recover.mjs` over the
  real log: `session.csv`, `changes.csv` **and** `edges.csv` (13 rows) identical for both games that
  finished cleanly, and the third game, torn down mid-run, recovered 13 edge rows where it previously
  produced an empty file.

  Two things worth keeping. **The old unit test could not have caught this**: "recovering a killed
  session produces the SAME tables as a clean finish" passed a placeholder string as `edges.csv` to
  *both* sides, so the one file that did not recover was the one file the equivalence test could not
  see. It now builds both sides through `edgeRows`. And **`toCSV(edgeRows(…))` did not typecheck** —
  `EdgeRow` was an `interface`, which TypeScript denies the implicit index signature `toCSV` requires,
  so two exported functions of the same module did not compose. It went unnoticed because every caller
  composing them was in an example's plain JavaScript. `EdgeRow` and `SnapshotRow` are now `type`
  aliases; widening `toCSV` to `object` was rejected, since it would make `toCSV([{a: {b: 1}}])`
  compile and emit `[object Object]`.
- **Shard the e2e tier. Promoted from "consider" to the main item, 2026-08-16.** §1.2 produced a
  controlled experiment that settles O8's load-versus-orphans question: adding one e2e file with
  two n=3 games took the **tier alone** from green 62/62 to 1 and then 3 failures in *other* files,
  removing it restored green, and orphan count was 0 throughout (`ISSUES.md` O8). The tier is now
  big enough that O8 shows up without a full `npm test` in front of it. The orphan `pkill` is still
  worth putting inside the runner, but it is no longer the main lever.
  - **Worse as of Tier 2's verification, same day.** With one more e2e scenario (66 tests) the tier
    alone went **1 green in 3** — `scope_visibility` at 90 s, then `chat` at 30 s, then green, 0
    orphans throughout, both victims green when run alone. `chat` is a new victim, so this is not a
    property of the three files O8 has been recorded against. The practical loss is a level of the
    signal hierarchy: re-reading the *tier* no longer separates a flake from a regression, only
    re-reading the *file* does.
  - A second, cheaper lever fell out of the same finding: **the cost of a test is a property of the
    test.** That file was spending two full games on a warning that fires before any participant
    connects; the participant-free version costs 0.27 s. Worth asking of the existing files too —
    "what is the smallest scenario that can observe this?" is not a question this suite has been
    asked systematically.

  ---

  **Abandoned on the measurement, and this is the tier's main finding.** Sharding cannot help, because
  **`node --test` already runs every test file in its own child process** — verified directly, two
  files under `--test-concurrency=1` reporting two different `process.pid`. With concurrency 1 the tier
  is already one fresh process per file, one at a time. The plan's lead item was a fix for a shape the
  suite does not have, and nine months of O8 notes had been pointing at it without anybody checking
  the process model.

  Measured before being abandoned, as 25 separate `node --test` invocations, swept before each of three
  passes: **3, 0 and 2 file failures — 5 of 75 file-runs, 6.7%, 0 orphans, all "gameID assigned"**.
  The same 1-green-in-3 as the single invocation. The tier also costs **89 s green**, so the "cost of a
  test" lever was worth much less than it looked: nothing here is slow, it is unreliable.

  What was done instead, in the order it mattered:

  1. **`scripts/e2e-repeat.mjs` / `npm run test:repeat -- <file> 25`.** The docs' rule had become
     "re-read the *file* alone", and this measures whether that rule is even usable. It is not, on its
     own: `topology_visibility` alone failed **2 of 25** runs, so a single green re-read of a file that
     fails 8% of the time says nothing. A rate does.
  2. **O8's signature, finally.** On a stalled run the server had created **fewer player scopes than
     there were connected participants**, and the participant left out had none at all. So this was
     never "players are not assigned to games" — it is a participant Classic never registered, and
     nothing gets as far as being assignable. Three milestones of notes describe the wrong step.
  3. **One subscription moved.** `topology_visibility` opened its extra `changes()` subscription before
     `createBatch` — precisely the shape M5 found and fixed in `rand2011` and then never applied
     elsewhere. Moved to after `batch.running()`, where it costs the test nothing (the network does not
     exist until the game starts): **2/25 → 0/40**. `scope_visibility` keeps the early subscription
     because its sentinel is written *at* batch creation, and now says so.
  4. **The orphan sweep is in the runner**, and prints its count, since the count is what licenses
     reading a red run as something other than a dirty machine.
  5. **A model of the rate, and its refutation, both in the same hour.** `chat` (3 `withScenario`
     calls) fails **5/25 = 20%**; `topology_visibility` (1 call) fails **2/25 = 8%**; both imply
     **~7–8% per scenario** under `1 − (1 − p)^scenarios`, which was neat enough to write down as
     "the unit of risk is the scenario". Then: the tier holds **58** `withScenario` calls, so a
     uniform 7.5% predicts a green tier **1.1%** of the time, and the tier is green about **1 run in
     3**. The model is wrong — risk is concentrated in a few files, not spread over scenarios — and
     the correction is in `ISSUES.md` O8 beside the claim. What survives is narrower: scenario count
     multiplies a file's exposure to whatever it is already exposed to, and **seconds are not the
     currency** (`chat`, 3.8 s green, is the worst offender measured; `restart_full`, 21 s, has never
     failed). Recorded because it is a fair sample of this tier: three of its findings arrived by a
     tidy explanation being checked one step further than it wanted to go.

  A reconnect-on-missing-player-scope repair was written and **not shipped**: across 60 runs of the
  shape that had stalled 10 times, it never triggered once. Shipping it would have added a recovery
  path that no run had ever executed, which is a mitigation in name only. Full numbers in `ISSUES.md`
  O8, including the honest statistics — at a ~10% rate, 30 runs cannot separate 10% from 0%, and none
  of these before/after pairs is individually significant.
- **Three examples share one committed `srtoken`** in `.empirica/empirica.toml`, copied from
  `examples/minimal`. Harmless on localhost and worth not teaching: give each its own, or add a
  line saying it is a scaffold-local dev secret.

  **Done — both, not either.** Each example now has its own `srtoken` *and* admin password (the plan
  only noticed the token; the password was copied too), above a comment saying what they are, that
  U1 makes an `srtoken` a total write capability, and that they must be regenerated before the config
  is reachable from anywhere but localhost. Distinct values are the part that stops a reader treating
  one example's token as a working default, and the comment is the part that survives being copied.
  Left alone deliberately: all three still declare `name = "scaffold-probe"`, which is a copied
  scaffold artefact but not one I can change and verify without booting each example's dev server.
- **Close O11 and U8 in `ISSUES.md`** when 1.1 and 1.2 land, and file U8 upstream — it is the
  strongest candidate after U1 and U2, with the shortest reproduction on the list.

  **Half done, and the remaining half is not mine to do quietly.** O11 and U8 are closed in
  `ISSUES.md` (Tier 1). Filing U8 upstream is an outward-facing act on a public tracker, so it is left
  for the maintainer to send rather than done unasked — and `PUBLICATION-PLAN.md` step 1 sequences U1's
  disclosure ahead of it anyway.

## Not doing, and why

- **O10, the Shirado bots.** Not a fix; a project. It needs a headless participant process per
  bot, a policy interface, and a way to keep bots out of the participant count a treatment
  declares. The hard part already exists in `src/verify/harness.ts`
  (`connectParticipant`), and `docs/PLATFORM-NOTES.md` §17 records the route. It should be its own
  milestone with its own justification, not a line item here.
- **Fixing U3, U4, U5, U6, U7, U8 upstream.** Reported, worked around, out of our hands.
- **A template repo.** Rejected in M5 for reasons that Tier 2 only strengthens: the copied surface
  is a liability, and this document exists because M5 put too much in it.

## Sequencing

1. ~~**Tier 1** first — it is the only tier where the status quo produces invalid data.~~
   **Done 2026-08-16**: §1.1 (O11, fixed) and §1.2 (U8, detected — the defect is upstream's).
2. ~~**Tier 3** next, despite being less urgent, because it is free before the API freeze and
   breaking after it. 3.3 needs a measurement before it needs a decision.~~ **Done 2026-08-16.**
   3.3 did need the measurement first, and the measurement invalidated the plan's own preferred
   fix — see the note there.
3. **Tier 2** — a refactor with a clear target, best done once Tier 1 has settled the shape of
   `NetworkConfig` (both add fields to it). **Done 2026-08-16.**
4. ~~**Tier 4** alongside, as capacity allows. **Now the only tier left, and sharding the e2e tier is
   its lead item**~~ — **Done 2026-08-16**, with its lead item abandoned on measurement rather than
   completed: the tier is already one process per file, so there was nothing to shard. See the note
   there for what replaced it.

Then, and only then, `PUBLICATION-PLAN.md` step 2: freeze the surface and publish. **That is now
next**, with one API change made in Tier 4 that the freeze should note: `EdgeRow` and `SnapshotRow`
became `type` aliases rather than `interface`s, so that `toCSV(edgeRows(…))` compiles at all.

**Baseline to hold throughout:** **276 unit / 34 mode / 66 e2e** as of 2026-08-16 — 225 / 34 / 62
before Tier 1, 243 / 34 / 64 after it, 255 / 34 / 65 after Tier 3, 274 / 34 / 66 after Tier 2 — with
`npm run check` clean. Tier 4 added 2 unit tests and no e2e tests, which is deliberate: it is the
tier that measured what an e2e scenario costs in reliability.

**The e2e tier's honest state at the close of M6.** It is **not green on demand**. The closing full
run lost `chat`, `told` and `scope_visibility`, all on "gameID assigned", 0 orphans, and a rerun of
the tier alone lost three again; `npm run test:repeat` puts `chat` at 5/25 and `topology_visibility`
at 0/40 after its subscription moved. Every failure across every run this session was O8 and no other
symptom. That is a suite that catches regressions in the 63 tests that pass and cannot presently
prove the absence of one in the three that flake — which is the state to publish against, stated
plainly rather than rounded to "green".

Tier 2's additions are almost all in the two cheap tiers, deliberately: 12 new tests in
`test/unit/sink.test.ts`, 7 in `test/unit/log.test.ts`, 5 for `parseNdjson` in
`test/unit/export.test.ts`, minus 5 net from moving the sink's tests out of
`test/unit/views.test.ts`, and **one** new e2e scenario.

**Read a red run in the right place — and this changed today.** The rule was "the e2e tier alone is
the reliable signal". It no longer is: at 66 tests the tier alone went 1-green-in-3 across three
swept, idle-machine runs, losing `scope_visibility` (90 s) and then `chat` (30 s) on `gameID
assigned` and then nothing, with **0 orphans** throughout. Both victims passed immediately when run
alone. So the check that still separates a flake from a regression is **the file alone**
(`npm run test:one <file>`), and `ISSUES.md` O8 now records the tier's demotion with the numbers.
Sweep orphans first regardless.

**Corrected again by Tier 4's measurement, and this is the version to follow.** "The file alone"
is not a check either, because the file alone fails too: `topology_visibility` was **2/25** on a swept
idle machine. One green re-read of a file with an 8% failure rate is not evidence. Use
**`npm run test:repeat -- <file> 25`** and compare rates, which is the only form of this check that
survives its own numbers. The runner now sweeps orphans itself and prints the count, so "0 orphans"
is on the record for every run rather than something to remember to do.

**A sharpening of O8 measured while verifying §1.1, since it changes how to read a red run.** The
e2e tier alone was green 62/62 on every attempt. The *same* tier inside a full `npm test` — unit
and mode first, one `npm run test` invocation — failed twice out of three runs, and both times on
`gameID assigned`: once `scope_visibility` alone, once `scope_visibility` and `told`, once
nothing. An orphan sweep immediately before the run did not prevent it. So the flake tracks the
weight of the *whole* run and not just the number of e2e files, which is evidence for Tier 4's
"shard the e2e tier" over "sweep harder", and it means **`npm test -- e2e` is the reliable signal
and a red full run needs a second look before it is a regression.**
