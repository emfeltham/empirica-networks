# shirado2017 — the colour coordination game

**A reconstruction of the human-only arm of the design in:**

> Shirado, H. & Christakis, N. A. (2017). Locally noisy autonomous agents improve global human
> coordination in network experiments. *Nature* **545**, 370–374.
> <https://doi.org/10.1038/nature22332>

**Read this first: it is a reconstruction, not a replication — and it is not the whole paper.**
The design was rebuilt from the paper. No data has been collected with this code and nothing has
been compared to the authors' results. The paper's own contribution is what the **bots** do, and
the bots are absent; see "What is not reconstructed". If you write about it, call it *a
reconstruction of the human-only condition of the design in Shirado & Christakis (2017)*.

Twenty participants sit in a network and each picks one of three colours, changing it whenever
they like. The group succeeds when **every** participant differs from all of their own
neighbours. Each participant sees only their own colour and their neighbours' — never the graph,
never how close the group is. The dependent variable is time to solution, within five minutes.

## Why this one, next to `rand2011`

It shares almost nothing with the Rand port, and the differences are the point.

| | `rand2011` | `shirado2017` |
|---|---|---|
| network | Erdős–Rényi, **rewired during play** | Barabási–Albert, **static** |
| time | discrete rounds, stochastic length | **continuous**, one 5-minute stage |
| outcome | cooperation rate over rounds | **time to a global solution** |
| what locality does | one condition among four | it **is** the task difficulty |

That last row is why this is the sharpest test of the whole package. In most designs a locality
leak makes the data *wrong*. Here it makes the task **trivial** — someone who can see the whole
graph solves it immediately — so a leak would not produce visibly broken numbers. It would drive
the dependent variable toward zero while every screen still looked correct.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && node scripts/example-install.mjs shirado2017

cd examples/shirado2017
empirica
```

Open one browser window per participant with a different `?participantKey=`. Pick a treatment:
**`Colour coordination (n=20)`** is the paper's design; **`(n=6, demo only)`** is what one person
can drive by hand, and at that size the problem is close to trivial, so read nothing into the
solution time.

Prove the neighbour-limited claim on your own machine:

```sh
npx empirica-networks verify --n 4        # once the package is published
node dist/verify/cli.cjs verify --n 4     # from a clone today
```

## What is reconstructed

- **The network.** Barabási–Albert, each new node attached with two links, generated fresh per
  session, participants placed at random — `topology.barabasiAlbert(20, 2, { rng })`. Seeded, so
  the realised graph is recoverable; the paper shows solvability depends on the draw, so an
  analysis that cannot recover the exact graph cannot control for it.
- **Three colours**, which is the chromatic number of these graphs. A fourth would make the task
  easy rather than hard, so it is not a parameter to tune.
- **Local visibility only**: own colour plus directly connected neighbours' colours.
- **The goal, stated but not observable.** Participants are told the group succeeds when everyone
  differs from all their neighbours, and are given no way to see whether that has happened. The
  gap between those two is the coordination problem.
- **Five minutes**, ending early the moment the network is properly coloured.

## What is not reconstructed

- **The bots — the paper's actual contribution.** Not a scoping choice: **`@empirica/core@1.12.5`
  ships no artificial-player facility at all.** Searched the shipped bundles for `bot`, `virtual`,
  `simulat`, `agent`, `artificial` and `robot`; the only hits are `bottom`, `both` and a CSS
  property. Empirica v1 had bots; v2 does not. So the 9 bot conditions (3 noise levels × 3
  placements) and the fixed-colour condition are absent, and what is here is the paper's **30
  control sessions** — the arm its Fig. 1 is entirely about. Recorded as
  `docs/PLATFORM-NOTES.md` §17 and `ISSUES.md` O10, including the route a bot would have to take
  (a headless participant process, which `src/verify/harness.ts` already implements).
- **Incentives.** The paper paid subjects by how quickly all conflicts were resolved. This does
  not pay anything, and payment is exactly what makes a time-pressure task a time-pressure task.
- **The solution-space measure.** The paper counts each network's proper 3-colourings via the
  chromatic polynomial and uses it as a covariate; that is not computed here. `edges.csv` has the
  graph, so it can be computed offline.
- **The interface.** The paper's screens are not reproduced. These are deliberately plain.

## Where each value lives

| Value | Written with | Who can read it |
|---|---|---|
| `color` | `state.set("color", …)` — the participant's own channel | **only their neighbours**, via `project()` |
| the global conflict count | nothing — held in the callbacks process | **nobody** |
| time to solution | `game.batch.set(…)` at the end | **nobody but the server** |

**The global conflict count is computed on every colour change and published nowhere.** A
participant who knew it would know when to stop trying, and not knowing is the coordination
problem the paper measures. The client computes the participant's *own* conflicts from the
neighbour colours it legitimately received, which reveals nothing new — and it deliberately
cannot say "solved", because zero local conflicts is not zero global conflicts. The paper's own
example has subjects who have solved the problem from their own point of view while the network
has not.

If you want to watch the global state live while a session runs, that is what `monitor()` is
for: a separate loopback port with its own token, holding no Empirica credential
(`MODULE-DESIGN.md` §15). It is off unless you set `MONITOR=1`.

## The data it writes

At game end, into `data/<gameID>/` (override with `SHIRADO2017_OUT`):

| File | One row per | Notes |
|---|---|---|
| `session.csv` | session | `solved`, `t_solution_ms`, node and edge counts, max degree |
| `changes.csv` | colour change | `t_ms` since stage start, who, their degree, and the **global** conflict count after the change |
| `edges.csv` | tie | the package's format; static here, so it is the graph |
| `views.ndjson` | delivered view | what each participant was shown, and when |

`t_solution_ms` is **empty** for an unsolved session, not `300000`. The paper censors at 300 s,
and writing the limit as though it were an observation is how a censored value silently becomes
a measurement — a survival analysis over such a column reports a median that never happened.

`conflicts_after` in `changes.csv` is the cost function over time. It cannot be reconstructed
from the colours alone without also knowing the graph at that instant, which is why it is
recorded rather than derived later.

### If the session ends early

**This matters more here than in most designs, because the dependent variable IS the change
log** — when each colour was chosen and what the global conflict count was afterwards. `session.csv`
and `changes.csv` are written when the game ends, so a session that ran four of its five minutes
and then died used to produce nothing at all. That is precisely the session you would want.

So the experiment appends **`data/run.ndjson` as it runs**, one record per colour change, through
the package's `net.log()` (`log: { file }` in `callbacks.js`) — which stamps each record with its
`gameID`, so one file holds every session of a batch. Unbuffered, which is the package default for
`log` and matters most here: this is the log where a lost buffer would cost the dependent variable.
Rebuild the CSVs from it:

```sh
node recover.mjs data/run.ndjson              # every session in the log
node recover.mjs data/run.ndjson <gameID>     # just one
```

`test/unit/shirado2017.test.ts` asserts the recovered tables are **byte-identical** to a clean
finish's, and that was checked end to end too: for the sessions of this suite's that solved and ended
naturally, the recovered `session.csv`, `changes.csv` **and** `edges.csv` matched the clean export
byte for byte.

**Read the recovered `session.csv` carefully.** An interrupted session gets `solved=0` and an
**empty** `t_solution_ms` — not `300000`, and not the elapsed time. The paper censors at 300 s; a
session cut short at four minutes is not even a censored observation at 300 s, so writing any
number there would turn "we stopped watching" into a measurement. The last `t_ms` in
`changes.csv` is the only honest statement about how long it ran.

`edges.csv` recovers in full, and did not until M6 Tier 4. The graph is durable on the batch scope
either way — but in Tajriba's store, and `recover.mjs` reads one text file on purpose, so the `graph`
record now carries the package's own edge events verbatim and the network comes back from the log
alone. Copying the events rather than rebuilding an edge list from the current graph is what makes it
byte-identical: every row's `t` is the event's own timestamp, which a reconstruction would have had
to invent. A log written before Tier 4 has no events in it, and the script says so loudly rather than
writing an empty file quietly.

## What is covered by tests

- `test/unit/shirado2017.test.ts` — the rules: what counts as a conflict, that an unchosen node
  conflicts with nobody, that `isSolved` requires *everyone* to have chosen, that
  `barabasiAlbert(20, 2)` stays inside the package's default envelope, and that an unsolved
  session is censored rather than recorded as 300 s.
- `test/e2e/shirado2017.test.ts` — this experiment's `callbacks.js`, **imported unmodified**,
  against a real Tajriba: a non-neighbour's colour never reaches a browser (asserted at the wire
  with per-participant sentinels, with the neighbour case as the non-vacuity arm), the global
  conflict count reaches nobody in any shape, and a proper colouring ends the session while an
  improper one does not.
- `npm run example:build shirado2017` (from the repo root) compiles the client; CI runs it for every
  example. Run `npm run example:install` first.

The end-condition test asserts the *negative* case first, deliberately: a detector that fires
early records a time to solution for a problem nobody solved, which is worse than one that never
fires, and testing only the positive case cannot tell them apart.
