# Docs plan — building out the documentation

Written 2026-08-16, after reading every file in `docs/`, the README, the three example READMEs,
`ISSUES.md`, and both CI workflows. Written before the docs, so the shape is a decision rather
than an accretion — the same discipline `docs/M5-ADOPTION.md` §5 used, and this plan is that
plan's successor.

The short version: **the docs are good at the two things the project has actually done, and
absent on the two things it has not.** What has been *built* (the mechanism, the guarantee, the
traps) is documented to an unusually high standard. What has been *run* (a real deployment) and
what has been *read* (the internals, by anyone who is not the author) have no document at all.

> **Status — Phases A, B and D complete, 2026-08-16.** Everything in this plan is now written
> except Phase C, which cannot be: it requires a real deployment and real data
> (`PUBLICATION-PLAN.md` §3).
>
> Written: `LICENSE`, `CITATION.cff`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`,
> [API](API.md), [ARCHITECTURE](ARCHITECTURE.md), [TROUBLESHOOTING](TROUBLESHOOTING.md),
> [DATA-AND-ANALYSIS](DATA-AND-ANALYSIS.md), [TOPOLOGIES](TOPOLOGIES.md),
> [DEPLOYING](DEPLOYING.md) (a stub, deliberately), [CONTRIBUTING](CONTRIBUTING.md),
> [TESTING](TESTING.md), [GLOSSARY](GLOSSARY.md), [the index](README.md), the README cut from 953
> to 270 lines, and two CI checks.
>
> Of the four gaps in §1: **1, 3 and 4 are closed.** **2 is *stated* rather than closed** —
> deployment is still undocumented, and the deliverable so far is a file that says so where
> someone planning a study will find it.
>
> §1's assessment below is left as written, because it is what the plan was reasoning from; §6
> carries the current state.

---

## 1. What exists, honestly assessed

| Document | Lines | Job it does | Does it do it? |
|---|---|---|---|
| `README.md` | 867 | Front door, U1 warning, install, API reference, envelope | **Yes, and too much.** It is three documents in a trench coat |
| `docs/GETTING-STARTED.md` | 292 | Ordered path: install → mandatory edit → private state → verify → export | **Yes.** The strongest file in the repo. Do not touch it except to add links |
| `docs/EXPERIMENTS.md` | 129 | The two reconstructions; reconstruction ≠ replication | Yes |
| `docs/PLATFORM-NOTES.md` | 748 | Every platform constraint, measured, dated, versioned | Yes — but it is a *lab notebook*, and it is being used as a user manual by everything that links into it |
| `docs/M5-ADOPTION.md` | 401 | Milestone decisions and the trap audit | Yes — explicitly not a user document |
| `docs/M6-HARDENING.md` | 540 | Milestone plan, partly executed | Yes — same |
| `docs/upstream/*` | 334 | Disclosure drafts and the disclosure checklist | Yes, and correctly kept apart |
| `examples/*/README.md` | 3 files | Per-experiment design, deviations, data, tests | Yes. Strong. The rand2011 one is a model for the rest |
| `ISSUES.md` | 548 | Known defects, ours and upstream's | Yes |

Roughly 3,900 lines of markdown, and it is **densely correct**. The problem is not quality; it is
that five of the nine entries above are process records rather than documentation, and the two
that are documentation carry everything else on their backs.

### The four gaps, in order of how much they cost

**1. Nothing explains how the package works internally.** `MODULE-DESIGN.md` — the design record —
is deliberately kept outside this repo, "alongside the investigation that produced it". Eight
places link to it. A reader who clones the repo therefore cannot follow any of those links. There
is no in-repo answer to: what is a channel, how does one get provisioned, what runs when a
participant connects, where does a projection actually get written, how does the client mode
learn about it, what enforces the envelope. That is the single largest gap and it blocks three
distinct audiences at once — a contributor, a JOSS reviewer, and the author in six months.

**2. Deployment is not documented anywhere. At all.** Grepping the whole repo for
*deploy | production | host | mturk | prolific | recruit | nginx | docker* returns eleven hits,
of which ten are about something else and one is the monitor's bind address. Every runnable
instruction in every document ends at `empirica` on localhost with four `?participantKey=` URLs.
There is no path from there to a study with real participants: no bundling, no hosting, no TLS,
no recruitment links, no batch configuration, no backup of the store, no retention decision, no
pre-flight check, no what-to-do-when-it-crashes procedure (and given U2, that procedure is
unusually load-bearing).

**3. The README is doing three jobs and is too long for any of them.** 867 lines, 33 code blocks.
It is simultaneously the front door, the security disclosure, and the complete API reference. A
newcomer meets the API reference by scrolling; someone looking up `maxNeighbourhoodBytes` meets
the U1 essay first.

**4. There is no symptom-first index.** This package's entire subject matter is *silent failure* —
the phrase "silently" appears throughout, and both traps found during M5 presented identically as
"a listener or a read that does nothing". Yet a person whose participants are stuck on "Waiting
for other players" has to already know that the answer is PLATFORM-NOTES §11 to find it. The
knowledge is all written down and it is indexed by *cause*, which is the order you can only use
once you already know the answer.

### Four smaller findings

- ~~**No `LICENSE` file**, though `package.json` says MIT~~ — **added 2026-08-16.** It was a
  straight defect: a repo that claims MIT in metadata and ships no license text is not
  MIT-licensed in any way a careful adopter's institution will accept. Still missing:
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CITATION.cff`, `CHANGELOG.md` — all on the JOSS
  review checklist named in `PUBLICATION-PLAN.md` §5.
- **The "not published yet" caveat is copy-pasted into at least five places**, each with its own
  wording of the `npx empirica-networks …` / `node dist/verify/cli.cjs …` duality. At publish
  time every one of them has to be found and edited, and the M5 retrospective already records one
  round of that going wrong (§8 item 3).
- **No glossary.** *Channel, projection, view, nbhd, kind, scope, told, envelope, run log, the
  seating plan* are all used as terms of art, defined once in passing, in different files.
- **No code snippet in any document is executed or typechecked by anything.** In a repo whose
  own retrospective concludes that "an example whose behaviour is *asserted* found three real
  bugs; an example whose behaviour is *described* would have shipped all three", the docs are
  entirely in the second category.

---

## 2. What the buildout is for

Four audiences, currently served by one document each at best:

| Audience | Wants | Has today |
|---|---|---|
| **Researcher adopting the package** | Get a design running correctly; know what will bite | GETTING-STARTED — well served |
| **Researcher *running* a study** | Deploy it, watch it, get the data out, survive a crash | **Nothing** |
| **Analyst, months later** | What files exist, what the columns mean, how to reproduce the run | Fragments in three files |
| **Contributor / reviewer / future maintainer** | How it works inside, how to build and test it, how to release | README §Development, 25 lines |

The plan below adds documents for rows 2–4 and thins row 1's front door.

---

## 3. The documents to write

Nine new files, two splits, and a set of cross-cutting fixes. Each entry gives the job, the
outline, **where the facts come from**, and what has to be true before it can be written honestly.

### 3.1 `docs/ARCHITECTURE.md` — how the package works *(new, highest value)*

The in-repo internals map. Not a copy of `MODULE-DESIGN.md`: that record is organised by
*decision and its reasoning* and belongs where it is. This is organised by *mechanism*, for
someone reading the source.

Outline:

1. **The one-paragraph model** — participant = node; each participant owns a private channel
   scope; the server writes projections there and nowhere else; the realised graph and its seed
   live on the batch scope, which participants cannot read.
2. **Module map** — a table of `src/*` to responsibility, with the entry-point rule from
   `src/index.ts` (why admin/player/react are deliberately not one barrel) stated up front.
3. **The lifecycle, end to end** — server start → `assertKindsRegistered` → duplicate-listener
   calibration → game start → topology realised from seed → channels provisioned → first publish
   → participant connects → mode installs → `useNeighbors()` resolves. One numbered walkthrough
   naming the file and function at each step.
4. **The publish path** — what triggers a republish (`watch` keys, rewiring, `tell`), how
   `project()` is called per (viewer, neighbour) pair, `validateProjection`, envelope check,
   write to channel, `ephemeral`.
5. **Where every piece of data lives, and why** — the table that currently exists per-example
   (`examples/rand2011/README.md` §"Where each value lives") generalised: player scope
   (broadcast), game scope (broadcast, §4b), batch scope (server-only), private channel
   (one participant), run log, view sink.
6. **The client half** — the mode as a superset of `EmpiricaClassic`, the `dones` protocol and
   why it is version-fragile, hook resolution and the `undefined` vs `[]` distinction.
7. **Determinism** — seed → `makeRng` → topology → recorded on batch → reproducible offline.
8. **The four version-fragile upstream contracts**, lifted from `.github/workflows/drift.yml`,
   which is currently the only place they are enumerated for a reader.

Sources: `src/admin/with_network.ts`, `provision.ts`, `projection.ts`, `envelope.ts`,
`kinds.ts`, `listeners.ts`, `views.ts`, `src/player/mode.ts`, `state.ts`, `view.ts`,
`drift.yml`, and `MODULE-DESIGN.md` for the reasoning to summarise and cite.

Constraint: it must say, per claim, whether the behaviour is pinned by a test, and name it.
An architecture doc that drifts is worse than none, and the only defence available here is the
same one the rest of the repo uses — point at the witness.

### 3.2 `docs/DEPLOYING.md` — from localhost to real participants *(new, and the one that cannot be faked)*

Outline:

1. **Pre-flight checklist** — the mandatory kind registration, `verify` passing on the
   deployment host, every private key declared, `views:` on if `project()` transforms anything,
   payoffs on the batch scope (U1), a dry run at the real `n`.
2. **Bundling and serving** — the Empirica CLI's production path, with the exact commands and
   versions used, recorded the way PLATFORM-NOTES records things.
3. **Hosting shape** — process supervision, TLS termination, websockets through a proxy,
   what the store file is and where it lives.
4. **Recruitment** — participant identification, the `?participantKey=` link structure, batch
   and treatment configuration, lobby behaviour, and what a participant who reloads sees.
5. **Running the monitor safely** — SSH tunnel rather than `host: 0.0.0.0`, restated from the
   README's warning, in the place where the temptation actually occurs.
6. **Backups and the crash procedure** — what to copy and how often; and then the honest part:
   **U2 means a crashed study cannot be resumed.** Games in progress end. Document how to detect
   it, how to salvage the data that exists, and how to decide whether to re-run.
7. **Data retention and ethics** — what is stored where, what leaves the server, what U1 means
   for an IRB protocol and for what you should choose to collect at all.
8. **Scale in production** — the envelope table, restated with the deployment-side variables
   (bandwidth per participant = degree × projection size), and the n ≥ 200 wall.

**This document cannot be written from the source. It has to be written while doing it.**
Nothing in this repo has ever been deployed — `PUBLICATION-PLAN.md` §3 says no data has been
collected with either reconstruction. Writing a deployment guide by reading Empirica's docs and
inferring would produce exactly the hazard `docs/M5-ADOPTION.md` §1 calls H-A: instructions that
look right, have never been run, and fail on someone else's study.

So this document is **coupled to `PUBLICATION-PLAN.md` §3** and should be written as its
by-product: run one reconstruction with real participants, and write down what you actually did,
dated and versioned like PLATFORM-NOTES. Until then, ship a short **`docs/DEPLOYING.md` stub that
says plainly that deployment is undocumented and untested**, listing the known-hard parts (§6,
§7 above). A stub that admits the gap is worth more than a plausible guess, and it is consistent
with how the rest of this repo treats unmeasured claims.

### 3.3 `docs/TROUBLESHOOTING.md` — symptom → cause → fix *(new, cheapest high-value item)*

A lookup table indexed by *what you observed*, which is the only key a stuck person has. Almost
pure re-indexing: every row already exists somewhere, written well.

| Symptom (verbatim, as it appears on screen) | Cause | Where |
|---|---|---|
| Everyone stuck on "Waiting for other players" with a full game; zod stack traces | Two copies of `@empirica/core` from a `file:` install | PLATFORM-NOTES §11, GETTING-STARTED §2 |
| Empty neighbourhoods forever, nothing errors | `networkKinds` not registered | PLATFORM-NOTES §6 |
| A read returns `undefined` and the manipulation does nothing | Undeclared key; use `stateOf()` not `inspect()` | ISSUES O11, GETTING-STARTED §4 |
| The second `onStageEnded` never runs | U8, one registration per lifecycle event | PLATFORM-NOTES §18, ISSUES U8 |
| A mutation from a timer reaches nobody | Writes only count inside a callback | PLATFORM-NOTES §15 |
| `useNeighbors()` is `undefined` | Before first publish; `[]` means isolated | GETTING-STARTED §5 |
| Everyone can see a value they should not | Written with `player.set()` | GETTING-STARTED §5 |
| e2e suite red on a rotating victim, "gameID assigned" timeout | Orphaned harness servers / whole-run weight | ISSUES O6, O8, M6 Tier 4 |
| A restart brought the server back but no game resumed | U2 | ISSUES U2 |
| Games do not start at n ≥ 200 | U7 | ISSUES U7 |
| An offline analysis script dies on import | §3a; use `empirica-networks/export` | PLATFORM-NOTES §3a |

Rule for the table: **one row per observable symptom, linking out rather than restating**, so it
cannot drift from the authoritative text. Add a row every time someone hits something — this is
the file that should grow fastest.

### 3.4 `docs/API.md` — the reference, extracted from the README *(split)*

Move the API reference out of the README. Keep the README as a front door of roughly 150 lines:
what it is, the U1 warning, install, a 30-line quickstart, the envelope summary, and a table of
pointers.

**Hand-written, not generated** — M5 §5 rejected type-generated reference docs because "the
hand-written one carries the *reasons*, which is what makes it worth reading". That judgement
holds and this is a move, not a rewrite. Organise by subpath, matching `exports` in
`package.json`, so a reader's import line tells them which section to open:
`empirica-networks/admin`, `/admin/monitor`, `/player`, `/player/react`, `/topology`,
`/topology/graphology`, `/export`, and the root.

Each entry: signature, what it does, the trap if it has one, and a link to the test that pins it.

**Sequencing note.** This is the one document with a hard dependency on `PUBLICATION-PLAN.md` §2,
the API freeze. Doing it before the freeze means writing it twice; doing it as *part of* the
freeze is nearly free, because the freeze requires enumerating the surface anyway. **Fold §3.4
into the freeze.**

### 3.5 `docs/TOPOLOGIES.md` — the generator catalogue *(new, small)*

Fifteen generators in `src/topology/index.ts` and no reference table anywhere. One row each:
signature, parameters, whether it is deterministic without an `rng`, whether it guarantees
connectivity, degree distribution in one phrase, and the paper it comes from where there is one
(Watts–Strogatz, Barabási–Albert, Erdős–Rényi). Plus the analysis helpers (`adjacency`,
`degrees`, `meanDegree`, `maxDegree`, `components`, `isConnected`) and the graphology bridge with
its `UndirectedGraph`-not-`Graph` warning.

Could live inside `docs/API.md`. Argument for a separate file: this is the part a researcher
reads while *designing* a study, not while writing code, and it is the section most likely to be
read alone.

### 3.6 `docs/DATA-AND-ANALYSIS.md` — what a run produces *(new)*

Currently split across README §Exporting, GETTING-STARTED §9, and each example's §"The data it
writes". Consolidate into one document that starts from "the study is over, what do I have":

1. **The inventory** — the Tajriba store, `edges.csv`, `snapshots.csv`, `views.ndjson`, the run
   log, and what is *not* recoverable (anything `ephemeral` and uncaptured).
2. **Column-by-column schemas** for each row type — `EdgeRow`, `SnapshotRow`, `ViewRow` — as
   tables, with the units and the meaning of `t`.
3. **Views: why you must turn capture on before the run.** Restate the "could have known" vs
   "was told" distinction — it is the sharpest idea in the export design and it is currently a
   paragraph in GETTING-STARTED §9.
4. **Reproducing a finished run** from the recorded seed and topology, offline.
5. **Into graphology / networkx / igraph** — the bridge, plus a plain-CSV path for people who
   do not work in JS. Most network researchers analyse in R or Python; the docs today assume JS.
6. **Recovery scripts** — what `examples/*/recover.mjs` do. (The caveat that Shirado's left
   `edges.csv` empty was fixed in M6 Tier 4; both examples now recover every table byte-identically,
   which is the more useful thing to document.)
7. **The `empirica-networks/export` subpath and why it exists** (§3a) — at the top of any
   offline script.

### 3.7 `docs/CONTRIBUTING.md` + `docs/TESTING.md` — build, test, release *(new; expands README §Development)*

Split because they have different readers: the first is "I want to change this", the second is
"why is the suite red".

`CONTRIBUTING.md`: repo layout; prerequisites (Node 20+, Empirica CLI); `npm run build` and what
tsup emits, including why the `bin` is CJS; `npm run check`; the entry-point rule (never
re-export admin from the root barrel, and why); how to add a topology generator, a hook, or a
config field, each with the test tier that must accompany it; the docs conventions this plan
sets; the release process once published.

`TESTING.md`: the three tiers and **what each one can and cannot prove** — unit (pure logic, no
server), mode (synthetic `TajribaProvider`, the tier that catches a `dones` break), e2e (real
Tajriba, the tier that proves the guarantee); the `verify` CLI and its three arms and why all
three are required; `scripts/*.mjs` one line each (`test`, `e2e-one`, `test-browser`,
`example-install`, `bench`, `soak`, `ceiling`); the orphan sweep and O8's "read a red run in the
right place" procedure, promoted out of M6 where it is currently buried at the bottom of a
milestone plan; both CI workflows, especially **drift.yml**, whose header comment is the best
short explanation in the repo of what is version-fragile and is invisible to anyone not reading
`.github/`.

### 3.8 `docs/GLOSSARY.md` *(new, small)*

Channel, projection, view, neighbourhood/`nbhd`, scope, kind, mode, told, envelope, run log,
seating plan, sentinel, reconstruction (vs replication), realised topology. One or two sentences
each, each linking to the section that develops it. Cheap, and it makes every other document
shorter.

### 3.9 Repository hygiene files *(new, small, blocking for JOSS)*

`LICENSE` (MIT text — a straight defect today), `CITATION.cff`, `CHANGELOG.md` (starting at the
first published version), `CODE_OF_CONDUCT.md`. Named here because `PUBLICATION-PLAN.md` §5
targets JOSS and these are checklist items there, not because they are interesting.

---

## 4. Cross-cutting fixes

**Single-source the "not published yet" caveat.** One canonical paragraph in the README's
Installing section; everywhere else links to it. At publish time that is one edit instead of a
search. The M5 retrospective already records this going wrong once.

**Decide what PLATFORM-NOTES is.** It is a lab notebook — 748 lines, ordered by discovery, with
✅/⚠️ markers and measurement dates — and eighteen links from user-facing documents send
researchers into it. That is not a bug in either document; it is a missing layer. Adding
TROUBLESHOOTING (§3.3) and ARCHITECTURE (§3.1) supplies the layer: after they exist, user docs
link to *them*, and PLATFORM-NOTES becomes what it is — the evidence, cited rather than
delegated to.

~~**Retire the milestone docs from the docs index.** Move them to `docs/decisions/` so `docs/` is
browsable as documentation.~~ — **abandoned on the count, 2026-08-16.** `M5-ADOPTION` and
`M6-HARDENING` have **52 inbound references across 27 files**, and they are not all markdown:
`src/admin/with_network.ts`, `src/admin/sink.ts`, `src/shared/keys.ts`, seven test files and
three example files all cite them by path in comments. Moving the files means editing source
comments for a documentation reorganisation, immediately before an API freeze, with a missed
reference silently becoming a dead path.

The actual goal was *a browsable `docs/` where process records are clearly not user
documentation*, and the index below achieves that on its own by filing them under a heading that
says so. Recorded rather than dropped, because "the tidier layout costs 52 edits into source
comments" is the kind of thing that gets re-proposed every six months.

**Add `docs/README.md` as an index**, with the four audiences from §2 as the top-level cut.
**Done 2026-08-16.**

**Make the snippets executable.** This is the recommendation with the most leverage and it is
the repo's own methodology turned on its docs. Options, cheapest first:

1. A `docs/snippets/` directory of real `.ts`/`.tsx` files that `npm run check` typechecks, with
   documents including them by reference rather than inlining prose copies.
2. A script that extracts fenced ```js/```jsx/```ts blocks tagged for checking and typechecks
   them against the built `dist/`, wired into CI.
3. Full doc-tests — extract and *run* the admin snippets against the e2e harness.

Recommend (2), plus (1) for the long examples. It catches the failure that actually happens here:
an API moves, and a snippet keeps compiling in a reader's head. Full doc-tests are not worth the
harness weight given e2e already imports every example's real `callbacks.js` unmodified.

**Add a link checker to CI. Done 2026-08-16** — `scripts/check-links.mjs`, `npm run check:links`,
one CI step on Node 22 only. Relative paths and section anchors; never external URLs, which would
make a green run depend on other people's uptime. 68 links across 21 files, 0 broken at the time
of writing.

Two implementation notes worth keeping. It skips fenced code blocks, because an illustrative
`[label](path)` inside an example is not a link this repository is promising to keep working. And
it reproduces GitHub's duplicate-heading suffixing (`-1`, `-2`), which is what makes
PLATFORM-NOTES' two `## 9.` sections both linkable — the anchors are exactly what rots here,
since sections are numbered by discovery order and therefore renumber.

---

## 5. What not to write, and why

- **Generated API docs from types.** Rejected at M5 and still right: the reasons are the content.
- **A tutorial series.** GETTING-STARTED is one ordered document that works; four overlapping
  ones would be worse. §3.6 and §3.2 are new *phases* of the work, not re-tellings of the same one.
- **A documentation site** (Docusaurus / Starlight / mkdocs). Not before publication. Markdown in
  the repo is readable on GitHub, reviewable in a PR, and greppable; a site adds a build, a
  deploy, and a second place for things to be stale. Revisit if adoption ever makes the flat
  file list the binding constraint.
- **A template repo.** Rejected twice already (M5 §2, M6 "Not doing"). Nothing here reopens it.
- **A Breadboard migration guide.** No Breadboard study code exists to migrate; the relationship
  is conceptual. Already settled in `PUBLICATION-PLAN.md` §3.
- **Deployment instructions inferred from Empirica's docs.** See §3.2. A stub that admits the gap
  beats a plausible guess, and this is the document where a plausible guess does the most damage.

---

## 6. Sequencing

Grouped by dependency, not by value.

**Phase A — now, no dependencies. Complete 2026-08-16.** Nothing here can be invalidated by the
API freeze.

1. ~~`LICENSE` (defect)~~ **done**. The other hygiene files (§3.9) are still open.
2. ~~`docs/TROUBLESHOOTING.md` (§3.3)~~ **done** — cheapest, highest immediate value.
3. ~~`docs/ARCHITECTURE.md` (§3.1)~~ **done** — the largest single gap.
4. ~~`docs/GLOSSARY.md`, `docs/README.md` index, link checker (§4)~~ **done**. The milestone-doc
   move was abandoned on the count — see §4.
5. ~~`docs/DEPLOYING.md` **as a stub** (§3.2)~~ **done** — the honest placeholder, so the gap is
   visible to anyone considering a real study on this.

**Phase B — done 2026-08-16, ahead of the freeze rather than with it.**

6. ~~`docs/API.md` extracted, README cut to a front door (§3.4)~~ **done.** README 953 → 270
   lines — 953, not the 867 in §1's table, because Phase A added links to it before this cut
   removed most of the file. The plan wanted this folded into the freeze to avoid writing it
   twice; doing it first turns out to *help* the freeze, because enumerating the surface is most
   of the freeze's work and the page is now the list to sign off. It carries a banner saying it
   needs a read-through at freeze time.

   Against the §7 target of "under 200 lines", the README is 270. The overshoot is the U1 warning
   (~30 lines, and it belongs at the top of the front door) and the envelope evidence (~45 lines,
   the only copy of the sparse bench table). Both were judged worth keeping over hitting a number.
7. ~~`docs/TOPOLOGIES.md` (§3.5)~~ **done** — as its own file rather than folded into API.md,
   for the reason §3.5 gave: it is read while designing a study, not while writing code.
8. ~~Snippet checking in CI (§4)~~ **done, and narrower than option (2).** See below.
9. ~~Single-source the publish caveat (§4)~~ **done** — one block in the README's Installing
   section, with an anchor, and everything else links to it.

**On item 8, because the plan's recommendation was not what shipped.** The plan recommended
extracting fenced blocks and typechecking them. Attempting it made the objection obvious: most
snippets are *fragments* by design — `state.set("choice", "A")` with no surrounding component is
the clearest way to show that line — and rewriting them into compilable programs would make them
worse documentation in order to catch errors.

What actually goes stale is narrower: **the import line.** `net.games()` became
`net.activeGames()`; the export helpers moved to their own subpath; `EdgeRow` stopped being an
interface. So `scripts/check-docs-api.mjs` extracts every `import { … } from "empirica-networks/…"`
in every fenced block and resolves it against the **built** `.d.ts` — 48 imports today, and it
catches both an unknown subpath and a name that is no longer exported. It runs in the `e2e` job,
which is the one that already builds.

The general form: **check the part that can be wrong without looking wrong.** A fragment that
stops compiling is visible to a reader; a renamed export is not.

**Phase C — needs a real deployment.**

10. `docs/DEPLOYING.md` for real, written *while* deploying, dated and versioned like
    PLATFORM-NOTES. The stub from Phase A lists what it has to cover.
11. ~~`docs/DATA-AND-ANALYSIS.md` (§3.6)~~ — **done.** Only one part of it genuinely needed real
    data: the R/Python path, which is written and **marked as not walked end to end**. The rest is
    schemas and file inventory, which are code facts. The run log living in the package rather
    than in each example is what gives one answer to "what does a run produce" instead of three.

    The generalisable rule: **defer the paragraph that needs the measurement, not the document
    that contains it.** §3.2 is the case where the whole document really is unmeasured, which is
    why it is a stub rather than a draft with warnings.

**Phase D — done 2026-08-16.**

12. ~~`docs/CONTRIBUTING.md` and `docs/TESTING.md` (§3.7)~~ **done**, along with the remaining
    hygiene files from §3.9: `CITATION.cff`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`.

    Two notes. `CITATION.cff` has **no `repository-code`** — the repository has no git remote, and
    a plausible-looking URL that 404s is worse than an absent field. And `CHANGELOG.md` opens with
    an `[Unreleased]` section that says plainly nothing has been released, rather than
    back-dating milestone work into version numbers that never existed.

**Item 10 remains, and cannot be brought forward.** It needs a deployment that has actually
happened, which is off the critical path (`docs/EVALUATION.md` §6). Everything else in this plan
is written.

ARCHITECTURE and DATA-AND-ANALYSIS are written against the full M6 surface — `read`, `stateOf()`,
`log:`, `onPrivateState`, `activeGames()`, `GameRef` and the reworked envelope all included.
Documenting a shape while it is still moving is the hazard here, and the answer is to let it
settle first.

## 7. Done-when

- A researcher can go from `empirica create` to a deployed study with real participants using
  only documents in this repo — **or** the repo says plainly, at the point where they would look,
  that it cannot yet take them there.
- Someone who has never read the source can explain the publish path from `docs/ARCHITECTURE.md`.
- Every symptom in §3.3's table is findable from the symptom, in one hop.
- Every code snippet in every document is checked by CI, or is explicitly marked as illustrative.
- No user-facing document requires reading a milestone plan or a file outside the repo.
- The README is under 200 lines and links to everything else.
