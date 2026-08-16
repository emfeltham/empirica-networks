# Open issues

Everything known to be outstanding after M1, with the evidence for each. Written as issues
rather than prose so they can be filed as-is when this repo gets a remote.

Status key: **ours** = fixable here · **upstream** = Empirica's, we can only work around or
report · **debt** = measurement or process, not a defect.

---

## Upstream — worth reporting to Empirica

These were all measured at runtime against `@empirica/core@1.12.5`, not read from docs. Each
has a reproduction in this repo. Three of them are the kind of thing a researcher would only
discover after collecting invalid data.

**Disclosure route and status: [`docs/upstream/DISCLOSURE.md`](docs/upstream/DISCLOSURE.md).**
U1 goes privately first via GitHub's security advisory form (the project publishes no
`SECURITY.md` and no contact address); U2 is an ordinary public issue. U3–U7 are held back
deliberately — sending seven at once to a quiet repository is how a report gets ignored. U7 is
the one to promote if a third slot opens: it has a reproduction with none of our code in it,
and it is the only one that caps how large a study can be.

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

*Done when:* the README envelope table cites repeated runs, or the figures move to a machine
that can host the clients without contending with them.

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

*Done when:* either the hang is reproduced and attributed, or the harness re-triggers
assignment when it detects the stall. Separately, and more cheaply: the orphan sweep above
belongs in the test runner, so a contaminated machine cannot present as a code regression.

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
| Template repo | Deferred; `examples/minimal` ships in-package instead. |
| Package name / `@yale-hnl` scope | Open decision 3, deliberately held: scoping later is a one-field change. |

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
