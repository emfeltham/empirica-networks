# Glossary

Terms of art used across these documents, each with the place that develops it. Empirica's own
vocabulary is included where this package uses it in a specific way.

**batch scope** — Empirica's outermost durable scope, one per batch of games. The only durable
scope measured *not* to be delivered to participants (`test/e2e/scope_visibility.test.ts`), which
is why the realised network, the seed, the edge history and any authoritative record of account
live there. → [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**bot / agent** — an artificial participant: a headless Node process that opens a real Tajriba
session, runs the real participant mode, and reads and writes through the same private channel a
browser does. There is deliberately no server-side path, so a bot cannot see the graph or a
non-neighbour. Empirica v2 ships no such facility; this one is `empirica-networks/bots`.
→ [BOTS.md](BOTS.md)

**channel** — the private `nbhd` scope belonging to one participant. Created at game start, one
per participant, linked to them alone. Everything neighbour-limited goes through it: the server
writes their view here, they write their own private state here, and the server writes anything
it tells them privately here. Its id is a capability (there is no write access control — see *U1*), so the
map from participants to channels is never participant-visible. → [ARCHITECTURE §3
step 7](ARCHITECTURE.md#3-the-lifecycle-end-to-end)

**dones protocol** — the client-side wiring by which `Attributes` and `Scopes` resolve values,
driven by feeding their dones subjects the set of updated node ids. Version-fragile and
**silent** when broken: every scope materialises and every `.get()` returns `undefined`.
Self-checked by `DonesWiringError`. → [ARCHITECTURE §6](ARCHITECTURE.md#6-the-client-half)

**envelope** — the enforced limits on what may be published: max degree, max bytes per view, and
max bytes per participant per publish (`maxNeighbourhoodBytes`, 64 KiB). What a participant's
connection actually carries is degree multiplied by how much is projected per neighbour, not
degree alone. Degree is checked at game start, before any channel exists, so a topology
that will not fit fails while the experiment is still abandonable.
→ [API §Envelope](API.md#envelope), and the README's *Supported envelope* for the measurements

**ephemeral** — Empirica's publish mode for a value that is delivered and not retained. Views are
published this way, which is why nothing durable holds what a participant saw and why view
capture has to be switched on *before* a run rather than reconstructed after it.
→ [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

**kind** — Empirica's term for a scope class. This package adds exactly one, `nbhd`, and
registering it in the consumer's `server/src/index.js` is the one mandatory edit.
→ [GETTING-STARTED §3](GETTING-STARTED.md)

**mode** — the client-side function passed as `<EmpiricaParticipant modeFunc={…}>`, which decides
what the participant context contains. `EmpiricaNetwork` is a superset of `EmpiricaClassic`,
composed with it rather than reimplementing it, so the whole Classic flow keeps working and the
network hooks have something to read. Omit it and every hook throws
`NetworkModeNotInstalledError`. → [ARCHITECTURE §6](ARCHITECTURE.md#6-the-client-half)

**neighbourhood** — the set of a participant's current neighbours, and by extension the array of
projected views delivered to them. `useNeighbors()` returns it; `undefined` means nothing has
been published yet, `[]` means genuinely isolated, and those are different answers.

**placement** — deciding *which* seats particular participants occupy, usually bots. Expressed by
relabelling the generated graph inside `topology({ players })` rather than by reordering people,
which is what keeps the degree distribution identical across arms — so a "central" condition
differs from a "peripheral" one only in who sits where. → [BOTS §4](BOTS.md)

**private state** — what a participant writes about themselves, on their own channel, under the
`state:` prefix. Written with `useNetworkState().set()`, never `player.set()`, which is broadcast
to everyone. Read server-side with `net.stateOf()`. → [GETTING-STARTED §5](GETTING-STARTED.md)

**projection / `project()`** — the pure function that decides what one participant may learn
about one neighbour. It runs per (viewer, neighbour) pair, and it is **the only path by which one
participant's data reaches another**. Returning a scope is refused.
→ [API, `NetworkConfig`](API.md#networkconfig)

**publish** — one round of writing every affected participant's view to their channel, as a single
batched RPC. It carries a per-game counter (`seq`), which is what a view record is keyed on and
what wakes a bot's `onView`. A view that would come back byte-identical is suppressed, so a
publish is evidence that something actually changed for that participant.
→ [ARCHITECTURE §4](ARCHITECTURE.md#4-the-publish-path)

**realised network / seed** — the graph a run actually used, and the seeded value it was generated
from, both recorded on the batch scope (`network:<gameID>`, `networkSeed:<gameID>`). The edge list
is stored as well as the seed, so an analysis reads back the graph that was used rather than
re-deriving one and hoping it matches. → [DATA-AND-ANALYSIS §4](DATA-AND-ANALYSIS.md)

**reconstruction** — a design rebuilt from its published paper, never run and never compared to
the authors' results. The term deliberately avoids *replication*, because nothing here has
reproduced anything. → [EXPERIMENTS.md](EXPERIMENTS.md)

**run log** — an append-only NDJSON file written *as the study happens* (`log: { file }`), for
whatever your analysis needs. Exists because `onGameEnded` fires only when a game ends naturally,
so a killed or crashed study — which after U2 is the normal shape of "something went wrong" —
produced no data at all. → [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

**scope** — Empirica's unit of state: an object with attributes, of some *kind*, delivered to
whichever participants are linked to it. Batch, game, round, stage, player and this package's
`nbhd` are all scopes, and which one a value lives on is the whole of who can read it.
→ [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**seat / `topologyIndex`** — a participant's position in the topology. The edge list is index
pairs, so the seat is what maps the shape onto people. Stored on each channel, immutably, because
`game.players` order is not stable and re-deriving it across a restart silently moved everyone to
a different node. → [ARCHITECTURE §3 step 9](ARCHITECTURE.md#3-the-lifecycle-end-to-end)

**seating plan** — informal: who occupies which node. Known to the server and to the monitor,
never to a participant.

**sentinel** — a high-entropy token held server-side and injected into projections by the
`verify` command, then matched by substring against raw wire frames. Nothing writes them to a
scope, so a leak through a channel nobody enumerated is still caught. → README, *Verify it
yourself*

**told** — a value the server writes to *one* participant's channel, under the `told:` prefix
(`network(game).tell(playerID, key, value)`, read with `useNetworkTold()`). A separate namespace
from `state:` so a participant cannot overwrite a server-authored value. Added because
`project()` covers only *current neighbours*, and Rand 2011's rewiring round requires telling
someone one fact about a **non**-neighbour. → [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**view** — one projected neighbour, as delivered. Published `ephemeral`, so nothing durable holds
it; view capture (`views: { file }`) is the only record of what a participant was actually
**told**, as distinct from what they *could have known*, which is all an edge log plus an
attribute export can reconstruct. → [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

**U-numbers / O-numbers** — issue ids in [`ISSUES.md`](../ISSUES.md). **U** is upstream, in
Empirica itself, generally not fixable here. **O** is ours. The ones you are most likely to meet:

| | |
|---|---|
| **U1** | No write access control — `protected` does not protect. Affects every Empirica study |
| **U2** | A full restart does not put participants back in their game. A crashed study cannot be resumed |
| **U7** | Game start corrupts the websocket stream at n ≥ 200 |
| **U8** | A lifecycle listener can only be registered once, silently |
| **U10** | Every participant receives every co-player's recruitment identifier — a Prolific PID, say, if that is what `?participantKey=` carried |
| **O1** | The published latency figures are single runs on one machine, and are upper bounds. Read them as a scale, not a value |
| **O4** | Late-joiner provisioning is a net under a path nobody has reproduced: a player with no `participantID` gets no channel, and one unprovisioned player blocks every publish in the game |

Most other **O** entries are closed. They are kept, struck through, because the entry is the
account of a trap — what it looked like, and why nothing caught it — and that outlives the fix.
