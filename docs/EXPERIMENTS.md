# The reconstructed experiments

Two published network experiments ship in this repo as complete, runnable Empirica projects. Both are covered by the test suite: their `callbacks.js` files are imported **unmodified** by `test/e2e/`, so a change to the package that breaks them goes red here rather than in someone else's study.

## Reconstruction, not replication — and why the word matters

**Nothing here has replicated anything.** These are the *designs*, rebuilt from the papers. No data has been collected with this code, no result has been compared to the authors', and no claim in either paper is supported or challenged by anything in this repository.

The distinction is not pedantry, and it is fixed in writing here because the language used in a repository gets reused in a paper:

> Correct: **"a reconstruction of the design in Rand et al. (2011)"**
> Wrong: "a replication of Rand et al. (2011)", unless data was collected and compared.

Two neighbouring claims are equally unavailable:

- **"Ported from Breadboard."** There is no code lineage. Measured 2026-08-15: the Breadboard tree is the *platform*, not a collection of studies; `dev/`, where a Breadboard install keeps its experiments, is **empty**; the only surviving trace of a real study is an asset path inside the bundled H2 database — a name and an id, no code, no graph, no content. "Port" here means *reconstruct a published design from its paper*, and claiming a lineage that does not exist would be the same category of error as claiming a replication.
- **"Validated against the paper."** Nothing has been compared to anyone's data. What *is* asserted is that each reconstruction behaves as its own description says — payoffs match the rule, the network is neighbour-limited at the wire, the manipulation reaches the people it is supposed to and nobody else. That is a claim about this code, not about the world.

What a reconstruction is good for, then: it is a **worked, tested example of a real design's shape**, and a starting point for someone who intends to collect data. It is not evidence.

## The pair

Three Human Nature Lab designs were considered. Each was checked against the paper rather than a summary; the numbers below are read off the papers.

| Study | n per session, as published | Initial network | Rewiring | Status |
|---|---|---|---|---|
| Rand, Arbesman & Christakis 2011, *PNAS* 108(48):19193–19198 | 785 subjects / 40 sessions, **mean 19.6 (SD 6.4)** | 20% of possible links at random | **yes**, k = 10% / 30% of pairs per round | **built** |
| Shirado & Christakis 2017, *Nature* 545:370–374 | 4,000 subjects / 230 sessions, **exactly 20** | preferential attachment, m = 2 | no | **built** (human-only arm) |
| Nishi, Shirado, Rand & Christakis 2015, *Nature* 526:426–429 | 1,462 subjects / 80 sessions, **mean 17.21 (SD 2.79)** | Erdős–Rényi, 30% of ties | yes, 30% of pairs per round | **not built** |

All three sit inside the **n ≤ 50** regime this package targets and inside its verified envelope. That was checked, not assumed; had one needed n > 50 it would have been a finding about the port rather than a number to round down.

### Why Nishi 2015 was not built

On the evidence above, not on taste: it is the *same substrate* as Rand 2011 — an Erdős–Rényi graph at n ≈ 17–20, a cooperate-or-defect choice made once toward all neighbours, and 30% of pairs offered a rewiring decision each round — with wealth visibility added on top. It would have been cheap to build for exactly the reason it would have demonstrated little: the plumbing is Rand's.

Its one distinctive idea is kept anyway, and put to better use. **Rand 2011 and Nishi 2015 differ by one field in `project()`:**

```js
// Rand, Arbesman & Christakis 2011
project: (n, v, ctx) => ({ id: n.id, action: ctx.stateOf(n).get("action") })

// Nishi et al. 2015, *visible* condition
project: (n, v, ctx) => ({ id: n.id, action: ctx.stateOf(n).get("action"),
                           wealth: ctx.stateOf(n).get("wealth") })   // <- the manipulation
```

So a Rand reconstruction that leaks wealth has not made an abstract mistake. It has silently run a **different published experiment**, one whose entire finding is that this change matters. That is the sharpest available statement of the hazard this milestone was built around, and it is why `test/e2e/rand2011.test.ts` asserts the field's *absence* at the wire rather than trusting the comment above it.

### Why this pair covers more than two studies' worth

| | `rand2011` | `shirado2017` |
|---|---|---|
| network | Erdős–Rényi, **rewired during play** | Barabási–Albert, **static** |
| time | discrete rounds, stochastic length | **continuous**, one 5-minute stage |
| dependent variable | cooperation rate over rounds | **time to a global solution** |
| what locality does | one condition among four | it **is** the task difficulty |
| package surface exercised | `network().addEdge`/`removeEdge`, edge history, `edgeRows`, `tell()`, raised envelope | `barabasiAlbert`, a server-side global objective, a solved-state detector |

The last row of the middle block is the one worth dwelling on. In Rand 2011 a locality leak makes the data *wrong*. In Shirado 2017 it makes the task **trivial** — a participant who can see the whole graph solves it at once — so the dependent variable collapses toward zero while every screen still looks correct. It is the design in which the guarantee is load-bearing rather than merely correct, which is why it earns a place next to the rewiring one.

## [`examples/rand2011`](../examples/rand2011) — cooperation in dynamic networks

Participants repeatedly choose, in one move toward all their neighbours, to cooperate or defect. Between rounds they are offered chances to break ties and form new ones. Four conditions: static, randomly regenerated, slow rewiring (k = 10%), fast rewiring (k = 30%).

**What it demonstrates about the package**

- **Rewiring during play**, and that the mutation sequence is recorded — for this design the sequence *is* the independent variable, so a mutation the log missed would be data loss.
- **`tell()`, and why it had to exist.** The paper shows a subject offered a *new* tie the other party's last action — and a person you are not connected to cannot be reached by `project()`, which runs over current neighbours only. Every alternative route is a broadcast. This is the gap the milestone found; `docs/M5-ADOPTION.md` §7 has the full account.
- **Where an authoritative record goes.** Running wealth lives on the batch scope, not the player scope, because `player.set("wealth", …)` is the obvious line to write while scoring and it publishes everyone's total to everyone.
- **Raising the envelope, with the reasoning attached.** The measured `maxDegree` is 16; the paper caps degree at nothing and reports a tail to about 20. The example raises the limit and says at the call site why that is safe at n = 20 and would not be at n = 100.

**Left out:** incentives, a hard 15-round cap, an assumption about non-responders (recorded as a column so it can be dropped), the paper's interface. Each is listed in the example's README.

## [`examples/shirado2017`](../examples/shirado2017) — the colour coordination game

Twenty participants each pick one of three colours and may change at any time. The group succeeds when every participant differs from all of their own neighbours. Each sees only their own colour and their neighbours'. Five minutes.

**What it demonstrates about the package**

- **A global objective participants cannot see.** The server recomputes the conflict count on every colour change and publishes it nowhere — a participant who knew it would know when to stop trying, and not knowing is the coordination problem. Asserted at the wire, in four shapes.
- **A solved-state detector that does not fire early.** Zero conflicts among a *partly* coloured network is not a solution; accepting it would record a time to solution for a problem nobody solved. That is the silent-*success* form of this codebase's characteristic failure, and the e2e test asserts the negative case before the positive one because testing only the positive case cannot tell a correct detector from one that fires on any change.
- **`barabasiAlbert` at the paper's parameters**, staying inside the default envelope — asserted across 50 seeds, since a hub-forming generator is exactly the kind of thing that would quietly exceed it and take the study down at game start.
- **Plain `.on(kind, key, …)` listeners coexisting with the package's own**, which is what makes a colour-change hook possible at all.

**Left out — including the paper's actual contribution:** the bots. Not a scoping choice. **`@empirica/core@1.12.5` ships no artificial-player facility of any kind** (searched the shipped bundles for `bot`, `virtual`, `simulat`, `agent`, `artificial`, `robot`; `docs/PLATFORM-NOTES.md` §17). Empirica v1 had bots; v2 does not. What is reconstructed is the **human-only** arm — the paper's 30 control sessions, which is what its Fig. 1 is entirely about — so it is a complete arm of the design rather than a broken version of the whole. The route a bot would have to take is recorded in `ISSUES.md` O10; the hard part already exists in `src/verify/harness.ts`.

Also left out: incentives, and the chromatic-polynomial solution-space covariate (computable offline from the exported `edges.csv`).

## Two bugs these reconstructions found

Both were in the reconstructions themselves, both silent, both caught by e2e assertions rather
than by reading the code. They are the argument for the shape of this milestone — an example
whose behaviour is asserted rather than described — so they are recorded here and not only in
the changelog.

- **`watch` silently doubled as the server's read list.** `inspect()` filled each node's `state`
  from the `watch` list and nothing else, so a private key the server needed but `project()` never
  read came back `undefined` — indistinguishable from "not written yet". The omitted key was
  the participants' rewiring answers: every answer was dropped, and the network never changed in
  the condition whose defining feature is that it changes. **Fixed 2026-08-16**: `read` declares
  server-only keys, and `net.stateOf()` throws for an undeclared one instead of returning
  `undefined`. `ISSUES.md` O11.
- **A lifecycle listener can only be registered once.** Empirica wraps `onStageEnded` and its
  siblings in a `unique` guard whose "already ran" marker is stored on the *scope*, so the first
  callback to run sets it and every later registration silently returns. The Rand port was
  written with one handler per stage; the second was dead code that looked live.
  `docs/PLATFORM-NOTES.md` §18, `ISSUES.md` U8.

A third, smaller one came out of the same work: `views: { file: "data/views.ndjson" }` used to
fail with a bare `ENOENT` if the directory did not exist, thrown from inside `withNetwork` at
game start, after participants had joined. It now creates the directory.

**A fourth was found by looking in `data/` after a green run.** The analysis CSVs are written in
`onGameEnded`, which fires only when a game ends *naturally* — and the e2e tests tear their servers
down first, so the export path was exercised only on the ~20% of runs where the stochastic
continuation draw happened to stop. A green suite and an empty `data/` at the same time. Both
reconstructions now write an append-only run log as they go, and both ship a `recover.mjs` that
rebuilds the same tables from it; the plumbing moved into the package as `log: { file }` and
`net.log()` (`docs/M6-HARDENING.md` §2.1) once it had been written by hand twice.

---

## If you are going to run one of these for real

- **Add incentives.** Neither reconstruction pays anything, and both original designs were
  incentivised. Nothing about behaviour carries across without that.
- **Re-read the deviations** in the example's own README, and decide which ones you are keeping.
- **Run `verify` on your own machine**, so the neighbour-limited claim is something you have
  checked rather than something you read here.
- **Turn on view capture** and keep `views.ndjson`. It is the audit trail for the privacy claim
  on *your* data rather than on this package's tests.
- **Turn on the run log** (`log: { file }`) and keep `run.ndjson`. It is the difference between a
  session that died at four minutes leaving four minutes of data and leaving none.
- **Read [the write-access warning](../README.md#read-this-before-running-a-study-on-empirica).** Both
  designs give participants a reason to want to alter someone else's state, and Empirica cannot
  stop them.
- **Plan for a crash to end the session.** A full server restart never puts participants back in
  their game (`ISSUES.md` U2).
