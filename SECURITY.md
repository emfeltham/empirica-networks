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
platform rather than in this code. Where one constrains this package it is described in
[`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md), separately from this package's own defects in
[`ISSUES.md`](ISSUES.md).

Please report a defect in Empirica to Empirica, not here. That project publishes no `SECURITY.md`
and no contact address, so the route for a security or privacy finding is GitHub's private
advisory form at
[`empiricaly/empirica`](https://github.com/empiricaly/empirica/security/advisories/new); ordinary
bugs go to [its issue tracker](https://github.com/empiricaly/empirica/issues).

## Scope

This covers the code in this repository. It does not cover the security properties of a study
built with it: `README.md`'s "Before running a study" section and `docs/PLATFORM-NOTES.md`
describe what this package does and does not guarantee about a running experiment.
