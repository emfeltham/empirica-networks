# Open issues

Everything known to be outstanding after M5, with the evidence for each. Written as issues
rather than prose so they can be filed as-is when this repo gets a remote.

Status key: **ours** = fixable here · **upstream** = Empirica's, we can only work around or
report · **debt** = measurement or process, not a defect.

The entries M5's example experiments surfaced have a plan in
[`docs/M6-HARDENING.md`](docs/M6-HARDENING.md). Tiers 1, 2 and 3 are done as of 2026-08-16. Tier 1
closed the two silent ones, both of which produced invalid data from a study that appears to work:
O11 is fixed, and U8 remains upstream's defect but is now detected and warned about at server
start. Tier 2 moved the run log and the participant-write hook out of the copied surface and into
the package (O12, O13). Tier 3 settled the API-coherence items that were free before
the API freeze and breaking after it (`NEXT_STEPS.md` §1.2).

Tier 4 is also done, as of 2026-08-16, and its lead item was abandoned on measurement. The example
clients now all build (in CI, via a script that iterates the directory rather than a hard-coded
path), Shirado's `edges.csv` recovers byte-identically, and each example has its own dev
credentials. Sharding the e2e tier, O8's proposed fix since M4, turned out to be a fix for a shape
the suite does not have, because `node --test` already runs every file in its own process. What
came out of it instead is a much sharper description of O8 and a tool for measuring a flake rate
(`npm run test:repeat`); see O8.

---

## Upstream — worth reporting to Empirica

These were all measured at runtime against `@empirica/core@1.12.5`, not read from docs. Each
has a reproduction in this repo. Three of them are the kind of thing a researcher would only
discover after collecting invalid data.

The disclosure route and status are recorded in
[`docs/upstream/DISCLOSURE.md`](docs/upstream/DISCLOSURE.md). U1 goes privately first via GitHub's
security advisory form (the project publishes no `SECURITY.md` and no contact address); U2 is an
ordinary public issue. U3–U8 are held back deliberately, since sending eight at once to a quiet
repository is how a report gets ignored.

U10 (added 2026-08-16) belongs in the private batch with U1. It is not a vulnerability, in that no
exploit is involved and no privilege is gained, but it discloses recruitment identities between
co-players, which is a participant-privacy matter rather than a bug report, and it shares U1's root
cause: Classic cross-links every participant to every player node, so every player attribute is
public to the game. Reporting the two together makes the shared cause visible; reporting U10 in
public first would tell readers where to look for U1.

This was revised after M5: the third slot should go to U8 rather than U7. U7 caps how large a
study can be, which matters to few people and only outside this package's target regime. U8 causes
a listener someone registered to silently never run, which produces invalid data from a study that
appears to work, and it costs nothing to fix or, at minimum, to document. It also has the shortest
reproduction of anything on this list: register `onStageEnded` twice.

### U1. `protected: true` does not prevent participant writes ⚠️ security

**Evidence:** `test/e2e/upstream_u1.test.ts` (public client API),
`test/e2e/participant_write.test.ts` (full characterisation incl. `protected`); PLATFORM-NOTES
§4a. The report is drafted and ready to file:
[`docs/upstream/U1-no-write-access-control.md`](docs/upstream/U1-no-write-access-control.md).

Any participant that knows a node id can set attributes on it, including on another participant's
`player` scope, whose id every participant already knows, because Classic cross-links every
participant to every player node. `protected: true` is documented as "not updatable by other
Participants" and is not enforced.

This is not specific to this package: any Empirica experiment where a participant benefits from
altering another's state is exposed. It is the highest-value thing on this list to report.

### U10. Every participant receives every co-player's recruitment identifier ⚠️ privacy

**Evidence:** `test/e2e/bots.test.ts` ("a co-player's recruitment identifier is on the wire");
PLATFORM-NOTES §22. Measured at the wire, 2026-08-16, `@empirica/core@1.12.5`.

`participantIdentifier`, the raw value of `?participantKey=`, reaches every other participant in
the game. Classic writes it immutably on the player scope at `PARTICIPANT_CONNECT`, and
`startGame` links every participant to every player node, so it is broadcast to people who never
asked for it and whose interface never shows it.

In a deployed study that key is the recruitment identity: the Prolific PID, whatever the
recruitment URL supplied. Such identifiers are stable across studies, so this hands strangers a
cross-study re-identification handle. It affects every Empirica Classic study, not only networked
ones, and does not depend on this package: the same two lines run whether or not `withNetwork` is
installed.

This is distinct from U1, which concerns writing to another participant's scope. Here the issue is
reading a value the platform put there and delivered unasked, though the root cause is the same:
Classic cross-links every participant to every player node, so every player attribute is public to
the game.

It is not fixable from here, and the read guarantee is unaffected: `project()` is still the only
route by which one participant's state reaches another. What leaks is who is in the room, under
the name their recruitment gave them.

A second consequence, for this package specifically, is that there is no naming scheme an
artificial participant can use that subjects cannot read. That is why `runBots` takes an
identifier list rather than a count, and why `examples/shirado2017` recognises its agents by
holding the list rather than by matching a prefix. For a design that does not tell subjects which
of their neighbours are software, a recognisable identifier is the manipulation disclosed. See
`docs/BOTS.md` §1.

The workaround, worth doing regardless, is to make `participantKey` an opaque per-study token and
keep the mapping to recruitment identity outside Empirica.

### U2. A full restart does not put participants back in their game ⚠️ data loss

**Evidence:** `test/e2e/restart_full.test.ts`; PLATFORM-NOTES §4e. The report is drafted and ready
to file: [`docs/upstream/U2-restart-does-not-restore-games.md`](docs/upstream/U2-restart-does-not-restore-games.md).

The store reloads correctly: batch, players, scopes and links all return. Players are never
reassigned, however, so `gameID` is never restored and no game resumes. Classic assigns a reloaded
player only if that participant is already online at the moment the player scope replays
(`if (online.has(participantID))`), which is a race no operator can win: measured 0/5 when
participants return after the replay settles, 1/5 when they race it.

It is also partial: `PARTICIPANT_CONNECT` creates a fresh player when it does not yet know one for
that participant, so a participant who arrives before their player scope replays gets a DUPLICATE.
Measured 2–4 of 4 existing player scopes reused, varying run to run, so a restart can fork some
participants' records while leaving others intact.

Consequence: a crash, deploy or `^C` mid-study ends the games in progress, and can leave two
player scopes for one participant in the stored result.

### U7. Game start corrupts the websocket stream at scale ⚠️ scale limit

**Evidence:** `test/bench/ceiling.ts` — `CEILING_PLAIN=1` removes this package from the picture
entirely — and `npm run bench`; PLATFORM-NOTES §16.

At n=200, five runs in six lose a participant at the moment the game starts, against 5/5 at n=100
and 3/3 at n=150. The client dies on a close frame carrying status 1006, which RFC 6455 §7.4.1
reserves and forbids on the wire, and which arrived marked compressed as control frames may not
be. So the frame stream is corrupt rather than closed: the signature of interleaved writes to a
connection that permits one writer, during the O(n²) cross-linking burst at game start.

It reproduces with stock Classic and no `withNetwork` registered, which is what makes it worth
reporting rather than fixing here. The server logs nothing at `info`, so from the operator's side
a study simply loses participants at the moment everyone joins.

It is not established whether a browser survives it. Node's `ws` validates frames strictly and
throws, where a browser would likely see a closed socket and let Empirica reconnect, so this may
be far less severe in production than in a harness. It still caps what can be verified here, and
an unverifiable n=200 is its own problem.

### U8. A lifecycle listener can only be registered once — silently ⚠️ silent failure

**Evidence:** PLATFORM-NOTES §18, read off `dist/admin.cjs`. Reproduced by
`examples/rand2011`, which was written with two `onStageEnded` handlers and whose second one
never ran; `test/e2e/rand2011.test.ts` is the witness.

`onGameStart`, `onRoundStart`, `onStageStart`, `onStageEnded`, `onRoundEnded` and `onGameEnded` all
register through `unique`, whose "already ran" marker (`ran-on-<attrID>`) is stored on the scope
and is therefore shared by every listener for that `(kind, key)`. The first callback to run sets
it; all later ones return without running.

Registrations are not deduplicated and nothing warns, so a second handler is registered, wrapped,
and silently skipped forever. Splitting handlers by concern, with one `onStageEnded` per stage, is
the obvious structure to write, and it does not work.

In our case the consequence was that rewiring answers were never applied, so the network never
changed in a condition whose defining feature is that it changes, with no error anywhere. This is
the strongest candidate to report after U1 and U2: it costs nothing to fix, by deduping the marker
per listener or documenting the constraint, and it silently produces invalid data rather than a
crash.

It remains open upstream: the defect is upstream's dispatcher and cannot be fixed here. It is now
detected from our side, as of 2026-08-16 (`docs/M6-HARDENING.md` §1.2, PLATFORM-NOTES §18a):
`withNetwork` counts registrations at server start and warns, naming the helper, the count and the
dispatch-inside-one-listener fix.

Four filters keep it off healthy code, and the last two were not anticipated in the plan:

- The six lifecycle `(kind, key)` pairs only. A duplicate anywhere else is a plain `.on`, which
  escapes `unique` and works.
- Matching placement. Classic's own `game/start` and `game/ended` registrations go through
  `unique.before` / `unique.after`, a different placement from the helpers' `unique.on`.
- Matching callback shape. `unique()` returns an anonymous 2-argument `AsyncFunction`, so a named,
  synchronous or differently-arity callback cannot be a wrapper. This is calibrated at startup from
  a throwaway `new collector.constructor()` rather than hardcoded, so a change to `unique` upstream
  retunes the detector instead of silently switching it off.
- `withNetwork`'s own `game/start` listener, excluded by identity. It is a plain `.on` on one of
  the six pairs and was shaped exactly like a wrapper, so without this exclusion the detector fired
  on a consumer with one correct `onGameStart`, which is both shipped examples.

The residual false positive is stated in the warning itself: a consumer calling
`.on("stage", "ended", async (ctx, props) => …)` directly, twice. This is rare, and far cheaper
than the silent failure being looked for. Every unrecognised shape switches the detector off
rather than guessing, since it reads an `/** @internal */` field.

*Covered by:* `test/unit/listeners.test.ts` (11) and `test/e2e/duplicate_listeners.test.ts` (2).
The e2e file asserts the warning, its absence on healthy code, and that the second handler
genuinely never ran, so if upstream ever fixes `unique`, that last assertion fails and says the
warning should be withdrawn rather than being left to mislead every consumer.

It remains the strongest candidate to report after U1 and U2, and detecting it does not change
that: a warning emitted by this package does not help anyone who is not using it.

### U9. `attributes(scopeID)` always returns `internal system error`

**Evidence:** `test/e2e/participant_write.test.ts` (the O7 characterisation block); measured
2026-08-16 against `@empirica/core@1.12.5`.

The GraphQL schema publishes `attributes(scopeID, first/after/last/before)`, described as
"attributes returns all attributes for a scope", a paginated `AttributeConnection`, and the typed
client exposes it on the admin session. Every call fails with `[GraphQL] internal system error`,
including for a stock Classic `game` scope, with and without pagination arguments, and for an id
that does not exist. The uniformity is the finding: there is no argument shape that works, so this
is not misuse.

The consequence is larger than one dead method: there is no working way to ask what attributes a
scope holds, at any layer. A `Scope` exposes only `get(key)`/`getAttribute(key)` with no
enumeration, and the query that would have provided it errors. Any design that needs to discover
keys rather than declare them is therefore not merely inconvenient on this platform but
impossible, which is why `NetworkConfig.watch`/`read` exist and why `stateOf()` checks against a
declared list (`ISSUES.md` O11).

Severity is low for anyone who is not trying to enumerate, which is most people, so it goes well
below U1/U2/U8 in the reporting queue. It is cheap to report, though: a one-line reproduction
against a stock experiment.

### U3. Attribute listeners subscribe the admin to nothing

**Evidence:** PLATFORM-NOTES §12.

`subscribeAttribute(kind, key)` only dispatches over attributes the admin already holds, so a
listener for a participant's later write never fires. The write reaches the server and echoes
back to its author, so it looks correct from the writer's own screen. It requires an explicit
`ctx.scopeSub({ kinds: [...] })`, which nothing implies. This is at minimum a documentation bug.

### U4. `EmpiricaClassic` never stops its animation-frame loop

**Evidence:** PLATFORM-NOTES §13. 68 uncleared timers after one mode test file.

It is polyfilled to `setTimeout` under Node and rescheduled from inside its own callback, with no
teardown. Any Node-side test of a Classic-derived mode hangs without `--test-force-exit`, and the
natural diagnosis is the opposite one ("I forgot to close something").

### U5. `@empirica/core` cannot be loaded from raw Node in either module system

**Evidence:** PLATFORM-NOTES §3, §3a, §4.

ESM fails on `tmp`'s `require("fs")` behind tsup's shim; CJS fails on a nested
`@empirica/tajriba` with no `exports` main. `withTajriba` is public but unusable for a second,
independent reason (its port autodetection needs `trace` logging). Everything here is bundled
as a result.

### U6. The `empirica` CLI orphans its server when killed

**Evidence:** `src/verify/server.ts`; `test/e2e/harness.test.ts`.

The CLI is a wrapper that execs a versioned binary as its own child, so killing the CLI leaves the
real server running and holding its port. 379 orphans accumulated across one session here before
it was noticed. This was worked around locally with `detached: true` plus a process-group kill;
arguably the CLI should forward signals.

---

## Ours

### O1. Bench figures are single runs, and are upper bounds — **debt**

**Evidence:** `test/bench/envelope.ts`, `test/bench/shard.ts`, `test/bench/host.ts`,
`test/bench/clocks.ts`, `test/bench/soak.ts`; SPIKE-REPORT §5–6.

Sharding was completed 2026-08-15: participants run in child processes, this process holds only
the server, callbacks and admin, and the send time rides inside the value so no clock protocol is
needed. Measured agreement across shards is under 1ms. n=150 and n=200 are measured.

Two things remain. Each cell is still one run, where §5–6 asks for three with fresh servers. And
the numbers are upper bounds rather than measurements of the package: sweeping
participants-per-process at n=100 moved p50 43.1 → 10.1 → 8.0ms for slices of 50 → 25 → 13, so the
harness's own contention still dominates, and one machine cannot spread 200 clients thinly enough
to escape it.

Fixed along the way: the bench used to time deliveries with a 25ms poll, quantising every sample.
Measured side by side on the same rounds, polled p50 was 52.4ms against a true 33.3ms, with 49 of
55 samples on one bin edge, and the README was citing the bin as evidence of a tight distribution.
Receipts now come from the client's own flush.

M6 §3.3 added dense cells and turned this debt into a positive finding (2026-08-16). `npm run
bench -- --dense` measures complete graphs, and a complete graph at n=20 (p50 7.5ms) is faster
than a degree-8 ring at n=50 (10.1ms). That is what let `maxDegree`'s default become n-dependent,
though it also strengthens this entry: the reason degree turned out to be second-order is that the
harness's participants-per-process contention dominates it, which is exactly the confound above.
The dense cells are single runs like all the others.

Also unmeasured, and the reason lifting the degree cap required adding `maxNeighbourhoodBytes`
rather than just raising a number, is that the bench projects two fields. It measures degree at
small view sizes and says nothing about degree × view size, which is the product a participant's
uplink carries. A cell with a realistic payload per neighbour does not exist.

This was worked 2026-08-16. Two of the three sub-items are closed, and the run-to-run one got
worse on inspection rather than better.

1. Repeated runs are done. `npm run bench -- --repeats N` runs each cell N times against a fresh
server and reports the median of the per-run p50s with the observed range. The README table now
cites three runs per cell.

2. `maxNeighbourhoodBytes` is measured and the guess retired. `npm run bench -- --bytes` pads each
neighbour view, so degree × view size is measurable at last (PLATFORM-NOTES §21):

| cell | neighbourhood / publish | p50 |
|---|---|---|
| n=20 d=19, 2 fields | 1.4 KiB | 11.5 ms |
| n=20 d=19, +1 KiB/view | 20.6 KiB | 21.4 ms |
| n=50 d=49, 2 fields | 3.7 KiB | 22.8 ms |
| n=50 d=49, +1 KiB/view | 53.1 KiB | 67.0 ms |

Payload costs more at higher degree: roughly 14.5× the bytes buys 1.9× the latency at d=19 and
2.9× at d=49, so it really is the product, which is what the limit was added on suspicion of. The
64 KiB default survives with a sharper meaning, a slope rather than a cliff: a design sitting
against it runs at ~67 ms rather than 10–25 ms and drops nothing.

The cells are paired inside one sweep, which is a consequence of item 3 rather than a detail.
Comparing a padded sweep against §19's numbers from another day was the obvious design and would
have measured the days instead.

3. Upper bounds: the offset turned out to be the machine's power management, and idle is the slow
case.

The same n=25 cell measured 3.3 to 18.3 ms across the session, a 5.5× range, while repeats within
any one sweep agreed to 4–17%. So a sweep carries an offset shared by everything in it, and
`--repeats` measures precision rather than accuracy: a tight range is not evidence a number is
right.

Seven hypotheses, each settled by measurement rather than argument:

| hypothesis | verdict |
|---|---|
| orphaned servers (U6) | no — 2 live processes, none orphaned |
| accumulated writes slowing Tajriba (append-only per attribute) | no — 20 rounds and 100 rounds both give p50 7.3 ms |
| within-run drift | no — `first/last third` flat in every cell |
| position in the sweep | not supported — slow run is first in one cell, last in another |
| coordinator process state (JIT, heap, GC) | no — 0.5–1.1 CPU-s per 32 s window, a 2–3% duty cycle |
| sweep/process identity | no — two processes, 10 runs: 3.4 ms and 3.5 ms |
| machine CPU load | yes, and backwards — see below |

Imposing known load on the 14-core host, three runs per condition:

| busy loops | load | p50 | coordinator CPU / 32 s |
|---|---|---|---|
| 0 | 1.2–1.7 | 10.2 ms | 0.9–1.1 s |
| 8 | 5.4–7.4 | 4.5 ms | 0.5–0.7 s |
| 20 | 11–26.6 | 7.3 ms | 0.7–0.9 s |

A busier machine is faster, non-monotonically, with a minimum at moderate load, so contention is
not the mechanism, or the ordering would reverse. The identifying detail is the CPU column: the
coordinator does identical work at 2–3% duty cycle throughout, yet burns 1.1 CPU-seconds idle
against 0.7 loaded. 57% more CPU time for the same instructions is a clock-frequency signature,
consistent with DVFS, plausibly with efficiency-core placement. PLATFORM-NOTES §21 has the detail
and what was deliberately not isolated (that needs `powermetrics` and root, and changes nothing).

So the offset was never the package, the harness, or contention. It was the host deciding how fast
to run, and a bench that leaves the machine nearly idle asks for the slowest clock it has.

This closes the entry by making its original goal unreachable rather than by reaching it. No
number of repeats helps: every run in a sweep sits at whatever clock was chosen, which is exactly
why within-sweep spread is 4–17% and between-sweep spread is 5×. An absolute latency figure from
this class of machine is not reproducible, and since the error is not one-directional it cannot
honestly be reported even as a bound.

What survives, and is now the practice:

- Paired comparisons inside one sweep are sound, because both arms see the same clock. Item 2's
  payload table is built that way and its conclusions hold while the absolute numbers move.
- The README publishes medians with ranges and says to read the scale, not the value.
- `perf.yml` gates on delivery and retention, never latency, which is a second and stronger reason
  than the one recorded in O6: a quiet CI runner may measure slower than a busy one.

This stayed open narrowly, now with a specification instead of a wish: an absolute figure needs
fixed clocks (bare-metal Linux with the governor pinned, or a cloud instance without burst) hosting
the clients off the server host.

This was worked 2026-09-11. The specification is now executable; what is left is hardware. Both of
its clauses were things the bench could not express, so the entry could only be satisfied by
someone remembering it. Both are now flags, and a sweep that does not meet them says so in its own
output.

1. Clients off the server host, `test/bench/host.ts`. `npm run bench -- --agent` runs a client
host that forks shards on demand; `npm run bench -- --clients HOST:PORT` makes the coordinator use
it instead of `fork()`. The shard messages are unchanged and carried as newline-delimited JSON over
one TCP connection, so a local sweep takes the same path it always did.

The thing to check before believing any of it is the clock, because the bench times a one-way
delivery with no clock protocol: the writer stamps `absNow()` inside the value and the recipient
subtracts it. Across two machines that would be nonsense, since NTP on a LAN is worth about a
millisecond against a quantity often under ten. It survives because both endpoints of every sample
are participants, and every participant is on the client host; the server is the only thing on the
other machine and it never timestamps anything. That is also why the agent forks all shards
locally rather than the coordinator addressing several agents, and why it refuses a second
coordinator instead of queueing it.

2. Fixed clocks, `test/bench/clocks.ts`. Every run now prints the host, the CPU, the governor and
the turbo state of both machines, because O1's whole finding is that the host's clock decision
moves the number by 5× while the run looks identical. Pinned means both halves: `performance` on
every CPU and boost off, since turbo makes the ceiling a function of thermal headroom and a long
sweep then drifts downward through itself. Only Linux can prove either; macOS exposes no governor,
and a cloud instance that genuinely has no burst usually exposes no `cpufreq` sysfs either, so
`--attest-clocks "<why>"` lets an operator assert what the kernel cannot confirm, and the words are
printed with the numbers.

3. `--absolute` refuses to run a sweep that could not produce one. Three conditions: fixed clocks
on both hosts (the client host stamps the receipt), clients off the server host, and `--repeats 3`.
It gates the sweep; it does not certify the result.

What is not done is the measurement itself, and no machine here can do it. The development host is
darwin/arm64: `--absolute` exits 2 on it, naming all three unmet conditions, which is the correct
behaviour and not a substitute for the number. The transport was verified over loopback with the
agent in a second process: two cells × two repeats, shards respawned between cells, 100% receipts,
p50 within 0.0 ms of the same cells run locally. That proves the plumbing and proves nothing about
the physics.

*Now done when:* a pinned bare-metal Linux host and a second machine for the clients run
`npm run bench -- --clients HOST:PORT --absolute --repeats 3`, and the result is recorded in
`docs/PLATFORM-NOTES.md` §21 beside the DVFS finding it answers.

### ~~O2. Long-session soak not run~~ — **closed 2026-08-15 by stating the limit**

`npm run soak` defaults to ~10 minutes. Tajriba RSS plateaus over that window (PLATFORM-NOTES
§14), but a multi-hour session at realistic write rates has not been observed.

This closes the entry the second way it allowed: the README envelope now carries "sessions beyond
~10 minutes: unverified" as a row. A multi-hour run would buy one observation at the cost of hours
of machine time, and the mechanism question it would answer, whether Tajriba accumulates per
write, is already answered no. Reopen if a study is planned that runs long enough to care.

### ~~O16. `verify --topology` was reported as honoured and silently ignored~~ — **fixed 2026-09-11**

**Evidence:** `src/verify/cli.ts` `parseArgs`; `test/unit/cli_version.test.ts`.

`--topology` was parsed as `argv[++i] as "ring"`, a cast, so every string typechecked, and
`runLeakCheck` never read the value, hardcoding `ring(playerCount)`. The name was carried as far
as `formatLeakResult`, which printed it. So `verify --topology=star -n 8` ran a ring and reported:

```
  topology: star of 8
  …
  PASS
```

This is filed at the severity it has rather than the size it has. It is one command, and the
command is the artefact a reviewer runs to decide whether the package's central claim is true; a
false attestation from it is worth more than a crash, because a crash is not believed. The same
principle was already written down for the other flag, in `test/unit/cli_version.test.ts`: "The
CLI must say so rather than silently accept and report a meaningless PASS." It was asserted for
`-n` and not for `--topology`.

It was fixed with the topology widening, since one change makes the flag both honoured and
meaningful: the name resolves through `CLI_TOPOLOGIES` (`src/verify/topologies.ts`), an unknown one
is refused with the list, and `test/unit/cli_version.test.ts` now fails if the cast returns.

A second, quieter version of the same fault was fixed alongside. Arm 1 printed a bare
`non-neighbour sentinels received : 0`. That line reads identically whether six non-neighbour
pairs were examined and none leaked, or the graph was complete and no such pair existed: a
numerator with no denominator cannot be falsified. It now prints `0/6 pairs`, and a run whose
denominator is zero fails instead of passing.

### O3. `restart_full` asserts conditionally, pending U2

The test reports which way the reassignment race went and asserts our recovery only in runs
where the platform cooperated. If U2 is ever fixed upstream, the conditional branch should
become unconditional.

*Done when:* U2 is resolved and the `if (!restored) return;` branch is removed.

### O4. Late-joiner provisioning is a net under a path we could not construct — **the net was broken; still no reproduction**

**Evidence:** `src/admin/with_network.ts` ParticipantConnect handler;
`net.stats().lateProvisioned`.

A player with no `participantID` at game start is reported as `pending` and re-provisioned on
connect. Classic sets `participantID` from an immutable attribute in its own `player` listener, so
players in `game.players` normally have one, and the failing path was never reproduced. The code
and comments say this plainly rather than implying a fix for an observed bug.

This was worked 2026-08-16, with two results, and the second is why this entry was worth opening
at all.

1. The reasoning above is not sound, though the conclusion may still be right. Read off
`@empirica/core@1.12.5` (`docs/PLATFORM-NOTES.md` §20): `game.players` is
`scopesByKindMatching("player", "gameID", this.id)`, a live filter over an attribute, while
`player.participantID` is a field assigned inside Classic's `_.on("player", …)` callback. These are
two different mechanisms, so "Classic sets it in its own listener, therefore players in
`game.players` have one" does not follow. Nothing structural keeps them in step. This does not
show that Classic produces such a player, and the entry stays open on that: the suspect window is
the subscription replay at process start, which is U2's territory and still unreproduced.

2. The net was itself defective, and would have failed silently. This was found by writing the
first test for it. The repair path called `provisionChannels(ctx, game)` without `indexOf`, so the
channel it created carried `topologyIndex: -1`. The OWNER listener records a seat only for
`idx >= 0`, so that participant's seat was never recorded; `tryRecover` refuses a game with a gap
in its seating plan rather than guessing who sits where. A game repaired by this path therefore ran
perfectly and was quietly unrecoverable at the next restart, which is worse than having no net,
because it looks like it worked and the failure arrives at a different time under a different
name. One argument to fix: `state.order` is already in scope and already contains the player, who
was in `game.players` all along and was missing a channel rather than a seat.

This bears on the "delete it as unreachable" option, which was the other half of the done-when. It
is now the more expensive choice: the path has four tests, deleting it fails two of them, and its
cost on the path everyone actually takes is one idempotent no-op per connect, measured rather than
assumed. Keep the net.

A method note, because it generalises: three milestones of "we could not construct it" were
resolved far enough to act on by reading upstream's shipped source for ten minutes, and the
remaining defect was found by writing a test for code nobody expected to run. An untestable path
is not a harmless one, and unreproducible was doing work here that unreachable had not earned.

*Covered by:* `test/unit/late_joiner.test.ts` (6), server-free against `test/unit/fake_admin.ts`.

This was worked again 2026-09-11: the second half of the done-when was unavailable, and now is
not.

"Ruled out at runtime rather than by inference" could not be acted on, because there was no
runtime to consult: the repair path fired silently. A study could have taken it in every session
it ever ran and left nothing behind, which is a fair description of how an entry stays open for
three milestones on an argument from reading upstream's source.

Two counters were added on `net.stats()`, both per process and neither reset between games, since
the question is whether this process ever saw it:

- `pendingAtStart` — players skipped at game start for having no `participantID`.
- `lateProvisioned` — players given a channel by the connect-time repair.

Counted separately because they are not the same event. A player pending at start who later
connects increments both, in that order; one that increments only `lateProvisioned` had a
`participantID` all along and lost a channel some other way, which would be a different defect
wearing this one's clothes.

The repair also now says so out loud (`lateProvisionMessage`), and the message is written to be
read as evidence rather than as a fault: the game is fine, and the reader is holding the
observation this entry wants. It asks for the two facts a later reader cannot recover, the
`@empirica/core` version and whether the server had just restarted, because the suspect window is
the subscription replay at process start (§20), which is U2's territory.

`npm run soak` prints the pair in its summary, being the longest real run in the repository. The
first observation, 2026-09-11, was `--minutes 1`, arm A, n=20 against a real Classic server:
`pendingAtStart 0, lateProvisioned 0`. One negative result on a short run is not a rule-out; it is
the first datum this entry has ever had that is not an inference.

*Still done when:* the platform path is reproduced — the mechanism in §20 says where to look — or
`lateProvisioned` is zero across a real deployment, which is the first thing to read off one.

### ~~O5. `endedGames` grows with the number of games a process runs~~ — **fixed 2026-08-16**

**Evidence:** `src/admin/with_network.ts`.

Ids only, and it is what stops finished games' channels being re-adopted when the kind
subscription replays them: a few dozen bytes per game against one `Scope` object per participant.
This is deliberate, documented, and heavily favourable, but genuinely unbounded.

It was fixed by the cap, the second route the entry allowed. `src/admin/retention.ts` holds
`MAX_ENDED_GAMES` (10,000) and `rememberEndedGame`, a FIFO bound over the same set; re-ending a
game already in the list refreshes it rather than leaving it next for eviction, because
`releaseGame` is reachable twice for one game (the `game/status` listener, and the `hasEnded`
branch of game start that a restart takes).

The batch-completion route was rejected on inspection. Clearing on batch end reduces safety, since
it forgets games while the process is still running, and it bounds nothing at all for a server
running one long batch, which is the shape a study actually has.

The part worth recording is why forgetting the oldest is safe. A replay that re-delivers an
evicted game's channels is the same replay that re-delivers that game's own `start` attribute, and
`onGameStartAttribute` releases an already-ended game rather than networking it, clearing the
channels it just adopted. So an eviction normally costs a transient hold of one scope per
participant, in the ordering where channels arrive first, rather than a permanent one. The residual
is the ordering where the game attribute never replays at all: then those scopes are held,
bounded by evicted games × participants, and only after both an admin reconnect and 10,000 games
ended in one process. The warning states this rather than implying the list is free to lose.

A second structure was found in the same pass, and it was not a memory bug. `lastOutbox`, the chat
relay's duplicate guard, is keyed by player, so none of `releaseGame`'s nine game-keyed deletes
reached it. Classic reuses a participant's player scope across sequential games, while the client
derives its sequence number from the outbox attribute on its own channel (`src/player/chat.ts`),
which is a new channel each game and therefore restarts at 1. So a participant who sent two
messages in game 1 had a stale high-water mark of 2 in game 2, the guard read `2 >= 1`, and their
first two messages were dropped silently, with the transcript recording a conversation that did
not happen. Reproduced at `[]` against an expected message before the fix.

That is the more serious half of this entry, and it was invisible from the issue as written: "grows
unboundedly" is a memory framing, and the search it prompts is for things that grow. What found it
was asking the adjacent question, which structures are keyed by something other than the game, of
which there was exactly one.

*Covered by:* `test/unit/retention.test.ts` (8), server-free: `withNetwork` takes a collector and
an event context, so a dispatching fake drives the whole admin lifecycle (start, provision,
materialise, relay, end) in about a millisecond. Several sequential games is what a retention claim
needs and what the e2e tier can least afford (O8 measured its headroom at one participant wide), so
this tier is the right home for it. Removing the `lastOutbox` line fails two of them; replacing the
cap with a bare `.add` fails a third. `net.stats()` gained `endedGames` and `chatSeqs` so both are
assertable exactly rather than by watching a heap graph, and `test/e2e/retention.test.ts`'s
full-shape assertion now names the one thing kept on purpose.

### ~~O6. Neither `bench` nor `soak` runs in CI~~ — **decided and shipped 2026-08-16**

Both are minutes long. CI currently runs unit/mode across Node 20/22/24, e2e once, and a weekly
`@empirica/core@latest` drift job.

The decision, recorded in `.github/workflows/perf.yml`, is weekly, gating on delivery and
retention, and deliberately not on latency or memory. That is half of what this entry proposed, and
the missing half is the interesting part.

It runs weekly rather than per-PR, as proposed, because both harnesses take minutes and spawn
hundreds of participants, and neither answers a question a pull request usually raises.
`workflow_dispatch` covers the times one does.

It does not gate against stored latency baselines, against the proposal. A GitHub-hosted runner is
a shared 2–4 vCPU machine, and this bench's dominant term is participants per process competing for
cores; O1 measured p50 moving 43.1 → 8.0 ms at fixed n purely by spreading the harness thinner. A
latency threshold there would measure the runner at least as much as the package, so it would
flap, and a gate that flaps gets muted, which is worse than no job because it reads as coverage.
That is how O14 happened.

What is exact and machine-independent is already computed by both harnesses and was being printed
and thrown away:

| | Gated on | Ignores |
|---|---|---|
| `npm run bench -- --assert` | `delivered == expected` receipts, zero silent rounds | every latency figure |
| `npm run soak -- --assert` | every `stats()` count back to zero after each game, `endedGames` up by exactly one | RSS and heap |

Those hold at any speed on any host, and they are what actually breaks when a regression lands: a
dropped republish, a stalled game, a release path that stops releasing. The soak assertion is the
one that would have caught `ISSUES.md` O5's `chatSeqs` leak, and it checks per game rather than at
the end so a leak starting at game 12 names game 12.

Every timing and memory figure is still recorded, into the job summary and as a 90-day artefact, so
the history needed to set a threshold later will exist, which it does not today. That is the
honest ordering: O1 is the reason a latency gate cannot be written yet, not an excuse for never
writing one.

`n >= 200` is excluded from the gate wherever it appears: it does not reliably start, and that is
U7's, not ours.

Both gates were verified in both directions before being trusted, 2026-08-16, since a gate that
cannot fail is the failure mode this whole entry is about:

| | result |
|---|---|
| `soak --assert` on healthy code | passes, exit 0, `ended=5` after 5 games |
| `soak --assert` with `EMPIRICA_NETWORKS_MAX_ENDED_GAMES=1` | fails, exit 1, naming games 1–4 and the expected count each |
| `bench --assert` on healthy code | passes, exit 0, "every publish arrived" |

The forced failure uses the existing env seam rather than a code edit, so the negative test is
repeatable by anyone. Exit-code propagation through `npm run …` → the wrapper script → the child
is the thing CI actually depends on, and it is shared by both runners; it was measured on the soak
and is the same three lines in `scripts/bench.mjs`.

### ~~O8. Players intermittently never get assigned to a game, in-suite~~ — **ours, fixed 2026-08-16**

Roughly 1 run in 3, an e2e test hangs on "gameID assigned": the server is up, the batch is running,
and players are simply never assigned. The same test passes 6/6 alone, and it still happens with
e2e running serially.

---

## FIXED 2026-08-16 — it was the harness, not Empirica

The cause was that the harness opened a second GraphQL subscription per watched participant.
`wireStream()` called `part.changes()`, and every call to that runs
`this.subscribe(ChangesDocument, …)` internally, a whole new subscription. So any test watching n
participants' wires made the server carry double that participant's traffic, and several tests did
it for every participant before `createBatch`, right through Classic's O(n²) assignment burst.
Assignment is the first thing to starve.

The fix (`src/verify/compat.ts`, `makeSharedProvider`) is to `share()` one subscription between the
`TajribaProvider` and every observer. The mode and the test now read the same stream, and no second
subscription exists.

| | before | after |
|---|---|---|
| `scope_visibility.test.ts` (worst victim) | 1/12, 2/15, 4/15 | 0/20 |
| `told.test.ts` | 4/12 | 0/10 |
| `chat`, `leak`, `topology_visibility` | intermittent | 0/10 each |
| e2e tier alone | ~1 green in 3 | 4/4 green |
| full `npm test` | "intermittently loses one or two victims" | 2/2 green |

Per-repetition cost fell with it: `scope_visibility` 9.7 s → 2.4 s, `told` 13.6 s → 4.2 s.

One subtlety, and the H-A test caught it: a fresh `part.changes()` replays current state to its
new subscriber, so an observer that subscribed late still saw attributes that already existed. A
late subscriber to a plain `share()` sees only what arrives afterwards. `rand2011.test.ts`
subscribes after assignment and depends on that history, and it failed deterministically, 4/4, on
its own non-vacuity guard: "no player attribute was visible in any wire, so the key-shaped search
is blind."

That guard is the reason this landed correctly rather than silently weakening every leak test in
the suite into one that can only pass. An absence assertion whose control is missing passes
perfectly. `docs/M5-ADOPTION.md` §1 H-A asks for exactly that pairing, and here it was
load-bearing.

This was resolved with an opt-in `recordWire` on `withScenario`, which uses `shareReplay` so an
observer gets every frame since connect, strictly more than the old accidental replay, and it
removes the ordering hazard entirely (a test may now subscribe whenever). It is off by default,
because `bench` and `soak` run hundreds of participants over 60 rounds and `soak` measures RSS: a
buffer they never read would be both a leak and a corrupted measurement.

This retires the "1 in 3" figure, the 90 s headroom on `scope_visibility`'s wait, the sharding
plan, and the guidance that opening wire subscriptions before the batch is an expensive shape to be
avoided; it is no longer expensive. What remains true is the reason it was expensive, and the rule
that a new e2e file should run at the smallest n that observes its claim.

It is not claimed that no `gameID assigned` timeout can ever happen again. Six clean runs of the
tier and 20 of the worst victim are evidence, not proof, and Empirica's assignment path is still
the same code. Reopen with a rate from `npm run test:repeat`, not a single red run.

---

### The investigation, kept for the shape of it

One victim was eliminated, and the cause was a known pattern left unfixed (2026-08-16).
`told.test.ts` opened a `wireStream()` subscription per participant before `createBatch`, the exact
shape M5 found and fixed in `rand2011` (see below), which this file kept. Every `wireStream()`
opens another GraphQL subscription for that participant, so four of them doubled the wire traffic
the server carried through Classic's O(n²) game-start burst. Moving them to after assignment, which
loses nothing since the sentinel only reaches the wire via a later `tell()`, took the file from
4/12 to 0/12, and from 13.6 s to 4.4 s per repetition.

Two structural observations fell out of the failure logs, and they are what made it findable:

- The failure is always the first test in the file, and the remaining tests in the same process
  then pass in 0.33 s and 1.8 s. So it is not machine load in any general sense; it is the specific
  scenario that opens extra subscriptions before assignment.
- The three named victims split into two kinds. `told` and `rand2011` opened subscriptions early
  incidentally, and could just move them. `scope_visibility` cannot: its sentinel is written by the
  `_.on("batch", …)` listener that fires the instant `createBatch` lands, so the subscription must
  already exist or the absence it measures means nothing.

The fix is not a general rule, and `chat.test.ts` establishes the counter-case. It has the
identical shape, so the same move was tried. `chat` is 0/12 as it stands and 1/12 with the
subscriptions moved, and the failure was qualitatively new: "the sender sees their own message", an
assertion failure at 336 ms rather than any timeout. Opening a sibling `changes()` subscription
mid-scenario appears to perturb that participant's own delivery ordering, which that assertion
reads directly. Reverted.

So the rule is to move the subscription when the file has a measured rate to fix, then measure the
result. `chat`'s appearances in tier runs are collateral from other files' load, which is exactly
O8's signature: the failing test is never the one that changed. Applying the `told` fix to it
would have been a change with no benefit and a new failure mode, justified entirely by
pattern-matching.

Four hypotheses were killed by measurement the same day. They are recorded because each looked
obviously right and each cost a run to rule out:

| tried | expectation | measured |
|---|---|---|
| 3 s settle between whole repetitions (fresh process each) | teardown of run i-1 overlaps startup of run i | 4/12 → 2/12. Inside noise at n=12 |
| 500 ms settle between subscribing and `createBatch` in `scope_visibility` | the handshake, not the subscription, is what competes | 1/12 → 2/15. No effect |
| `scope_visibility` N=3 → N=2 | a third fewer extra subscriptions | 1/12, 2/15 → 4/15. Worse |
| moving `chat`'s subscriptions below assignment | the `told` fix generalises | 0/12 → 1/12, new failure mode. Reverted |

So the residual in `scope_visibility` is not handshake overlap and does not scale down with n at
these sizes. `npm run test:repeat` now takes an optional settle argument (`… <file> 12 3000`), the
instrument built for the first row, kept because ruling a hypothesis out cheaply is the whole point
of having it.

The tier effect was measured at each step. Before the `told` fix the tier failed on two
consecutive runs and lost two victims on a third. Immediately after it: 1 failure
(`scope_visibility`), then green, then green. After the `chat` experiment was reverted and
everything settled: three consecutive green runs, 67/67 each.

That is the best recorded state for this tier; the standing figure in this issue has been "1 green
in 3" since M4. O8 is not closed: `scope_visibility` still carries a measured ~8-13% alone, its
cause is structural, and three green runs is not a rate. But the largest single contributor was a
fixable test-shape bug rather than anything unexplained, which shifts the prior: before assuming
the remaining rate is Empirica's, the other files should be checked for shapes like it.

The marginal cost of one file, measured 2026-08-16, is small enough to be alarming. Adding
`test/e2e/kind_registration.test.ts` at n=2, two games, took the tier from 66/66 to `told.test.ts`
failing on `gameID assigned` twice consecutively, 0 orphans. Removing the file restored 66/66.
Shrinking it to n=1, two games still, one participant each, restored 67/67, also twice
consecutively.

So the tier's headroom is currently one participant wide. That is the second time this exact
pattern has been measured (`docs/M6-HARDENING.md` Tier 4 found it with an n=3 file), and it means
the sizing rule is not hygiene: every new e2e file should be written at the smallest n that can
observe its claim, or it will break somebody else's test rather than its own.

A rate for one victim, measured 2026-08-16: `npm run test:repeat -- test/e2e/told.test.ts 10`,
twice, with 0 orphans reported on every repetition, gave 4/10 and 1/10, all on `gameID assigned`.
Two things follow. The file fails alone, not only under whole-run weight, so "run the file alone"
(`docs/TESTING.md` §4 step 3) is a weaker discriminator than it reads, and step 4's rate is the one
that actually decides. And at these rates a single pass or a single failure is worth nothing
either way: the two runs above differed by 3/10 with the same code paths under test on both sides.

This was corrected 2026-08-15. It had been recorded as `scope_visibility.test.ts` being flaky, with
the leading explanation that it opens an extra wire subscription per participant and is "the
heaviest thing in the suite". Then `topology_visibility.test.ts` failed the same way, on the same
wait, and it does no such thing. So the weight explanation is wrong, and this is not a property of
one test; it is the suite's shared assignment path. The 90s headroom added to `scope_visibility`
was a mitigation for a diagnosis that did not hold.

The one hypothesis still standing is that it is the same path as U2, where Classic assigns a
reloaded player only if that participant is already online at the moment the player scope replays.
This is not established: no reproduction pins it down, and the timing here differs from U2's
restart scenario.

New evidence from 2026-08-15 (M4) suggested the rate tracks orphaned tajriba servers, that is, U6.
This was noticed while establishing that a new e2e file was not the cause. Measured on one machine,
small n, so this is an observation and not an attribution:

| orphaned tajriba processes | full-suite runs | result |
|---|---|---|
| ~20 | 2 | both failed, same test, same 90s "gameID assigned" wait |
| 0 (after `pkill`) | 1 | passed, 187 / 27 / 50 |

The orphans are U6's: the `empirica` CLI execs a versioned binary as its own child, so a killed CLI
leaves the real server running. Each survivor was holding ~45s of accumulated CPU and ~150MB. A
machine carrying twenty of them is not the machine the suite was timed on, and player assignment is
the first thing to starve.

This does not explain O8, since the hang predates any orphan accumulation and reproduces on a
quiet machine, but it plausibly explains the rate, and it explains why "1 in 3" has never been
stable. It also gives a cheap mitigation that costs nothing to adopt:

```sh
pkill -f "empirica-networks-.*tajriba.toml"   # harness servers only; all use --store.mem
```

Worth checking before concluding that a suite failure is a regression. Two investigations this
session started from a red suite that a clean machine turned green.

Both affected tests are measurements recording documented facts, not regression guards on our
code, so a rerun remains the pragmatic response.

M5 added a third data point, and it concerns load rather than orphans (2026-08-15). The e2e tier
grew from 21 files to 24, the two reconstructions plus `told`, and the new files run at n=10 and
n=8 against the suite's previous norm of 4. The rate went up correspondingly, and one case was
deterministic rather than intermittent: `test/e2e/rand2011.test.ts`'s first test opened an extra
wire subscription per participant before creating the batch, and timed out on "gameID assigned" on
4 consecutive runs on an idle machine. Moving the subscription to after assignment fixed it, 0
failures since.

That is worth separating from the rest of O8. It is not the unexplained hang: it is Classic's O(n²)
assignment work being starved by concurrent subscription setup, it is reproducible, and it has a
fix. It also suggests the underlying hang is a more extreme form of the same thing, which would
make the standing "1 in 3" figure a property of the suite's weight rather than a constant,
consistent with the orphan observation above, and still not established.

The rate was measured over the M5 session, on one machine, swept clean before each run:

| | full-suite runs | e2e result |
|---|---|---|
| after M5's additions (24 files) | 4 | 2 green, 2 failed on `scope_visibility` "gameID assigned" |
| e2e tier alone, immediately after a failure | 1 | green, 61/61 |

M6 §1.1 added a fourth data point, and it points away from orphans (2026-08-16). The e2e tier did
not grow: no new files, no larger n; the change was 7 new unit tests. Yet:

| | runs | result |
|---|---|---|
| full `npm test` (unit → mode → e2e), swept immediately before each | 3 | 1 green; 1 failed `scope_visibility`; 1 failed `scope_visibility` and `told`, both on "gameID assigned" |
| `npm test -- e2e` alone, swept before | 1 | green, 62/62 |
| `npm run test:one test/e2e/scope_visibility.test.ts`, run seconds after that file had just failed at 90 s inside a full run | 1 | green in 2.2 s |

The sweep did not prevent it, and the e2e tier's own weight was unchanged, so what changed between
green and red is that unit and mode ran first in the same `npm test`. That makes the whole run's
weight the variable, not the e2e file count and not orphan count, and it is the first observation
that separates the two hypotheses.

M6 §1.2 then produced the controlled experiment, and it settles the load question (2026-08-16).
Adding `test/e2e/duplicate_listeners.test.ts`, two scenarios at n=3, running two full games, took
the e2e tier alone, which had been green 62/62 on every attempt that day, to 1 and then 3 failures
in other files. Removing that one file restored 62/62 green. Re-adding a cheaper version of it (the
two warning arms need no batch, no game and no participants, because the detector fires in the
collector's `start` hook) gave 64/64 green, then one failure. Orphan count was 0 before and after
each run, checked with `pgrep`.

| | runs | result |
|---|---|---|
| e2e tier, 25 files, new test with two n=3 games | 2 | 1 failure, then 3 — all "gameID assigned" in OTHER files |
| e2e tier, that one file removed (detector code still in place) | 1 | green, 62/62 |
| e2e tier, file restored with participant-free warning arms | 2 | green 64/64, then 1 failure (`scope_visibility`) |
| orphan servers, measured around each run | — | 0 |

So the cause is load, not orphans. The failing test is never the new one and never the changed
code; it is whichever `waitFor("gameID assigned")` happens to be running when Classic's assignment
work is starved. Three consequences follow, in order of how much they matter:

1. Sharding the e2e tier (`docs/M6-HARDENING.md` Tier 4) is no longer optional if the tier keeps
   growing. It is now large enough that O8 shows up in the tier alone, not just in a full run.
2. The cost of a test is a property of the test. Two n=3 games were spent on a warning that fires
   before any participant connects. Asking "what is the smallest scenario that can observe this?"
   is now part of writing an e2e test here, and it is worth asking of the existing ones too.

This was confirmed a second time the same day, on a different test (M6 §3.3). A new
`test/e2e/envelope.test.ts` arm asserted an absence: throw on the breach, then wait 8 s to confirm
nothing published, plus a second scenario for non-vacuity, 8.5 s and two servers. The tier went red
on `topology_visibility`. Rewritten to assert the warning positively via `onExceed: "warn"`, one
server, 0.25 s, and the tier went green twice consecutively.

3. A red run must be re-read in isolation (`npm run test:one <file>`) before it is called a
   regression. The tier is no longer a reliable signal on its own either; see the Tier 2 data point
   below.

That is two independent add/trim/re-run cycles pointing the same way, and it sharpens the guidance
past "shard the tier": waiting for an absence is the expensive shape. It costs a timeout by
construction and it is a weaker claim than the positive assertion usually available next to it.
Both offending tests were rewritten to assert something happened rather than that nothing did, and
both got cheaper and sharper at once.

Small n, one machine, so this is an observation and not a rate. But it is worse than the 1-in-3
recorded above, and the only thing that changed is the weight of what runs before it, which is the
third independent line of evidence pointing at load rather than at anything in `scope_visibility`
itself.

M6 Tier 2 withdraws the one piece of good news above (2026-08-16). Yesterday's note ended
"re-running the e2e tier alone was green every time it was tried". That is no longer true. Tier
2 added exactly one e2e scenario (a third arm in `test/e2e/private_state.test.ts`, ~0.4 s, n=4),
taking the tier from 65 tests to 66. Three consecutive tier-alone runs, swept immediately before
each, on an otherwise idle machine:

| run | result | victim | passes alone? |
|---|---|---|---|
| 1 | 1 failure | `scope_visibility`, 90 s "gameID assigned" | yes, 1/1 |
| 2 | 1 failure | `chat`, 30 s "gameID assigned" | yes, 3/3 |
| 3 | green, 66/66 | — | — |

Orphan count was 0 before and after all three. So the tier alone is now at 1 green in 3, which is
the rate the full run had yesterday, and the victims differ from run to run, including `chat`,
which is not one of the three tests O8 has been recorded against.

Two things follow, and only one of them is comfortable.

- The signal hierarchy has collapsed by one level. "Full run red → re-read the tier alone" no
  longer separates a flake from a regression. What still separates them is the file alone, which
  was green immediately after failing in both cases. That is now the check that matters.
- This is not attributed to the added scenario, and it would be dishonest to say it is. One
  scenario against a 25-file tier is a small change, the machine also ran builds and subprocess
  tests that day, and n=3 cannot separate the two. What the observation does establish is that the
  tier is at the threshold rather than comfortably below it, which is the same conclusion the
  controlled experiments reached, arrived at without a controlled experiment. Sharding it
  (`docs/M6-HARDENING.md` Tier 4) is now the only item on this list that would actually change the
  situation.

M6 Tier 4 measured the sharding plan, and it cannot work, for a structural reason (2026-08-16). The
fix this entry has pointed at since M4 was to shard the e2e tier. It cannot help, because `node
--test` already runs each test file in its own child process. This was verified directly: two
files under `--test-concurrency=1` report two different `process.pid`. With concurrency 1 the tier
is therefore already one fresh process per file, run one at a time; "sharding" would change only
which process does the spawning.

Measured rather than argued, as 25 separate `node --test` invocations, swept before each of three
passes, on an idle machine:

| pass | file failures | victims |
|---|---|---|
| 1 | 3 / 25 | `chat`, `told`, `topology_visibility` |
| 2 | 0 / 25 | — |
| 3 | 2 / 25 | `scope_visibility`, `topology_visibility` |

5 failures in 75 file-runs (6.7%), 0 orphans throughout, every one on "gameID assigned": the same
1-green-in-3 the single invocation gives. Two more facts fall out. The tier costs 89 s when green
(heaviest file `restart_full`, 21 s), so "the cost of a test" was never the lever either. And the
per-file rate means "re-read the file alone" is itself only probabilistic: `topology_visibility`
alone failed 2 of 25 runs, so one green re-read of a file that fails 8% of the time is not evidence
of anything. `scripts/e2e-repeat.mjs` (`npm run test:repeat -- <file> 25`) exists to measure a rate
instead of re-running once and hoping.

The stall's signature is new and points away from game scheduling. A probe looping a minimal
scenario with instrumentation on both sides caught one: on a stalled run the server had created
fewer player scopes than there were connected participants, and the participant left out had no
player scope at all, not a player waiting for a game but a participant Classic never registered. So
"players are never assigned" has been the wrong description for three milestones: nothing gets as
far as being assignable. Both halves agree: the callbacks' own `_.on("player", …)` fired 3 times
for 4 participants, and the client-side check reported `NO-PLAYER-SCOPE` for exactly one of them.

What correlates with it, and how strongly, is an extra `changes()` subscription per participant,
what the harness's `wireStream()` opens on top of the mode's own, opened before the batch exists:

| condition | fresh-process runs | stalls |
|---|---|---|
| `topology_visibility`, subscription opened first (as written since M4) | 25 | 2 (8%) |
| the same file, subscription moved after `batch.running()` | 40 | 0 |
| minimal probe, no extra subscription | 25 | 0 |
| minimal probe, extra subscription after `batch.running()` | 30 | 0 |
| minimal probe, extra subscription before `createBatch` | 30 | 3 (10%) |
| minimal probe, the same but awaiting each subscription's first frame first | 30 | 10 (33%) |

Read that as consistent evidence and not as a demonstration. At a ~10% rate, 30 runs cannot
separate 10% from 0%: 2/25 against 0/40 is p≈0.14 on its own, and telling them apart would need a
few hundred runs per condition. What makes it worth acting on is that it is the third independent
sighting of one shape: M5 found `rand2011`'s first test failing 4 consecutive times with a
subscription opened before the batch and never again after moving it; the table adds a before/after
in a second file; and the last row goes the wrong way for every explanation except an interaction
with participant registration.

Two things it rules out, which is most of its value, are orphans (0 throughout) and the tier's
shape (already per-file processes, 89 s green). It is also not reproducible warm: 500 in-process
iterations, 250 plain and 250 with the extra subscriptions, produced zero stalls, which is why
every previous attempt to reproduce this by looping a scenario failed. A reproduction needs a fresh
process per attempt.

The unit of risk is the scenario, and two files now say so with the same number. Measured with
`npm run test:repeat`, 25 fresh runs each:

| file | `withScenario` calls | file failure rate | implied per-scenario rate |
|---|---|---|---|
| `test/e2e/chat.test.ts` | 3 | 5/25 = 20% | 7.2% |
| `test/e2e/topology_visibility.test.ts` | 1 | 2/25 = 8% | 8.0% |

Two independent files, three-fold different scenario counts, gave the same ~7–8% per scenario
under `rate = 1 − (1 − p)^scenarios`.

And then the model fails its own next test, which is the more useful result. The tier contains 58
`withScenario` calls. At a uniform 7.5% that predicts 4.3 failures per run and a green tier 1.1% of
the time. The tier is green roughly 1 run in 3, and observed 3 failures in the run that closed this
tier. So per-scenario risk is emphatically not uniform: it is concentrated in a few files, and
7–8% is those files' rate rather than the suite's.

What the victims share is an extra `changes()` subscription, but so do six files that have never
been victims (`monitor`, `participant_write`, `provision`, `rand2011`, `shirado2017`,
`private_state`), so that is necessary-looking and not sufficient. This remains unexplained, and is
left that way.

Two things do survive it. Scenario count is a real multiplier within a file: the same defect makes
`chat` fail 2.5× as often as `topology_visibility`, so where a file can make several claims in one
scenario it should, as `test/e2e/private_state.test.ts` does. And the standing "the cost of a test
is a property of the test" advice was about seconds, which are not the currency: `chat` is 3.8 s
green and the worst offender measured, `restart_full` is 21 s and has never failed.

*Also done when:* ~~the e2e tier stops being a single serial run of ever-heavier files. Nothing
here is per-file expensive; it is the total.~~ Superseded 2026-08-16: it is already per-file
processes and the total is 89 s.

*Done when:* either the hang is reproduced and attributed (the reproduction now exists at ~8% per
run of `topology_visibility` with its subscription moved back, which is enough to bisect against
but not enough to have attributed it) or the harness re-triggers registration when it detects the
stall. A reconnect-on-missing-player-scope repair was drafted and not shipped: across 60 runs of
the shape that had stalled 10 times, the repair never triggered once, so it would have been an
untested recovery path pretending to be a mitigation. ~~Separately, and more cheaply: the orphan
sweep above belongs in the test runner~~ — done 2026-08-16: `scripts/test.mjs` sweeps before the
e2e tier and prints the count, because the count is the evidence that licenses reading a red run
as something other than a dirty machine.

### ~~O15. The kind-registration check false-accuses correct code at large n~~ — **fixed 2026-08-16**

This was found 2026-08-16, by `npm run bench -- --repeats 3` printing it, not by a test: the
warning simply appeared in a run that was measuring something else.

At n=200 the O14 automatic check fired:

```
empirica-networks: 200 private channels were created 5s ago and NONE has materialised,
so the "nbhd" scope kind is almost certainly not registered.
```

The kind is registered. The bench passes `networkKinds` to `startCallbacks`, and the cell went on
to deliver every expected receipt, which is not possible without materialised channels.

The discriminator is sound; the deadline is not. `REGISTRATION_CHECK_MS` is a flat 5 s, justified
in O14 as "channels materialise in milliseconds at every size in the envelope", which is true, and
load-bearing in a way that was not noticed: it is a statement about the envelope, and the check
applies at every n. At n=200 the assignment burst saturates the server (U7, PLATFORM-NOTES §16),
so the first channel takes longer than 5 s to come back through the subscription and a healthy
system is told its correct code is broken.

This is the exact failure O14's own reasoning set out to avoid, quoted from that entry: "The cost
of being wrong here is telling someone their correct code is broken, which makes the warning worth
ignoring, which makes it worthless." The message's hedge, "If it IS registered, this is something
else — a stalled subscription", is what stops this being severe, and it is doing more work than
intended.

It is intermittent, measured 2026-08-16. Two full `--repeats 3` sweeps the same afternoon: it
fired in one and not the other, and in neither did it fire at n=150 or below. So one occurrence in
two sweeps at n=200, and zero inside the measured range, which is a rate rather than a
characterisation. This is recorded that way deliberately: O8 spent four milestones being described
from single observations, and `npm run test:repeat` exists because of it.

That the check depends on load is consistent with the mechanism above, and it is also why the rate
is not worth chasing far. n=200 is outside the supported envelope, does not reliably start (2 of 3
runs lost a shard in the same sweep), and the warning's own hedge names the alternative cause.

Options, in the order they are worth considering:

- Scale the wait with the number of channels created. Delivery of the subscription replay is
  O(channels), so a constant was always the wrong shape. This needs a coefficient, which is
  another number to justify.
- Require two consecutive misses before warning. This removes almost all false positives at the
  cost of doubling the delay on a true one, and a true one is fatal-but-silent, so the delay is
  cheap.
- Say less. Drop "almost certainly not registered" to "has not materialised", and let the two
  candidate causes carry equal weight. This is cheapest, and it makes the warning honest at every n
  rather than accurate at small ones.

*Done when:* the n=150 behaviour is measured, and either the deadline stops depending on n or the
message stops asserting a cause it cannot establish.

---

Both options were pursued, 2026-08-16, and the measurement is what changed the answer.

1. The quantity had never been measured, so it was instrumented first: `net.stats().firstChannelMs`,
first `addScopes` request to first `nbhd` scope arriving back on the subscription, taken on the
admin's own event loop, which is the loop the check's timer runs on, so the two are comparable by
construction. The bench reports it per run and the slowest across repeats. Three runs per cell
(`docs/PLATFORM-NOTES.md` §16a):

```
  n= 25      83    84    86 ms          n=150   2343  3324  4287 ms
  n= 50     394   463   491 ms          n=200   4813  5022  5870 ms
  n=100    1590  2285  2320 ms
```

This is worse than the entry above says, and in a way that matters. O15 recorded "zero
[occurrences] inside the measured range" and treated n=200 as the problem. But at n=150, inside the
supported envelope, a healthy server used 86% of the deadline. The check was not failing outside
its range; it was one unlucky run from false-accusing inside it, and had simply not been unlucky
yet. A rate of "one in two sweeps at n=200" described the symptom and hid that.

2. The deadline scales linearly, and the shape was a decision the data forced. Two mechanisms
compete: the subscription replay this check waits on is O(channels), while the load it queues
behind is Classic's O(n²) cross-linking at game start (§16). The measurement settles it: growth
steepens to n=150 and then flattens (n=150 → 200 is 1.37× for 1.33× the participants), so a
quadratic deadline would extrapolate growth that stops.

```
registrationWaitMs(created) = max(5000, 100 * created)
```

100 ms per channel is a safety factor rather than a fit: the fitted worst case is nearer 30 ms per
channel, and `docs/PLATFORM-NOTES.md` §21 measured a 2.5× sweep-level swing from machine power
state alone, the same cell at 7.3 ms and 18.3 ms an hour apart. A deadline sized to a fit would
false-accuse on a cold laptop. The result holds a 3.4×–4.3× margin at every measured n, which is
roughly constant; no flat number has that property at any value. Small n is untouched, because the
5 s floor was never wrong there.

The asymmetry is what licenses being generous: waiting longer costs a misconfigured study a few
more seconds before it is told, and it is a study that will never work at all otherwise. Firing
early costs the warning its credibility, for everyone, permanently.

3. The message stops diagnosing. It named a cause, "almost certainly not registered", that this
process cannot establish and that was measured being wrong. It now states the observation, names
both causes with the registration one first and the diff attached, and says outright that it
cannot tell them apart.

4. And it retracts itself. The residual failure of any deadline sized from a measurement is a
machine slower than the one measured, so the fix above shrinks the false-accusation window without
closing it. If a channel arrives after the warning, the package says so in the same log and says
nothing needs fixing. This is the part worth keeping from the whole exercise: an operator reading a
log after the fact no longer finds an unanswered claim that their server is misconfigured, and the
one report that would improve the coefficient, an n and a latency that beat it, is now printed,
together, at the moment it happens.

The entry's second option, "require two consecutive misses", was rejected. On a timer it is a
longer deadline wearing a disguise: same observable behaviour, more machinery, and it makes the
delay on a true warning worse for no gain that scaling does not already give.

*Covered by:* `test/unit/registration.test.ts` (9) and `test/unit/first_channel.test.ts` (2), both
server-free. The margin is asserted as a margin against the measured table rather than as a
constant, because a test pinning `registrationWaitMs(150) === 15000` would pass for any
coefficient anyone later typed in. The retraction needs a deadline that expires while healthy
channels are in flight, O15's exact race, which no real server can be asked to lose on demand, so
it is reproduced deterministically at n=3 with the deadline forced to zero.
`test/e2e/kind_registration.test.ts` remains the real-server witness and now also asserts that a
genuinely unregistered kind is not retracted, since a retraction that ran unconditionally would
erase every true warning this check will ever print.

Two existing tests failed on the new `stats()` field, and both were right to. The retention suites
compare the whole record with `deepEqual` rather than checking fields one by one, so adding
`firstChannelMs` made them red until it was argued for in place. That is the assertion working:
`stats()` is the package's answer to "does it leak", and a field that could be added to it without
anyone noticing is a field that could grow without bound without anyone noticing. Both now mask
the value rather than dropping it from the comparison, so the record stays exhaustive.

One thing was found on the way, in the bench rather than the package. A shard that dies takes its
IPC channel with it, and `.send()` on a closed channel raises an asynchronous `error` event rather
than a throw, so the try/catch that exists to record "this cell could not start" cannot see it, and
an unhandled `error` killed the coordinator. The first n=200 sweep lost its second and third
repeats that way, after the first had already recorded the shard loss as a result. The loop's whole
design is that a cell which cannot start is data; this discarded it in the one place it was most
needed. Fixed, and the failure path now reports the latency too.

### ~~O7. `admin.taj.attributes()` is untested~~ — **exercised 2026-08-16; it does not work (U9)**

This was noted during M1 and never exercised. Low priority; listed so it is not mistaken for
covered.

It has now been exercised, and the answer is that the API is broken upstream. Every call shape
returns `[GraphQL] internal system error`:

| call | result |
|---|---|
| channel scope, `first: 100` | `internal system error` |
| channel scope, no pagination | `internal system error` |
| stock Classic game scope | `internal system error` |
| a scope id that does not exist | `internal system error` |

The uniformity means it is not our custom kind, not the pagination arguments, and not a bad id, and
the scope in the first row certainly exists and certainly has attributes, because the assertions
immediately above it in the same test have just proved a participant's write landed there. Filed
as U9.

This is worth more than a coverage tick, because of what it does to O11's design. That fix rests on
"an Empirica Scope exposes only `get(key)`, with no attribute enumeration", which is why `watch`
and `read` must be declared and why `stateOf()` needs a list to check against. The raw admin query
looked like the escape hatch, since enumeration does exist in the GraphQL schema. It does not
work, so the constraint is not merely a property of the Scope model: there is no working
enumeration at any layer. The declaration requirement is forced, not chosen.

*Covered by:* `test/e2e/participant_write.test.ts`, as a characterisation in the same spirit as
R1b, folded into an existing scenario rather than a new file (one query, versus the most expensive
thing in this repo to add — `ISSUES.md` O8). It asserts the failure, so if upstream fixes it the
test goes red and says to close U9 and rewrite it as a working-API test.

### ~~O7b. Nothing in the package would notice if `attributes()` started working~~ — **investigated 2026-08-16; the premise was wrong, and what was actually missing was the other direction**

The test above pins the current behaviour, which is the right thing while it is broken. Nobody
should build on it until U9 moves.

Something would notice, weekly. `.github/workflows/drift.yml` runs `npm test -- e2e` against
`@empirica/core@latest` every Monday, skipping when upstream has not moved, and the e2e tier is
every file in `test/e2e/`, including the `attributes()` probe. A fix upstream turns that assertion
red without anyone going looking. So this issue was claiming a gap that did not exist, which costs
a reader the same session it cost to disprove. This is the symmetric failure to O9, and the more
embarrassing one: there the prose over-claimed what the code did, here it under-claimed.

Two real things came out of looking, though.

The notice would have arrived saying too little. The assertion's message said "close U9 and
rewrite this test to assert the contents", a rewrite anyone would do without pausing. But U9's
actual consequence is architectural: O11's design (declared `watch`/`read` keys, `stateOf()`
checking against a list) rests on there being no attribute enumeration at any layer, and this query
working is the counter-example. The declaration requirement would probably survive, since it is
synchronous and in-process, which a network round trip never will be, but it would be chosen
rather than forced, and that difference is the whole justification. The message now says so, and
`drift.yml`'s header names U9 alongside U8 as a fix-detector.

The pin had no guard in the other direction. `drift.yml` fires when upstream moves. Nothing fired
when we move to it, and forty claims across `src`, `test` and `docs` are dated to
`@empirica/core@1.12.5` under the `CONTRIBUTING` §6 convention, seventeen of them in
`PLATFORM-NOTES` alone, most of them measurements the new version is precisely the reason to doubt.
A bump could re-date none of them silently. `test/unit/upstream_pin.test.ts` now fails on a bump
and lists every stale citation by `file:line`, with a message saying that re-dating is not the
remedy: re-measuring is. Unit tier, no server. It deliberately does not check the installed
version, which would fail first under `drift.yml`'s `--no-save` upgrade and mask the contract
failures that job exists to find.

While wiring it, `VERIFIED_CORE` in `src/verify/compat.ts` was found exported and read by
nothing: a second copy of the pin, in the one file whose entire job is version-fragile contracts,
sitting beside a first copy in `cli.ts` that a test did check. This is the O14 shape exactly.
Collapsed to one declaration that the CLI prints and two tests hold in place.

Also worth recording: upstream has not shipped in 15 months. `1.12.5` is `latest`, published
2025-05-27, after a run of 1.9.0→1.12.5 across 2024 and early 2025. So `drift.yml` has taken the
"nothing to test" path every week of this project's life, and none of the fix-detectors above has
ever run against a version where it could fire. They are correct and they are untested by events,
which is an argument for the `upstream_pin` guard, not against the drift job: the event this
package will actually see first is us choosing to upgrade, not upstream releasing.

This entry never had a "Done when", which is the tell. It was filed as accepted debt rather than as
a claim to check, so nothing ever asked whether the claim was true. Closed now; what remains open
is U9 itself, upstream.

### ~~O9. The monitor's browser script is not covered by any test~~ — **covered 2026-08-16; it found a defect**

**Evidence:** `test/unit/monitor_*.test.ts` and `test/e2e/monitor.test.ts` assert on the
endpoint. One assertion touches the page — `new Function()` over its `<script>`, so a syntax
error cannot ship a silently blank monitor — but nothing exercises its behaviour.

M4 was built so that this matters as little as possible: the layout, the metrics, the history
replay and the change detection are all pure functions on the server, tested there, and the served
page is left with `createElementNS` and a `fetch`. But "as little as possible" is not "nothing".
The scrubber's index arithmetic, the colour assignment, and the SSE reconnect banner are real logic
living in `src/admin/monitor/ui.ts`, and the only thing standing behind them is that they are
short.

This is now covered by `test/browser/monitor_page.ts`: real Chromium, the real `serveMonitor`, the
real page and the real SSE stream, with only the `MonitorSource` synthetic. That the file can be
written at all is `src/admin/monitor/http.ts` property 1 holding: the server takes a snapshot
function and never a connection, so there is no Empirica CLI, no server and no datastore here, and
the test costs about four seconds rather than the minute `two_windows.ts` costs.
`scripts/test-browser.mjs` now discovers the directory and takes a filter
(`npm run test:browser -- monitor_page`) instead of naming one file.

The `gone` assertion failed on the first run, and the bug was real. `gone()` set the badge and the
banner and left `payload` alone, so every seat, every tie and every watched private value stayed
on screen, and the table view kept the complete seating plan. The page's own comment above that
function said the opposite ("deliberately not keep showing the last picture"), and had said it
since M4. An operator who scrolled past the banner, or who was reading the table, would have read a
dead study as a running one, the misreport MODULE-DESIGN §15.5 exists to prevent, arrived at
through the one surface that had no test. Fixed: `gone()` drops the payload and clears the graph,
the panels and the table; `apply()` re-enables the scrubber if a game comes back.

Worth recording alongside O7b and O18: the comment describing the intended behaviour was written,
believed, and cited as the design for one day short of a milestone, while the code did the other
thing. Prose is not coverage, whichever document it sits in.

The related gap PLATFORM-NOTES §8 forces on `player/react` is NOT closed by this and is not the
same shape: hooks cannot be rendered against a synthetic mode at all, whereas the monitor's page
only ever needed a browser. What the two share is the residual risk — a bug renders something
plausible rather than throwing — and this file is now evidence that the risk was not theoretical.

*Done when:* ~~a browser test loads the page against a synthetic endpoint and asserts the node
count, the scrubbed edge count at a chosen frame, and that a `gone` event replaces the graph with
the banner rather than leaving a stale picture.~~ All three are now covered, plus: one label per
node (the relief rule, since a light-mode slot sits below 3:1), the ties cut at a scrubbed frame,
that dragging to the end resumes live rather than freezing on the last frame, that a value keeps
its colour when the counts change, the stalled-channel banner, and that a lost stream deliberately
does not clear the graph, since the two banners are different claims and only a browser can tell
them apart. The scrubber arithmetic and the `gone` clearing were both mutation-checked: reverting
either turns the file red.

Still not covered, and named so it is not mistaken for covered, are the tooltip's positioning
arithmetic, the game picker (it needs two games and reloads the page), and every colour claim in
the palette comment: the test asserts which slot each node gets, not that the slots clear a
contrast gate.

### ~~O17. Data written only at game end~~ — **fixed 2026-08-15**

**Evidence:** measured by looking in `data/` after a green run of `test/e2e/rand2011.test.ts` and
finding only `views.ndjson` and not one CSV.

Both reconstructions wrote their analysis CSVs in `onGameEnded`, which fires only when a game ends
naturally. A study killed, crashed or stopped mid-session produced no CSVs at all, and after U2 a
crash mid-study is the normal shape of "something went wrong", since a restart cannot resume the
game anyway. This was worse in `examples/shirado2017`, where the change log was held in process
memory and was the dependent variable: a session that ran four of its five minutes lost all of it.

Fixed by the pattern the package already uses for views: append an NDJSON run log as events happen,
and build the CSVs from it, either at game end or afterwards with `examples/*/recover.mjs`. A pure
`fromLog()` feeds the same `exportFiles()` both paths use, and the unit tests assert the two
produce byte-identical CSVs, so recovered data cannot quietly differ from normal data.
`test/e2e/rand2011.test.ts` asserts the log is on disk while the game is still running, with the
absence of the CSVs asserted alongside it so the test cannot pass by looking at a finished game.

### ~~O18. The offline export helpers could not be imported offline~~ — **fixed 2026-08-15**

**Evidence:** writing `examples/rand2011/recover.mjs` and having it die on
`ERR_UNSUPPORTED_DIR_IMPORT: cross-fetch/polyfill` before executing a line.

`edgeRows`, `snapshotRows`, `viewRows` and `toCSV` are pure functions over plain data
(`src/admin/export.ts` has a single type import and nothing else), and the README said they "run
offline over data collected months ago". They could not: the only route to them was
`empirica-networks/admin`, which pulls in `@empirica/core/admin`, which cannot be loaded from raw
Node in either module system (PLATFORM-NOTES §3a).

It is worth noting how this got through: the trap was already documented, the trap audit already
listed §3a as consumer-facing and "named in the docs", and the packaging walked into it anyway.
Naming a trap is not the same as not having it.

Fixed with an `empirica-networks/export` subpath, pinned by
`test/unit/export_isolation.test.ts` — which scans the source, so it is meaningful before a build,
and fails on any runtime import rather than only on `@empirica`.

### ~~O10. No bots, so Shirado 2017's own contribution is not reconstructed~~ — **built 2026-08-16**

**Evidence:** PLATFORM-NOTES §17. `@empirica/core@1.12.5` ships no artificial-player facility;
searched the bundles for `bot`, `virtual`, `simulat`, `agent`, `artificial`, `robot`. Empirica v1
had them, so assuming they exist is the natural mistake, and the brief for M1 assumed it.

The entry's done-when offered two ways out: build the facility, or record the decision not to. It
was built. `empirica-networks/bots` ships a headless participant process with a policy interface,
and `examples/shirado2017` now reconstructs both arms of Shirado & Christakis (2017): the 30
control sessions and the 3 agents x 3 noise levels x 3 placements that are the paper's actual
contribution. See [`docs/BOTS.md`](docs/BOTS.md) for the full account.

A bot is a participant, and that is the constraint the whole design falls out of. It opens a real
Tajriba session, runs the real mode, reads through the same `project()` and writes through the same
private channel. There is no server-side path; one would have made the bot conditions a comparison
between two different games rather than between two kinds of player. It is also not optional: this
package's topology is defined over `game.players`, and a node with no participant behind it has no
seat and no channel (O4).

Three things the estimate in §17 got wrong were, each of them, the actual work.

1. "About thirty lines of public API" was true of the connection, false of the facility. The
   lifecycle a participant traverses before it can act is six named phases, and every way of
   getting it wrong is silent: a bot that never plays throws nothing, logs nothing and times
   nothing out, and the study simply waits for a game that will never reach its player count.
   Three separate causes produced that identical symptom while building this (no player scope, no
   assignment, unset `introDone`). So the phase is a pure function, each phase has a stall reason
   naming what to check, and a bot stuck in one for 30 s says so. `src/bots/lifecycle.ts` is bigger
   than the socket code.

2. "Indistinguishable from a human at the wire" was true of everything a bot does, false of what
   it is called. Measuring it turned up U10: every participant receives every co-player's
   `participantIdentifier`, so `bot-1` is readable from any browser. For this design that is not a
   metadata leak, since subjects are not told which neighbours are software; it is the manipulation
   disclosed. Consequently, `runBots` requires an identifier list rather than inventing one from a
   count, the default generator matches the shape Empirica's own client produces, and the server
   recognises agents by holding the list rather than by matching a pattern.

3. Placement was not expressible at all. The paper's independent variable is where the agents sit,
   central, peripheral, random, and the topology function received an anonymous `playerCount`. Who
   landed on which node was decided afterwards, out of reach. `topology` now receives `players` in
   seat order, so `players[i]` is whoever will occupy index `i`; placement is then done by
   relabelling the generated graph rather than by reordering people, which is what keeps the degree
   distribution identical across arms. A placement implemented by generating a different graph
   would manipulate structure and position at once. Pinned by `test/unit/seating.test.ts`, whose
   point is the case that would otherwise pass: a broken mapping still yields a perfectly correct
   graph, over the wrong people.

The condition travels down the bot's own channel, not through a second config file. The server
`tell()`s each agent its noise level at stage start; the runner cannot act on a value it was not
sent, and waits loudly rather than defaulting. Two processes each reading their own copy of the
condition is how a study runs 10%-noise agents and records them as 30% with nothing anywhere
disagreeing.

One reconstruction ambiguity was resolved explicitly rather than buried. Whether the noisy draw
includes the colour an agent already has is not settled by what was reconstructed. It is uniform
over all three here, so an eps of 0.3 produces an observable change about 0.2 of the time; the
alternative convention would make eps the rate of visible change. This is stated in `design.mjs`
and asserted in the unit tier, because any comparison with the paper's numbers depends on it. The
agent interval is likewise a stated choice, not a measurement: an agent's speed is not neutral, and
one that moved every 50 ms would dominate a session regardless of its noise.

*Covered by:* `test/unit/bot_lifecycle.test.ts` (9), `test/unit/bot_identity.test.ts` (11),
`test/unit/seating.test.ts` (3), the agent half of `test/unit/shirado2017.test.ts` (14),
`test/e2e/bots.test.ts` (3 — seating, placement, projection both ways, U10 at the wire, and a game
ending), and `test/e2e/shirado2017.test.ts`'s agent arm, which runs the example's own
`callbacks.js` unmodified with three agents seated centrally.

Still not reconstructed, and unchanged by this, are the paper's incentive scheme, its
solution-space covariate, and its interfaces. See the example's README.

### ~~O11. `watch` silently doubles as the server's read list~~ — **fixed 2026-08-16**

**Evidence:** `src/admin/inspect.ts`; found while building `examples/rand2011`.

`inspect()` populated each node's `state` from the `watch` list and nothing else, so a private key
the server needed but `project()` never read came back `undefined`, indistinguishable from "the
participant has not written it". In the Rand port the omitted key was the participants' rewiring
answers, and the effect was that the network never changed, silently.

This was fixed per `docs/M6-HARDENING.md` §1.1, in two parts:

- `NetworkConfig.read` splits the declaration by intent: `watch` for keys `project()` reads, `read`
  for keys only the server consumes. The two are unioned internally, so misfiling a key between
  them cannot break anything; the split exists to give the accessor below something to check
  against, and to give the next reader a named place to look.
- `net.stateOf(gameID, playerID, key)` is the loud read path. `undefined` from it means exactly one
  thing: the participant has not written the key. An undeclared key, an unnetworked game, a player
  outside the graph and an unmaterialised channel all throw, and the undeclared-key message quotes
  a ready-to-paste `read` line. The guard order is asserted: the key check runs before the game
  lookup, so a typo is not reported as an ended game.

The constraint that shaped it is recorded because it rules out the obvious alternative: an Empirica
`Scope` exposes only `get(key)`/`getAttribute(key)`, with no attribute enumeration, so `inspect()`
cannot simply list every `state:*` key it holds. That absence is why `watch` became the read list
in the first place, and it is why the fix is a declaration plus a loud accessor rather than
enumeration.

`inspect()` is unchanged in shape and still returns `undefined` for all of these, since it is the
monitor's payload and has to stay plain, serialisable data (`MODULE-DESIGN.md` §15.4, the design
record kept outside this repository — see `docs/README.md`). So this is a
split of labour, not a deprecation: `inspect()` for the seating plan and for observation,
`stateOf()` for anything a listener acts on.

*Covered by:* `test/unit/state_of.test.ts` (7), and `test/e2e/rand2011.test.ts`, whose waits now
go through `stateOf` so that deleting `"rewireAnswers"` from the example's `read` fails by naming
the undeclared key rather than timing out on a graph that never changed. Verified by doing
exactly that, 2026-08-16. The failure is still a `waitFor` timeout — the condition's last error is
appended to the message — so it takes 30 s to arrive; loud, but not fast.

### ~~O12. The run log lived in the copied surface, hand-rolled, twice~~ — **fixed 2026-08-16**

**Evidence:** `examples/*/server/src/callbacks.js` before this change; `docs/M5-ADOPTION.md` §2.

The analysis CSVs are written in `onGameEnded`, which fires only when a game ends naturally. A
study that is killed, crashes, or is stopped never reaches it, and after U2 a crash mid-study is
the normal shape of something going wrong, since a restarted server cannot resume a game anyway. So
the case where partial data matters most produced none. This was found by looking in `data/` after
a green run of `test/e2e/rand2011.test.ts` and seeing `views.ndjson` and not one CSV.

M5 fixed it in the examples: an append-only NDJSON log, plus a `recover.mjs` per example. That put
~90 lines of `mkdirSync` + `appendFileSync` + try/catch into the copied surface, the code a
consumer forks and can no longer patch, twice, breaking `M5-ADOPTION` §2's own rule. A package
missing something is usually discovered this way.

This was fixed per `docs/M6-HARDENING.md` §2.1:

- `src/admin/sink.ts` holds one append-only NDJSON writer. `views` is now a caller of it, and so is
  the new `log: { file }` / `net.log(game, record)`.
- One file serves a whole study. `net.log` stamps `gameID` and `at`, so concurrent games interleave
  safely and `recover.mjs` groups by game offline, which also means a game whose directory was
  never created is no longer a game with no recoverable data.
- The two sinks default differently, and that is the decision, not an oversight. `views` buffers
  256 because it is on the publish path; `log` defaults to 1 because a facility that exists so a
  killed study still has data must not default to holding its newest records in memory.
- `parseNdjson(text)` ships from `empirica-networks/export`, since both `recover.mjs` scripts had
  hand-rolled the split/parse/count loop. It takes text rather than a path because that subpath is
  contractually unable to import `node:fs` (§3a, `test/unit/export_isolation.test.ts`); the plan
  had asked for `readNdjson(path)`, which that invariant rules out.

One latent defect was found while moving the code. The old `flush()` ignored `fs.writeSync`'s
return value. `write(2)` is permitted to write fewer bytes than asked and reports that by returning
the count rather than by throwing, so a short write would have truncated a record mid-file, which
is worse than losing the tail, because the tail is expected of a killed run and is counted, while a
hole in the middle is a corrupted log that still parses. It now loops on the byte count. This is
not an observed failure: short writes are effectively unheard of for a regular file, and a consumer
pointing `file` at a FIFO is the case this guards.

*Covered by:* `test/unit/sink.test.ts` (12) and `test/unit/log.test.ts` (7). Two of the sink tests
spawn a real process, because the claim the facility rests on cannot be simulated in-process: at
`batch: 256`, a SIGKILL after 300 records leaves exactly 256 on disk, and at `batch: 1` it leaves
all 300. It was verified end to end as well: for a session that ended naturally, the CSVs
`recover.mjs` rebuilt from the log were byte-identical to the clean export, which until now was a
unit-tested claim only.

### ~~O13. No first-class hook for "a participant wrote private state"~~ — **fixed 2026-08-16**

**Evidence:** `examples/shirado2017/server/src/callbacks.js` before this change.

Shirado's solution detector has to run whenever a participant writes their colour, and the only way
to get that was:

```js
import { NBHD_KEYS, NBHD_KIND, stateKey } from "empirica-networks/admin";
Empirica.on(NBHD_KIND, stateKey("color"), (_ctx, props) => { … });
```

Three problems, in increasing order of seriousness: it reaches past the package's abstraction into
its key layout; it requires knowing that a plain `.on` escapes the `unique` guard (U8); and it works
only because `withNetwork` issues `ctx.scopeSub({ kinds: ["nbhd"] })` at start. Copied into a
project that does not call `withNetwork`, it is a listener that never fires and says nothing (U3).

This was fixed per `docs/M6-HARDENING.md` §2.2: `NetworkConfig.onPrivateState` delivers
`{ gameID, playerID, key, value }`, plain data, player ids not indices, for any key in `watch` or
`read`, after the republish that write triggered. It is a config field rather than a
`net.onPrivateState(key, cb)` method deliberately: a method invites registration after the admin
has started, and a listener registered too late is a listener that never fires, which is the class
of bug being closed.

*Covered by:* `test/e2e/private_state.test.ts`'s new arm, which asserts both that a participant's
write arrives with the right player id and value, and that a server-authored `tell` under the same
key name does not: `told:secret` and `state:secret` are separate namespaces, and if they ever
merged an author's handler would start scoring the server's own stimulus as a participant's
decision. `test/e2e/shirado2017.test.ts`'s "a proper colouring ends the session" is still the
witness that U3 has not regressed, and now runs through the hook: removing the hook's one call site
fails both tests.

### ~~O14. `assertKindsRegistered` is never called — the one mandatory edit is still silently fatal~~ — **fixed 2026-08-16**

This was found 2026-08-16, while writing `docs/ARCHITECTURE.md`, not by a failing test but by
trying to write down which function runs at which point in the lifecycle, and finding that this
one runs at no point at all.

The fact: `assertKindsRegistered` and `KindsNotRegisteredError` exist in `src/admin/kinds.ts`, are
exported from `empirica-networks/admin`, and print `REGISTRATION_DIFF`, the exact two-line diff a
consumer needs. Nothing in the package calls the function, and no test covers it. Repo-wide, the
only occurrences are its own definition and the export line.

This matters more than a normal dead-code finding because skipping the registration is the first
mistake a new adopter can make, and its symptom is the package's characteristic one: the channels
are never modelled, there is nothing to write views to, nothing errors, and every participant sits
with an empty neighbourhood forever. `docs/M5-ADOPTION.md` §6 files this trap under "impossible to
skip silently", which is the strongest column in that audit, and it is the only row in the table
whose claim rests on a call that does not exist.

How it got here is worth recording, because of the shape. `docs/PLATFORM-NOTES.md` §6 states the
requirement in the future tense, "so `withNetwork` must assert on `"ready"` and throw with the
exact diff". The helper was built to satisfy it. The wiring never happened, and the M5 audit then
recorded the requirement as met. This is precisely the failure M5 §8 confessed about §3a: "The
trap was known, documented, audited, and shipped anyway." Twice now, the audit's own weakest point
has been treating a documented intention as a done thing.

It is not a one-line fix, because `withNetwork` receives the collector, not the kind map (the map
is passed to `AdminContext.init` in a different file), so it cannot check registration directly.

Two routes were considered, neither free:

- Direct: reach the kind map from the `"start"` context, if it is reachable at all, and call the
  existing assertion. Cheapest if `ctx` exposes it; needs checking against `@empirica/core`
  internals, which is the dependency `.github/workflows/drift.yml` exists to police.
- Indirect, and probably right: detect the consequence, that a game started, channels were
  provisioned, and no `nbhd` scope materialised within some window. That is the same shape as the
  existing `pendingChannelsMessage` warning, uses only public API, and catches other causes of the
  same symptom. Costs a timer and a decision about the window.

This was fixed by the indirect route, 2026-08-16. `withNetwork` now arms a one-shot check after the
first game's channels are provisioned: if channels were demonstrably created and none has
materialised within `REGISTRATION_CHECK_MS` (5 s), it warns with the diff.

```
empirica-networks: 2 private channels were created 5s ago and NONE has materialised, so the "nbhd" scope kind is almost certainly not registered. Every participant will sit with an empty neighbourhood, and nothing else will report it.
  … the diff …
If it IS registered, this is something else — a stalled subscription. net.inspect(gameID).pendingChannels lists who is missing.
```

Four decisions are worth keeping.

Warn, not throw. It fires from a timer, outside the runloop, where a throw is an unhandled
rejection that can take down a server with participants in it. A study that is already broken
should not also crash.

The discriminator is real, not a guess. `provisionChannels` throws if a returned payload carries no
owner attribute, so "the scopes exist in Tajriba" is established rather than assumed. Upstream's
`Scopes` drops an unknown kind with its own `scopes: unknown scope kind` warning and returns, so
created-but-never-materialised has essentially one cause. The message still names the other one
and how to check it.

Five seconds, and the number is about false accusations. Channels materialise in milliseconds at
every size in the envelope. The cost of being wrong here is telling someone their correct code is
broken, which makes the warning worth ignoring, which makes it worthless.

> The claim in that paragraph is false above n ≈ 50, and the paragraph is kept as written because
> being right about the stake while wrong about the fact is the whole shape of O15. "Channels
> materialise in milliseconds at every size in the envelope" was never measured; it was inferred
> from small-n runs and then applied at every n. Measured 2026-08-16: 4287 ms at n=150, inside
> that same envelope. Fixed in O15: the deadline scales, the message stops diagnosing, and the
> warning retracts itself when it turns out to have been impatient.

`assertKindsRegistered` stays, and is now documented as what it always could have been: the eager,
opt-in check for the one place that legitimately holds the kind map, the consumer's own
`server/src/index.js`. The direct route from `withNetwork` was rejected on inspection: reaching the
map from a listener context means an `@internal` constructor field plus a `protected` member of
`Scopes`, a fifth version-fragile dependency (`drift.yml`) that would go quiet exactly when
upstream moved, the failure mode the check exists to prevent.

*Covered by:* `test/e2e/kind_registration.test.ts`, which runs the same experiment twice and
differs by one argument, `classicKinds` where `networkKinds` belongs. It asserts the defect as
well as the warning (`stats().channelScopes === 0` on the broken arm, `> 0` on the healthy one),
because a test that only checked for the warning could pass for the wrong reason, which is how the
original claim survived four milestones. Commenting out the one call site fails it.

A note on the fix's own verification, since it repeats this issue's lesson: a single run of
`told.test.ts` failed with the change and passed without it, which looked like a decisive
regression and was reported as one. It was not: `npm run test:repeat` gave 1/10 with the change and
4/10 without it, both on `gameID assigned` with 0 orphans, O8, on one of its three named victims.
The procedure in `docs/TESTING.md` §4 exists for exactly this, and skipping it produced a
confident wrong answer in the same session as an issue about a confident wrong answer.

---

## M2 scope, deferred by design

These are not defects; they are recorded so the boundary of M1 stays legible. See
`MODULE-DESIGN.md` §12.

| Item | Where it stands |
|---|---|
| ~~Remaining topology generators~~ | Done 2026-08-15. Ships `star`, `wheel`, `grid` (with `periodic`), `ladder`, `pairs`, `wattsStrogatz`, `barabasiAlbert`, `erdosRenyi`, `geometricRandom`, `fromEdgeList`, plus `components`/`isConnected`. Three of Breadboard's sixteen were omitted on purpose: two were duplicates under other names, one could not be reconstructed from its name. |
| ~~Rewiring — `network()` handle~~ | Done 2026-08-15. `addEdge`/`removeEdge`/`rewire` plus reads and an append-only history log, all keyed by player id. Covered by `test/e2e/rewiring.test.ts`. |
| ~~Neighbour-scoped chat~~ | Done 2026-08-15. `chat: true` plus `useNeighborChat()`. §7.4's open question is answered structurally: messages live on the recipient's channel, so a rewire stops new messages without erasing delivered ones, and the envelope worry does not arise, because chat is a separate key rather than part of the projected view. |
| ~~Edge-history export~~ | Done 2026-08-15. `edgeRows`/`snapshotRows`/`toCSV` in the Breadboard `Connected`/`Disconnected` shape, plus `historyIsConsistent`. Pure functions over an event log, so they run offline on stored data. `views.csv` remains open (decision 5). |
| ~~Live network monitor~~ | Done 2026-08-15. `monitor(handle)` serves a loopback-bound page from the callbacks process: live graph, per-node state, history scrubber, publish counts and unmaterialised channels. Not sigma and not in the template repo; `MODULE-DESIGN.md` §15 says why, and what it rules out structurally versus by convention. The served page is covered by `test/browser/monitor_page.ts` as of 2026-08-16, which found and fixed a stale-graph defect on `gone`; see O9 for what remains uncovered. |
| ~~Template repo~~ | Rejected 2026-08-15 at M5, not deferred. Fork-and-adapt is the ecosystem pattern and the reason not to ship a fork point: anything in a template is code you cannot patch, and only the in-package path is testable by this suite. All three examples ship in-package and each one's `callbacks.js` is imported unmodified by `test/e2e/`. Reasoning: `docs/M5-ADOPTION.md` §2, `MODULE-DESIGN.md` §6. |
| ~~Package name / `@yale-hnl` scope~~ | Settled 2026-08-15 by the maintainer as `empirica-networks`, unscoped. Discovery is the binding constraint in an ecosystem with no registry. Publishing itself stays blocked on U1 disclosure (`NEXT_STEPS.md` §1.1), which is why `private: true` is still set. |

---

## Decided, not open

Recorded because they look like gaps and are not.

- The topology is not participant-readable. It moved to the batch scope, the one durable scope
  measured not to be delivered to participants (PLATFORM-NOTES §4c).
- Ephemeral views do not accumulate in Tajriba. Measured flat across 240 publishes (§14). This was
  the spike's top unknown.
- Reconnection works, for clean disconnect, abrupt TCP drop, browser refresh and long absence.
  Only the server-side restart is broken, and that is U2.
- The target regime is n ≤ 50, decided 2026-08-15. U7 (games do not reliably start at n ≥ 200) and
  the unsharded tail in O1 are both well outside it. They are recorded because they are true, not
  because they are in the way, and work on them should be weighed accordingly.
