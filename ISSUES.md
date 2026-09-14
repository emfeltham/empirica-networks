# Open issues

Everything known to be outstanding in this package, with the evidence for each. Defects in
Empirica itself are not tracked here; where one constrains this package, it is described in
[`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md).

Status key: **ours** = fixable here · **debt** = measurement or process, not a defect. Defects in
Empirica itself are not tracked here; where one blocks an entry below, it is named in words.

Closed entries are not kept in this file. What each fix changed is recorded in
[`CHANGELOG.md`](CHANGELOG.md), and the reasoning behind each is in the git history.

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

Also unmeasured, and the reason lifting the degree cap required adding `maxNeighborhoodBytes`
rather than just raising a number, is that the bench projects two fields. It measures degree at
small view sizes and says nothing about degree × view size, which is the product a participant's
uplink carries. A cell with a realistic payload per neighbor does not exist.

This was worked 2026-08-16. Two of the three sub-items are closed, and the run-to-run one got
worse on inspection rather than better.

1. Repeated runs are done. `npm run bench -- --repeats N` runs each cell N times against a fresh
server and reports the median of the per-run p50s with the observed range. The README table now
cites three runs per cell.

2. `maxNeighborhoodBytes` is measured and the guess retired. `npm run bench -- --bytes` pads each
neighbor view, so degree × view size is measurable at last (PLATFORM-NOTES §19):

| cell | neighborhood / publish | p50 |
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
| orphaned servers | no — 2 live processes, none orphaned |
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
consistent with DVFS, plausibly with efficiency-core placement. PLATFORM-NOTES §19 has the detail
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
behavior and not a substitute for the number. The transport was verified over loopback with the
agent in a second process: two cells × two repeats, shards respawned between cells, 100% receipts,
p50 within 0.0 ms of the same cells run locally. That proves the plumbing and proves nothing about
the physics.

*Now done when:* a pinned bare-metal Linux host and a second machine for the clients run
`npm run bench -- --clients HOST:PORT --absolute --repeats 3`, and the result is recorded in
`docs/PLATFORM-NOTES.md` §19 beside the DVFS finding it answers.

### O3. `restart_full` asserts conditionally, pending an upstream fix to restart recovery

The test reports which way the reassignment race went and asserts our recovery only in runs
where the platform cooperated. If restart recovery is ever fixed upstream, the conditional branch should
become unconditional.

*Done when:* upstream restores a participant's game across a restart, and the
`if (!restored) return;` branch is removed.

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
the subscription replay at process start, which is upstream's restart path and still unreproduced.

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
the subscription replay at process start (§20), which is upstream's restart path.

`npm run soak` prints the pair in its summary, being the longest real run in the repository. The
first observation, 2026-09-11, was `--minutes 1`, arm A, n=20 against a real Classic server:
`pendingAtStart 0, lateProvisioned 0`. One negative result on a short run is not a rule-out; it is
the first datum this entry has ever had that is not an inference.

*Still done when:* the platform path is reproduced — the mechanism in §20 says where to look — or
`lateProvisioned` is zero across a real deployment, which is the first thing to read off one.

### O19. The radius 1.5 envelope figures are arithmetic, not measurement — **debt**

**Evidence:** `docs/API.md` §"Showing the ties among a participant's neighbors"; `CHANGELOG.md`;
`test/bench/envelope.ts`.

The structure payload is documented as costing "about 1 KB at degree 16 against a 64 KiB
`maxNeighborhoodBytes`". That number was computed, not observed: at most 120 neighbor-neighbor
pairs at six bytes each plus seventeen positions. Nothing has ever weighed one.

This is the same kind of gap §18 and §19 of `docs/PLATFORM-NOTES.md` were written to close for
degree and view size, and it is worth naming for the same reason: the prose around it reads as
measured, and a reader deciding whether radius 1.5 fits their deployment would be entitled to
treat it that way. `npm run bench` has no radius flag and no cell at 1.5, so there is no sweep to
point at either.

Two things the arithmetic does not cover, and neither is small. Ties among neighbors scale with
the SQUARE of degree while the neighbor views scale linearly, so the ratio the figure describes
holds only at the degree it was computed at. And the layout runs per viewer per shape change on
the server, which is CPU rather than bytes and is not in the envelope at all.

*Done when:* `npm run bench` accepts a radius and has at least one cell at 1.5 on a dense graph,
and the figures in `docs/API.md` either come from it or say they do not.

### O23. `wheel` is the only named CLI topology that can demonstrate radius 1.5

**Evidence:** `src/verify/topologies.ts` `CLI_TOPOLOGIES`; `test/unit/leak_vacuity.test.ts`
"triangle-free shapes are refused at radius 1.5".

`verify --radius 1.5` needs a graph where somebody's two neighbors are connected to each other.
Of the six shapes a flag can name, `ring`, `star`, `pairs` and `ladder` are triangle-free and are
refused; `complete` is refused for the older reason that it has no non-neighbor. That leaves
`wheel`.

The refusal is correct and the message names `wheel`, so nobody is stuck. But a verification tool
with one usable subject is thin: a user checking their own study is one shape away from having
nothing to compare against, and every shape that would help — `ringLattice`, `wattsStrogatz`,
`barabasiAlbert`, `geometricRandom` — takes a parameter a flag cannot carry. The escape hatch is
real (`runLeakCheck()` accepts the generator a study hands `withNetwork`) and is documented, and
it is also a code change rather than a command.

*Done when:* `--topology` reaches at least one more triangle-rich shape, either by accepting a
parameter or by naming a fixed-parameter variant and saying which parameter was fixed.

### O25. The offline recovery path cannot rebuild a radius 1.5 study's screens

**Evidence:** `examples/rand2011/recover.mjs:38`, `examples/shirado2017/recover.mjs:40`;
`src/admin/export.ts` `structureRows` / `positionRows`.

Both recovery scripts import `{ edgeRows, parseNdjson, snapshotRows, toCSV }` and neither calls
`structureRows` or `positionRows`. A study run at radius 1.5 whose views were captured therefore
has the structure on disk and no script that turns it into a table, while `docs/DATA-AND-ANALYSIS.md`
documents both tables as part of the inventory.

Nothing is lost today, and the reason is its own small finding: the only example that CAN run at
radius 1.5 is `examples/minimal`, under `NBHD_RADIUS=1.5` — and `minimal` has no `recover.mjs` and
never sets `views: { file }`, so it writes no `views.ndjson` to recover from. The two examples with
recovery scripts both run at the default radius and always will. So the gap is that the shipped
demonstration of the offline path and the shipped demonstration of radius 1.5 are in different
directories and cannot meet.

*Done when:* one example both runs at radius 1.5 and recovers its own structure to CSV, which is
the only arrangement that would have caught this.
