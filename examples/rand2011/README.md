# rand2011 — cooperation in dynamic networks

**A reconstruction of the design in:**

> Rand, D. G., Arbesman, S. & Christakis, N. A. (2011). Dynamic social networks promote
> cooperation in experiments with humans. *PNAS* **108**(48), 19193–19198.
> <https://doi.org/10.1073/pnas.1108243108>

This is a reconstruction of the design, not a replication. The design was rebuilt from the
paper. No data has been collected with this code, nothing has been compared with the authors'
results, and nothing here supports or challenges their findings. No code from the original
Breadboard implementation exists, so nothing here has been ported from it. If you run it and write about it,
call it *a reconstruction of the design in Rand et al. (2011)*.

Participants sit in a network and repeatedly choose, in one move toward all of their neighbours,
whether to cooperate or defect. Between rounds, in the dynamic conditions, they are
offered the chance to break existing ties and form new ones. The paper's finding is that when
the network updates fast enough, cooperation is sustained; when it is static or slow, it
collapses.

## Why this one

Rewiring during play is the capability that motivated this package, and this is its canonical
published use. It exercises the parts nothing else does: `network().addEdge`/`removeEdge`, the
append-only edge history, `edgeRows`/`snapshotRows`, `tell()`, and a per-round private decision
whose payoff is neighbour-limited.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && node scripts/example-install.mjs rand2011

cd examples/rand2011
empirica
```

Open one browser window per participant, each with a different `?participantKey=`:

```
http://localhost:3000/?participantKey=one
http://localhost:3000/?participantKey=two
...
```

Pick a treatment in the admin console. `Fluid (n=6, demo only)` is the one you can drive by
hand; the four `n=20` treatments are the paper's own scale (it ran 785 subjects over 40 sessions,
mean network size 19.6, SD 6.4). At n=6 there are 15 pairs rather than 190, so a round offers
about 5 rewiring decisions rather than 57 — use it to watch the mechanism, not to look at
behaviour.

Prove the neighbour-limited claim on your own machine, rather than taking it from this file:

```sh
npx empirica-networks verify --n 4        # once the package is published
node dist/verify/cli.cjs verify --n 4     # from a clone today
```

## The four conditions

Set by the `condition` factor in `.empirica/treatments.yaml`. An unknown value throws at game
start rather than falling through to a default arm.

| Condition | What happens between rounds | The paper |
|---|---|---|
| `fixed` | nothing; the network never changes | reproduces earlier null results for static networks |
| `random` | the network is regenerated at random every round | a well-mixed population — the tragedy of the commons |
| `viscous` | 10% of **pairs** are offered a rewiring decision | too slow; cooperation declines |
| `fluid` | 30% of **pairs** are offered a rewiring decision | cooperation is robust and stable |

`k` is a fraction of all pairs, not of existing ties. At n = 20 that is 190 pairs, so
`fluid` means about 57 decisions per round spread over 20 people, and one person can be offered
several. Reading it as a fraction of ties would run perfectly and produce a network five times
less fluid than the paper's — which is why `test/unit/rand2011.test.ts` pins the number.

## Where each value lives and why

| Value | Written with | Who can read it |
|---|---|---|
| `action` (cooperate/defect) | `state.set("action", …)` — the participant's own channel | **only their neighbours**, via `project()` |
| `rewireAnswers` | `state.set(…)` — the participant's own channel | **only the server** |
| `score` / rewiring offers / feedback | `net.tell(playerID, …)` — server to one participant | **only that participant** |
| `wealth` (authoritative) | `game.batch.set(…)` | **nobody but the server** |

The one field that is not in `project()` matters as much as the ones that are. Adding
`wealth` to the projection would not be a bug in the abstract — it would silently turn this into
the visible condition of a different published experiment:

> Nishi, A., Shirado, H., Rand, D. G. & Christakis, N. A. (2015). Inequality and visibility of
> wealth in experimental social networks. *Nature* **526**, 426–429.

whose whole finding is that this one field changes behaviour and raises inequality. The
experiment would still run, the screens would still look right, and the data would answer
someone else's question. `test/e2e/rand2011.test.ts` asserts the absence at the wire, in both
shapes a leak can take — a broadcast player attribute (`"key":"wealth"`) and a field inside a
published object.

Equally, the authoritative wealth record is on the batch scope rather than the player scope.
`player.set("wealth", …)` is the obvious line to write while scoring, and it broadcasts every
participant's running total to every other participant. The batch scope is the one durable scope
confirmed by measurement not to be delivered to participants (`docs/PLATFORM-NOTES.md` §4c).

## What is reconstructed, and what is not

**Reconstructed from the paper:**

- Payoffs: cooperating costs 50 units per neighbour and gives each neighbour 100; defecting
  costs and gives nothing. Payoffs are not normalised by degree, which is what makes
  connections worth acquiring.
- The initial network: 20% of possible links, at random.
- The rewiring protocol: a fraction *k* of pairs per round; one of the two, at random, decides;
  the decider is shown the other's last action and nothing else — not their degree, not the
  shape of the graph.
- Post-rewiring feedback: how many others broke ties with you, and how many formed new ones.
- Stochastic session length: 80% chance of another round, drawn from a seeded random number generator so the realised
  length is part of the reproducible record.

**Not reconstructed, and each of these is a real difference:**

- **Incentives.** The paper ran paid on Mechanical Turk, converting units to money. This scores
  in units only. Payment changes behaviour, so no behavioural comparison should be read across.
- **A round cap.** Rounds stop at 15 regardless of the continuation draw, so a session cannot run
  unboundedly. The paper reports eleven rounds; the cap is recorded in `rounds.csv` via the round
  number, so an analyst can see it rather than infer it.
- **Non-responders.** The paper does not say what happens to a subject who does not choose. Here
  they are scored as defectors, and `rounds.csv` carries a `submitted` column so you can drop
  those rows instead of inheriting our assumption.
- ~~**The envelope.**~~ **No longer a deviation, as of 2026-08-16.** The paper caps degree at
  nothing and its Fig. 1B shows a tail to about 20, so this reconstruction needs degree up to n−1.
  It used to raise `maxDegree` to 64 with a paragraph of justification at the call site — and that
  paragraph was a bug report, which the package acted on: the old default of 16 came from a sweep
  of sparse graphs at n up to 100, a measurement about n being enforced as one about degree. The
  missing cells were measured, a complete graph at n=20 turned out to be faster than a degree-8
  ring at n=50, and the default is now `n − 1` at n ≤ 50. This experiment now sets no envelope
  override at all. A study at n = 100 would still be capped at 16 and would still have to override,
  which is a fact about the evidence and not about this design.
- **The interface.** The paper's screens are not reproduced. These are deliberately plain.

## The data it writes

At game end, into `data/<gameID>/` (override with `RAND2011_OUT`):

| File | One row per | Notes |
|---|---|---|
| `rounds.csv` | participant × round | condition, action, `submitted`, degree, payoff, cumulative wealth |
| `edges.csv` | tie change | the package's own format, including the initial graph |
| `network_snapshots.csv` | edge-log event | the full edge list at each point, replayed from the log |
| `views.ndjson` | delivered view | what each participant was actually shown, and when |

All keyed on `game_id`, so `rounds.csv` joins directly onto `edges.csv`: whether a person lost
ties after defecting can be answered with a merge alone, without consulting whoever ran the study. Flatten the
views with `viewRows()`; every column of every table is documented in
[`docs/DATA-AND-ANALYSIS.md`](../../docs/DATA-AND-ANALYSIS.md).

`views.ndjson` is on because `project()` here reads `stateOf()`, so a delivered view is not
reconstructible afterwards from the edge log plus an attribute export. Those tell you what
someone could have known.

### If the run ends early

The CSVs above are written only when a game ends. A study that is killed, crashes, or is stopped
mid-session never reaches that point, and after `ISSUES.md` U2 a crash mid-study is treated as the normal shape
of "something went wrong", because a restarted server cannot put participants back into their game
anyway. The session ends regardless, and the rounds that did complete are real
data.

So the experiment also appends `data/run.ndjson` as it runs, with one record per scored round, plus
the condition and the edge events. This file is written through the package's `net.log()` (`log: { file }` in
`callbacks.js`), which stamps each record with its `gameID` and the moment it was written, so one
file holds a whole study, and a batch of concurrent games can interleave safely into it. Rebuild the CSVs from
it:

```sh
node recover.mjs data/run.ndjson              # every game in the log
node recover.mjs data/run.ndjson <gameID>     # just one
```

The recovered tables are not merely approximately the same: `test/unit/rand2011.test.ts` asserts the recovered
`rounds.csv` is byte-identical to one written at a clean finish, because recovered data that
quietly differs from normal data is worse than no recovery. This was checked end to end as well as in unit
tests: for a session in this suite that happened to end naturally, `rounds.csv`, `edges.csv`, and
`network_snapshots.csv` recovered from the log all matched the clean export byte for byte. A
truncated final line, which a hard kill can produce, is dropped and counted, so it costs a
visible warning rather than a silent round.

Every record is on disk as it is written, with no buffer: that is the package default for `log`,
because a log that exists to survive a kill should not be holding its newest rows in memory when
the kill arrives.

`views.ndjson` was already continuous: the package flushes it on a full batch, a 2-second idle,
game end, and process exit, so a hard kill loses at most one batch.

## What is covered by tests

- `test/unit/rand2011.test.ts` — the design's rules, checked against the paper's own numbers by
  hand: payoffs, the rewiring draw, the feedback counts, the continuation probability, the export
  shape. No server is involved, and it runs in milliseconds.
- `test/e2e/rand2011.test.ts` — this experiment's `callbacks.js`, imported unmodified, against
  a real Tajriba: wealth is absent from the wire, a non-neighbour's action never arrives, payoffs
  match the paper's rule applied to the realised graph, rewiring offers are about non-neighbours
  and reach only their decider, and an answer really does change the graph and gets logged.
- `npm run example:build rand2011` (from the repository root) compiles the client. CI runs it for every
  example, which is what catches an import path that resolves nowhere — the package's exports map
  against a real bundler, which no test in the three tiers exercises because they all alias
  `empirica-networks` to `src`. Run `npm run example:install` first.

Not covered: the hooks in isolation, which cannot be mounted against a synthetic mode
(`docs/PLATFORM-NOTES.md` §8), and the browser UI, which has no Playwright test here — only
`examples/minimal` has one.

## Two known pitfalls

Both were real bugs in this code, both silent, both caught by the e2e tests.

- `watch` is also the server's read list: `inspect()` fills each node's `state` from `watch`
  and nothing else, so `rewireAnswers`, which `project()` never touches, still has to be listed
  or it reads back `undefined`. Without it, every answer was dropped and the network never changed
  in the fluid condition. See `ISSUES.md` O11.
- `onStageEnded` can only be registered once: Empirica's lifecycle helpers are wrapped in a
  `unique` guard whose marker is stored on the scope, so a second registration never runs. This
  file was written with one handler per stage, and the second was dead. See
  `docs/PLATFORM-NOTES.md` §18 and `ISSUES.md` U8.
