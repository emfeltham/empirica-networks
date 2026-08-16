# M5 — adoption: decisions, docs plan, and the trap audit

*Written 2026-08-15, before the docs and the ported experiments, so the reasoning is on record
rather than reconstructed afterwards.*

M1–M4 made the mechanism **safe by construction**. M5 has to make it **legible**, because from
here the person hitting a trap is not the person who documented it. Structure and tests do not
travel into a copy; prose does.

---

## 1. The three failure modes this milestone is defending against

In descending order of how much damage they do.

### H-A. A port that runs but silently deviates from the published design

Put one value on the player scope instead of the private channel and it is broadcast to every
participant. The experiment still runs, the screens still look right, and the manipulation is
gone. That is `SPIKE-REPORT.md` §2 and PLATFORM-NOTES §4a/§4c, and an example that embodies it
becomes a template for invalid studies at whatever rate people copy it.

This milestone has a concrete instance of it, which is worth stating because it is not
hypothetical. **Rand 2011 and Nishi 2015 differ by one field in `project()`.** Rand's subjects
see their neighbours' cooperation decisions and *not* their wealth; Nishi's "visible" condition
adds exactly that one field, and its whole result is the difference. So:

```js
// Rand, Arbesman & Christakis 2011
project: (n, v, ctx) => ({ id: n.id, action: ctx.stateOf(n).get("action") })

// Nishi, Shirado, Rand & Christakis 2015, *visible* condition
project: (n, v, ctx) => ({ id: n.id, action: ctx.stateOf(n).get("action"),
                           wealth: ctx.stateOf(n).get("wealth") })   // <-- the manipulation
```

A reconstruction of Rand 2011 that leaks wealth has not made a mistake in the abstract: it has
silently run a *different published experiment*, one whose finding is that this change matters.
That is H-A with a citation attached, and it is why the Rand port asserts the absence of the
field rather than commenting on it (`test/e2e/rand2011.test.ts`).

### H-B. Calling a re-implementation a replication

A port that has never collected data has reproduced **nothing**. With a paper planned
(`PUBLICATION-PLAN.md`), the language used here gets reused there, so it is fixed here:

> **"a reconstruction of the design in [cite]"** — never "a replication of [cite]", unless data
> was actually collected and compared.

Two further words are banned in this repo for the same reason:

- **"ported from Breadboard"** implies a code lineage that does not exist. Measured 2026-08-15:
  `~/breadboard-v2-working` is the *platform*, not a collection of studies; `dev/`, where a
  Breadboard install keeps its experiments, is **empty**; the only surviving trace of a real
  study is an asset path inside the bundled H2 database
  (`breadboard\dev\REDACTED`) — a name and an id, no code, no graph, no
  content. So "port" here means *reconstruct a published design from its paper*. Claiming a code
  lineage would be the same category of error as claiming a replication.
- **"validated against"** a paper. Nothing here has been compared to anyone's data.

### H-C. The template repo is a fork point that never receives an update

Fork-and-adapt is the observed ecosystem pattern (`NETWORKS-MODULE-FEASIBILITY.md`, "Pattern 2",
the Watts-Lab case study). Its cost is that every bug fixed in the package after someone forks
stays unfixed for them, forever, silently.

The rule that follows, and it decides §2: **anything in the template is code you cannot patch.**

**Broken by its own author, and that was the useful part — added 2026-08-16.** This milestone then
put ~90 lines of infrastructure into the copied surface: a hand-rolled run log (`mkdirSync` +
`appendFileSync` + try/catch) and a `fromLog` reader, in *both* examples, because the package had no
home for either. `examples/shirado2017`'s version ran on the callback path on every participant
colour change. The same milestone also had Shirado importing `NBHD_KIND` and `stateKey` to get at
"a participant wrote private state", because there was no hook for it.

Neither was a decision; both were written under protest by the person who wrote this rule. M6 Tier 2
moved them into the package as `log: { file }` / `net.log()` and `onPrivateState` (`ISSUES.md` O12,
O13). The lesson worth keeping is the diagnostic: **a rule broken by its own author is the most
reliable evidence that the package is missing something** — more reliable than a feature request,
because nobody asked for either of these.

---

## 2. What the distribution shape mitigates, versus merely warns about

**Decision: in-package `examples/` only. No template repo, no `degit` target, no `npm create`
scaffolder.**

This reverses MODULE-DESIGN §6 and §12, which both said "npm package + template repo". The
argument that changed it is the one in H-C, read once more: Pattern 2 is the strongest case
*for* a template repo (it matches how the field actually consumes Empirica) and, on the second
reading, the strongest case *against* one (fork-and-adapt is precisely the mechanism by which a
fixed bug never reaches the person who has it).

The insight that settles it: **no distribution shape solves the fork-point problem. The only
lever is how much code is inside the copied surface.** A template repo maximises it — app
scaffolding, an example experiment, and monitor wiring, all forked at once. In-package examples
minimise it: the user runs upstream's own `empirica create`, which Empirica maintains, and then
applies a documented diff.

Three further reasons, in order of weight:

1. **Only the in-package path is testable by this suite.** `examples/minimal` is exercised by
   `test/e2e/example.test.ts` against current source and by `npm run test:browser` in real
   Chromium. A template repo would be a second release surface with no CI, for a package that is
   not published at all yet. Extending a tested property beats creating an untested parallel one.
2. **It is the reversible direction.** A template repo can later be *generated from* a tested
   in-package example. Retrofitting tests onto a forked template cannot be done at all, because
   the forks are already gone.
3. **`npm create` and `degit` do not actually help.** They always copy the *current* version,
   which fixes staleness at the moment of copying and changes nothing afterwards — the fork point
   is still a fork point. They cost a second published artifact for that.

Honest accounting of what this buys, because "mitigates" and "warns about" are different things:

| | H-A: silent deviation | H-B: reconstruction ≠ replication | H-C: unpatchable fork |
|---|---|---|---|
| **in-package `examples/`** (chosen) | **Mitigated, partly by construction.** Both ports are imported unmodified by the e2e suite, so a deviation introduced by a future refactor goes red here. Their behavioural claims are assertions, not prose. What it cannot touch: the moment a researcher edits their copy, the tests stay behind. | **Warned about only.** This is a language discipline. No distribution shape can enforce it; §1 H-B and the wording in each example's README are the whole mechanism. | **Reduced, not solved.** The copied surface shrinks to the four-file diff plus the experiment's own logic; the scaffold belongs to `empirica create` and the library is a `peerDependency` that `npm update` patches. The experiment logic in the copy is still unpatchable — which is why it is small, pure, and unit-tested. |
| ~~template repo~~ (rejected) | Would *worsen* it: an untested example is the one most likely to drift, and it is also the one people copy. | No difference. | Would maximise it. |

One consequence taken deliberately: **the monitor stays out of every example's default path.**
It is `MONITOR=1`-gated in `examples/*/server/src/index.js`, exactly as MODULE-DESIGN §15
requires, because a template that ships the monitor on by default ships the leak this package
exists to prevent (§15.1, H1/H2).

---

## 3. Which experiments, and why that pair

**Chosen: Rand, Arbesman & Christakis 2011 (primary) + Shirado & Christakis 2017 (second).**

All three candidate designs were checked against the papers in the user's Zotero library, not
taken from a list. The numbers below are read off the papers.

| Study | n per session, as published | Initial network | Rewiring? | Chosen |
|---|---|---|---|---|
| Rand, Arbesman & Christakis 2011, *PNAS* 108(48):19193–19198 | 785 subjects over 40 sessions, **mean 19.6 (SD 6.4)** | 20% of possible links, at random → `erdosRenyi(n, 0.2)` | **Yes** — k = 10% (viscous) / 30% (fluid) of pairs per round | **Primary** |
| Shirado & Christakis 2017, *Nature* 545:370–374 | 4,000 subjects over 230 sessions, **exactly 20** | preferential attachment, each new node with 2 links → `barabasiAlbert(20, 2)` | No | **Second** |
| Nishi, Shirado, Rand & Christakis 2015, *Nature* 526:426–429 | 1,462 subjects over 80 sessions, **mean 17.21 (SD 2.79)** | Erdős–Rényi, 30% of ties present (mean degree 5.33) | Yes — 30% of pairs per round | Rejected |

**All three sit inside the n ≤ 50 regime this package targets**, and inside the verified
envelope. Confirmed against the papers rather than assumed; no chosen design needs n > 50.

**Why Rand 2011 is primary.** Rewiring is the capability that motivated this package
(MODULE-DESIGN §12, README), and this is its canonical published use. It exercises the parts of
the package nothing else does: `network().addEdge`/`removeEdge`, the append-only edge history,
`edgeRows`/`snapshotRows`, and a per-round private decision whose *payoff* is neighbour-limited.

**Why Shirado 2017 second, rather than Nishi 2015.** Nishi was rejected on the measured
evidence above, not on taste: it is the *same substrate* as Rand 2011 — an Erdős–Rényi graph at
n ≈ 17–20, cooperate-or-defect toward all neighbours, 30% of pairs offered a rewiring decision
each round — with wealth visibility added. It would have been cheap for exactly the reason it
would have proved little. Its one distinctive idea is kept without porting it: it is the worked
example of H-A in §1, which is a better use of it than a second app that re-runs Rand's plumbing.

Shirado 2017 shares almost nothing with Rand 2011, and the differences are the point:

| | Rand 2011 | Shirado 2017 |
|---|---|---|
| network | Erdős–Rényi, **rewired during play** | Barabási–Albert, **static** |
| time | discrete rounds, stochastic length | **continuous**, one 5-minute stage |
| dependent variable | cooperation rate over rounds | **time to a global solution** |
| what locality does | it is one condition among four | it **is the task difficulty** |
| exercises | rewiring, edge export, payoff accounting | `barabasiAlbert`, a server-side global objective participants cannot see |

That last row is why Shirado 2017 is the sharper test of the whole package. In Rand 2011 a
locality leak makes the data wrong. In Shirado 2017 a locality leak makes the task **trivial** —
a participant who can see the whole graph's colours solves it immediately, so the dependent
variable (time to solution) collapses toward zero and the experiment measures nothing. It is the
design where the guarantee is load-bearing rather than merely correct.

### What is NOT reconstructed, stated up front

- **Shirado 2017's bots.** The paper's contribution is 3 software agents with varying noise and
  network position. They are not reconstructed, and the reason is a measured platform fact rather
  than a scoping choice: **`@empirica/core@1.12.5` ships no artificial-player facility at all.**
  Searched the shipped bundles for `bot`, `virtual`, `simulat`, `agent`, `artificial` and `robot`
  — no matches beyond `bottom`, `both` and `borderBot` (a CSS property). Recorded as
  PLATFORM-NOTES §17 with the route a bot would have to take, and as `ISSUES.md` O10. What is
  reconstructed is the **human-only** arm — the 30 control sessions, which is what the paper's
  Fig. 1 is entirely about — so it is a complete arm of the design rather than a broken version
  of the whole.
- **Incentives.** Neither paper's payment scheme is reconstructed; both ran paid on Mechanical
  Turk. Payoffs are computed and recorded in experimental units. Anyone running either design for
  real has to add their own incentive-compatible payment, and that changes behaviour, so no
  behavioural claim here should be read across from the papers.
- **The stochastic session length** in Rand 2011 *is* reconstructed (80% continuation per round,
  drawn from the seeded rng), because it is reproducible from the recorded seed and therefore
  costs nothing to do properly.

---

## 4. The other decisions this milestone forced

### Package name — MODULE-DESIGN §13 decision 3, now settled

**`empirica-networks`, unscoped.** Settled by the maintainer 2026-08-15.

The competing option was `@yale-hnl/empirica-networks`. Scoping is the more conservative choice —
it makes attribution explicit and does not imply a relationship with Empirica that does not
exist. It lost to the constraint the feasibility note identifies as binding: **discovery is the
hard part, not the code.** There is no plugin API, no registry, and no "awesome-empirica" list,
so the bare name is the entire discovery mechanism, and `@empirica/chat`'s 64 downloads/month is
the ceiling to beat.

Two costs accepted rather than waved away:

- An unscoped `empirica-*` name **reads as semi-official**. Answered in prose, since it cannot be
  answered in metadata: the README says plainly that this is not affiliated with or endorsed by
  the Empirica project.
- The name is **squattable until claimed**. That is an argument for claiming it, not for scoping.

Scoping remains a one-field change if the judgement ever reverses — but it would be a breaking
change after the first publish, which is why this is settled now rather than at publish time.

### Publishing — deliberately not done in M5

`"private": true` at `0.0.0` **stays**, and the two-line change that lifts it is documented in
`docs/GETTING-STARTED.md` rather than made. `PUBLICATION-PLAN.md` step 1 makes U1 disclosure
blocking on everything else, and it is right: publishing an install path for a package whose
README documents an unpatched cross-participant write vulnerability, before its maintainer has
had the disclosure window, gets the order wrong. `private: true` is also the only thing standing
between a stray `npm publish` and that outcome, so removing it early buys nothing and risks the
one thing that cannot be undone.

Consequence to fix rather than ignore: **the README's `npx empirica-networks verify` does not
work today**, because there is nothing on npm to fetch. Every doc that shows it now shows the
from-a-clone form first and labels the `npx` form as what it becomes on publish.

### Where the ported experiments live

**In-package, under `examples/`** — the only consumer path this suite can cover, which is the
same argument as §2. Each is imported unmodified by an e2e test, the way `examples/minimal`
already is.

### Where U1 is disclosed to users

**In `README.md`, above the API**, in the words someone deciding whether to run a study needs:
what an attacker can do, what it means for their data, and what to do about it. Anyone running a
study on Empirica is exposed whether or not they use this package, so it is not a footnote about
this module.

**Kept out of two places, deliberately:**

- **Out of every example experiment's content.** An example's job is to be copied; a security
  advisory embedded in a `callbacks.js` is a comment that gets deleted in the first edit and
  reaches nobody who needed it. The examples link to the README section instead.
- **Out of paper content.** Vulnerability disclosure is its own track with its own timeline
  (`docs/upstream/DISCLOSURE.md`). Folding it into a paper as evidence of rigour is a category
  error even when it would be flattering, and `PUBLICATION-PLAN.md` already keeps them separate —
  this milestone must not undo that.

---

## 5. Docs plan

Written before the docs, so the shape is a decision rather than an accretion.

| Document | Audience and job | Status after M5 |
|---|---|---|
| `README.md` | The front door. The guarantee and its limits, **U1**, install, a 30-line quickstart, the envelope, and pointers. Stays the API reference. | Revised |
| `docs/GETTING-STARTED.md` | **The "one document"** from the milestone's done-when. A newcomer's ordered path: install → the mandatory edit → private state → run → prove it with `verify` → export. Every trap that bites during *install* rather than at runtime is named at the step where it bites. | New |
| `docs/EXPERIMENTS.md` | The two reconstructions: which paper, what was reconstructed, what was **not**, what each one demonstrates about the package, and the reconstruction-vs-replication wording. | New |
| `docs/M5-ADOPTION.md` | This file. Decisions and their reasoning. Not a user document. | New |
| `docs/PLATFORM-NOTES.md` | Unchanged in purpose: platform facts with the date and version measured. Gains §17 (no artificial players). | Extended |
| `examples/*/README.md` | Per-experiment: the citation, the design, the deviations, how to run it, and what the tests assert. | New ×2 |

Deliberately **not** written: an API reference generated from types (the README's hand-written
one carries the *reasons*, which is what makes it worth reading), and a tutorial series
(one ordered document that works beats four that overlap).

---

## 6. Trap audit: every consumer-hittable trap in PLATFORM-NOTES

The milestone's done-when requires that each is *either impossible by construction or named in
the docs where the consumer will hit it*. This is the audit, section by section. "Not
consumer-facing" means it can only be hit by someone developing this package or its tests.

| § | Trap | Can a consumer hit it? | Disposition |
|---|---|---|---|
| 1, 2, 7 | (capabilities, not traps) | — | — |
| 3 | `@empirica/tajriba` unimportable under bare Node ESM | No — consumers' servers are bundled by the Empirica CLI | Not consumer-facing |
| **3a** | **`@empirica/core` cannot be loaded from raw Node at all** | **Yes** — the moment they write a script that imports their own `callbacks.js` outside `empirica` | **Named** — GETTING-STARTED "Scripts that import your callbacks", and README Development |
| 4 | `withTajriba` public but unusable | No | Not consumer-facing |
| **4a** | **No write access control; `protected` does not protect** | **Yes, always** | **Named** — README, its own top-level section (U1). This is the disclosure decision in §4 |
| **4b** | Game scope is participant-visible | **Yes** — the natural place to put a network index | **Impossible by construction** for this package's own records (they are on the batch scope, `GAME_KEYS` is empty and documented as to why). Still **named**, because a consumer can put their own data there |
| 4c | Batch scope is the one place participants cannot read | (the fix, not the trap) | **Named** as the mechanism behind `readNetwork`/`readSeed` and behind where authoritative payoffs go |
| 4d | A restart re-fires `game.start` and used to reseat everyone | No — fixed here, and pinned by `test/e2e/restart.test.ts` | **Impossible by construction** |
| **4e** | **A full restart does not put participants back in their game (U2)** | **Yes** — any crash, deploy or `^C` mid-study | **Named** — README envelope and GETTING-STARTED "What you cannot recover". No documentation makes a crashed study resumable, so it is stated as a limit, not a procedure |
| 5 | `EventContext` has no `setAttributes` | No | Not consumer-facing |
| **6** | **Kind registration is a mandatory consumer edit, silently fatal if skipped** | **Yes, on the first install** | **Impossible to skip silently** — `assertKindsRegistered` throws with the exact diff. Also the first step in GETTING-STARTED and the first row of every example's four-file table |
| 8 | Hooks cannot be rendered against a synthetic mode | No — it is our testing limit | Not consumer-facing; stated in each example's "what is covered" |
| 10 | `ephemeral` attributes survive a reconnect | (capability) | — |
| **11** | **A `file:` link loads TWO copies of `@empirica/core`** | **Yes** — anyone developing against a local clone of this package, which is what an adopter who forks does | **Named** — GETTING-STARTED "Installing from a clone", with the symptom ("Waiting for other players" with a full game) first, because that is what they will search for |
| 12 | Attribute listeners subscribe the admin to nothing (U3) | **Yes** — for their *own* listeners on participant-written keys | **Named** — GETTING-STARTED "Your own listeners". `withNetwork` already issues the `scopeSub` for `nbhd`, so the package's own path is safe and `test/e2e/monitor.test.ts` is the witness |
| 13 | `EmpiricaClassic` never stops its animation-frame loop | No — only bites Node-side tests | Not consumer-facing; named in README Development |
| 14 | Memory: what grows and what does not | (measurement) | Named — README envelope, "sessions beyond ~10 minutes: unverified" |
| **15** | **Writes only count inside a callback** | **Yes** — the natural way to drive a rewiring study is a timer | **Named** — README "Mutate only from inside a listener", GETTING-STARTED, and a comment in the Rand 2011 example at the one place it would be tempting |
| **16** | **Game start corrupts the websocket stream at scale (U7)** | **Yes**, at n ≥ 200 | **Named** — README envelope table. Both examples default well inside the regime |
| **17** | **No artificial-player facility** *(new in M5)* | **Yes** — anyone who assumes bots exist, as this milestone's brief did | **Named** — PLATFORM-NOTES §17, `ISSUES.md` O10, and `docs/EXPERIMENTS.md` where Shirado 2017's missing arm is explained |
| **18** | **A lifecycle listener can only be registered ONCE, silently** *(new in M5)* | **Yes, immediately** — splitting `onStageEnded` by stage is the obvious structure to write | ~~Named~~ → **Named AND detected, 2026-08-16.** Still not *preventable* — it is upstream's dispatcher, and nothing here can make a dead listener speak — but `withNetwork` counts registrations at server start and warns, which is the strongest column available for a trap we do not own. GETTING-STARTED §6, PLATFORM-NOTES §18/§18a, `docs/M6-HARDENING.md` §1.2, `ISSUES.md` U8 |
| **(ours)** | **`watch` silently doubled as the server's read list** *(found in M5)* | **Yes** — any design whose server reads a private key `project()` does not | ~~Named~~ → **Impossible by construction, 2026-08-16.** `read` declares server-only keys and `net.stateOf()` throws for an undeclared one. This row is the audit's own point made against itself: it sat in the weaker column for a day, and moving it took a config field and an accessor. `docs/M6-HARDENING.md` §1.1, `ISSUES.md` O11 |

**Gap found by doing this audit, and it is the largest single finding of M5:** there is no
consumer-facing way for the *server* to write to one participant privately. See §7 — it was
built rather than routed around, and `MODULE-DESIGN.md` §17 has the shape.

**Two more traps were found afterwards, by the experiments rather than by the audit** — §18 and
the `watch` row above, both added to this table after the fact. Worth noting how they were found,
because it is the argument for the shape of this milestone: neither came from reading code or
from writing docs. Both came from an e2e assertion failing on a shipped example, and both had the
same presentation — *a listener or a read that silently does nothing*. An audit of documented
traps cannot find the undocumented ones; running the thing can.

---

## 7. The gap this milestone found: no server→participant private write path

Found while designing the Rand 2011 port, confirmed by reading the source rather than inferred.

**The fact.** `withNetwork` exposes exactly one route from server to client — `project()` — and
it runs per `(viewer, neighbour)` pair, over *current neighbours only*. `ctx.stateOf()` can
*read* a participant's private channel, but it exists only inside `project()`, and nothing
public can *write* to a channel. `NetworkHandle` is read-only by design (MODULE-DESIGN §15.4:
"its reads are plain data"). The one server-authored private write in the codebase is chat's
fan-out, and it is internal.

**Why it blocks a faithful Rand 2011.** The paper's rewiring round works like this: a fraction
*k* of all pairs is chosen at random; for each chosen pair one member, picked at random, is
offered the chance to break the tie (if one exists) or form one (if not); and **"before choosing
to break or form a connection, the deciding subject is informed of the other's action in the
preceding round"** — while *not* being told the network structure or the other's degree.

For a *break* offer the pair are already neighbours, so the normal projection covers it. For a
*form* offer **the target is by definition a non-neighbour**, and one participant has to learn
one fact about them. There is no way to deliver that today:

| Route | Why it fails |
|---|---|
| Put the offer on the player scope | Broadcast to everyone. Reveals the whole offer structure to all participants — H-A |
| Put it on the game scope | Same, plus PLATFORM-NOTES §4b |
| Add the tie provisionally so `project()` covers it | The *other* party then learns they were offered and sees the decider's action. In the paper they learn only an aggregate, at the end of the round. A stated deviation, but a real one — and it changes what someone knows while making their own decision in the same round |
| Register your own `nbhd` listener and write to the scope | Works, and is the reason this is a gap rather than a wall. It also means every adopter re-implements the package's channel bookkeeping in code that lives in *their* copy — H-C exactly |

**Resolution: add the write path to the package, in M5, rather than route around it.** Four
reasons, in order of weight:

1. Rewiring is the capability that motivated this package. An adoption milestone in which the
   canonical rewiring experiment **cannot be expressed** would be shipping the wrong conclusion
   about what the package is for.
2. `PUBLICATION-PLAN.md` step 2 is "freeze the public API surface". Finding a missing write path
   *now* costs an afternoon; finding it after the freeze costs a minor version and a migration.
   This is the last cheap moment.
3. The alternative in the table's last row pushes package internals into the copied surface,
   which is the failure mode §2 was designed around.
4. It is small, and it reuses machinery that already exists and is already tested — the chat
   fan-out's write path, and `validateProjection`.

**The design constraint it must respect.** The README's central sentence is "`project()` is the
only path to a client", and a raw `set` on someone's channel would falsify it. So the new API is
deliberately *not* a raw write:

- it validates through the same `validateProjection` that `project()`'s output goes through, so a
  scope, a cycle, a `BigInt` or a `NaN` is refused identically;
- it writes under a namespace distinct from the participant's own `state:` keys, so a server
  message and a participant's own value cannot collide;
- it lives on the per-game handle (`network(game)`), which is where the "only inside a listener"
  contract already lives (PLATFORM-NOTES §15);
- and the README sentence becomes "`project()` is the only path by which one participant's data
  reaches another" — which is the claim that was actually load-bearing. A server telling one
  participant something is a different act from one participant learning about another, and
  conflating them is what made the gap invisible for four milestones.

See `MODULE-DESIGN.md` §17 for the built shape, and `docs/EXPERIMENTS.md` for the one place a consumer meets it.

---

## 8. What actually shipped, against §5

Recorded after the fact, because a plan is only useful if somebody says how it turned out.

**As planned.** The distribution decision (§2) held; there is no template repo. The docs in §5's
table all exist. Both chosen experiments (§3) were built, at the papers' own parameters, each
imported unmodified by an e2e test.

**Not as planned, in order of how much it mattered:**

1. **The API changed.** §7 predicted the gap and recommended building the write path; it was
   built (`MODULE-DESIGN.md` §17). An adoption milestone was not supposed to add public API, and
   this one did — because the alternative was shipping an adoption milestone in which the
   canonical rewiring experiment could not be expressed.
2. **Two new traps were found, and neither by this audit.** §6's table was written from
   PLATFORM-NOTES, which by definition only contains what was already known. Both new entries —
   a lifecycle listener that can only be registered once (upstream, silent) and `watch` silently
   doubling as the server's read list (ours) — came from an e2e assertion failing on a shipped
   example. Both had the same presentation: **a listener or a read that silently does nothing.**
3. **The `verify` command in the docs did not work**, because nothing is on npm. Every place that
   showed `npx empirica-networks verify` now shows the from-a-clone form first.
4. **One package defect fixed on the way**: `views: { file: "data/views.ndjson" }` threw a bare
   `ENOENT` from inside `withNetwork` at game start if the directory did not exist.

**The generalisable point**, and the reason the milestone was shaped this way: an example whose
behaviour is *asserted* found three real bugs, two of them in itself. An example whose behaviour
is *described* would have shipped all three, and the person who hit them would not have been the
person who wrote them — which is H-A, arriving exactly where §1 said it would.

**And one uncomfortable one about §6.** That audit marked §3a "named in the docs", and then the
first offline analysis script written here died on it — the pure export helpers were reachable
only through a subpath that imports `@empirica/core/admin`. The trap was known, documented,
audited, and shipped anyway. The table already distinguishes "impossible by construction" from
"named in the docs"; the failure was in putting §3a in the second column and treating that as
done. Fixed with an `empirica-networks/export` subpath. Everything still open from this milestone
has a plan in [`M6-HARDENING.md`](M6-HARDENING.md).
