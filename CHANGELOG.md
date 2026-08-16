# Changelog

Notable changes to `empirica-networks`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html) from the first release.

## [Unreleased]

**Nothing has been released.** The package is `private: true` at `0.0.0` while an unpatched
upstream vulnerability goes through disclosure — see `PUBLICATION-PLAN.md` §1. This section will
become `0.1.0` at the first publish, and the API freeze (`PUBLICATION-PLAN.md` §2) is what makes
the entries below meaningful as a baseline rather than a moving target.

Development history to that point is recorded by milestone, in the documents that carry the
reasoning as well as the change:

| | |
|---|---|
| **M1** | The mechanism: private channels, projection, the read guarantee, `verify` |
| **M2** | Topology generators, rewiring during play, neighbour-scoped chat, edge-history export |
| **M3** | View capture — recording what participants were actually shown |
| **M4** | The live monitor |
| **M5** | Adoption: two reconstructed experiments, the docs, `tell()`. [`docs/M5-ADOPTION.md`](docs/M5-ADOPTION.md) |
| **M6** | Hardening: what the shipped examples surfaced. [`docs/M6-HARDENING.md`](docs/M6-HARDENING.md) |

### Added since M5 (all 2026-08-16)

- `NetworkConfig.read` — declare private keys the server consumes but `project()` never touches,
  and `net.stateOf()` to read them **loudly**. Previously `watch` did both jobs under one name,
  and an unlisted key read back as `undefined` — indistinguishable from "not submitted"
  (`ISSUES.md` O11).
- `NetworkConfig.log` and `net.log()` — an append-only run log written *as the study happens*,
  because analysis files were only written at a natural game end and a killed study produced none
  (`ISSUES.md` O12).
- `NetworkConfig.onPrivateState` — a first-class hook for "a participant wrote private state",
  replacing a pattern that reached into the package's key layout (`ISSUES.md` O13).
- Duplicate-lifecycle-listener detection at server start, for upstream U8.
- `net.activeGames()`, replacing `net.games()`; `GameRef` and `gameIDOf()` so every entry point
  takes either a game scope or its id.
- `envelope.maxNeighbourhoodBytes` (64 KiB default).

### Changed

- **`envelope.maxDegree` now depends on n**: `n - 1` at n ≤ 50, `16` above. The old flat cap of 16
  came from a sweep of *sparse* graphs while varying n, so it was a number about n enforced as a
  number about degree. Measured properly in `docs/PLATFORM-NOTES.md` §19.
- `EdgeRow` and `SnapshotRow` are `type` aliases rather than interfaces, so `toCSV(edgeRows(…))`
  typechecks.

### Documentation

- New: [`docs/API.md`](docs/API.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md),
  [`docs/DATA-AND-ANALYSIS.md`](docs/DATA-AND-ANALYSIS.md),
  [`docs/TOPOLOGIES.md`](docs/TOPOLOGIES.md), [`docs/DEPLOYING.md`](docs/DEPLOYING.md) (a stub —
  deployment is genuinely undocumented), [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md),
  [`docs/TESTING.md`](docs/TESTING.md), [`docs/GLOSSARY.md`](docs/GLOSSARY.md), and an index.
- The README is a front door again — the API reference moved to `docs/API.md`.
- `LICENSE` added. The package claimed MIT in metadata and shipped no licence text.
- Two CI checks: `check:links` (relative paths and section anchors) and `check:docs` (every
  documented `empirica-networks` import, resolved against the built package).

### Known

- **`ISSUES.md` O14** — `assertKindsRegistered` is exported and never called, so the one mandatory
  consumer edit is still silently fatal. Found while writing the architecture document.
- **U1** — no write access control anywhere in Empirica. Affects every Empirica study.
- **U2** — a crashed study cannot be resumed.
- **U7** — games do not reliably start at n ≥ 200.
- **U8** — a lifecycle listener can only be registered once, silently.
