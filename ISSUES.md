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

### U1. `protected: true` does not prevent participant writes ⚠️ security

**Evidence:** `test/e2e/participant_write.test.ts`; PLATFORM-NOTES §4a.

Any participant that knows a node id can set attributes on it — including on another
participant's `player` scope, whose id every participant already knows, because Classic
cross-links every participant to every player node. `protected: true` is documented as "not
updatable by other Participants" and is not enforced.

Not specific to this package: **any** Empirica experiment where a participant benefits from
altering another's state is exposed. The highest-value thing on this list to report.

### U2. A full restart does not put participants back in their game ⚠️ data loss

**Evidence:** `test/e2e/restart_full.test.ts`; PLATFORM-NOTES §4e.

The store reloads correctly — batch, players, scopes, links all return. Players are never
reassigned, so `gameID` is never restored and no game resumes. Classic assigns a reloaded
player only if that participant is already online at the moment the player scope replays
(`if (online.has(participantID))`), which is a race no operator can win: measured **0/5** when
participants return after the replay settles, **1/5** when they race it.

Consequence: a crash, deploy or `^C` mid-study ends the games in progress.

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

### O1. Bench and soak are single runs, unsharded — **debt**

**Evidence:** `test/bench/envelope.ts`, `test/bench/soak.ts`; SPIKE-REPORT §5–6.

Before any number here is published it needs three repetitions with fresh servers, and
participants sharded across processes for n ≥ 200. Today every participant shares one Node
event loop, so the latency tail bounds the harness as much as the package, and **n ≥ 200 is
unmeasured for exactly that reason**.

*Done when:* a sharded runner exists and the README envelope table cites repeated runs.

### O2. Long-session soak not run — **debt**

`npm run soak` defaults to ~10 minutes. Tajriba RSS plateaus over that window (PLATFORM-NOTES
§14), but a multi-hour session at realistic write rates has not been observed.

*Done when:* one multi-hour run is recorded, or the supported session length is stated as a
limit in the README envelope table.

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

### O7. `admin.taj.attributes()` is untested

Noted during M1 and never exercised. Low priority; listed so it is not mistaken for covered.

---

## M2 scope, deferred by design

Not defects — recorded so the boundary of M1 stays legible. See `MODULE-DESIGN.md` §12.

| Item | Where it stands |
|---|---|
| 12 remaining topology generators (`wattsStrogatz`, `barabasiAlbert`, `erdosRenyi`, `star`, `grid`, …) | M1 ships `ring`, `ringLattice`, `complete`, `empty` plus graph helpers. `topology` takes a plain edge list, so authors can supply their own meanwhile. |
| Rewiring — `network()` handle, `addEdge`/`removeEdge`/`rewire` | Designed in §4, **not built**. The runloop batching it depends on is already load-bearing for `watch`, so the assumption is tested even though the API is not. |
| Neighbour-scoped chat | §7.4, proposal only. |
| Edge-history export, `views.csv` | §9, proposal only. Open decision 5. |
| Live network monitor | M4. |
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
