# Testing

Three tiers, a verification command, and four measurement harnesses. The tiers are separated by
**what each one can prove**, not by speed — the speed difference is a consequence.

Read [§4](#4-reading-a-red-run) before concluding that a red run is a regression. That section
exists because getting it wrong has cost this project real investigations more than once.

```sh
npm test                                          # unit + mode + e2e
npm test -- unit mode                             # the cheap tiers, no server needed
npm run test:one test/e2e/rand2011.test.ts        # one e2e file, for the inner loop
npm run test:repeat -- test/e2e/chat.test.ts 25   # the same file 25 times, reporting a rate
npm run check                                     # tsc --noEmit
npm run check:links                               # documentation links
```

Baseline, measured 2026-08-16 after M6 closed: **276 unit / 34 mode / 66 e2e**, green, with
`npm run check` clean. (`docs/M6-HARDENING.md` records 255/34/65 — that was taken mid-milestone,
before Tier 2 and Tier 4 landed.) The e2e tier takes ~90 s.

---

## 1. The three tiers

### unit — pure logic, no server

`test/unit/*.test.ts`, run directly under `tsx`. Milliseconds.

**Can prove:** anything about the pure functions — topology generators, `edgeRows`/`snapshotRows`/
`viewRows`, `toCSV`, `validateProjection`, the envelope arithmetic, `graphMetrics`, the duplicate-
listener detector's shape analysis, the NDJSON sink's batching.

**Cannot prove:** that any of it is wired up. Every silent failure this package documents was a
wiring failure, and the unit tier is blind to all of them by construction.

**Constraint:** unit tests must not import `@empirica/core/admin`, which cannot be loaded
unbundled (`docs/PLATFORM-NOTES.md` §3a). That is why they can run directly under `tsx` and why
they are separated from e2e in CI.

`test/unit/export_isolation.test.ts` is worth knowing about: it fails if anything with a runtime
import ever reaches the `empirica-networks/export` entry, which is what keeps offline analysis
scripts working.

### mode — the client, against a synthetic provider

`test/mode/*.test.ts`, driving a synthetic `TajribaProvider` (`test/mode/synthetic.ts`).

**Can prove:** that `EmpiricaNetwork` composes correctly, that the hooks resolve, that
`undefined` and `[]` stay distinct, and — the reason this tier exists — **that the `dones`
protocol is still wired correctly.** That contract is version-fragile and fails *silently*: every
scope materialises and every `.get()` returns `undefined`.

**Cannot prove:** anything about the real wire, and it cannot render hooks against the synthetic
mode (`docs/PLATFORM-NOTES.md` §8) — that is a testing limit of ours, not a consumer-facing one.

**Why it is separate from e2e:** an e2e run can mask a `dones` break by simply timing out
somewhere else. This tier fails on the actual contract.

### e2e — a real Tajriba

`test/e2e/*.test.ts`, **bundled to CJS before running**, mirroring how a consumer's server is
built. Minutes. Needs the Empirica CLI on PATH.

**Can prove:** the guarantee. This is the only tier that observes the real wire, the real
subscription machinery, and the real runloop.

Some of the load-bearing ones:

| | Proves |
|---|---|
| `leak.test.ts`, `scope_visibility.test.ts` | non-neighbours receive nothing; the batch scope is not delivered |
| `topology_visibility.test.ts` | the seed and edge list do not reach participants |
| `restart.test.ts`, `restart_full.test.ts` | a restart does not silently reseat anyone |
| `duplicate_listeners.test.ts` | the U8 detector fires — **and if it ever fails saying the second handler *did* run, upstream fixed U8 and the warning should be withdrawn** |
| `example.test.ts`, `rand2011.test.ts`, `shirado2017.test.ts` | each example's real `callbacks.js`, imported **unmodified** |
| `upstream_u1.test.ts`, `participant_write.test.ts` | U1 is real, through the public API |

**The examples being imported unmodified is the point.** An example whose behaviour is *asserted*
found three real bugs during M5, two of them in itself; an example whose behaviour is *described*
would have shipped all three.

## 2. `verify` — the guarantee as a command

```sh
npm run build && node dist/verify/cli.cjs verify --n 4
```

Not a test tier: the command a **reviewer** would run, which is why CI runs the command itself and
not just the library it wraps. Three arms, all required:

```
  non-neighbour sentinels received : 0   (must be 0)
  neighbour sentinels delivered    : 8/8 (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)
```

A clean result with a **silent control** means the check is blind; a clean result with **nothing
delivered** means the projection never ran. Most privacy tests are wrong in exactly one of those
two ways, so both are reported as failures.

Sentinels are high-entropy tokens injected into projections and matched by substring against raw
wire frames — so a leak through a channel nobody enumerated is still caught.

## 3. The scripts

| | |
|---|---|
| `scripts/test.mjs` | the runner for all three tiers. Sweeps orphans before e2e and **reports the count**, because the count is evidence |
| `scripts/e2e-one.mjs` | one e2e file, bundled the same way. The inner loop |
| `scripts/e2e-repeat.mjs` | one file N times in a fresh process each, reporting a rate. For O8 |
| `scripts/test-browser.mjs` | Playwright, real browsers. Asserts the guarantee at the tab |
| `scripts/example-install.mjs` | packs and installs into the examples — **as a tarball, never a `file:` link** |
| `scripts/example-build.mjs` | builds each example's client. Catches import-resolution errors a parse check cannot |
| `scripts/bench.mjs` | end-to-end publish latency. `--dense` for the degree sweep |
| `scripts/soak.mjs` | long-run memory. Prints `net.stats()` alongside RSS |
| `scripts/ceiling.mjs` | the U7 reproduction. `CEILING_PLAIN=1` runs it without this package |

Everything that touches `@empirica/core/admin` is bundled to CJS first, for the same reason every
time (`docs/PLATFORM-NOTES.md` §3a).

## 4. Reading a red run

**Two causes, and neither is a regression. Check both before concluding anything.**

### Orphaned harness servers — `ISSUES.md` U6

The Empirica CLI execs a versioned binary as its own child, so killing the CLI leaves the real
server running and holding its port. Accumulated orphans starve player assignment, and the suite
then fails on a *rotating victim* with a 30-second "gameID assigned" timeout.

```sh
pkill -f "empirica-networks-.*tajriba.toml"
```

`scripts/test.mjs` now sweeps before the e2e tier and prints the count. **"0 before the run" is
what licenses reading a red run as something other than a dirty machine** — a silent sweep would
have made O8's investigation impossible.

### Whole-run weight — `ISSUES.md` O8

Measured, and it changes the procedure. The e2e tier **alone** was green 62/62 on every attempt.
The *same* tier inside a full `npm test` failed twice out of three runs, both times on "gameID
assigned" — once `scope_visibility` alone, once `scope_visibility` and `told`, once nothing. An
orphan sweep immediately beforehand did not prevent it.

So the flake tracks the weight of the *whole* run, not the number of e2e files, and:

> **`npm test -- e2e` is the reliable signal. A red full run needs a second look before it is a
> regression.**

### The procedure

1. **Sweep orphans**, and note the count.
2. **Re-run the tier alone** — `npm test -- e2e`.
3. **Run the file alone** — `npm run test:one <file>`.
4. **Get a rate** if it is intermittent — `npm run test:repeat -- <file> 25`.

Only then is it a regression.

Sharding the e2e tier was proposed as the fix and **abandoned on the measurement**: the tier is
already sharded, so it cannot help. What did help was asking of each test *"what is the smallest
scenario that can observe this?"* — one file was spending two full games on a warning that fires
before any participant connects, and the participant-free version costs 0.27 s. **The cost of a
test is a property of the test**, and that question has not been asked systematically of the
existing files.

## 5. CI

Both workflows are in `.github/workflows/`.

### `ci.yml`

| Job | What it covers |
|---|---|
| `unit` | `check`, then `unit mode`, across Node 20 / 22 / 24. Plus `check:links` on 22 only |
| `e2e` | the real-Tajriba tier on Node 22, then `build`, then **the `verify` command itself** |
| `example` | installs the tarball and builds an example client — the half only a real build catches |

Concurrency cancels in-flight runs on the same ref: e2e spawns real Tajriba servers on fixed
ports, so overlapping runs would collide rather than merely waste time. Server logs are uploaded
on failure.

The e2e job is current-Node only on purpose — it needs the CLI and a real Tajriba, and running
that three times over would triple the slowest job to re-test the same server binary.

### `drift.yml` — the alarm

Runs the suite against **`@empirica/core@latest`** every Monday, and is *expected* to be the first
thing that goes red after an upstream release. **That is the signal, not a flake.**

It exists because four contracts this package depends on are version-fragile and **three fail
silently**: the `TajribaProvider` constructor shape, the `dones` protocol, `AdminContext.init`
arity, and `ListenersCollector.attributeListeners` plus the `unique` wrapper shape.

The last is the only one touching an `@internal` field. The U8 detector *calibrates* the wrapper
shape at startup rather than hardcoding it, so it retunes itself — but if the field moves or is
renamed, the detector switches off and consumers stop being warned about a real defect.

The job skips when upstream has not moved, which keeps a green run meaningful instead of
re-testing the pinned version weekly under a name that says otherwise. Mode tests run first and
are reported separately, because they are the tier that catches a `dones` break.

## 6. Known gaps

Recorded rather than implied.

- **Neither `bench` nor `soak` runs in CI** (`ISSUES.md` O6). Bench figures are single runs and
  upper bounds (O1).
- **The monitor's browser script is covered by no test** (`ISSUES.md` O9).
- **`admin.taj.attributes()` is untested** (`ISSUES.md` O7).
- **`assertKindsRegistered` is covered by no test, and called by nothing** (`ISSUES.md` O14) — the
  package's most consequential silent failure has no witness.
- **Hooks cannot be rendered against the synthetic mode** (`docs/PLATFORM-NOTES.md` §8).
