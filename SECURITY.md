# Security policy

## Reporting a vulnerability in this package

If you find a security issue in `empirica-networks` itself, please report it privately through
[GitHub's security advisory form for this repository](https://github.com/emfeltham/empirica-networks/security/advisories/new)
rather than as a public issue. Include a reproduction if you have one; the project's own defect
log (`ISSUES.md`) uses working reproductions for exactly this reason.

Reports are acknowledged as soon as practical. There is no bug bounty; this is a small research
project maintained by one person.

## Reporting a vulnerability in Empirica itself

Some issues surfaced while building this package are in the underlying [Empirica](https://empirica.ly)
platform rather than in this code. Those are tracked separately, under `docs/upstream/`, with
their own disclosure route and status recorded in
[`docs/upstream/DISCLOSURE.md`](docs/upstream/DISCLOSURE.md). Please use that route, not this one,
for anything that is a defect in Empirica rather than in this package: `ISSUES.md` tracks this
package's own defects (O-numbered), and [`docs/upstream/ISSUES.md`](docs/upstream/ISSUES.md)
tracks Empirica's (U-numbered).

## Scope

This covers the code in this repository. It does not cover the security properties of a study
built with it: `README.md`'s "Before running a study" section and `docs/PLATFORM-NOTES.md`
describe what this package does and does not guarantee about a running experiment.
