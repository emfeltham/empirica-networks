# Runbook: building and running `simulate`

**Audience: whoever is implementing this, working alone.** `docs/EVALUATION.md` says *what* the
evaluation claims and *why*; this says how to build the instrument and how to run it. Read
EVALUATION.md §1 and §7 first — they are short, and everything here serves them.

You do not need to have written any part of this package. You do need to be comfortable with
Node, TypeScript and reading other people's tests.

**What you will produce:** a `simulate` command that runs the shipped Shirado reconstruction over
N seeded sessions per arm, keeps every output file, and audits them. Plus a results directory and
a short written report of what the audit found.

**Rough effort**, and these are estimates: steps 1–3 about two days, step 4 (the audit) one day,
steps 5–6 one day each. The browser hybrid in §9 is a separate week and is not part of this.

---

## 0. Before you start

Run these. If any fails, fix that before writing code — none of them are affected by the work you are about to do, so a failure means the environment is at issue.

```sh
cd empirica-networks
npm install
npm run check          # tsc --noEmit. Must be silent
npm test -- unit       # ~340 tests, seconds
npm test -- e2e        # 71 tests, ~2 minutes, needs to download the empirica binary once
```

The e2e tier is the one that matters: it proves a real Tajriba starts on your machine. If it is
red, read `docs/TESTING.md` §4 before assuming a regression — `ISSUES.md` O8 means a single red
run is not always real. `npm run test:repeat` measures a rate.

**Sweep stray servers** if a run ever looks wrong:

```sh
pkill -f "empirica-networks-.*tajriba.toml"
```

Then read, in this order, and do not skip them — every trap in §10 comes from one of them:

| | |
|---|---|
| `test/e2e/shirado2017.test.ts` | how the example's callbacks are driven against a real server |
| `test/e2e/bots.test.ts` | how `runBots` seats a game alongside human participants |
| `examples/shirado2017/README.md` | the design, and what is deliberately not reconstructed |
| `docs/BOTS.md` | the policy interface and the lifecycle |

## 1. The rig you are building on, and what it does not cover

**Use the test harness, not the `empirica` dev server.** `withScenario` in `src/harness/harness.ts`
boots a real Tajriba, starts callbacks, connects participants and tears everything down.
`test/e2e/shirado2017.test.ts` already drives the example's **unmodified**
`server/src/callbacks.js` through it. That is the proven path and it is what you extend.

**State plainly in your report that this rig does not exercise:** the React client, the browser
WebSocket, `Lobby()`, or the example's own `server/src/index.js`. Those are §9's job. The rig
covers the server, the package, the channels and the data pipeline — which is C1, C3, C4 and C5.

## 2. What to build, and where

| File | What it is |
|---|---|
| `src/simulate/simulate.ts` | the run loop: arms × seeds → sessions, keeping output |
| `src/verify/audit.ts` | reads a results directory, checks C1 and C4, prints a verdict |
| `src/verify/cli.ts` | add a `simulate` command beside `verify` |
| `scripts/simulate.mjs` | bundles to CJS and runs it, exactly like `scripts/bench.mjs` |
| `package.json` | add `"simulate": "node scripts/simulate.mjs"` beside `"bench"` |
| `test/unit/audit.test.ts` | the audit's own tests — see step 4, this one is not optional |

Note that `verify` is *not* an npm script — it ships as a CLI (`node dist/verify/cli.cjs verify`)
because consumers run it. `simulate` is ours, so an npm script is the right shape for it; whether
it also becomes a public CLI command is a decision for after it works.

**Bundling is not a style choice.** `@empirica/core` cannot be loaded from bare Node in either
module system (`docs/PLATFORM-NOTES.md` §3a). Copy the esbuild block from `scripts/bench.mjs`;
it already solves this.

## 3. Step 1 — one session, output kept

**Goal:** one control-arm session at n = 20, played to its natural end, with every file the
example writes left on disk.

Start from `test/e2e/shirado2017.test.ts`. The changes from that starting point are:

- **20 participants**, not the test's small n.
- **A results directory per run.** Set `SHIRADO2017_OUT` to something like
  `results/<runId>/<arm>/<seed>` *before importing the callbacks module* — it reads the env var
  at module load (`callbacks.js:39`), so setting it afterwards does nothing. This is the first
  trap and it fails silently by writing to `data/`.
- **Let the stage run to the design's duration** rather than the test's 600 ms.
- **Do not assert.** A test fails loudly; a runner records and moves on. The audit in step 4 is
  what judges the output.

**Definition of done:** `results/<runId>/control/<seed>/` contains a `<gameID>/` directory with
`session.csv`, `changes.csv`, `edges.csv`, and alongside them `views.ndjson` and `run.ndjson`.

**Check it by hand before going further.** Open `edges.csv` and confirm it has the edges of a
20-node Barabási–Albert graph. Open `session.csv` and confirm the condition columns say what you
asked for. If either is wrong, nothing downstream means anything.

## 4. Step 2 — the simulated participants

Seventeen or twenty simulated participants, driven by `runBots` with a policy that plays the
colour game. `docs/BOTS.md` describes the interface; `botChoice` in the example's `design.mjs` is
an existing implementation of the rule.

**The vacuity rule, and it constrains the whole evaluation.** If the simulated participants use
`botChoice`, then in the agent arm *every* node is running the agent policy, and the
agent-vs-control comparison means nothing. That is acceptable — this evaluation does not make
cross-arm claims. What is **not** acceptable is reporting anything that reads as an outcome
difference between arms. Report system properties per arm. Write this at the top of your results
file so the next reader cannot miss it.

**Identifiers.** `runBots` requires an explicit list; `botIdentifiers(n)` generates development
ones. In the **agent arm** the server has to hold the same list as the runner — export
`SHIRADO2017_BOT_KEYS` with exactly the three agent identifiers, and give the other seventeen
participants different ones. Mismatch here produces a session that never starts.

**Definition of done:** a control session where all 20 participants move and the game reaches a
solved or timed-out end; and an agent session where `session.csv` records `bots: 3` with the
placement and noise you configured.

## 5. Step 3 — arms, seeds, sessions

Wrap step 1 in two loops: arm, then seed. Ten seeds per arm to start.

- **Fresh server per session.** `withScenario` already does this. Do not try to reuse one — the
  bench learned that startup variance is part of what you are measuring.
- **`resetChannels()` between sessions** if you run more than one in a process. Every test file
  in the repo does this in a `beforeEach`, for a reason.
- **Seeds are the point.** Record the seed in the directory name *and* inside the results file.
  C4 depends on being able to re-run one.
- **A session that fails is data.** Catch, record why, continue to the next seed. The bench does
  exactly this and `ISSUES.md` O15 is a case where discarding a failed run destroyed the evidence
  that mattered.

**Definition of done:** `npm run simulate` produces 20 session directories and a manifest listing
arm, seed, game id, and whether the session completed.

## 6. Step 4 — the audit (C1). The most important step

Everything else is plumbing. This is the claim.

`views.ndjson` holds one `ViewRecord` per delivered view (`src/shared/keys.ts:217`):

```ts
{ gameID: string, viewer: string, seq: number, at: number, view: unknown[] }
```

**The check:** for every record, the set of `id`s in `view` must equal the viewer's neighbour set
in that game's realised graph. Shirado does not rewire, so the graph is static per game — read it
from that session's `edges.csv`.

Three outcomes, and **all three must be reported**:

| | |
|---|---|
| A non-neighbour appears in a view | **C1 has failed.** Stop the evaluation. This is the finding and it leads the paper |
| A neighbour is missing from a view | not a leak, but a delivery defect — record it |
| Zero records for a session | **the audit is vacuous for that session.** Not a pass |

**That third row is why `test/unit/audit.test.ts` is not optional.** An audit that reports "no
leaks" over an empty file is the exact shape of failure this repo keeps finding — the check ran,
said nothing, and meant nothing. Write the tests first:

- a hand-built views file with a known leak → the audit reports it
- a clean file → the audit passes **and** reports how many records it checked
- an empty file → the audit reports **vacuous**, not pass
- a view containing a neighbour twice, or a viewer not in the graph → an error, not silence

**Definition of done:** the audit prints, per arm, the number of sessions, records checked,
leaks, missing deliveries, and vacuous sessions. A non-zero leak count exits non-zero.

## 7. Step 5 — reproducibility (C4)

Two checks, both cheap:

1. **Same seed, same graph.** Re-run one seed in a fresh process; `edges.csv` must be identical.
2. **The export rebuilds from the log.** `examples/shirado2017/recover.mjs` reconstructs
   `session.csv` and `changes.csv` from `run.ndjson`. Run it against a completed session and
   diff. `edges.csv` must come back byte-identical — the example's README says this is the
   property being protected.

**Definition of done:** both pass on at least three sessions per arm, and the results file states
which sessions were checked rather than claiming it for all of them.

## 8. Step 6 — resilience (C5)

The part a human sample cannot give you. For each, inject the failure and confirm the export for
the part that ran is complete and readable:

| Injection | How |
|---|---|
| Participant drops mid-session | `run.stop()` on one bot partway through |
| Participant never submits | a policy that returns without writing |
| Session killed outright | end the process mid-game; `run.ndjson` must still reconstruct |

**What "passes" means:** not that the session survives — some will not, and `docs/upstream/ISSUES.md` U2 says a
full restart never restores participants to their game. It means **the data for what did happen
is intact and says what happened.** A session that dies and leaves an honest partial record is a
pass. One that dies and leaves nothing, or leaves a record implying it completed, is a failure.

## 9. Not in scope for this runbook

- **The browser hybrid.** ~4 Playwright contexts + ~16 bots against the real `empirica` server.
  It is the one gap bots cannot cover (`docs/EVALUATION.md` §4) and it needs its own measurement
  first. Separate piece of work.
- **Anything with real participants.** `docs/EVALUATION.md` §6.
- **Modifying `examples/shirado2017`.** If you find yourself needing to, stop: the example being
  run *unmodified* is part of what the evaluation demonstrates. A needed change is a finding —
  write it down and raise it.
- **Cross-arm outcome comparisons.** See §4.

## 10. Traps, all of which fail quietly

1. **`playerCount` counts agents.** A 20-node treatment with 3 agents needs **17** other
   participants. Supply 20 and the game sits one seat short forever. The runner warns after 30 s
   rather than hanging silently — read the message, it names this.
2. **`SHIRADO2017_OUT` is read at module load.** Set it before the import, not after.
3. **`views.ndjson` and `run.ndjson` live at the top of `OUT_DIR`,** while exports go to
   `OUT_DIR/<gameID>/`. Several sessions sharing an `OUT_DIR` append to one views file. Records
   carry `gameID` so the audit still works — but if you want per-session files, give each session
   its own `OUT_DIR`.
4. **`SHIRADO2017_BOT_KEYS` must match** between the server side and the runner, exactly.
5. **Orphaned Tajriba servers** survive a killed run and will make the next one behave strangely.
   The `pkill` line in §0.
6. **A single red e2e run is not necessarily a regression** (`ISSUES.md` O8). Measure a rate.

## 11. What to hand back

A directory of results, and a short written report containing:

- the machine, the date, and the `@empirica/core` version (`src/harness/compat.ts` has the pin)
- sessions attempted, completed, and failed — with the reasons, not just the count
- the audit output: records checked, leaks, missing deliveries, vacuous sessions
- which sessions were checked for C4, and the outcome
- the C5 injections and what each produced
- **anything you had to work around**, especially anything that made you want to edit the example

Latency figures, if you record any, carry the machine and the `ISSUES.md` O1 caveat. They are
never a headline: an absolute latency number from a laptop is not reproducible, and O1 explains
why at length.

**If C1 fails once, stop and raise it immediately.** Do not re-run to see if it goes away.

---

*See also: `docs/EVALUATION.md`, `docs/BOTS.md`, `docs/TESTING.md`,
`examples/shirado2017/README.md`, `ISSUES.md` O1/O8, `docs/upstream/ISSUES.md` U2/U7.*
