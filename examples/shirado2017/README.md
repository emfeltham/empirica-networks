# shirado2017 — the colour coordination game

**A reconstruction of the design in:**

> Shirado, H. & Christakis, N. A. (2017). Locally noisy autonomous agents improve global human
> coordination in network experiments. *Nature* **545**, 370–374.
> <https://doi.org/10.1038/nature22332>

This is a reconstruction of the design, not a replication. The design was rebuilt from the
paper. No data has been collected with this code, and nothing has been compared with the authors'
results. If you write about it, call it *a reconstruction of the design in Shirado & Christakis
(2017)*, and see "What is not reconstructed" below: three things are not reconstructed, including the
incentives.

Both arms are here: the 30 control sessions, and the paper's own contribution of 3 autonomous
agents x 3 noise levels x 3 placements. The agents run as a separate process, `server/bots.mjs`,
on `empirica-networks/bots`. Empirica provides no artificial-player facility, so this required a new
entry point rather than a configuration flag (`ISSUES.md` O10, [`docs/BOTS.md`](../../docs/BOTS.md)).

Twenty participants sit in a network and each picks one of three colours, changing it whenever
they like. The group succeeds when **every** participant differs from all of their own
neighbours. Each participant sees only their own colour and their neighbours' — never the graph,
never how close the group is. The dependent variable is time to solution, within five minutes.

## Why this one, next to `rand2011`

It shares almost nothing with the rand2011 reconstruction, and the differences are the point.

| | `rand2011` | `shirado2017` |
|---|---|---|
| network | Erdős–Rényi, **rewired during play** | Barabási–Albert, **static** |
| time | discrete rounds, stochastic length | **continuous**, one 5-minute stage |
| outcome | cooperation rate over rounds | **time to a global solution** |
| what locality does | one condition among four | it **is** the task difficulty |

That last row is why this is the sharpest test of the whole package. In most designs a locality
leak makes the data wrong. Here it makes the task trivial: someone who can see the whole
graph solves it immediately, so a leak would not produce visibly broken numbers. It would drive
the dependent variable toward zero while every screen still looked correct.

## Run it

```sh
# from the repo root: build, pack, and install the package into this example
npm install && node scripts/example-install.mjs shirado2017

cd examples/shirado2017
empirica
```

Open one browser window per participant with a different `?participantKey=`. Pick a treatment:
`Colour coordination (n=20, humans only)` is the paper's control arm; `(n=6, demo only)` is
what one person can drive by hand, and at that size the problem is close to trivial, so read
nothing into the solution time.

### With the agents

The nine agent conditions need a second process, and both halves need the same participant
keys, because the server has no other way to know which of its participants are agents:

```sh
cd examples/shirado2017/server
export SHIRADO2017_BOT_KEYS=$(node bots.mjs --keys)

# terminal 1 — the study
cd .. && SHIRADO2017_BOT_KEYS=$SHIRADO2017_BOT_KEYS empirica

# terminal 2 — the agents
cd server && node bots.mjs
```

Then pick, for example, `n=20, 3 agents: central, 10% noise` — the paper's finding — and open
seventeen browser windows, not twenty. `playerCount` is the size of the network, agents
included. Recruiting twenty leaves the game one seat short forever; the runner reports this after 30 seconds
rather than remaining silent about it. `n=6, 3 agents: central, 10% noise (demo only)` needs three
windows and is the one to try first.

A shared key list is used rather than a `bot-` prefix, because every participant in a game receives every
other participant's `?participantKey=` (`docs/upstream/ISSUES.md` U10). A recognisable key would be readable
from any browser, and this design does not tell subjects which of their neighbours are software,
so that is the manipulation being disclosed, not a metadata leak. `node bots.mjs --keys` generates keys
shaped like the ones Empirica's own client produces; a deployed study should use keys drawn from
the same space as its human recruitment keys. [`docs/BOTS.md`](../../docs/BOTS.md) §1.

The agents are told their noise level by the server, on their own private channel
(`net.tell` at stage start), so the treatment is the single source of truth for the condition.
Two processes each reading their own copy is how a study ends up running 10%-noise agents while
recording them as 30%.

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
- **The agents.** Three per session, on the paper's 3 x 3 grid of noise levels (0%, 10%, 30%) and
  placements (central, peripheral, random). An agent switches away from a local conflict as a
  human would, and with probability `noise` picks at random instead. Placement is by degree:
  "central" is the three highest-degree nodes of the graph that session drew. It is implemented by
  relabelling the generated graph rather than by generating a different one, so every arm draws
  from the same distribution of structures — an arm whose degree distribution also differed would
  confound position with structure.

## What is not reconstructed

- **The agents' pace, and one of their rules.** Two numbers here are choices, not measurements,
  and they are stated rather than buried because both affect any comparison with the paper's
  results. (1) `BOT_INTERVAL_MS` is 1500 ms — an agent's speed is obviously not neutral, and one
  moving every 50 ms would dominate a session regardless of its noise level. (2) Whether the noisy
  draw includes the colour an agent already has is not settled by what was reconstructed; it is
  uniform over all three here, so an eps of 0.3 produces an observable change about 0.2 of the
  time. Excluding the current colour would make eps the rate of visible change instead.
- **The fixed-colour agent condition.** The paper also ran agents that never change; that arm is
  not here.
- **Incentives.** The paper paid subjects according to how quickly all conflicts were resolved. This does
  not pay anything, and payment is an important part of what creates a genuine time-pressure task.
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
| an agent's noise level | `network(game).tell(playerID, "noise", …)` — that agent's own channel | **only that agent** |
| which nodes are agents | `SHIRADO2017_BOT_KEYS`, in both processes' environments | the server — and, unavoidably, anyone reading their own wire (U10) |

The last row is the uncomfortable one and is stated rather than glossed over. The list is a shared
secret between the two processes, but the identifiers themselves are not secret from participants:
Classic delivers every participant's `?participantKey=` to every co-player. So the agents' keys are
chosen to be indistinguishable from human ones rather than hidden. A subject who inspects their
wire sees six participant keys and cannot tell which three are software, which is the best the
platform allows, not a guarantee.

The global conflict count is computed on every colour change and published nowhere. A
participant who knew it would know when to stop trying, and not knowing is the coordination
problem the paper measures. The client computes the participant's own conflicts from the
neighbour colours it legitimately received, which reveals nothing new, and it deliberately
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
| `session.csv` | session | `solved`, `t_solution_ms`, node and edge counts, max degree, and the agent condition |
| `changes.csv` | colour change | `t_ms` since stage start, who, their degree, `is_bot`, and the **global** conflict count after the change |
| `edges.csv` | tie | the package's format; static here, so it is the graph |
| `views.ndjson` | delivered view | what each participant was shown, and when |
| `bots.ndjson` | agent action | written by `server/bots.mjs`, in its own file because it is a separate process |

It is important to record which nodes were agents, because nothing else does. An agent writes the same key, on the
same kind of channel, through the same code path as a human — that is the property they were built
to have — so `is_bot` in `changes.csv` and `bot_indices` in `session.csv` are the only things that
separate them. `bot_indices` records the seating, so an analysis can check that the placement happened
rather than trust the label: a placement bug produces a complete, plausible table with the
manipulation silently absent. Note that `bot_noise` is empty rather than `0` in the human-only
arm: "no agents" and "agents with zero noise" are two different conditions the paper ran, and a
`0` in both would merge them.

`t_solution_ms` is empty for an unsolved session, not `300000`. The paper censors at 300 seconds,
and writing the limit as though it were an observation is how a censored value silently becomes
a measurement: a survival analysis over such a column reports a median that never happened.

`conflicts_after` in `changes.csv` is the cost function over time. It cannot be reconstructed
from the colours alone without also knowing the graph at that instant, which is why it is
recorded rather than derived later.

### If the session ends early

This matters more here than in most designs, because the dependent variable is the change
log: when each colour was chosen and what the global conflict count was afterwards. `session.csv`
and `changes.csv` are written when the game ends, so a session that ran four of its five minutes
and then crashed used to produce nothing at all. That is precisely the session you would want.

So the experiment appends `data/run.ndjson` as it runs, one record per colour change, through
the package's `net.log()` (`log: { file }` in `callbacks.js`), which stamps each record with its
`gameID`, so one file holds every session of a batch. This is unbuffered, which is the package default for
`log`, and it matters most here: this is the log where a lost buffer would cost the dependent variable.
Rebuild the CSVs from it:

```sh
node recover.mjs data/run.ndjson              # every session in the log
node recover.mjs data/run.ndjson <gameID>     # just one
```

`test/unit/shirado2017.test.ts` asserts the recovered tables are byte-identical to those from a clean
finish, and that was checked end to end too: for the sessions in this suite that solved and ended
naturally, the recovered `session.csv`, `changes.csv`, and `edges.csv` matched the clean export
byte for byte.

The recovered `session.csv` needs careful reading. An interrupted session gets `solved=0` and an
empty `t_solution_ms`, not `300000`, and not the elapsed time. The paper censors at 300 seconds; a
session cut short at four minutes is not even a censored observation at 300 seconds, so writing any
number there would turn "we stopped watching" into a measurement. The last `t_ms` in
`changes.csv` is the only honest statement about how long it ran.

`edges.csv` now recovers in full, which was not true until M6 Tier 4. The graph is durable on the batch scope
either way, but that data lives in Tajriba's store, and `recover.mjs` reads one text file on purpose, so the `graph`
record now carries the package's own edge events verbatim, and the network comes back from the log
alone. Copying the events rather than rebuilding an edge list from the current graph is what makes it
byte-identical: every row's `t` is the event's own timestamp, which a reconstruction would have had
to invent. A log written before Tier 4 has no events in it, and the script reports this clearly rather than
writing an empty file silently.

## What is covered by tests

- `test/unit/shirado2017.test.ts` — the rules: what counts as a conflict, that an unchosen node
  conflicts with nobody, that `isSolved` requires everyone to have chosen, that
  `barabasiAlbert(20, 2)` stays inside the package's default envelope, and that an unsolved
  session is censored rather than recorded as 300 seconds. Plus the agents: that a 0%-noise agent really
  is deterministic (it is the baseline the other arms are read against, so a fencepost error there would
  move every result), that an agent moves even when every colour conflicts, because a stationary agent
  would constitute a deadlock, and that `placeBots` leaves the degree sequence unchanged in
  every arm, with a non-vacuity check that these graphs really do have hubs.
- `test/e2e/shirado2017.test.ts` — this experiment's `callbacks.js`, imported unmodified,
  against a real Tajriba: a non-neighbour's colour never reaches a browser (asserted at the wire
  with per-participant sentinels, with the neighbour case as the non-vacuity arm), the global
  conflict count reaches nobody in any shape, and a proper colouring ends the session while an
  improper one does not.
  Its agent arm runs three agents against this file, seated centrally: the placement survives the
  round trip through Classic's seating, each agent is told noise 0.3 by the server (a move is the
  only evidence that `tell` arrived — there is no other reader for a `told:` key), and `is_bot` is
  recorded for the agents' moves and for nobody else's.
- `npm run example:build shirado2017` (from the repository root) compiles the client; CI runs it for every
  example. Run `npm run example:install` first.

The end-condition test asserts the negative case first, deliberately: a detector that fires
early records a time to solution for a problem nobody solved, which is worse than one that never
fires, and testing only the positive case cannot tell them apart.
