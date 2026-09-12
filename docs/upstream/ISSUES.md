# Upstream issues

Defects found in Empirica itself while building this package, not in this package. This
package's own open issues are tracked separately, in [`../../ISSUES.md`](../../ISSUES.md).

These were all measured at runtime against `@empirica/core@1.12.5`, not read from docs. Each
has a reproduction in this repo. Three of them are the kind of thing a researcher would only
discover after collecting invalid data.

The disclosure route and status are recorded in
[`DISCLOSURE.md`](DISCLOSURE.md). U1 goes privately first via GitHub's
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
[`U1-no-write-access-control.md`](U1-no-write-access-control.md).

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
to file: [`U2-restart-does-not-restore-games.md`](U2-restart-does-not-restore-games.md).

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
declared list (`../../ISSUES.md` O11).

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

**Evidence:** `src/harness/server.ts`; `test/e2e/harness.test.ts`.

The CLI is a wrapper that execs a versioned binary as its own child, so killing the CLI leaves the
real server running and holding its port. 379 orphans accumulated across one session here before
it was noticed. This was worked around locally with `detached: true` plus a process-group kill;
arguably the CLI should forward signals.
