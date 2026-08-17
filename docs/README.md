# Documentation

Cut by what you are trying to do. If you are new, start at
[GETTING-STARTED](GETTING-STARTED.md) and ignore the rest of this page.

## Using the package

| | |
|---|---|
| [**GETTING-STARTED**](GETTING-STARTED.md) | The ordered path: install → the one mandatory edit → private state → run → prove the guarantee → export. Read it top to bottom once |
| [**TROUBLESHOOTING**](TROUBLESHOOTING.md) | Indexed by symptom, for when something is silently wrong. Start here when nothing errored and something is off anyway |
| [**API**](API.md) | Every export, by import path, with the reasoning behind each decision |
| [**TOPOLOGIES**](TOPOLOGIES.md) | The 15 generators and 6 measures: parameters, connectivity, envelope implications. The page to read while *designing* |
| [**BOTS**](BOTS.md) | Artificial participants: the policy interface, placement, counting them into `playerCount`, and why a bot's *name* is participant-visible |
| [**GLOSSARY**](GLOSSARY.md) | Channel, projection, view, seat, told, envelope, U-numbers |
| [**EXPERIMENTS**](EXPERIMENTS.md) | The two reconstructed papers: what each shows, what was left out, and why "reconstruction" is not "replication" |

## Running a study

| | |
|---|---|
| [**DEPLOYING**](DEPLOYING.md) | **Read this before planning a real study.** Deployment is not yet documented, and this file says exactly how far the repository can take you — plus the pre-flight checklist and the parts known to be hard |
| [**DATA-AND-ANALYSIS**](DATA-AND-ANALYSIS.md) | What a finished run produces, every column of every table, and how to reproduce a run from what is stored. One decision here has to be made *before* the run |

## Understanding or changing it

| | |
|---|---|
| [**ARCHITECTURE**](ARCHITECTURE.md) | How it works inside: the module map, the lifecycle end to end, the publish path, where every value lives, and the four upstream contracts that break silently |
| [**CONTRIBUTING**](CONTRIBUTING.md) | Layout, build, the rules that are not style, how to add things, and releasing |
| [**TESTING**](TESTING.md) | The three tiers and what each can prove — and **how to read a red run** before calling it a regression |
| [**PLATFORM-NOTES**](PLATFORM-NOTES.md) | Every platform constraint, with the date and version it was measured against. The evidence the other documents cite |
| [`../ISSUES.md`](../ISSUES.md) | Known defects. **U** is upstream, **O** is ours |
| [**DOCS-PLAN**](DOCS-PLAN.md) | What is still missing from these documents, and when it gets written |

## Process records — not user documentation

Kept because the reasoning is worth more than the conclusion, and cited by the documents above.

| | |
|---|---|
| [M5-ADOPTION](M5-ADOPTION.md) | The adoption milestone: distribution shape, which experiments and why, and the trap audit |
| [M6-HARDENING](M6-HARDENING.md) | The hardening milestone: what the shipped examples surfaced, and what each fix cost. Complete as of 2026-08-16 |
| [`../PUBLICATION-PLAN.md`](../PUBLICATION-PLAN.md) | Disclosure → API freeze → demonstration study → preprint |
| [upstream/DISCLOSURE](upstream/DISCLOSURE.md) | The disclosure route and its checklist |
| [upstream/U1](upstream/U1-no-write-access-control.md) · [upstream/U2](upstream/U2-restart-does-not-restore-games.md) | Drafted upstream reports |

`MODULE-DESIGN.md` — why the package is shaped the way it is — is deliberately **not** in this
repository; it is kept with the investigation that produced it.
[ARCHITECTURE](ARCHITECTURE.md) is the in-repo answer to *how it works*, which is the question
most links to it were actually asking.
