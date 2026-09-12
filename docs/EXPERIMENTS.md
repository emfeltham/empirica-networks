# The reconstructed experiments

Two published network experiments ship in this repository as complete, runnable Empirica projects. Both are covered by the test suite: their `callbacks.js` files are imported unmodified by `test/e2e/`, so a change to the package that breaks them causes a test failure here rather than in someone else's study.

## Reconstruction versus replication

Nothing here has replicated anything. These are designs, rebuilt from the papers. No data has been collected with this code, no result has been compared to the authors', and no claim in either paper is supported or challenged by anything in this repository.

The distinction matters, and it is fixed in writing here because the language used in a repository gets reused in a paper:

> Correct: "a reconstruction of the design in Rand et al. (2011)"
> Incorrect: "a replication of Rand et al. (2011)", unless data was collected and compared.

Two neighboring claims are equally unsupported:

- The claim that the design was "ported from Breadboard" does not hold, because there is no code lineage. Measured 2026-08-15: the Breadboard tree is the platform, not a collection of studies; `dev/`, where a Breadboard install keeps its experiments, is empty; the only surviving trace of a real study is an asset path inside the bundled H2 database, a name and an id, no code, no graph, no content. "Port" here means reconstructing a published design from its paper, and claiming a lineage that does not exist would be the same category of error as claiming a replication.
- The claim that a reconstruction has been "validated against the paper" does not hold either. Nothing has been compared to anyone's data. What is asserted is that each reconstruction behaves as its own description says: payoffs match the rule, the network is neighbor-limited at the wire, and the manipulation reaches the people it is supposed to and nobody else. That is a claim about this code, not about the world.

A reconstruction, then, is a worked, tested example of a real design's shape, and a starting point for someone who intends to collect data. It is not evidence.

## Selecting the pair

Three Human Nature Lab designs were considered. Each was checked against the paper rather than a summary; the numbers below are read off the papers.

| Study | n per session, as published | Initial network | Rewiring | Status |
|---|---|---|---|---|
| Rand, Arbesman & Christakis 2011, *PNAS* 108(48):19193–19198 | 785 subjects / 40 sessions, mean 19.6 (SD 6.4) | 20% of possible links at random | yes, k = 10% / 30% of pairs per round | built |
| Shirado & Christakis 2017, *Nature* 545:370–374 | 4,000 subjects / 230 sessions, exactly 20 | preferential attachment, m = 2 | no | built, control arm and the 3 x 3 agent conditions |
| Nishi, Shirado, Rand & Christakis 2015, *Nature* 526:426–429 | 1,462 subjects / 80 sessions, mean 17.21 (SD 2.79) | Erdős–Rényi, 30% of ties | yes, 30% of pairs per round | not built |

All three sit inside the n ≤ 50 regime this package targets and inside its verified envelope. That was checked, not assumed; had one needed n > 50, it would have been a finding about the reconstruction rather than a number to round down.

### Excluding Nishi 2015

The decision follows the evidence above rather than a preference: Nishi 2015 uses the same substrate as Rand 2011 (an Erdős–Rényi graph at n ≈ 17–20, a cooperate-or-defect choice made once toward all neighbors, and 30% of pairs offered a rewiring decision each round), with wealth visibility added on top. It would have been cheap to build for exactly the reason it would have demonstrated little: the plumbing is Rand's.

Its one distinctive idea is kept anyway, and put to better use. Rand 2011 and Nishi 2015 differ by one field in `project()`:

```js
// Rand, Arbesman & Christakis 2011
project: (n, v, ctx) => ({ id: n.id, action: ctx.stateOf(n).get("action") })

// Nishi et al. 2015, *visible* condition
project: (n, v, ctx) => ({ id: n.id, action: ctx.stateOf(n).get("action"),
                           wealth: ctx.stateOf(n).get("wealth") })   // <- the manipulation
```

A Rand reconstruction that leaks wealth has therefore not made an abstract mistake: it has silently run a different published experiment, one whose entire finding is that this change matters. That is the sharpest available statement of the hazard this milestone was built around, and it is why `test/e2e/rand2011.test.ts` asserts the field's absence at the wire rather than trusting the comment above it.

### Covering more than two studies

| | `rand2011` | `shirado2017` |
|---|---|---|
| network | Erdős–Rényi, rewired during play | Barabási–Albert, static |
| time | discrete rounds, stochastic length | continuous, one 5-minute stage |
| dependent variable | cooperation rate over rounds | time to a global solution |
| what locality does | one condition among four | it is the task difficulty |
| package surface exercised | `network().addEdge`/`removeEdge`, edge history, `edgeRows`, `tell()`, raised envelope | `barabasiAlbert`, a server-side global objective, a solved-state detector |

The last row of the middle block is the one worth dwelling on. In Rand 2011 a locality leak makes the data wrong. In Shirado 2017 it makes the task trivial (a participant who can see the whole graph solves it at once), so the dependent variable collapses toward zero while every screen still looks correct. This is the design in which the guarantee is load-bearing rather than merely correct, which is why it earns a place next to the rewiring one.

## [`examples/rand2011`](../examples/rand2011) — cooperation in dynamic networks

Participants repeatedly choose, in one move toward all their neighbors, to cooperate or defect. Between rounds they are offered chances to break ties and form new ones. Four conditions: static, randomly regenerated, slow rewiring (k = 10%), fast rewiring (k = 30%).

What it demonstrates about the package:

- Rewiring during play, and that the mutation sequence is recorded: for this design the sequence is the independent variable, so a mutation the log missed would be data loss.
- `tell()`, and why it had to exist. The paper shows a subject offered a new tie the other party's last action, and a person you are not connected to cannot be reached by `project()`, which runs over current neighbors only. Every alternative route is a broadcast. This is the gap the milestone found.
- Where an authoritative record goes. Running wealth lives on the batch scope, not the player scope, because `player.set("wealth", …)` is the obvious line to write while scoring and it publishes everyone's total to everyone.
- Raising the envelope, with the reasoning attached. The measured `maxDegree` is 16; the paper caps degree at nothing and reports a tail to about 20. The example raises the limit and says at the call site why that is safe at n = 20 and would not be at n = 100.

Left out: incentives, a hard 15-round cap, an assumption about non-responders (recorded as a column so it can be dropped), the paper's interface. Each is listed in the example's README.

## [`examples/shirado2017`](../examples/shirado2017) — the color coordination game

Twenty participants each pick one of three colors and may change at any time. The group succeeds when every participant differs from all of their own neighbors. Each sees only their own color and their neighbors'. Five minutes.

What it demonstrates about the package:

- A global objective participants cannot see. The server recomputes the conflict count on every color change and publishes it nowhere: a participant who knew it would know when to stop trying, and not knowing is the coordination problem. Asserted at the wire, in four shapes.
- A solved-state detector that does not fire early. Zero conflicts among a partly colored network is not a solution; accepting it would record a time to solution for a problem nobody solved. This is the silent-success form of this codebase's characteristic failure, and the e2e test asserts the negative case before the positive one because testing only the positive case cannot tell a correct detector from one that fires on any change.
- `barabasiAlbert` at the paper's parameters, staying inside the default envelope, asserted across 50 seeds, since a hub-forming generator is exactly the kind of thing that would quietly exceed it and take the study down at game start.
- Plain `.on(kind, key, …)` listeners coexisting with the package's own, which is what makes a color-change hook possible at all.

The agents, the paper's actual contribution, needed a new entry point, because `@empirica/core@1.12.5` ships no artificial-player facility of any kind (searched the shipped bundles for `bot`, `virtual`, `simulat`, `agent`, `artificial`, `robot`; `docs/PLATFORM-NOTES.md` §17). Empirica v1 had bots; v2 does not.

So both arms are here on top of `empirica-networks/bots`, which runs each agent as a headless participant process, the only kind of thing Empirica can seat at a node. The example ships the human-only arm, the paper's 30 control sessions and what its Fig. 1 is entirely about, plus all nine agent conditions (3 agents x 3 noise levels x 3 placements) and the deterministic-agent control. Three things that are not obvious from the outside, each written up in [`docs/BOTS.md`](BOTS.md) and `ISSUES.md` O10:

- the lifecycle is where bots fail, and every way of failing is silent: a bot that never plays leaves the study waiting for a game that will never reach its player count, with no error anywhere;
- placement needed a package change. The paper's independent variable is where the agents sit, and the topology function had no way to say which participant would occupy which node;
- a bot's name is participant-visible. Measuring that turned up an upstream privacy finding: every participant receives every co-player's `participantIdentifier`.

Also left out: incentives, and the chromatic-polynomial solution-space covariate (computable offline from the exported `edges.csv`).

## Three traps these reconstructions surfaced

The examples exist to have their behavior asserted rather than described, and these are what that bought: three silent defects, each caught by an e2e assertion rather than by reading the code.

- `watch` is not the server's read list. `read` declares the keys the server needs, and `net.stateOf()` throws for an undeclared one rather than returning `undefined`, which is indistinguishable from "not written yet". Fill a node's `state` from `watch` alone and a key the server needs but `project()` never reads comes back empty; in the Rand design that silently drops every rewiring answer, and the network never changes in the condition whose defining feature is that it changes. `ISSUES.md` O11.
- A lifecycle listener can only be registered once. Empirica wraps `onStageEnded` and its siblings in a `unique` guard whose "already ran" marker is stored on the scope, so the first callback to run sets it and every later registration silently returns. Register each helper once and dispatch inside it. `docs/PLATFORM-NOTES.md` §17.
- The analysis CSVs are written in `onGameEnded`, which fires only when a game ends naturally. A session that crashes, or a test that tears its server down first, gives you a green run and an empty `data/`. Both reconstructions therefore write an append-only run log as they go and ship a `recover.mjs` that rebuilds the same tables from it; the plumbing is in the package as `log: { file }` and `net.log()`.

`CHANGELOG.md` records what each of these cost.

---

## Running one of these in a real study

- Add incentives. Neither reconstruction pays anything, and both original designs were incentivised. Nothing about behavior carries across without that.
- Re-read the deviations in the example's own README, and decide which ones you are keeping.
- Run `verify` on your own machine, so the neighbor-limited claim is something you have checked rather than something you read here.
- Turn on view capture and keep `views.ndjson`. It is the audit trail for the privacy claim on your data rather than on this package's tests.
- Turn on the run log (`log: { file }`) and keep `run.ndjson`. It is the difference between a session that died at four minutes leaving four minutes of data and leaving none.
- Read [the write-access warning](../README.md#before-running-a-study). Both designs give participants a reason to want to alter someone else's state, and Empirica cannot stop them.
- Plan for a crash to end the session. A full server restart never puts participants back in their game.
