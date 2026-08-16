# Glossary

Terms of art used across these documents, each with the place that develops it. Empirica's own
vocabulary is included where this package uses it in a specific way.

**batch scope** — Empirica's outermost durable scope, one per batch of games. The only durable
scope measured *not* to be delivered to participants (`test/e2e/scope_visibility.test.ts`), which
is why the realised network, the seed, the edge history and any authoritative record of account
live there. → [ARCHITECTURE §5](ARCHITECTURE.md#5-where-every-value-lives-and-why)

**channel** — the private `nbhd` scope belonging to one participant. Created at game start, one
per participant, linked to them alone. Everything neighbour-limited goes through it: the server
writes their view here, they write their own private state here, and the server writes anything
it tells them privately here. Its id is a capability (there is no write ACL — see *U1*), so the
map from participants to channels is never participant-visible. → [ARCHITECTURE §3
step 7](ARCHITECTURE.md#3-the-lifecycle-end-to-end)

**dones protocol** — the client-side wiring by which `Attributes` and `Scopes` resolve values,
driven by feeding their dones subjects the set of updated node ids. Version-fragile and
**silent** when broken: every scope materialises and every `.get()` returns `undefined`.
Self-checked by `DonesWiringError`. → [ARCHITECTURE §6](ARCHITECTURE.md#6-the-client-half)

**envelope** — the enforced limits on what may be published: max degree, max bytes per view, and
max bytes per participant per publish (`maxNeighbourhoodBytes`, 64 KiB). Degree alone is not the
thing to watch; **degree × how much you project per neighbour** is what a participant's
connection carries. → README, *Supported envelope*

**kind** — Empirica's term for a scope class. This package adds exactly one, `nbhd`, and
registering it in the consumer's `server/src/index.js` is the one mandatory edit.
→ [GETTING-STARTED §3](GETTING-STARTED.md)

**neighbourhood** — the set of a participant's current neighbours, and by extension the array of
projected views delivered to them. `useNeighbors()` returns it; `undefined` means nothing has
been published yet, `[]` means genuinely isolated, and those are different answers.

**private state** — what a participant writes about themselves, on their own channel, under the
`state:` prefix. Written with `useNetworkState().set()`, never `player.set()`, which is broadcast
to everyone. Read server-side with `net.stateOf()`. → [GETTING-STARTED §5](GETTING-STARTED.md)

**projection / `project()`** — the pure function that decides what one participant may learn
about one neighbour. It runs per (viewer, neighbour) pair, and it is **the only path by which one
participant's data reaches another**. Returning a scope is refused. → README, *`project()` is the
only path to a client*

**reconstruction** — a design rebuilt from its published paper, never run and never compared to
the authors' results. Deliberately not called a *replication*: nothing here has reproduced
anything. → [EXPERIMENTS.md](EXPERIMENTS.md)

**run log** — an append-only NDJSON file written *as the study happens* (`log: { file }`), for
whatever your analysis needs. Exists because `onGameEnded` fires only when a game ends naturally,
so a killed or crashed study — which after U2 is the normal shape of "something went wrong" —
produced no data at all. → [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md)

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
