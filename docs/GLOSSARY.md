# Glossary

This glossary defines specialized terms used throughout the documentation. It also includes
Empirica terminology when the package assigns it a more specific meaning.

**batch scope** — Empirica's outermost durable scope, one per batch of games. The only durable
scope measured not to be delivered to participants (`test/e2e/scope_visibility.test.ts`), which
is why the realized network, the seed, the edge history and any authoritative record of account
live there. → [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**bot / agent** — an artificial participant: a headless Node process that opens a real Tajriba
session, runs the real participant mode, and reads and writes through the same private channel a
browser does. There is deliberately no server-side path, so a bot cannot read a non-neighbor or see
the whole graph — and, at radius 1.5, cannot see *less* than a human either: `ctx.structure()`
gives it the same ties among its own neighbors a browser in that seat is shown.
Empirica v2 ships no such facility; this one is `empirica-networks/bots`.
→ [BOTS.md](BOTS.md)

**channel** — the private `nbhd` scope belonging to one participant. Created at game start, one
per participant, linked to them alone. Everything neighbor-limited goes through it: the server
writes their view here, they write their own private state here, and the server writes anything
it tells them privately here. Its id is a capability (Empirica has no write access control), so the
map from participants to channels is never participant-visible. → [ARCHITECTURE §3
step 7](ARCHITECTURE.md#3-the-lifecycle-end-to-end)

**dones protocol** — the client-side wiring by which `Attributes` and `Scopes` resolve values,
driven by feeding their dones subjects the set of updated node ids. Version-fragile and silent
when broken: every scope materialises and every `.get()` returns `undefined`.
Self-checked by `DonesWiringError`. → [ARCHITECTURE §6](ARCHITECTURE.md#6-the-client-half)

**envelope** — the enforced limits on what may be published: max degree, max bytes per view, and
max bytes per participant per publish (`maxNeighborhoodBytes`, 64 KiB). What a participant's
connection actually carries is degree multiplied by how much is projected per neighbor, not
degree alone. Degree is checked at game start, before any channel exists, so a topology
that will not fit fails while the experiment is still abandonable.
→ [API §Envelope](API.md#envelope), and the README's "Supported envelope" section for the measurements

**ephemeral** — Empirica's publish mode for a value that is delivered and not retained. Views are
published this way, so view capture must be enabled before a run to create a durable record of
what each participant saw.
→ [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

**headless participant** — a participant process that uses the same network protocol as a browser
but has no graphical interface. Bots and automated verification clients run in this form.

**NDJSON** — newline-delimited JSON: a text format containing one complete JSON record per line.
The run log uses this format so that each record reaches disk independently and an interrupted
final line can be detected during recovery.

**kind** — Empirica's term for a scope class. This package adds exactly one, `nbhd`, and
registering it in the consumer's `server/src/index.js` is the one mandatory edit.
→ [GETTING-STARTED §3](GETTING-STARTED.md)

**mode** — the client-side function passed as `<EmpiricaParticipant modeFunc={…}>`, which decides
what the participant context contains. `EmpiricaNetwork` is a superset of `EmpiricaClassic`,
composed with it rather than reimplementing it, so the whole Classic flow keeps working and the
network hooks have something to read. Omit it and every hook throws
`NetworkModeNotInstalledError`. → [ARCHITECTURE §6](ARCHITECTURE.md#6-the-client-half)

**neighborhood** — the set of a participant's current neighbors and, by extension, the array of
projected views delivered to that participant. `useNeighbors()` returns `undefined` before the
first publication and `[]` for a genuinely isolated node. The *closed* neighborhood is that set
plus the participant themselves, and is what a radius 1.5 subgraph is induced on.

**radius** — how much of the network a participant is shown, set by `graph: { radius }` and
recorded per game on the batch scope. `1` (the default) sends nothing beyond the projected views:
the client draws a star, which is what Breadboard's participants saw. `1.5` additionally sends the
ties *between* a participant's own neighbors.

The fraction is the convention from egocentric network analysis, where personal networks are
routinely described as 1.5-degree, and it counts steps out from the viewer: radius 1 is the
participant, their neighbors, and the ties to them; 1.5 keeps that same set of people and adds the
ties *among* them; 2 would add the neighbors' own neighbors. So 1.5 is half a step because it adds
edges and no nodes — the viewer learns something a two-step walk would have shown them without
meeting anyone two steps away. Wider radii are refused rather than rounded down for that reason:
the next legal value is not 1.6 but 2, and at 2 a participant is shown somebody they have no
connection to, which is the guarantee itself rather than a setting.

A property of what participants are told, not of the graph — two studies on one topology at
different radii leave identical edge lists. → [API, `NetworkConfig`](API.md#networkconfig)

**structure** — the subgraph delivered at radius 1.5: the ties induced on a participant's closed
neighborhood, as pairs of indices into the array that participant already holds, plus a position
per node laid out on the server. Never seat indices; index `0` is the viewer.
Read with `useNetworkStructure()`, recorded in `ViewRecord.graph`.
→ [API](API.md#showing-the-ties-among-a-participants-neighbors)

**placement** — deciding which seats particular participants occupy, usually bots. Expressed by
relabeling the generated graph inside `topology({ players })` rather than by reordering people,
which is what keeps the degree distribution identical across arms, so a "central" condition
differs from a "peripheral" one only in who sits where. → [BOTS §4](BOTS.md)

**private state** — information a participant writes about themselves to their own channel under
the `state:` prefix. Write it with `useNetworkState().set()`; `player.set()` broadcasts values to
the entire game. Read private state on the server with `net.stateOf()`.
→ [GETTING-STARTED §5](GETTING-STARTED.md)

**projection / `project()`** — the pure function that decides what one participant may learn
about one neighbor. It runs per (viewer, neighbor) pair, and it is the only path by which one
participant's data reaches another. Returning a scope is refused.
→ [API, `NetworkConfig`](API.md#networkconfig)

**publish** — one round of writing every affected participant's view to their channel, as a single
batched RPC. It carries a per-game counter (`seq`), which is what a view record is keyed on and
what wakes a bot's `onView`. A view that would come back byte-identical is suppressed, so a
publish is evidence that something actually changed for that participant.
→ [ARCHITECTURE §4](ARCHITECTURE.md#4-the-publish-path)

**realized network / seed** — the graph a run actually used, and the seeded value it was generated
from, both recorded on the batch scope (`network:<gameID>`, `networkSeed:<gameID>`). The edge list
is stored as well as the seed, so an analysis reads back the graph that was used rather than
re-deriving one and hoping it matches. → [DATA-AND-ANALYSIS §4](DATA-AND-ANALYSIS.md)

**reconstruction** — an experimental design rebuilt from its published description. The projects
in this repository have been exercised as software but have collected no participant data or
results for comparison with the original studies. These properties distinguish them from
replications. → [EXPERIMENTS.md](EXPERIMENTS.md)

**run log** — an append-only NDJSON file written during a study (`log: { file }`). It preserves
analysis records from interrupted sessions, which bypass the `onGameEnded` callback and cannot be
resumed by the upstream platform. → [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

**scope** — Empirica's unit of state: an object with attributes, of some kind, delivered to
whichever participants are linked to it. Batch, game, round, stage, player and this package's
`nbhd` are all scopes, and which one a value lives on is the whole of who can read it.
→ [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**seat / `topologyIndex`** — a participant's position in the topology. The edge list is index
pairs, so the seat is what maps the shape onto people. Stored on each channel, immutably, because
`game.players` order is not stable and re-deriving it across a restart silently moved everyone to
a different node. → [ARCHITECTURE §3 step 9](ARCHITECTURE.md#3-the-lifecycle-end-to-end)

**seating plan** — informal term for the mapping between participants and network nodes. The
server and monitor know this mapping; participant clients receive only local neighborhood data.

**sentinel** — a random token held on the server and injected into projections by the `verify`
command. The verifier searches for these tokens throughout raw network frames. Keeping them
outside Empirica scopes allows the test to detect leaks through unexpected channels. → README,
“Verifying the guarantee”

**Tajriba** — Empirica's data service. It manages sessions, scopes, attributes, and the network
connection between server code and participant clients.

**told** — a value the server writes to one participant's channel under the `told:` prefix
(`network(game).tell(playerID, key, value)`, read with `useNetworkTold()`). Its namespace is
separate from participant-authored `state:` values. This mechanism supports private server
messages, including the information about a prospective neighbor required by the Rand 2011
rewiring round. → [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**view** — the projected representation of one neighbor as delivered to a participant. Views use
Empirica's `ephemeral` publication mode. Enable view capture (`views: { file }`) to record the
information actually delivered; an edge log and attribute export can reconstruct only the
information that was potentially available. → [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

**O-numbers** — issue ids in [`../ISSUES.md`](../ISSUES.md), this package's own defect log. The ones
you are most likely to meet:

| | |
|---|---|
| O1 | The published latency figures are single runs on one machine, and are upper bounds. Read them as a scale, not a value |
| O4 | Late-joiner provisioning is a net under a path nobody has reproduced: a player with no `participantID` gets no channel, and one unprovisioned player blocks every publish in the game |

Most other O entries are closed. They are kept, struck through, because the entry is the
account of a trap (what it looked like, and why nothing caught it), and that outlives the fix.
