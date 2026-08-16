# Open issues

Everything known to be outstanding after M5, with the evidence for each. Written as issues
rather than prose so they can be filed as-is when this repo gets a remote.

Status key: **ours** = fixable here · **upstream** = Empirica's, we can only work around or
report · **debt** = measurement or process, not a defect.

**The entries M5's example experiments surfaced have a plan: [`docs/M6-HARDENING.md`](docs/M6-HARDENING.md).**
**Tiers 1, 2 and 3 are done as of 2026-08-16.** Tier 1 closed the two silent ones, both of which
produced invalid data from a study that appears to work: O11 is fixed, and U8 remains upstream's
defect but is now detected and warned about at server start. Tier 2 moved the run log and the
participant-write hook out of the copied surface and into the package (O12, O13). Tier 3 settled
the API-coherence items that were free before `PUBLICATION-PLAN.md`'s freeze and breaking after it.

**Tier 4 is done too (2026-08-16), and its lead item was abandoned on measurement.** The example
clients now all build (in CI, via a script that iterates the directory rather than a hard-coded
path), Shirado's `edges.csv` recovers byte-identically, and each example has its own dev credentials.
Sharding the e2e tier — O8's proposed fix since M4 — turned out to be a fix for a shape the suite does
not have, because `node --test` already runs every file in its own process. What came out of it
instead is a much sharper description of O8 and a tool for measuring a flake rate
(`npm run test:repeat`). See O8.

---

## Upstream — worth reporting to Empirica

These were all measured at runtime against `@empirica/core@1.12.5`, not read from docs. Each
has a reproduction in this repo. Three of them are the kind of thing a researcher would only
discover after collecting invalid data.

**Disclosure route and status: [`docs/upstream/DISCLOSURE.md`](docs/upstream/DISCLOSURE.md).**
U1 goes privately first via GitHub's security advisory form (the project publishes no
`SECURITY.md` and no contact address); U2 is an ordinary public issue. U3–U8 are held back
deliberately — sending eight at once to a quiet repository is how a report gets ignored.

**Revised after M5: the third slot should go to U8, not U7.** U7 caps how large a study can be,
which matters to few people and only outside this package's target regime. U8 makes a listener
somebody registered silently never run, which produces *invalid data from a study that appears
to work* — and it costs nothing to fix or, at minimum, to document. It also has the shortest
reproduction of anything on this list: register `onStageEnded` twice.

### U1. `protected: true` does not prevent participant writes ⚠️ security

**Evidence:** `test/e2e/upstream_u1.test.ts` (public client API),
`test/e2e/participant_write.test.ts` (full characterisation incl. `protected`); PLATFORM-NOTES
§4a. **Report drafted and ready to file:**
[`docs/upstream/U1-no-write-access-control.md`](docs/upstream/U1-no-write-access-control.md).

Any participant that knows a node id can set attributes on it — including on another
participant's `player` scope, whose id every participant already knows, because Classic
cross-links every participant to every player node. `protected: true` is documented as "not
updatable by other Participants" and is not enforced.

Not specific to this package: **any** Empirica experiment where a participant benefits from
altering another's state is exposed. The highest-value thing on this list to report.

### U2. A full restart does not put participants back in their game ⚠️ data loss

**Evidence:** `test/e2e/restart_full.test.ts`; PLATFORM-NOTES §4e. **Report drafted and ready
to file:** [`docs/upstream/U2-restart-does-not-restore-games.md`](docs/upstream/U2-restart-does-not-restore-games.md).

The store reloads correctly — batch, players, scopes, links all return. Players are never
reassigned, so `gameID` is never restored and no game resumes. Classic assigns a reloaded
player only if that participant is already online at the moment the player scope replays
(`if (online.has(participantID))`), which is a race no operator can win: measured **0/5** when
participants return after the replay settles, **1/5** when they race it.

It is also **partial**: `PARTICIPANT_CONNECT` creates a fresh player when it does not yet know
one for that participant, so a participant who arrives before their player scope replays gets a
DUPLICATE. Measured 2–4 of 4 existing player scopes reused, varying run to run — so a restart
can fork some participants' records while leaving others intact.

Consequence: a crash, deploy or `^C` mid-study ends the games in progress, and can leave two
player scopes for one participant in the stored result.

### U7. Game start corrupts the websocket stream at scale ⚠️ scale limit

**Evidence:** `test/bench/ceiling.ts` — `CEILING_PLAIN=1` removes this package from the picture
entirely — and `npm run bench`; PLATFORM-NOTES §16.

At n=200, five runs in six lose a participant at the moment the game starts, against 5/5 at
n=100 and 3/3 at n=150. The client dies on a close frame carrying status **1006**, which RFC
6455 §7.4.1 reserves and forbids on the wire, and which arrived marked compressed as control
frames may not be. So the frame stream is corrupt rather than closed — the signature of
interleaved writes to a connection that permits one writer, during the O(n²) cross-linking
burst at game start.

Reproduces with **stock Classic and no `withNetwork` registered**, which is what makes it worth
reporting rather than fixing here. The server logs nothing at `info`, so from the operator's
side a study simply loses participants at the moment everyone joins.

Not established: whether a browser survives it. Node's `ws` validates frames strictly and
throws, where a browser would likely see a closed socket and let Empirica reconnect — so this
may be far less severe in production than in a harness. It still caps what can be verified
here, and an unverifiable n=200 is its own problem.

### U8. A lifecycle listener can only be registered once — silently ⚠️ silent failure

**Evidence:** PLATFORM-NOTES §18, read off `dist/admin.cjs`. Reproduced by
`examples/rand2011`, which was written with two `onStageEnded` handlers and whose second one
never ran; `test/e2e/rand2011.test.ts` is the witness.

`onGameStart`, `onRoundStart`, `onStageStart`, `onStageEnded`, `onRoundEnded` and `onGameEnded`
all register through `unique`, whose "already ran" marker (`ran-on-<attrID>`) is stored **on the
scope** and is therefore shared by every listener for that `(kind, key)`. The first callback to
run sets it; all later ones return without running.

Registrations are not deduplicated and nothing warns, so a second handler is registered, wrapped,
and silently skipped forever. Splitting handlers by concern — one `onStageEnded` per stage — is
the obvious structure to write and it does not work.

Consequence in our case: rewiring answers were never applied, so the network never changed in a
condition whose defining feature is that it changes, with no error anywhere. **The strongest
candidate to report after U1 and U2**: it costs nothing to fix (dedupe the marker per listener,
or document the constraint), and it silently produces invalid data rather than a crash.

**Still open upstream — the defect is upstream's dispatcher and we cannot fix it. Detected from
our side as of 2026-08-16** (`docs/M6-HARDENING.md` §1.2, PLATFORM-NOTES §18a): `withNetwork`
counts registrations at server start and warns, naming the helper, the count and the
dispatch-inside-one-listener fix.

Four filters keep it off healthy code, and the last two were not anticipated in the plan:

- **The six lifecycle `(kind, key)` pairs only.** A duplicate anywhere else is a plain `.on`,
  which escapes `unique` and works.
- **Matching placement.** Classic's own `game/start` and `game/ended` registrations go through
  `unique.before` / `unique.after`, a different placement from the helpers' `unique.on`.
- **Matching callback shape.** `unique()` returns an anonymous 2-argument `AsyncFunction`, so a
  named, synchronous or differently-arity callback cannot be a wrapper. Calibrated at startup from
  a throwaway `new collector.constructor()` rather than hardcoded, so a change to `unique`
  upstream retunes the detector instead of silently switching it off.
- **`withNetwork`'s own `game/start` listener, excluded by identity.** It is a plain `.on` on one
  of the six pairs and was shaped exactly like a wrapper, so without this the detector fired on a
  consumer with one correct `onGameStart` — which is both shipped examples.

The residual false positive is stated in the warning itself: a consumer calling
`.on("stage", "ended", async (ctx, props) => …)` directly, twice. Rare, and far cheaper than the
silent failure being looked for. Every unrecognised shape switches the detector off rather than
guessing, since it reads an `/** @internal */` field.

*Covered by:* `test/unit/listeners.test.ts` (11) and `test/e2e/duplicate_listeners.test.ts` (2).
The e2e file asserts the warning, its absence on healthy code, **and** that the second handler
genuinely never ran — so if upstream ever fixes `unique`, that last one fails and says the warning
should be withdrawn rather than being left to mislead every consumer.

**Still the strongest candidate to report after U1 and U2**, and detecting it does not change
that: a warning we emit does not help anyone who is not using this package.

### U3. Attribute listeners subscribe the admin to nothing

**Evidence:** PLATFORM-NOTES §12.

`subscribeAttribute(kind, key)` only dispatches over attributes the admin already holds, so a
listener for a participant's later write never fires. The write reaches the server and echoes
back to its author, so it looks correct from the writer's own screen. Requires an explicit
`ctx.scopeSub({ kinds: [...] })`, which nothing implies. At minimum a documentation bug.

### U4. `EmpiricaClassic` never stops its animation-frame loop

**Evidence:** PLATFORM-NOTES §13. 68 uncleared timers after one mode test file.

Polyfilled to `setTimeout` under Node and rescheduled from inside its own callback, with no
teardown. Any Node-side test of a Classic-derived mode hangs without `--test-force-exit`, and
the natural diagnosis is the opposite one ("I forgot to close something").

### U5. `@empirica/core` cannot be loaded from raw Node in either module system

**Evidence:** PLATFORM-NOTES §3, §3a, §4.

ESM fails on `tmp`'s `require("fs")` behind tsup's shim; CJS fails on a nested
`@empirica/tajriba` with no `exports` main. `withTajriba` is public but unusable for a second,
independent reason (its port autodetection needs `trace` logging). Everything here is bundled
as a result.

### U6. The `empirica` CLI orphans its server when killed

**Evidence:** `src/verify/server.ts`; `test/e2e/harness.test.ts`.

The CLI is a wrapper that execs a versioned binary as its own child, so killing the CLI leaves
the real server running and holding its port. **379 orphans** accumulated across one session
here before it was noticed. Worked around locally with `detached: true` plus a process-group
kill; arguably the CLI should forward signals.

---

## Ours

### O1. Bench figures are single runs, and are upper bounds — **debt**

**Evidence:** `test/bench/envelope.ts`, `test/bench/shard.ts`, `test/bench/soak.ts`;
SPIKE-REPORT §5–6.

**Sharding is done** (2026-08-15): participants run in child processes, this process holds only
the server, callbacks and admin, and the send time rides inside the value so no clock protocol
is needed — measured agreement across shards is under 1ms. n=150 and n=200 are measured.

Two things remain. Each cell is still **one run** where §5–6 asks for three with fresh servers.
And the numbers are **upper bounds, not measurements of the package**: sweeping
participants-per-process at n=100 moved p50 43.1 → 10.1 → 8.0ms for slices of 50 → 25 → 13, so
the harness's own contention still dominates, and one machine cannot spread 200 clients thinly
enough to escape it.

Fixed along the way: the bench used to time deliveries with a 25ms **poll**, quantising every
sample. Measured side by side on the same rounds, polled p50 52.4ms against a true 33.3ms, 49
of 55 samples on one bin edge — and the README was citing the bin as evidence of a tight
distribution. Receipts now come from the client's own flush.

**M6 §3.3 added dense cells and turned this debt into a positive finding (2026-08-16).**
`npm run bench -- --dense` measures complete graphs, and a complete graph at n=20 (p50 7.5ms) is
faster than a degree-8 ring at n=50 (10.1ms). That is what let `maxDegree`'s default become
n-dependent — but note it also *strengthens* this entry: the reason degree turned out to be
second-order is that the harness's participants-per-process contention dominates it, which is
exactly the confound above. The dense cells are single runs like all the others.

Also unmeasured, and it is why lifting the degree cap required adding `maxNeighbourhoodBytes`
rather than just raising a number: **the bench projects two fields.** It measures degree at small
view sizes and says nothing about degree × view size, which is the product a participant's uplink
carries. A cell with a realistic payload per neighbour does not exist.

*Done when:* the README envelope table cites repeated runs, or the figures move to a machine
that can host the clients without contending with them. A dense cell with a realistic per-neighbour
payload would retire the `maxNeighbourhoodBytes` guess as well.

### ~~O2. Long-session soak not run~~ — **closed 2026-08-15 by stating the limit**

`npm run soak` defaults to ~10 minutes. Tajriba RSS plateaus over that window (PLATFORM-NOTES
§14), but a multi-hour session at realistic write rates has not been observed.

Closed the second way the entry allowed: the README envelope now carries "sessions beyond ~10
minutes: unverified" as a row. A multi-hour run would buy one observation at the cost of hours
of machine time, and the *mechanism* question it would answer — does Tajriba accumulate per
write? — is already answered no. Reopen if a study is planned that runs long enough to care.

### O3. `restart_full` asserts conditionally, pending U2

The test reports which way the reassignment race went and asserts our recovery only in runs
where the platform cooperated. If U2 is ever fixed upstream, the conditional branch should
become unconditional.

*Done when:* U2 is resolved and the `if (!restored) return;` branch is removed.

### O4. Late-joiner provisioning is a net under a path we could not construct

**Evidence:** `src/admin/with_network.ts` ParticipantConnect handler.

A player with no `participantID` at game start is reported as `pending` and re-provisioned on
connect. Classic sets `participantID` from an immutable attribute in its own `player` listener,
so players in `game.players` normally have one, and the failing path was never reproduced. The
code and comments say this plainly rather than implying a fix for an observed bug.

*Done when:* either a reproduction exists, or the path is deleted as unreachable.

### O5. `endedGames` grows with the number of games a process runs

**Evidence:** `src/admin/with_network.ts`.

Ids only, and it is what stops finished games' channels being re-adopted when the kind
subscription replays them — a few dozen bytes per game against one `Scope` object per
participant. Deliberate, documented, and heavily favourable, but genuinely unbounded.

*Done when:* a batch-completion signal lets it be cleared, or a cap is added.

### O6. Neither `bench` nor `soak` runs in CI

Both are minutes long. CI currently runs unit/mode across Node 20/22/24, e2e once, and a weekly
`@empirica/core@latest` drift job.

*Done when:* a decision is recorded — probably a weekly job that fails on regression against
stored baselines, not a per-PR one.

### O8. Players intermittently never get assigned to a game, in-suite

Roughly **1 run in 3** an e2e test hangs on "gameID assigned": the server is up, the batch is
running, and players are simply never assigned. The same test passes **6/6 alone**, and it
still happens with e2e running serially.

**Corrected 2026-08-15.** This was recorded as `scope_visibility.test.ts` being flaky, with the
leading explanation that it opens an extra wire subscription per participant and is "the
heaviest thing in the suite". Then `topology_visibility.test.ts` failed the same way, on the
same wait, and it does no such thing. So the weight explanation is wrong, and this is not a
property of one test — it is the suite's shared assignment path. The 90s headroom added to
`scope_visibility` was a mitigation for a diagnosis that did not hold.

The one hypothesis still standing is that it is the same path as **U2**, where Classic assigns a
reloaded player only if that participant is already online at the moment the player scope
replays. **Not established** — no reproduction pins it down, and the timing here differs from
U2's restart scenario.

**New evidence 2026-08-15 (M4): the rate tracks orphaned tajriba servers, i.e. U6.** Noticed
while establishing that a new e2e file was not the cause. Measured on one machine, small n, so
this is an observation and not an attribution:

| orphaned tajriba processes | full-suite runs | result |
|---|---|---|
| ~20 | 2 | both failed, same test, same 90s "gameID assigned" wait |
| 0 (after `pkill`) | 1 | passed, 187 / 27 / 50 |

The orphans are U6's: the `empirica` CLI execs a versioned binary as its own child, so a killed
CLI leaves the real server running. Each survivor was holding ~45s of accumulated CPU and
~150MB. A machine carrying twenty of them is not the machine the suite was timed on, and player
assignment is the first thing to starve.

This does **not** explain O8 — the hang predates any orphan accumulation and reproduces on a
quiet machine — but it plausibly explains the *rate*, and it explains why "1 in 3" has never
been stable. It also gives a cheap mitigation that costs nothing to adopt:

```sh
pkill -f "empirica-networks-.*tajriba.toml"   # harness servers only; all use --store.mem
```

Worth checking before concluding that a suite failure is a regression. Two investigations this
session started from a red suite that a clean machine turned green.

Both affected tests are *measurements* recording documented facts, not regression guards on our
code, so a rerun remains the pragmatic response.

**M5 added a third data point, and it is about load rather than orphans (2026-08-15).** The e2e
tier grew from 21 files to 24 — the two reconstructions plus `told` — and the new files run at
n=10 and n=8 against the suite's previous norm of 4. The rate went up correspondingly, and one
case was **deterministic rather than intermittent**: `test/e2e/rand2011.test.ts`'s first test
opened an extra wire subscription per participant *before* creating the batch, and timed out on
"gameID assigned" on 4 consecutive runs on an idle machine. Moving the subscription to after
assignment fixed it, 0 failures since.

That is worth separating from the rest of O8. It is not the unexplained hang: it is Classic's
O(n²) assignment work being starved by concurrent subscription setup, it is reproducible, and it
has a fix. It also suggests the underlying hang is a more extreme form of the same thing, which
would make the standing "1 in 3" figure a property of the suite's weight rather than a constant —
consistent with the orphan observation above, and still not established.

**Rate measured over the M5 session, on one machine, swept clean before each run:**

| | full-suite runs | e2e result |
|---|---|---|
| after M5's additions (24 files) | 4 | 2 green, 2 failed on `scope_visibility` "gameID assigned" |
| e2e tier alone, immediately after a failure | 1 | green, 61/61 |

**M6 §1.1 added a fourth data point, and it points away from orphans (2026-08-16.)** The e2e tier
did not grow — no new files, no larger n; the change was 7 new *unit* tests. Yet:

| | runs | result |
|---|---|---|
| full `npm test` (unit → mode → e2e), swept immediately before each | 3 | 1 green; 1 failed `scope_visibility`; 1 failed `scope_visibility` **and** `told`, both on "gameID assigned" |
| `npm test -- e2e` alone, swept before | 1 | green, 62/62 |
| `npm run test:one test/e2e/scope_visibility.test.ts`, run seconds after that file had just failed at 90 s inside a full run | 1 | green in 2.2 s |

The sweep did not prevent it, and the e2e tier's own weight was unchanged — so what changed
between green and red is that **unit and mode ran first in the same `npm test`**. That makes the
whole run's weight the variable, not the e2e file count and not orphan count, and it is the first
observation that separates the two hypotheses.

**M6 §1.2 then produced the controlled experiment, and it settles the load question (2026-08-16).**
Adding `test/e2e/duplicate_listeners.test.ts` — two scenarios at n=3, running two full games — took
the **e2e tier alone**, which had been green 62/62 on every attempt that day, to 1 and then 3
failures in *other* files. Removing that one file restored 62/62 green. Re-adding a cheaper version
of it (the two warning arms need no batch, no game and **no participants**, because the detector
fires in the collector's `start` hook) gave 64/64 green, then one failure. Orphan count was **0**
before and after each run, checked with `pgrep`.

| | runs | result |
|---|---|---|
| e2e tier, 25 files, new test with two n=3 games | 2 | 1 failure, then 3 — all "gameID assigned" in OTHER files |
| e2e tier, that one file removed (detector code still in place) | 1 | green, 62/62 |
| e2e tier, file restored with participant-free warning arms | 2 | green 64/64, then 1 failure (`scope_visibility`) |
| orphan servers, measured around each run | — | 0 |

So: **load, not orphans.** The failing test is never the new one and never the changed code; it is
whichever `waitFor("gameID assigned")` happens to be running when Classic's assignment work is
starved. Three consequences, in order of how much they matter:

1. **Sharding the e2e tier (`docs/M6-HARDENING.md` Tier 4) is no longer optional if the tier keeps
   growing.** It is now large enough that O8 shows up in the tier alone, not just in a full run.
2. **The cost of a test is a property of the test.** Two n=3 games were spent on a warning that
   fires before any participant connects. Asking "what is the smallest scenario that can observe
   this?" is now part of writing an e2e test here, and it is worth asking of the existing ones too.

**Confirmed a second time the same day, on a different test (M6 §3.3).** A new
`test/e2e/envelope.test.ts` arm asserted an *absence* — throw on the breach, then wait 8 s to
confirm nothing published, plus a second scenario for non-vacuity: 8.5 s and two servers. The tier
went red on `topology_visibility`. Rewritten to assert the warning *positively* via
`onExceed: "warn"` — one server, **0.25 s** — and the tier went green twice consecutively.

3. **A red run must be re-read in isolation** (`npm run test:one <file>`) before it is called a
   regression. The tier is no longer a reliable signal on its own either — see the Tier 2 data
   point below.

That is two independent add/trim/re-run cycles pointing the same way, and it sharpens the guidance
past "shard the tier": **waiting for an absence is the expensive shape.** It costs a timeout by
construction and it is a weaker claim than the positive assertion usually available next to it. Both
offending tests were rewritten to assert something happened rather than that nothing did, and both
got cheaper and sharper at once.

Small n, one machine, so this is an observation and not a rate. But it is worse than the 1-in-3
recorded above, and the only thing that changed is the weight of what runs before it — which is the
third independent line of evidence pointing at load rather than at anything in `scope_visibility`
itself.

**M6 Tier 2 withdraws the one piece of good news above (2026-08-16).** Yesterday's note ended
"re-running the e2e tier alone was green every time it was tried". That is **no longer true.** Tier
2 added exactly one e2e scenario — a third arm in `test/e2e/private_state.test.ts`, ~0.4 s, n=4 —
taking the tier from 65 tests to 66. Three consecutive tier-alone runs, swept immediately before
each, on an otherwise idle machine:

| run | result | victim | passes alone? |
|---|---|---|---|
| 1 | 1 failure | `scope_visibility`, 90 s "gameID assigned" | yes, 1/1 |
| 2 | 1 failure | `chat`, 30 s "gameID assigned" | yes, 3/3 |
| 3 | green, 66/66 | — | — |

Orphan count was **0** before and after all three. So the tier alone is now at **1 green in 3**,
which is the rate the *full run* had yesterday, and the victims differ from run to run — including
`chat`, which is not one of the three tests O8 has been recorded against.

Two things follow, and only one of them is comfortable.

- **The signal hierarchy has collapsed by one level.** "Full run red → re-read the tier alone" no
  longer separates a flake from a regression. What still separates them is the *file* alone, which
  was green immediately after failing in both cases. That is now the check that matters.
- **This is not attributed to the added scenario, and it would be dishonest to say it is.** One
  scenario against a 25-file tier is a small change, the machine also ran builds and subprocess
  tests that day, and n=3 cannot separate the two. What the observation does establish is that the
  tier is *at* the threshold rather than comfortably below it — which is the same conclusion the
  controlled experiments reached, arrived at without a controlled experiment. Sharding it
  (`docs/M6-HARDENING.md` Tier 4) is now the only item on this list that would actually change the
  situation.

**M6 Tier 4 measured the sharding plan, and it cannot work — for a structural reason (2026-08-16).**
The fix this entry has pointed at since M4 was to shard the e2e tier. It cannot help, because
**`node --test` already runs each test file in its own child process.** Verified directly: two files
under `--test-concurrency=1` report two different `process.pid`. With concurrency 1 the tier is
therefore already one fresh process per file, run one at a time; "sharding" would change only which
process does the spawning.

Measured rather than argued, as 25 separate `node --test` invocations, swept before each of three
passes, on an idle machine:

| pass | file failures | victims |
|---|---|---|
| 1 | 3 / 25 | `chat`, `told`, `topology_visibility` |
| 2 | 0 / 25 | — |
| 3 | 2 / 25 | `scope_visibility`, `topology_visibility` |

**5 failures in 75 file-runs (6.7%), 0 orphans throughout, every one on "gameID assigned"** — the
same 1-green-in-3 the single invocation gives. Two more facts fall out. The tier costs **89 s when
green** (heaviest file `restart_full`, 21 s), so "the cost of a test" was never the lever either. And
the per-file rate means **"re-read the file alone" is itself only probabilistic**:
`topology_visibility` alone failed **2 of 25** runs, so one green re-read of a file that fails 8% of
the time is not evidence of anything. `scripts/e2e-repeat.mjs` (`npm run test:repeat -- <file> 25`)
exists to measure a rate instead of re-running once and hoping.

**The stall's signature, which is new and points away from game scheduling.** A probe looping a
minimal scenario with instrumentation on both sides caught one: on a stalled run the server had
created **fewer player scopes than there were connected participants**, and the participant left out
had **no player scope at all** — not a player waiting for a game, but a participant Classic never
registered. So "players are never assigned" has been the wrong description for three milestones:
nothing gets as far as being assignable. Both halves agree — the callbacks' own `_.on("player", …)`
fired 3 times for 4 participants, and the client-side check reported `NO-PLAYER-SCOPE` for exactly
one of them.

**What correlates with it, and how strongly.** An extra `changes()` subscription per participant —
what the harness's `wireStream()` opens, on top of the mode's own — **opened before the batch
exists**:

| condition | fresh-process runs | stalls |
|---|---|---|
| `topology_visibility`, subscription opened first (as written since M4) | 25 | 2 (8%) |
| the same file, subscription moved after `batch.running()` | 40 | **0** |
| minimal probe, no extra subscription | 25 | 0 |
| minimal probe, extra subscription after `batch.running()` | 30 | 0 |
| minimal probe, extra subscription before `createBatch` | 30 | 3 (10%) |
| minimal probe, the same but awaiting each subscription's first frame first | 30 | 10 (33%) |

Read that as consistent evidence and **not** as a demonstration. At a ~10% rate, 30 runs cannot
separate 10% from 0% — 2/25 against 0/40 is p≈0.14 on its own, and telling them apart would need a
few hundred runs per condition. What makes it worth acting on is that it is the *third* independent
sighting of one shape: M5 found `rand2011`'s first test failing **4 consecutive times** with a
subscription opened before the batch and never again after moving it; the table adds a before/after
in a second file; and the last row goes the wrong way for every explanation except an interaction
with participant registration.

**Two things it rules out, which is most of its value.** Not orphans (0 throughout), and not the
tier's shape (already per-file processes, 89 s green). Also not reproducible warm: **500 in-process
iterations — 250 plain, 250 with the extra subscriptions — produced zero stalls**, which is why every
previous attempt to reproduce this by looping a scenario failed. A reproduction needs a fresh process
per attempt.

**The unit of risk is the SCENARIO, and two files now say so with the same number.** Measured with
`npm run test:repeat`, 25 fresh runs each:

| file | `withScenario` calls | file failure rate | implied per-scenario rate |
|---|---|---|---|
| `test/e2e/chat.test.ts` | 3 | 5/25 = 20% | 7.2% |
| `test/e2e/topology_visibility.test.ts` | 1 | 2/25 = 8% | 8.0% |

Two independent files, three-fold different scenario counts, the same **~7–8% per scenario** under
`rate = 1 − (1 − p)^scenarios`.

**And then the model fails its own next test, which is the more useful result.** The tier contains
**58 `withScenario` calls**. At a uniform 7.5% that predicts 4.3 failures per run and a green tier
**1.1%** of the time. The tier is green **roughly 1 run in 3**, and observed 3 failures in the run
that closed this tier. So per-scenario risk is emphatically **not uniform**: it is concentrated in a
few files, and 7–8% is those files' rate rather than the suite's.

What the victims share is an extra `changes()` subscription — but so do six files that have never
been victims (`monitor`, `participant_write`, `provision`, `rand2011`, `shirado2017`,
`private_state`), so that is necessary-looking and not sufficient. **Unexplained, and left that way.**

Two things do survive it. Scenario count is a real multiplier *within* a file — the same defect
makes `chat` fail 2.5× as often as `topology_visibility` — so where a file can make several claims in
one scenario it should, as `test/e2e/private_state.test.ts` does. And the standing "the cost of a
test is a property of the test" advice was about **seconds**, which are not the currency: `chat` is
3.8 s green and the worst offender measured, `restart_full` is 21 s and has never failed.

*Also done when:* ~~the e2e tier stops being a single serial run of ever-heavier files. Nothing
here is per-file expensive; it is the total.~~ **Superseded 2026-08-16**: it is already per-file
processes and the total is 89 s.

*Done when:* either the hang is reproduced and attributed — the reproduction now exists at ~8% per
run of `topology_visibility` with its subscription moved back, which is enough to bisect against but
not enough to have attributed it — or the harness re-triggers registration when it detects the stall.
A reconnect-on-missing-player-scope repair was drafted and **not** shipped: across 60 runs of the
shape that had stalled 10 times, the repair never triggered once, so it would have been an untested
recovery path pretending to be a mitigation. ~~Separately, and more cheaply: the orphan sweep above
belongs in the test runner~~ — **done 2026-08-16**, `scripts/test.mjs` sweeps before the e2e tier and
prints the count, because the count is the evidence that licenses reading a red run as something
other than a dirty machine.

### O7. `admin.taj.attributes()` is untested

Noted during M1 and never exercised. Low priority; listed so it is not mistaken for covered.

### O9. The monitor's browser script is not covered by any test — **debt**

**Evidence:** `test/unit/monitor_*.test.ts` and `test/e2e/monitor.test.ts` assert on the
endpoint. One assertion touches the page — `new Function()` over its `<script>`, so a syntax
error cannot ship a silently blank monitor — but nothing exercises its behaviour.

M4 was built so that this matters as little as possible: the layout, the metrics, the history
replay and the change detection are all pure functions on the server, tested there, and the
served page is left with `createElementNS` and a `fetch`. But "as little as possible" is not
"nothing". The scrubber's index arithmetic, the colour assignment, and the SSE reconnect
banner are real logic living in `src/admin/monitor/ui.ts`, and the only thing standing behind
them is that they are short.

This is the same gap PLATFORM-NOTES §8 forces on `player/react` — hooks cannot be rendered
against a synthetic mode, so the response was to move decisions out of the untestable place —
and the residual risk is the same shape: a bug here renders something plausible rather than
throwing. Playwright is already a devDependency and `npm run test:browser` already drives real
Chromium, so the route is open; it was not taken because the monitor is an operator tool whose
output is checked by a human looking at it, which is a weaker argument than a test and is
recorded as such rather than dressed up.

*Done when:* a browser test loads the page against a synthetic endpoint and asserts the node
count, the scrubbed edge count at a chosen frame, and that a `gone` event replaces the graph
with the banner rather than leaving a stale picture.

### ~~O12. Data written only at game end~~ — **fixed 2026-08-15**

**Evidence:** measured by looking in `data/` after a green run of `test/e2e/rand2011.test.ts` and
finding only `views.ndjson` and not one CSV.

Both reconstructions wrote their analysis CSVs in `onGameEnded`, which fires only when a game ends
**naturally**. A study killed, crashed or stopped mid-session produced no CSVs at all — and after
U2 a crash mid-study is the normal shape of "something went wrong", since a restart cannot resume
the game anyway. Worse in `examples/shirado2017`, where the change log was held in process memory
and *was the dependent variable*: a session that ran four of its five minutes lost all of it.

Fixed by the pattern the package already uses for views: append an NDJSON run log as events happen,
and build the CSVs from it — at game end, or afterwards with `examples/*/recover.mjs`. A pure
`fromLog()` feeds the same `exportFiles()` both paths use, and the unit tests assert the two
produce **byte-identical** CSVs, so recovered data cannot quietly differ from normal data.
`test/e2e/rand2011.test.ts` asserts the log is on disk *while the game is still running*, with the
absence of the CSVs asserted alongside it so the test cannot pass by looking at a finished game.

### ~~O13. The offline export helpers could not be imported offline~~ — **fixed 2026-08-15**

**Evidence:** writing `examples/rand2011/recover.mjs` and having it die on
`ERR_UNSUPPORTED_DIR_IMPORT: cross-fetch/polyfill` before executing a line.

`edgeRows`, `snapshotRows`, `viewRows` and `toCSV` are pure functions over plain data —
`src/admin/export.ts` has a single *type* import and nothing else — and the README said they "run
offline over data collected months ago". They could not: the only route to them was
`empirica-networks/admin`, which pulls in `@empirica/core/admin`, which cannot be loaded from raw
Node in either module system (PLATFORM-NOTES §3a).

Worth noting how this got through: **the trap was already documented, the trap audit already listed
§3a as consumer-facing and "named in the docs", and the packaging walked into it anyway.** Naming a
trap is not the same as not having it.

Fixed with an `empirica-networks/export` subpath, pinned by
`test/unit/export_isolation.test.ts` — which scans the source, so it is meaningful before a build,
and fails on any runtime import rather than only on `@empirica`.

### O10. No bots, so Shirado 2017's own contribution is not reconstructed — **scope**

**Evidence:** PLATFORM-NOTES §17. `@empirica/core@1.12.5` ships no artificial-player facility;
searched the bundles for `bot`, `virtual`, `simulat`, `agent`, `artificial`, `robot`.

`examples/shirado2017` reconstructs the **human-only** arm — the paper's 30 control sessions,
which is what its Fig. 1 is about. The bot conditions (3 agents × 3 noise levels × 3 placements)
are the paper's actual contribution and are absent.

Not a defect in this package, and not a gap that documentation closes: it needs a headless
participant process per bot, which is real work with a real API surface (a bot runner, a policy
interface, and a way to keep bots out of the participant count a treatment declares).

*Done when:* either a bot runner ships with a policy interface and the noise/placement conditions
are reconstructed, or the decision not to build one is recorded with its reasoning. Note that
`src/verify/harness.ts` already contains the hard part.

### ~~O11. `watch` silently doubles as the server's read list~~ — **ours, fixed 2026-08-16**

**Evidence:** `src/admin/inspect.ts`; found while building `examples/rand2011`.

`inspect()` populated each node's `state` from the `watch` list and nothing else, so a private
key the server needed but `project()` never read came back `undefined` — indistinguishable from
"the participant has not written it". In the Rand port the omitted key was the participants'
rewiring answers, and the effect was that the network never changed, silently.

**Fixed** per `docs/M6-HARDENING.md` §1.1, in two parts:

- `NetworkConfig.read` splits the declaration by intent — `watch` for keys `project()` reads,
  `read` for keys only the server consumes. The two are **unioned** internally, so misfiling a
  key between them cannot break anything; the split exists to give the accessor below something
  to check against, and to give the next reader a named place to look.
- `net.stateOf(gameID, playerID, key)` is the loud read path. `undefined` from it means exactly
  one thing — the participant has not written the key. An undeclared key, an unnetworked game, a
  player outside the graph and an unmaterialised channel all **throw**, and the undeclared-key
  message quotes a ready-to-paste `read` line. The guard order is asserted: the key check runs
  before the game lookup, so a typo is not reported as an ended game.

The constraint that shaped it, recorded because it rules out the obvious alternative: an Empirica
`Scope` exposes only `get(key)`/`getAttribute(key)`, with **no attribute enumeration**, so
`inspect()` cannot simply list every `state:*` key it holds. That absence is why `watch` became
the read list in the first place, and it is why the fix is a declaration plus a loud accessor
rather than enumeration.

`inspect()` is unchanged in shape and still returns `undefined` for all of these — it is the
monitor's payload and has to stay plain, serialisable data (`MODULE-DESIGN.md` §15.4). So this is
a split of labour, not a deprecation: `inspect()` for the seating plan and for observation,
`stateOf()` for anything a listener acts on.

*Covered by:* `test/unit/state_of.test.ts` (7), and `test/e2e/rand2011.test.ts`, whose waits now
go through `stateOf` so that deleting `"rewireAnswers"` from the example's `read` fails by naming
the undeclared key rather than timing out on a graph that never changed. Verified by doing
exactly that, 2026-08-16. The failure is still a `waitFor` timeout — the condition's last error is
appended to the message — so it takes 30 s to arrive; loud, but not fast.

### ~~O12. The run log lived in the copied surface, hand-rolled, twice~~ — **ours, fixed 2026-08-16**

**Evidence:** `examples/*/server/src/callbacks.js` before this change; `docs/M5-ADOPTION.md` §2.

The analysis CSVs are written in `onGameEnded`, which fires only when a game ends **naturally**. A
study that is killed, crashes, or is stopped never reaches it — and after U2 a crash mid-study is
the *normal* shape of something going wrong, since a restarted server cannot resume a game anyway.
So the case where partial data matters most produced none. Found by looking in `data/` after a green
run of `test/e2e/rand2011.test.ts` and seeing `views.ndjson` and not one CSV.

M5 fixed it in the examples: an append-only NDJSON log, plus a `recover.mjs` per example. That put
~90 lines of `mkdirSync` + `appendFileSync` + try/catch into the **copied surface** — the code a
consumer forks and can no longer patch — twice, breaking `M5-ADOPTION` §2's own rule. A package
missing something is usually discovered this way.

**Fixed** per `docs/M6-HARDENING.md` §2.1:

- `src/admin/sink.ts` holds one append-only NDJSON writer. `views` is now a caller of it, and so is
  the new `log: { file }` / `net.log(game, record)`.
- **One file for a whole study.** `net.log` stamps `gameID` and `at`, so concurrent games interleave
  safely and `recover.mjs` groups by game offline — which also means a game whose directory was
  never created is no longer a game with no recoverable data.
- **The two sinks default differently, and that is the decision, not an oversight.** `views`
  buffers 256 because it is on the publish path; `log` defaults to **1** because a facility that
  exists so a killed study still has data must not default to holding its newest records in memory.
- `parseNdjson(text)` ships from `empirica-networks/export`, since both `recover.mjs` scripts had
  hand-rolled the split/parse/count loop. It takes text rather than a path because that subpath is
  contractually unable to import `node:fs` (§3a, `test/unit/export_isolation.test.ts`) — the plan
  had asked for `readNdjson(path)`, which that invariant rules out.

**One latent defect found while moving the code.** The old `flush()` ignored `fs.writeSync`'s return
value. `write(2)` is permitted to write fewer bytes than asked and reports that by returning the
count rather than by throwing, so a short write would have truncated a record **mid-file** — worse
than losing the tail, because the tail is expected of a killed run and is counted, while a hole in
the middle is a corrupted log that still parses. Now loops on the byte count. Not an observed
failure: short writes are effectively unheard of for a regular file, and a consumer pointing `file`
at a FIFO is the case this guards.

*Covered by:* `test/unit/sink.test.ts` (12) and `test/unit/log.test.ts` (7). Two of the sink tests
spawn a real process, because the claim the facility rests on cannot be simulated in-process: at
`batch: 256`, a SIGKILL after 300 records leaves **exactly 256** on disk, and at `batch: 1` it
leaves all 300. Verified end to end as well — for a session that ended naturally, the CSVs
`recover.mjs` rebuilt from the log were byte-identical to the clean export, which until now was a
unit-tested claim only.

### ~~O13. No first-class hook for "a participant wrote private state"~~ — **ours, fixed 2026-08-16**

**Evidence:** `examples/shirado2017/server/src/callbacks.js` before this change.

Shirado's solution detector has to run whenever a participant writes their colour, and the only way
to get that was:

```js
import { NBHD_KEYS, NBHD_KIND, stateKey } from "empirica-networks/admin";
Empirica.on(NBHD_KIND, stateKey("color"), (_ctx, props) => { … });
```

Three problems, in increasing order of seriousness: it reaches past the package's abstraction into
its key layout; it requires knowing that a plain `.on` escapes the `unique` guard (U8); and it works
**only** because `withNetwork` issues `ctx.scopeSub({ kinds: ["nbhd"] })` at start. Copied into a
project that does not call `withNetwork`, it is a listener that never fires and says nothing (U3).

**Fixed** per `docs/M6-HARDENING.md` §2.2: `NetworkConfig.onPrivateState` delivers
`{ gameID, playerID, key, value }` — plain data, player ids not indices — for any key in `watch` or
`read`, after the republish that write triggered. A config field rather than a
`net.onPrivateState(key, cb)` method, deliberately: a method invites registration after the admin
has started, and a listener registered too late is a listener that never fires, which is the class
of bug being closed.

*Covered by:* `test/e2e/private_state.test.ts`'s new arm, which asserts both that a participant's
write arrives with the right player id and value, and that a server-authored `tell` under the **same
key name** does not — `told:secret` and `state:secret` are separate namespaces, and if they ever
merged an author's handler would start scoring the server's own stimulus as a participant's
decision. `test/e2e/shirado2017.test.ts`'s "a proper colouring ends the session" is still the
witness that U3 has not regressed, and now runs through the hook: removing the hook's one call site
fails both tests.

---

## M2 scope, deferred by design

Not defects — recorded so the boundary of M1 stays legible. See `MODULE-DESIGN.md` §12.

| Item | Where it stands |
|---|---|
| ~~Remaining topology generators~~ | **Done 2026-08-15.** Ships `star`, `wheel`, `grid` (with `periodic`), `ladder`, `pairs`, `wattsStrogatz`, `barabasiAlbert`, `erdosRenyi`, `geometricRandom`, `fromEdgeList`, plus `components`/`isConnected`. Three of Breadboard's sixteen omitted on purpose — two were duplicates under other names, one could not be reconstructed from its name. |
| ~~Rewiring — `network()` handle~~ | **Done 2026-08-15.** `addEdge`/`removeEdge`/`rewire` plus reads and an append-only history log, all keyed by player id. Covered by `test/e2e/rewiring.test.ts`. |
| ~~Neighbour-scoped chat~~ | **Done 2026-08-15.** `chat: true` plus `useNeighborChat()`. §7.4's open question is answered structurally — messages live on the recipient's channel, so a rewire stops new messages without erasing delivered ones — and the envelope worry does not arise, because chat is a separate key rather than part of the projected view. |
| ~~Edge-history export~~ | **Done 2026-08-15.** `edgeRows`/`snapshotRows`/`toCSV` in the Breadboard `Connected`/`Disconnected` shape, plus `historyIsConsistent`. Pure functions over an event log, so they run offline on stored data. `views.csv` remains open (decision 5). |
| ~~Live network monitor~~ | **Done 2026-08-15.** `monitor(handle)` serves a loopback-bound page from the callbacks process: live graph, per-node state, history scrubber, publish counts and unmaterialised channels. Not sigma and not in the template repo — `MODULE-DESIGN.md` §15 says why, and what it rules out structurally versus by convention. Remaining gap: O9. |
| ~~Template repo~~ | **Rejected 2026-08-15 at M5, not deferred.** Fork-and-adapt is the ecosystem pattern *and* the reason not to ship a fork point: anything in a template is code you cannot patch, and only the in-package path is testable by this suite. All three examples ship in-package and each one's `callbacks.js` is imported unmodified by `test/e2e/`. Reasoning: `docs/M5-ADOPTION.md` §2, `MODULE-DESIGN.md` §6. |
| ~~Package name / `@yale-hnl` scope~~ | **Settled 2026-08-15 by the maintainer: `empirica-networks`, unscoped.** Discovery is the binding constraint in an ecosystem with no registry. Publishing itself stays blocked on U1 disclosure (`PUBLICATION-PLAN.md` step 1), which is why `private: true` is still set. |

---

## Decided, not open

Recorded because they look like gaps and are not.

- **The topology is not participant-readable.** It moved to the batch scope, the one durable
  scope measured not to be delivered to participants (PLATFORM-NOTES §4c).
- **Ephemeral views do not accumulate in Tajriba.** Measured flat across 240 publishes
  (§14). This was the spike's top unknown.
- **Reconnection works**, for clean disconnect, abrupt TCP drop, browser refresh and long
  absence. Only the *server-side* restart is broken, and that is U2.
- **The target regime is n ≤ 50**, decided 2026-08-15. U7 (games do not reliably start at
  n ≥ 200) and the unsharded tail in O1 are both well outside it. They are recorded because
  they are true, not because they are in the way — weigh work on them accordingly.
