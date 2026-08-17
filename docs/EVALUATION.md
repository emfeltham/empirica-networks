# Evaluating the platform

`PUBLICATION-PLAN.md` §3, rewritten 2026-08-16 after the framing was corrected.

**The contribution is a platform.** The paper is a methods/tool paper extending Empirica to
network-structured designs (§4). So the empirical section is a **platform evaluation**, not a
study — it has to establish that the thing works, at the scale it claims, with the guarantee it
claims, and it has to say where the walls are.

---

## 1. The claims, and the evidence class each needs

| | Claim | Evidence |
|---|---|---|
| **C1** | **A participant receives their neighbours' projected views and nothing else** | Wire-level sentinel testing (`verify`), plus a `views.ndjson` audit over full-scale sessions of a real design |
| **C2** | Network-structured designs are expressible, including agent manipulations | Two reconstructed papers with test suites and stated deviations; Shirado's 3 × 3 agent grid |
| **C3** | It runs at the scale it claims, and the wall is where we say it is | `bench`, `ceiling` — including the n = 200 failure, which is itself a result |
| **C4** | A run is reproducible from its record | Seed and realised graph on the batch scope; same seed → same network; exports rebuilt from `run.ndjson` |
| **C5** | It survives what a real session does to it | Dropout, mid-session disconnect, restart, killed process |
| **C6** | Adopting it costs one mandatory edit, and skipping it is caught | The registration check, its deadline, and its retraction |

**C1 is the differentiator.** Stock Empirica cross-links every participant to every other; the
whole point of this package is that it does not. The rest is table stakes for a platform, and C1
is the reason it exists.

**C1 is also a property of the wire, not of the people on it.** A simulated participant's frames
are leak-tested exactly as well as a human's — the sentinel either arrives or it does not. That
observation is load-bearing for everything below.

## 2. The instrument: simulated sessions at full scale

Not a substitute for anything. It is the correct instrument for C1, C3, C4 and C5, and the only
one that can produce C5 at all.

**The machinery already exists.** `test/e2e/shirado2017.test.ts` imports
`examples/shirado2017/server/src/callbacks.js` **unmodified** against a real Tajriba;
`test/e2e/bots.test.ts` runs mixed human+bot sessions through `runBots`; the example already
writes `views.ndjson`, `run.ndjson`, `edges.csv`, `session.csv` and `changes.csv`. What is missing
is a runner that does this at the design's own n, across arms, for the real duration, and **keeps
the output** instead of asserting on it and deleting it.

**Proposed: a `simulate` command beside `verify`.** Runs the unmodified example over N seeded
sessions per arm into a dated output directory, then audits it.
**[`EVALUATION-RUNBOOK.md`](EVALUATION-RUNBOOK.md) is the build and operating plan**, written to
be handed over.

| | |
|---|---|
| n | 20, the paper's own — 17 simulated participants + 3 agents, and 20 + 0 for the control arm |
| Arms | control, and central × 10% noise |
| Sessions | enough seeds that a per-session flake shows up as a rate rather than an anecdote |
| Output | the full export set per session, plus a `views.ndjson` audit across all of them |

**One trap, specific to Shirado.** If the simulated participants run the example's own
`botChoice`, every node is executing the agent policy and **the agent-vs-control comparison is
vacuous**. The runner reports system properties *per arm* and never outcomes *across* arms. Easy
to get wrong in a write-up, where it would read as a result.

## 3. What simulation does better than people

Not a consolation prize: **C5 is unreachable with a human sample.** Simulated participants can be
told to drop out at a chosen second, never submit, disconnect mid-stage and return, or attempt a
write they should not be able to make. Those are the failures a platform has to survive, and you
cannot ask 17 people to produce them on cue — or ethically at all, in the last case.

## 4. The gap simulation leaves, and how to close most of it

**Browser clients.** Bots are Node, and `docs/PLATFORM-NOTES.md` §16 turns on exactly this: Node's
`ws` validates frames strictly and *throws* where a browser would see a closed socket and
reconnect, so "the consequence for real participants is untested". A bot-only run cannot speak to
it — it would re-measure the harness whose strictness produced the caveat.

**The hybrid closes most of it.** `test/browser/two_windows.ts` already drives real Chromium
contexts through Playwright. A session of ~4 browsers and ~16 bots at n = 20 exercises the actual
React client and a real browser WebSocket inside a full-size network, at a fraction of the cost of
twenty browser contexts. A second step after `simulate`, because Playwright at that scale needs
its own measurement before it is trusted.

## 5. What this takes off the critical path

Simulated participants have synthetic identifiers, so U10 does not apply to them.

- **U10 leaves §3's critical path.** It remains a live obligation on its own terms
  (`PUBLICATION-PLAN.md` §1), and it stays *out of* the paper by the standing decision to keep
  disclosure separate from paper content — but it no longer gates the empirical section.
- **IRB, the payment layer and recruitment leave the plan entirely.** The incentive work sketched
  in the previous version of this document is **de-scoped, not deferred**.
- Publication is then gated by §1's disclosure obligation and §2's API freeze, and by nothing in
  the evaluation itself.

## 6. A real deployment, kept off the critical path

A tool paper is stronger for evidence that somebody ran something real with it, and that argument
is genuine — but it is a nice-to-have, not a claim in §1's table. If it is ever done it should be
one small pilot, framed explicitly as a usability and deployment report rather than as a study,
and it re-imports U10, IRB and payment the moment it is scheduled. It is not scheduled.

`docs/EXPERIMENTS.md` §"If you are going to run one of these for real" stays exactly as it is:
guidance for *adopters*, who are the people who will actually run studies with this. That is the
right home for it, and it is not this document's job.

## 7. Success and kill criteria

Fixed before the runner exists, so the runner cannot be shaped around them.

| | |
|---|---|
| C1 | **zero** non-neighbour views across every session. One failure ends the evaluation |
| C3 | ≥ 8 of 10 sessions per arm reach first publish with a complete network |
| C4 | every session's `edges.csv` rebuilds byte-identically from `run.ndjson` |
| C4 | same seed, same realised graph, across processes |
| C5 | every injected failure still produces a complete export for the part that ran |
| — | latency reported with the machine and the `ISSUES.md` O1 caveat, never as a headline |

**A failure that is reported is worth more than a retry that is not.** If C1 fails once, that is
the finding, and it leads the paper.

---

*See also: `PUBLICATION-PLAN.md`, `docs/EXPERIMENTS.md`, `docs/BOTS.md`, `docs/TESTING.md`,
`ISSUES.md` U7/U10.*
