# Documentation

This index groups the documentation by task. New users should begin with
[GETTING-STARTED](GETTING-STARTED.md), which provides a complete introductory path.

## Using the package

| | |
|---|---|
| [GETTING-STARTED](GETTING-STARTED.md) | An ordered path through installation, required configuration, private state, execution, verification, and export |
| [TROUBLESHOOTING](TROUBLESHOOTING.md) | A symptom-based guide to failures that may occur without an explicit error |
| [API](API.md) | Every export, organized by import path, with the reasoning behind its design |
| [TOPOLOGIES](TOPOLOGIES.md) | Fourteen graph generators and six measures, including parameters, connectivity, and implications for the package's supported limits |
| [BOTS](BOTS.md) | Artificial participants: the policy interface, placement, inclusion in `playerCount`, and visibility of bot identifiers |
| [GLOSSARY](GLOSSARY.md) | Definitions of project-specific terms, including *channel*, *projection*, *view*, *seat*, *told*, *envelope*, and *O-number* |
| [EXPERIMENTS](EXPERIMENTS.md) | Two experiments reconstructed from published papers, including their scope and their distinction from replications |
| [API → The `verify` CLI](API.md#the-verify-cli) | Options, exit codes, and an explanation of the verifier's three checks |
| [`../examples/`](../examples) | Three runnable projects: begin with [`minimal`](../examples/minimal), followed by the two reconstructions. Tests import each example's `callbacks.js` directly to ensure continued compatibility |

## Running a study

| | |
|---|---|
| [DEPLOYING](DEPLOYING.md) | The current scope of deployment support, a preflight checklist, and known operational challenges |
| [DATA-AND-ANALYSIS](DATA-AND-ANALYSIS.md) | Run outputs, table schemas, and procedures for reproducing a run from stored data; review the view-capture decision before data collection |

## Understanding or changing it

| | |
|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | The module map, end-to-end lifecycle, publication path, data locations, and four upstream contracts that can fail silently |
| [CONTRIBUTING](CONTRIBUTING.md) | Repository layout, build process, substantive contribution rules, extension guides, and release process |
| [TESTING](TESTING.md) | The three test tiers, the evidence each provides, and a method for diagnosing failures before classifying them as regressions |
| [PLATFORM-NOTES](PLATFORM-NOTES.md) | Versioned and dated measurements of platform constraints that support claims elsewhere in the documentation |
| [`../ISSUES.md`](../ISSUES.md) | Known defects in this package (O-numbered) |

[ARCHITECTURE](ARCHITECTURE.md) is the primary design document for readers seeking an internal
account of the package.
