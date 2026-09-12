# Next steps — the package

**Dated 2026-09-11.** M1–M7 are complete and recorded in [`CHANGELOG.md`](CHANGELOG.md); this is
the forward half — what is not done, why, and what would count as done. Every claim here is
current as of this date and cited to the file that carries it, on the same convention as
[`ISSUES.md`](ISSUES.md) and `docs/PLATFORM-NOTES.md`.

It exists because `PUBLICATION-PLAN.md` left this repository on 2026-08-25 (commit `6fb750a`,
"Move paper-related to separate dir") and took the release gate with it. Six documents still cite
it by name — `README.md`, `CHANGELOG.md`, `ISSUES.md`, `docs/DEPLOYING.md`, `docs/DOCS-PLAN.md`,
`docs/EVALUATION.md` — and a reader of the shipped repository can follow none of those citations.
The route to a preprint stays with the manuscript. The route for the package is here.

Two facts order everything below: **publication is gated on disclosure, and nothing else is.**
Section 1 is a chain. Sections 2–6 are independent of it and of each other.

---

## 1. The critical path to `0.1.0`

### 1.1 Disclosure — the only true blocker, and the clock has not started

[`docs/upstream/DISCLOSURE.md`](docs/upstream/DISCLOSURE.md) is a tracking file with four boxes.
All four are empty:

```
- [ ] U1 submitted privately — date:
- [ ] U1 response received — date:
- [ ] U1 public issue filed (only if no response by 2026-08-29) — date:
- [ ] U2 public issue filed — date:
```

Both reports are written and ready to paste (`docs/upstream/U1-no-write-access-control.md`,
`docs/upstream/U2-restart-does-not-restore-games.md`). The wait-until date of **2026-08-29** has
passed, but nothing was ever submitted — so the two-week courtesy period never began. The date is
stale, not expired, and the distinction is the whole of what to do next: submit, then re-date from
the day of submission.

Order, from `DISCLOSURE.md` and `ISSUES.md:37`:

1. **U1 with U10, privately**, through GitHub's advisory form. U10 travels with U1 rather than
   separately: same repository, same maintainer, and one of the two is a security report already.
2. **U2 publicly, now.** "There is no reason to hold it behind U1" (`DISCLOSURE.md:40`). It is the
   cheapest open item in this repository and it is blocked by nothing.
3. **U3–U6 batched later**, and only if U1 or U2 draws a reply — sending six at once to a quiet
   repository is how a report gets ignored (`DISCLOSURE.md:48`).

*Done when:* the four boxes carry dates, and the wait-until date is reset from the day U1 was
actually submitted.

### 1.2 The API freeze, which has no definition inside this repository

`CHANGELOG.md:8` makes the freeze a precondition for the changelog meaning anything — "the API
freeze is what makes the entries below meaningful as a baseline rather than a moving target" — and
points at `PUBLICATION-PLAN.md` §2, which is not here. `ISSUES.md:14` already treats the freeze as
in force ("the API-coherence items that were free before the freeze and breaking after it"), so
the package is being governed by a rule it does not state.

The surface itself is in the repository and needs no reconstruction: the `exports` map at
`package.json:12-50` (ten entry points), described export by export in `docs/API.md` and checked
against `dist` by `npm run check:docs`.

*Done when:* this repository says what is frozen and what "breaking" means for it — one section,
in `docs/CONTRIBUTING.md`, which already has a releasing section — and `[Unreleased]` in the
changelog can honestly be renamed `0.1.0`.

### 1.3 Publishing mechanics, none of which exist

- `"private": true` at `"0.0.0"` (`package.json:3-4`), deliberately: it is "the only thing standing
  between a stray `npm publish` and a published package with an unpatched upstream hole in it"
  (`README.md:56`).
- ~~No `repository` field, and no git remote (`docs/DOCS-PLAN.md:456`).~~ Fixed 2026-09-11: a
  remote now exists, and `package.json` carries `repository`, `author`, `homepage` and `bugs`.
- No release workflow. `.github/workflows/` is `ci.yml`, `drift.yml`, `perf.yml` — nothing
  tag-triggered, no `npm publish` anywhere.
- Every install instruction goes through `npm pack` and a `file:` tarball (`README.md:67`). That
  path exists to dodge the two-copies-of-`@empirica/core` trap (`docs/TROUBLESHOOTING.md` §1), and
  it stops being the recommended path the day the package is on npm.

*Done when:* a tagged release publishes from CI, and `README.md` and `docs/GETTING-STARTED.md`
install with `npm install empirica-networks` — keeping the tarball route only as the
install-from-source instruction.

---

## 2. Defects that are ours

Three O-numbers are open (`ISSUES.md`, where an unstruck `###` header means open):

| | State | Done when |
|---|---|---|
| **O1** — bench figures are single runs and upper bounds (debt) | `ISSUES.md:253`. Narrowed twice. The specification became executable on 2026-09-11 — `--clients` puts the participants on a second machine, `--absolute` refuses a sweep that could not produce an absolute figure — so what is left is **hardware, not code** | A pinned bare-metal Linux host and a second machine for the clients run `npm run bench -- --clients HOST:PORT --absolute --repeats 3`, and the figure is recorded in `docs/PLATFORM-NOTES.md` §21 |
| **O3** — `restart_full` asserts conditionally | `ISSUES.md:375`. Blocked, not stalled | U2 is resolved and the `if (!restored) return;` branch is removed (`ISSUES.md:381`) |
| **O4** — late-joiner provisioning is a net under a path we could not construct | `ISSUES.md:383`. One real defect inside it was fixed; on 2026-09-11 the path stopped being silent — `net.stats().lateProvisioned` counts it, the soak reports it, and the first datum (n=20, one minute, real Classic) is zero | The platform path is reproduced — `docs/PLATFORM-NOTES.md` §20 says where to look — or `lateProvisioned` is zero across a real deployment, which is now the first thing to read off one |

Four smaller gaps carry no O-number and are named here so they are not mistaken for covered:

- **Channel index is not rebuilt after a restart** (`src/admin/provision.ts:62`). Recovery is
  possible — nbhd scopes carry immutable owner/playerID attributes — and is not implemented. Moot
  while U2 stands, since no game resumes anyway; it becomes the next obstacle the day U2 is fixed.
- **Monitor coverage residue** (`ISSUES.md:1190`): the tooltip's positioning arithmetic, the game
  picker, and every colour claim in the palette comment.
- **`views.csv`** remains open under M2 decision 5 (`ISSUES.md:1512`).
- ~~**The leak checker knows one topology.**~~ **Done 2026-09-11.** `topology` now takes a name or
  the study's own generator, and what a run can establish is computed from the realised graph
  (`src/verify/topologies.ts`). Found and fixed in passing: `--topology` had been reported as
  honoured while being ignored — `ISSUES.md` O16.

---

## 3. Upstream: watch, do not wait

U1, U2, U7, U8, U9 and U10 are open and none is fixable here (`CHANGELOG.md` → Known).
`drift.yml` already watches the four version-fragile contracts weekly and re-runs the tests pinned
to U8 and U9, so an upstream fix announces itself rather than being discovered. Beyond §1.1 there
is no work in this section — it is listed so it is not mistaken for work.

---

## 4. `simulate` — a complete build spec with nothing built

[`docs/EVALUATION-RUNBOOK.md`](docs/EVALUATION-RUNBOOK.md) is a step-by-step spec written to be
handed to someone who has not worked on this package. None of the six files it names exists:
`src/verify/simulate.ts`, `src/verify/audit.ts`, a `simulate` command in `src/verify/cli.ts`,
`scripts/simulate.mjs`, the `"simulate"` npm script, `test/unit/audit.test.ts`. Its own estimate is
about five days, with the browser hybrid (§9) a separate week and out of scope.

It belongs on the package's list and not only the paper's, for one reason: it is the only thing
that would run the shipped example at the design's own n, across arms, for the real duration, and
**keep the output** instead of asserting on it and deleting it (`docs/EVALUATION.md:40`). Every
existing tier throws its sessions away.

Not release-blocking. `docs/EVALUATION.md:94` keeps the real deployment off the critical path and
says plainly that it is not scheduled.

---

## 5. Documentation: one item, and it cannot be brought forward

`docs/DEPLOYING.md` is a stub that says deployment is undocumented and untested, which is the
honest state — nothing here has ever been run with real participants. `docs/DOCS-PLAN.md:460`:
"Item 10 remains, and cannot be brought forward." The real document has to be written *while*
deploying, dated and versioned like `PLATFORM-NOTES.md`; `docs/DEPLOYING.md` §3 lists the seven
things it must cover, so whoever writes it does not start from a blank page. The deployment itself
is `PUBLICATION-PLAN.md` §3, outside this repository.

One smaller item: the R/Python analysis path in `docs/DATA-AND-ANALYSIS.md` is written and marked
as not walked end to end (`docs/DOCS-PLAN.md:429`). Walking it once is an afternoon and does not
depend on anything above.

---

## 6. Test and CI gaps

Each is deliberate; none is free.

- **The browser tier does not run in CI.** `test/browser/two_windows.ts` and
  `test/browser/monitor_page.ts` exist and run only by hand (`npm run test:browser`); `ci.yml`
  never invokes it. That is the tier covering the React client, the browser websocket, and the
  monitor page — the half `simulate` explicitly cannot reach (`docs/EVALUATION-RUNBOOK.md` §1).
  *Done when:* it runs on a schedule, weekly beside `drift.yml` if per-PR is too slow.
- **Performance is recorded, not gated** (`perf.yml:116`). Correct as it stands — O1 is the reason
  a shared CI runner cannot produce an absolute figure — and it means a regression is visible only
  to someone who looks.
- **The e2e tier has a known flake rate** (O8, fixed as a harness defect, with residue).
  `npm run test:repeat` measures the rate; `docs/TESTING.md` §4 says how to read a red run.

---

## 7. Hygiene, found while writing this

- ~~**Dangling citations.**~~ Fixed 2026-09-11 in every user-facing document: `README.md`,
  `CHANGELOG.md`, `ISSUES.md`, `docs/API.md`, `docs/GETTING-STARTED.md`, `docs/DEPLOYING.md` and
  `docs/CONTRIBUTING.md` no longer cite `PUBLICATION-PLAN.md` bare — each site now points at
  `NEXT_STEPS.md`'s equivalent section, or, for the deployment citation, says plainly that the
  document lives outside this repository. The process records (`docs/DOCS-PLAN.md`,
  `docs/EVALUATION.md`, this file) still cite it bare, which is fine — a reader of those already
  knows to expect that, per `docs/README.md`'s own distinction between user documentation and
  process records.
- ~~**`ISSUES.md` reused two numbers.**~~ Fixed 2026-09-11: the earlier, M5-era entries that had
  collided with M6's O12 and O13 are renumbered O17 (`Data written only at game end`) and O18
  (`The offline export helpers could not be imported offline`); every citing document was updated
  to match.
- **`examples/rand2011/recover.mjs` carries the hazard fixed in `shirado2017` on 2026-09-11.** It
  imports an ESM `server/src/design.js` from a package with no `"type"`, which is fatal below Node
  20.19 and merely warns above it (`docs/BOTS.md` §7). The fix is the `.mjs` extension.

---

## Not in this file

The paper. `PUBLICATION-PLAN.md` and `PAPER-OUTLINE.md` moved to the manuscript's working
directory on 2026-08-25, and `docs/EVALUATION.md` is the part of that plan which stays, because
what the platform has to prove is a fact about the platform.

---

**If only one thing gets done:** submit U1 privately and file U2 publicly. It is an afternoon, it
is the only item everything else in §1 waits on, and the two-week clock cannot start until it
happens.
