# Testing

Three tiers run under `npm test`, a browser tier that is run deliberately, a verification command,
and four measurement harnesses. The tiers are separated by what each one can prove, not by speed;
the speed difference follows from that distinction.

Read [Section 4](#4-reading-a-red-run) before concluding that a red run is a regression. That section
exists because getting it wrong has cost this project real investigations more than once.

```sh
npm test                                          # unit + mode + e2e
npm test -- unit mode                             # the cheap tiers, no server needed
npm run test:one test/e2e/rand2011.test.ts        # one e2e file, for the inner loop
npm run test:repeat -- test/e2e/chat.test.ts 25   # the same file 25 times, reporting a rate
npm run test:browser                              # real Chromium, run deliberately (§1)
npm run test:browser -- monitor_page              # one browser file, by substring
npm run check                                     # tsc --noEmit
npm run check:links                               # documentation links
```

Baseline, measured 2026-08-16 after M6 closed: 288 unit / 34 mode / 67 e2e, with `npm run check`
clean. The tier was green on six consecutive runs, and the full `npm test` was green on two;
`ISSUES.md` O8 stood at "1 green in 3" from M4 until its cause was found in the harness on
2026-08-16. The e2e tier takes approximately 90 seconds.

---

## 1. The three tiers

### The unit tier — pure logic, no server

`test/unit/*.test.ts`, run directly under `tsx`, executes in milliseconds.

Can prove: anything about the pure functions, such as topology generators, `edgeRows`/
`snapshotRows`/`viewRows`, `toCSV`, `validateProjection`, the envelope arithmetic, `graphMetrics`,
the duplicate-listener detector's shape analysis, and the NDJSON sink's batching.

Cannot prove: that any of it is wired up to Empirica. Every silent failure this package documents
was a wiring failure, and no fake can tell you the real dispatcher behaves like the fake.

One qualification applies. `test/unit/fake_admin.ts` supplies a collector and an
`EventContext`, which is everything `withNetwork` needs and does not construct, so the whole
admin lifecycle (game start, provisioning, channels materialising, the chat relay, participant
connect, game end) can be exercised here in about a millisecond. The tier can prove things about
how our own handlers interact, and that reach has proven valuable twice: the
`lastOutbox` defect in `ISSUES.md` O5, which needs several sequential games to appear, and the
seat-index defect in O4, which needs a player who has no `participantID` at game start. Neither
was affordable in e2e; O8 measured its margin at one participant wide, and the cost of a
scenario there is paid by whichever other file is waiting on an assignment.

Read the boundary precisely, because it is easy to claim more than the tier can support. The fake
asserts our side of each contract: that `addScopes` results are mapped back by attribute, that a
released game stops being tracked. It assumes Tajriba dispatches, replays and reuses scopes the
way the comments say it does, and those claims rest on `test/e2e/restart.test.ts` and
PLATFORM-NOTES, Section 12, not on anything in the unit tier. A fake that drifts from the platform
passes happily. Use it for lifecycle logic over many games; use e2e for anything the platform
decides.

Constraint: unit tests must not import `@empirica/core/admin`, which cannot be loaded unbundled
(`docs/PLATFORM-NOTES.md`, Section 3a). That is why they can run directly under `tsx` and why they
are separated from e2e in continuous integration (CI).

`test/unit/export_isolation.test.ts` is worth knowing about: it fails if anything with a runtime
import ever reaches the `empirica-networks/export` entry, which is what keeps offline analysis
scripts working.

The bots are tested in this tier for the same reason. `src/bots/lifecycle.ts` and
`src/bots/identity.ts` import nothing, the same rule as `registration.ts` and `retention.ts`,
because both hold decisions that fail silently at runtime. A bot in the wrong phase throws
nothing and times nothing out; a bot with a recognisable identifier discloses a manipulation while
working perfectly. A live run reveals neither of these, so both are decided by pure
functions and asserted exhaustively in `test/unit/bot_lifecycle.test.ts` and
`test/unit/bot_identity.test.ts`. `test/unit/seating.test.ts` covers the seating guarantee the
same way, and its point is the failure that would otherwise pass: a broken seat mapping still
produces a perfectly correct graph, over the wrong people.

### The mode tier — the client, against a synthetic provider

`test/mode/*.test.ts`, driving a synthetic `TajribaProvider` (`test/mode/synthetic.ts`).

Can prove: that `EmpiricaNetwork` composes correctly, that the hooks resolve, that `undefined` and
`[]` stay distinct, and, which is the reason this tier exists, that the `dones` protocol is still
wired correctly. That contract is version-fragile and fails silently: every scope materialises and
every `.get()` returns `undefined`.

Cannot prove: anything about the real wire, and it cannot render hooks against the synthetic mode
(`docs/PLATFORM-NOTES.md`, Section 8); that is a limit of our tests, not a consumer-facing one.

Why it is separate from e2e: an e2e run can mask a `dones` break by simply timing out somewhere
else. This tier fails on the actual contract.

### The e2e tier — a real Tajriba

`test/e2e/*.test.ts` is bundled to CJS before running, mirroring how a consumer's server is built.
It takes minutes to run and needs the Empirica CLI on PATH.

Can prove: the guarantee. This is the only tier that observes the real wire, the real subscription
machinery, and the real runloop.

Some of the most important ones:

| | Proves |
|---|---|
| `leak.test.ts`, `scope_visibility.test.ts` | non-neighbors receive nothing, across a ring, a star and a disconnected graph; a shape that could prove nothing is refused; the batch scope is not delivered |
| `topology_visibility.test.ts` | the seed and edge list do not reach participants |
| `restart.test.ts`, `restart_full.test.ts` | a restart does not silently reseat anyone |
| `duplicate_listeners.test.ts` | the U8 detector fires, and if it ever fails by saying the second handler did run, upstream has fixed U8 and the warning should be withdrawn |
| `kind_registration.test.ts` | the unregistered-kind check fires, and that the defect it warns about is real (`ISSUES.md` O14) |
| `example.test.ts`, `rand2011.test.ts`, `shirado2017.test.ts` | each example's real `callbacks.js`, imported unmodified |
| `upstream_u1.test.ts`, `participant_write.test.ts` | U1 is real, through the public API |
| `bots.test.ts` | a bot is a participant: it seats the game, is placed, and its writes project both ways, plus U10 at the wire, and that a game ending ends the bots |

`bots.test.ts` is the tier's most direct answer to "is this really the same code path". A bot in
these tests behaves as a genuine participant: it opens a real session, sets `introDone` (without
which the game never reaches its player count), receives a real channel, and its `state.set()`
shows up in a human's view. The U10 case in the same file is why the bot API takes an identifier
list rather than a count: it finds each participant's key as a substring of every other
participant's frames, with the participant's own key as the non-vacuity arm.

The fact that the examples are imported unmodified is itself significant. An example whose
behavior is asserted found three real bugs during M5, two of them in itself; an example whose
behavior is described would have shipped all three.

### The browser tier — real Chromium, run deliberately

`test/browser/*.ts`, bundled the same way and run outside `npm test`: each file needs a
Chromium download, and one of them needs the Empirica CLI. `npm run test:browser` runs every
file, one process at a time; a substring argument runs a subset.

| | Proves | Needs |
|---|---|---|
| `two_windows.ts` | the guarantee at the tab level: four real windows, and a non-neighbor's private value never arrives in the bytes, which cannot be checked by looking at the screen | CLI, ports 3000/8844, approximately 1 minute |
| `monitor_page.ts` | the monitor's served script: the scrubber, the color scale, and the two banners | Chromium only, approximately 4 seconds |

Can prove: what only a browser can, including a real reload restoring a real session, the actual
bytes a tab received, and the behavior of the one script in this package that no other tier can
load.

Cannot prove anything cheaper than the tier below it can, which is why it is not in `npm test`.
Both files exist because the claim was otherwise resting on a human looking at the screen. That is
worth stating plainly: `monitor_page.ts` failed on its first run and the bug was real: `gone()`
left the complete seating plan on screen while the badge said the game was over (`ISSUES.md` O9).

Note the asymmetry in cost. `two_windows.ts` is heavy because the guarantee needs a real study;
`monitor_page.ts` is cheap because `serveMonitor` takes a snapshot function and never an Empirica
connection, so the whole endpoint runs against a synthetic source. In other words, a property of
the design made this testing efficiency possible.

## 2. The `verify` command

```sh
npm run build && node dist/verify/cli.cjs verify --n 4
```

This is not a test tier. It is the command a reviewer would run, which is why CI runs the command
itself rather than only the library it wraps. It has three required components:

```
  non-neighbor sentinels received : 0/4 pairs  (must be 0)
  neighbor sentinels delivered    : 8/8  (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)
```

A clean result with a silent control means the check is blind; a clean result with nothing
delivered means the projection never ran. A clean result with no candidate pairs (the denominator
on the first line) means nothing was examined at all, which is why the denominator is printed and
why a topology that would produce one is refused before the run starts (`--topology=complete`, or
`--topology=wheel` at n=4, which is the same graph). Most privacy tests are wrong in exactly one of
those two ways, so both are reported as failures.

Sentinels are high-entropy tokens injected into projections and matched by substring against raw
wire frames, so a leak through a channel nobody enumerated is still caught.

## 3. The scripts

| | |
|---|---|
| `scripts/test.mjs` | the runner for all three tiers. Sweeps orphans before e2e and reports the count, because the count is evidence |
| `scripts/e2e-one.mjs` | one e2e file, bundled the same way; used for rapid iteration during development |
| `scripts/e2e-repeat.mjs` | one file N times in a fresh process each, reporting a rate. For O8 |
| `scripts/test-browser.mjs` | Playwright, real browsers. Discovers `test/browser/*.ts`, one process each; takes a substring filter, and errors on a filter that matches nothing |
| `scripts/example-install.mjs` | packs and installs into the examples, as a tarball rather than a `file:` link |
| `scripts/example-build.mjs` | builds each example's client. Catches import-resolution errors a parse check cannot |
| `scripts/bench.mjs` | end-to-end publish latency, plus first-channel latency (`ISSUES.md` O15) reported even for runs that do not complete. `--dense` for the degree sweep, `--payload` for degree × view size, `--repeats` for a published figure, `--clients` to put the participants on another machine |
| `scripts/soak.mjs` | long-run memory. Prints `net.stats()` alongside RSS |
| `scripts/ceiling.mjs` | the U7 reproduction. `CEILING_PLAIN=1` runs it without this package |
| `scripts/simulate.mjs` | the platform evaluation: the shipped Shirado reconstruction at its own n, across arms and seeds, keeping every output file, then auditing `views.ndjson` for C1. The one harness that does not throw its sessions away. `--seeds`, `--arms`, `--n`, `--out` |

Everything that touches `@empirica/core/admin` is bundled to CJS first, for the same reason every
time (`docs/PLATFORM-NOTES.md`, Section 3a).

### `--assert`: the half of bench and soak that runs in CI

`.github/workflows/perf.yml` runs both weekly, and its pass/fail decision depends on the
correctness each already computes, never on the timings.

```sh
npm run bench -- --assert    # every publish arrived; no round went unseen
npm run soak  -- --assert    # every finished game released everything it held
```

The reasoning is in that workflow's header and in `ISSUES.md` O6, and it is worth knowing before
adding a check of your own: a CI runner is a shared machine with 2 to 4 virtual CPUs, and this
bench's dominant term is participants per process competing for cores, so a latency threshold
would fluctuate unpredictably. A check that fluctuates is typically disabled, and a disabled job
appears to provide coverage while providing none. Latency and memory are recorded to the job
summary instead, so the history needed to set a threshold will eventually exist.

### Two machines: `--clients`, and what an absolute number costs

Every bench figure in this repository is an upper bound, and the reason is the harness rather
than the package: the participants and the server share one host, so at any interesting n they
compete for the same cores. It is measurable: p50 at n=100 fell 43.1 → 10.1 → 8.0 ms purely by
spreading the shards thinner (`--perShard`), and it is systematic, so repeats cannot touch it.
`ISSUES.md` O1 is that entry.

```sh
npm run bench -- --agent --port 7411              # on the client machine
npm run bench -- --clients CLIENT-HOST:7411 --repeats 3   # on the server machine
```

The coordinator keeps the server, the callbacks and the admin; the agent forks every shard. The
control channel is newline-delimited JSON over one TCP connection carrying the same messages
`fork()` IPC carried, so a sweep without `--clients` takes the path it always did.

Why the timing still means anything across the split: the bench has no clock protocol. The writer
stamps the send time inside the value and the recipient subtracts it on flush. Two machines'
clocks differ by more than the quantity being measured, so that would normally be fatal. It is
not, because both endpoints of every sample are participants, and all participants are on the
client host. The server never timestamps anything. This is also why the agent forks all shards
locally: split them across two client hosts and the measurement becomes an NTP offset.

Three practical things. The coordinator advertises an address for the remote participants to dial
and guesses it from the first non-internal IPv4. A host with a VPN or a container bridge has
several answers, so read the printed line and use `--advertise` when it is wrong. The agent takes
one coordinator at a time and refuses a second, because two sweeps sharing a client host measure
each other. And there is no authentication on the port: the intended deployment is two hosts on a
private network for the length of one sweep.

### `--absolute`: the sweep refuses rather than mislabels

The other half of O1 is the host's own clock. The same cell measured 3.3 to 18.3 ms across one
session while repeats within a sweep agreed to 4–17%, and the cause was DVFS: the coordinator
burned 1.1 CPU-seconds idle against 0.7 loaded for identical work (`docs/PLATFORM-NOTES.md` §21).
A bench that leaves the machine nearly idle asks for the slowest clock it has.

So every run now prints the host, CPU, governor and turbo state of both machines, and `--absolute`
refuses to start unless all three of O1's conditions hold: fixed clocks on both hosts, clients off
the server host, and at least three repeats. Pinned means `performance` on every CPU and boost
off; only Linux can prove it. A cloud instance without burst often exposes no `cpufreq` sysfs at
all, so `--attest-clocks "<why>"` lets you assert it in words, which are then printed beside the
numbers.

```
$ npm run bench -- --absolute
  NOT an absolute measurement — 3 condition(s) unmet:
    - server host …: darwin exposes no CPU governor, so frequency cannot be pinned (ISSUES.md O1)
    - participants share this host with the server (--clients)
    - --repeats 1, and SPIKE-REPORT §5-6 asks for 3
```

It gates the sweep; it does not certify the result. Meeting the conditions is necessary and not
sufficient.

## 4. Reading a red run

There are two causes, and neither indicates a regression. Check both before concluding anything.

### Orphaned harness servers — `docs/upstream/ISSUES.md` U6

The Empirica CLI execs a versioned binary as its own child, so killing the CLI leaves the real
server running and holding its port. Accumulated orphans starve player assignment, and the suite
then fails on a rotating victim with a 30-second "gameID assigned" timeout.

```sh
pkill -f "empirica-networks-.*tajriba.toml"
```

`scripts/test.mjs` now sweeps before the e2e tier and prints the count. Seeing "0 before the run"
is what licenses reading a red run as something other than a dirty machine; a silent sweep would
have made the O8 investigation impossible.

### Whole-run weight — `ISSUES.md` O8

Measured, and it changes the procedure. The e2e tier alone was green 62/62 on every attempt.
The same tier inside a full `npm test` failed twice out of three runs, both times on "gameID
assigned": once `scope_visibility` alone, once `scope_visibility` and `told`, once nothing. An
orphan sweep immediately beforehand did not prevent it.

So the rate of intermittent failure tracks the weight of the whole run, not the number of e2e
files, and:

> `npm test -- e2e` is the reliable signal. A red full run needs a second look before it is
> treated as a regression.

### The expensive shapes

1. Opening extra wire subscriptions before the batch, which the harness already handles. A second
GraphQL subscription per participant, which is what `part.changes()` opens, doubles the traffic the
server carries for each of them, and opening it before `createBatch` starves Classic's assignment.
That is the mechanism behind `ISSUES.md` O8.

`makeSharedProvider` `share()`s one subscription between the mode and every observer, so
`wireStream()` costs nothing and may be called whenever you like. If your test subscribes after
the scenario has started and needs the history, pass `recordWire: true` to `withScenario`; it
replays every frame since connect. Every leak test needs it, because the non-vacuity control has
to be visible too.

2. Waiting for an absence. This is still expensive, and still worth avoiding: it costs a timeout
by construction and is a weaker claim than the positive assertion usually available beside it.
`envelope.test.ts` asserts the warning positively via `onExceed: "warn"`, one server, 0.25 seconds,
rather than throwing and then waiting 8 seconds to confirm nothing published.

3. Running at a larger n than the claim needs. `kind_registration.test.ts` at n=2 made
`told.test.ts` fail twice consecutively; at n=1 the tier went green. Ask what the smallest
scenario is that can observe the claim.

### The procedure

1. Sweep orphans, and note the count.
2. Re-run the tier alone: `npm test -- e2e`.
3. Run the file alone: `npm run test:one <file>`.
4. Get a rate: `npm run test:repeat -- <file> 10`, on both sides of your change.

Only then is it a regression.

> Step 4 is not optional. Measured 2026-08-16, before O8 was fixed: `told.test.ts` failed once
> with a change and passed once without it, run alone, which looked decisive and was reported as
> a regression. It was not: ten repetitions of each gave 1/10 with and 4/10 without, same
> timeout, 0 orphans. A single run is not evidence about an intermittent failure, in either
> direction.
>
> The same discipline then found the real cause and, separately, stopped a fix being applied to
> `chat.test.ts` where it would have traded a known intermittent failure for an unknown one.
> Budget approximately 70 seconds.

Sharding the e2e tier was proposed as the fix and abandoned on the measurement: the tier is
already sharded, so it cannot help. What did help was asking of each test what the smallest
scenario is that can observe it. One file was spending two full games on a warning that fires
before any participant connects, and the participant-free version costs 0.27 seconds.

The tier's margin is currently one participant wide, measured twice. Adding
`kind_registration.test.ts` at n=2 made `told.test.ts` fail on `gameID assigned` twice in a row;
removing the file restored green; rewriting it at n=1 restored green with the file in place.
M6 Tier 4 found the same thing with an n=3 file.

So every new e2e file should be written at the smallest n that can observe its claim, not merely
as good practice, but because the alternative is breaking somebody else's test rather than your
own, which is the hardest kind of failure to attribute. The cost of a test is a property of the
test.

## 5. Continuous integration

Both workflows are in `.github/workflows/`.

### `ci.yml`

| Job | What it covers |
|---|---|
| `unit` | `check`, then `unit mode`, across Node 20 / 22 / 24. Plus `check:links` on 22 only |
| `e2e` | the real-Tajriba tier on Node 22, then `build`, then the `verify` command itself |
| `example` | installs the tarball and builds an example client: the half only a real build catches |

Concurrency cancels in-flight runs on the same ref: e2e spawns real Tajriba servers on fixed
ports, so overlapping runs would collide rather than merely waste time. Server logs are uploaded
on failure.

The e2e job is current-Node only on purpose: it needs the CLI and a real Tajriba, and running
that three times over would triple the slowest job to re-test the same server binary.

### `drift.yml` — the alarm

Runs the suite against `@empirica/core@latest` every Monday, and is expected to be the first
thing that goes red after an upstream release. That is the intended signal, not a sign of
instability.

It exists because four contracts this package depends on are version-fragile, and three fail
silently: the `TajribaProvider` constructor shape, the `dones` protocol, `AdminContext.init`
arity, and `ListenersCollector.attributeListeners` plus the `unique` wrapper shape.

The last is the only one touching an `@internal` field. The U8 detector calibrates the wrapper
shape at startup rather than hardcoding it, so it retunes itself, but if the field moves or is
renamed, the detector switches off and consumers stop being warned about a real defect.

The job skips when upstream has not moved, which keeps a green run meaningful instead of
re-testing the pinned version weekly under a name that says otherwise. Mode tests run first and
are reported separately, because they are the tier that catches a `dones` break.

It also catches upstream fixes, which is why the e2e step is not optional. Two findings are
pinned by tests that assert the current broken behavior: U8 (`duplicate_listeners.test.ts`,
"the second handler never ran") and U9 (`participant_write.test.ts`, `attributes()` errors). A fix
upstream turns those red with a message saying what to close. This job is the only thing that ever
runs them against a version where they could pass.

### The other direction — `test/unit/upstream_pin.test.ts`

`drift.yml` fires when upstream moves. This unit test fires when we move to it: bumping the
`@empirica/core` devDependency turns it red and lists, by `file:line`, every dated measurement still
citing the version left behind, around forty of them, since `CONTRIBUTING`, Section 6 requires
each to name its version.

That is the point. A pin bump is more than a find-and-replace operation: each of those lines is a
measurement, and the new version is precisely the reason to doubt it. The test also holds the
single pin declaration (`VERIFIED_CORE`, `src/harness/compat.ts`) against `package.json`, and
`cli_version.test.ts` checks that the verify CLI still prints that one rather than a copy. It
deliberately does not assert that the installed core matches the pin: `drift.yml` installs
`@empirica/core@latest` with `--no-save`, so such an assertion would fail first and mask the
contract failures the job exists to find.

## 6. Known gaps

Recorded rather than implied.

- Neither `bench` nor `soak` runs in CI (`ISSUES.md` O6). Bench figures are single runs and
  upper bounds (O1).
- Hooks cannot be rendered against the synthetic mode (`docs/PLATFORM-NOTES.md`, Section 8).
- Parts of the monitor page are still uncovered: tooltip positioning, the game picker, and the
  palette's own contrast claims (`ISSUES.md` O9, which closed the rest on 2026-08-16).

Two entries left this list on 2026-08-16, and the removals are worth as much as the list: the
monitor's browser script (O9) and `admin.taj.attributes()` (O7) are both exercised now. The
attributes result was that the API does not work at all; see `docs/upstream/ISSUES.md` U9. A gap list is only
useful if closing something removes it, and only honest if what closing revealed is written down.
