# Documentation

This index is organized by what you are trying to do. If you are new, start at
[GETTING-STARTED](GETTING-STARTED.md) and ignore the rest of this page.

## Using the package

| | |
|---|---|
| [GETTING-STARTED](GETTING-STARTED.md) | The ordered path: install → the one mandatory edit → private state → run → prove the guarantee → export. Read it top to bottom once |
| [TROUBLESHOOTING](TROUBLESHOOTING.md) | Indexed by symptom, for when something is silently wrong. Start here when nothing errored and something is off anyway |
| [API](API.md) | Every export, by import path, with the reasoning behind each decision |
| [TOPOLOGIES](TOPOLOGIES.md) | The 14 generators and 6 measures: parameters, connectivity, envelope implications. The page to read while designing |
| [BOTS](BOTS.md) | Artificial participants: the policy interface, placement, counting them into `playerCount`, and why a bot's name is participant-visible |
| [GLOSSARY](GLOSSARY.md) | Channel, projection, view, seat, told, envelope, U-numbers |
| [EXPERIMENTS](EXPERIMENTS.md) | The two reconstructed papers: what each shows, what was left out, and why "reconstruction" is not "replication" |
| [API → The `verify` CLI](API.md#the-verify-cli) | The one binary: options, exit codes, and what each of the three arms means |
| [`../examples/`](../examples) | Three runnable projects: [`minimal`](../examples/minimal) first, then the two reconstructions. Each one's `callbacks.js` is imported unmodified by a test, so none of them can rot |

## Running a study

| | |
|---|---|
| [DEPLOYING](DEPLOYING.md) | The file to read before planning a real study. Deployment is not yet documented, and this file says exactly how far the repository can take you, plus the pre-flight checklist and the parts known to be hard |
| [DATA-AND-ANALYSIS](DATA-AND-ANALYSIS.md) | What a finished run produces, every column of every table, and how to reproduce a run from what is stored. One decision here has to be made before the run |

## Understanding or changing it

| | |
|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | How it works inside: the module map, the lifecycle end to end, the publish path, where every value lives, and the four upstream contracts that break silently |
| [CONTRIBUTING](CONTRIBUTING.md) | Layout, build, the rules that are not style, how to add things, and releasing |
| [TESTING](TESTING.md) | The three tiers and what each can prove, and how to read a red run before calling it a regression |
| [PLATFORM-NOTES](PLATFORM-NOTES.md) | Every platform constraint, with the date and version it was measured against. The evidence the other documents cite |
| [`../ISSUES.md`](../ISSUES.md) | Known defects in this package (O-numbered) |
| [upstream/ISSUES](upstream/ISSUES.md) | Known defects in Empirica itself (U-numbered), found while building this package |

[ARCHITECTURE](ARCHITECTURE.md) is the answer to how the package works internally, and is the
question most links to a design document were actually asking.
