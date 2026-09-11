# Documentation

Cut by what you are trying to do. If you are new, start at
[GETTING-STARTED](GETTING-STARTED.md) and ignore the rest of this page.

## Using the package

| | |
|---|---|
| [**GETTING-STARTED**](GETTING-STARTED.md) | The ordered path: install → the one mandatory edit → private state → run → prove the guarantee → export. Read it top to bottom once |
| [**TROUBLESHOOTING**](TROUBLESHOOTING.md) | Indexed by symptom, for when something is silently wrong. Start here when nothing errored and something is off anyway |
| [**API**](API.md) | Every export, by import path, with the reasoning behind each decision |
| [**TOPOLOGIES**](TOPOLOGIES.md) | The 14 generators and 6 measures: parameters, connectivity, envelope implications. The page to read while *designing* |
| [**BOTS**](BOTS.md) | Artificial participants: the policy interface, placement, counting them into `playerCount`, and why a bot's *name* is participant-visible |
| [**GLOSSARY**](GLOSSARY.md) | Channel, projection, view, seat, told, envelope, U-numbers |
| [**EXPERIMENTS**](EXPERIMENTS.md) | The two reconstructed papers: what each shows, what was left out, and why "reconstruction" is not "replication" |
| [**API** → The `verify` CLI](API.md#the-verify-cli) | The one binary: options, exit codes, and what each of the three arms means |
| [`../examples/`](../examples) | Three runnable projects — [`minimal`](../examples/minimal) first, then the two reconstructions. Each one's `callbacks.js` is imported unmodified by a test, so none of them can rot |

## Running a study

| | |
|---|---|
| [**DEPLOYING**](DEPLOYING.md) | The file to read before planning a real study. Deployment is not yet documented, and this file says exactly how far the repository can take you — plus the pre-flight checklist and the parts known to be hard |
| [**DATA-AND-ANALYSIS**](DATA-AND-ANALYSIS.md) | What a finished run produces, every column of every table, and how to reproduce a run from what is stored. One decision here has to be made *before* the run |

## Understanding or changing it

| | |
|---|---|
| [**ARCHITECTURE**](ARCHITECTURE.md) | How it works inside: the module map, the lifecycle end to end, the publish path, where every value lives, and the four upstream contracts that break silently |
| [**CONTRIBUTING**](CONTRIBUTING.md) | Layout, build, the rules that are not style, how to add things, and releasing |
| [**TESTING**](TESTING.md) | The three tiers and what each can prove — and **how to read a red run** before calling it a regression |
| [**PLATFORM-NOTES**](PLATFORM-NOTES.md) | Every platform constraint, with the date and version it was measured against. The evidence the other documents cite |
| [`../ISSUES.md`](../ISSUES.md) | Known defects. **U** is upstream, **O** is ours |

## Keeping process records (not user documentation)

Kept because the reasoning is worth more than the conclusion, and cited by the documents above.
Nothing here is needed to use the package.

| | |
|---|---|
| [M5-ADOPTION](M5-ADOPTION.md) | The adoption milestone: distribution shape, which experiments and why, and the trap audit |
| [M6-HARDENING](M6-HARDENING.md) | The hardening milestone: what the shipped examples surfaced, and what each fix cost. Complete as of 2026-08-16 |
| [`../NEXT_STEPS.md`](../NEXT_STEPS.md) | What is left to do on the package: the critical path to `0.1.0`, the open defects, and what is deliberately not scheduled. Dated 2026-09-11 |
| [DOCS-PLAN](DOCS-PLAN.md) | The plan these documents were written from, and the one item still open |
| [EVALUATION](EVALUATION.md) | The paper's empirical section: what a *platform* has to prove, and why simulated sessions are the instrument |
| [EVALUATION-RUNBOOK](EVALUATION-RUNBOOK.md) | How to build and run `simulate`, written to be handed to someone who has not worked on this package |
| [upstream/DISCLOSURE](upstream/DISCLOSURE.md) | The disclosure route and its checklist |
| [upstream/U1](upstream/U1-no-write-access-control.md) · [upstream/U2](upstream/U2-restart-does-not-restore-games.md) | Drafted upstream reports |

`PUBLICATION-PLAN.md` and `PAPER-OUTLINE.md` — the route to a preprint, and the preprint's own
section plan — moved **out of this repository** on 2026-08-25, to the manuscript's working
directory. They are about the paper rather than the package, and a repository that ships to
adopters is the wrong home for a document tracking a submission. Documents here still cite
`PUBLICATION-PLAN.md` by name where the reasoning depends on it; [EVALUATION](EVALUATION.md) is
the part of that plan which stays, because what the platform has to prove is a fact about the
platform.

`MODULE-DESIGN.md` — why the package is shaped the way it is — is deliberately **not** in this
repository; it is kept with the investigation that produced it.
[ARCHITECTURE](ARCHITECTURE.md) is the answer to *how it works* kept inside this repository, which
is the question most links to it were actually asking.
