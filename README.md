# empirica-networks

Network experiments for [Empirica](https://empirica.ly): participants are nodes in a graph,
and **each participant sees only their neighbours' state**.

Status: **M5, in development.** The mechanism works end to end and is covered by tests; two
published network experiments are reconstructed here and exercised by the same suite. The public
API is not frozen and **the package is not on npm yet** — see [Installing](#installing).

Not affiliated with, or endorsed by, the Empirica project. The name is descriptive.

| | |
|---|---|
| **New here?** | [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — install to verified guarantee, in order |
| Want a real study to read | [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) — two reconstructed papers |
| Platform constraints | [`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md) — measured, dated, versioned |
| Known defects | [`ISSUES.md`](ISSUES.md) — ours and upstream's |
| What is being fixed next | [`docs/M6-HARDENING.md`](docs/M6-HARDENING.md) — the plan for what the ported experiments surfaced |
| Why it is shaped this way | `MODULE-DESIGN.md` — the design record, kept alongside the investigation that produced it rather than in this repo |

This file is the API reference. It carries the reasoning behind each decision, which is the part
worth reading.

## Read this before running a study on Empirica

**Empirica has no write access control, and this affects your study whether or not you use this
package.** Any participant who knows a node id can set any attribute on it — including on another
participant's `player` scope, whose id every participant already knows, because Classic
cross-links everyone to everyone. `protected: true` is documented as "not updatable by other
Participants" and is **not enforced**.

In practice, for a participant who opens the browser console:

- they can overwrite another participant's answers, score, or assigned condition;
- they can do it without the server logging anything unusual;
- and your server-side code cannot tell an altered value from an honest one.

What to do about it, in order:

1. **Treat every participant-written value as untrusted input**, exactly as you would a form
   field on a public website. Compute anything that matters server-side, from values you can
   attribute.
2. **Keep the record of account somewhere participants cannot write** — the batch scope. Both
   reconstructions in this repo do this for payoffs, and say so at the call site.
3. **Judge whether your design gives anyone a reason to bother.** A study where altering
   someone else's state pays — a competitive game, a bonus tied to relative performance — is
   exposed in a way a survey is not.

This module does not, and cannot, claim that a participant's state is tamper-proof. Measured in
`test/e2e/participant_write.test.ts` and `test/e2e/upstream_u1.test.ts`; mechanism in
`docs/PLATFORM-NOTES.md` §4a; tracked as `ISSUES.md` U1, which is going through private
disclosure to Empirica's maintainers (`docs/upstream/DISCLOSURE.md`).

## Installing

**Not published yet.** The package is `"private": true` at `0.0.0`, deliberately: U1 above is an
unpatched cross-participant write vulnerability affecting every Empirica study, and it is going
through disclosure first (`PUBLICATION-PLAN.md`). Publishing an install path before that window
closes gets the order wrong, and `private: true` is the only thing standing between a stray
`npm publish` and an outcome that cannot be undone.

Until then, install from a packed tarball:

```sh
npm pack                                    # in this repo -> empirica-networks-0.0.0.tgz
npm --prefix server install /path/to/empirica-networks-0.0.0.tgz
npm --prefix client install /path/to/empirica-networks-0.0.0.tgz
```

Do **not** use a `file:` link: npm makes it a symlink, which loads two copies of
`@empirica/core` and breaks every `instanceof` inside Empirica, with a symptom that names
nothing (`docs/PLATFORM-NOTES.md` §11).

Commands below written as `npx empirica-networks …` are what they become once published; the
from-a-clone form is given alongside where it matters.

**The name is settled** (`MODULE-DESIGN.md` §13, decision 3): `empirica-networks`, unscoped,
chosen over `@yale-hnl/empirica-networks` because discovery is the binding constraint in an
ecosystem with no registry, no plugin API and no curated list. Renaming after the first publish
would be a breaking change, which is why it was decided before rather than at publish time.

## The guarantee, and its limit

**What holds.** A participant never receives a non-neighbour's projected state. Not "the UI
doesn't render it" — the bytes never arrive. Each participant has a private channel scope
linked to them alone, and projections are written only there.

**Where participants write matters.** Empirica cross-links every participant to every player
node, so anything written with `player.set(key, value)` is broadcast to **everyone**, whatever
the topology. Projecting such a value restricts nothing — the raw attribute is already out.

```js
// ✗ broadcast to every participant, neighbour or not
player.set("choice", "A");

// ✓ private: written to this participant's own channel
const state = useNetworkState();
state.set("choice", "A");
```

and on the server, read it through the projection context rather than off the player:

```js
project: (neighbour, viewer, ctx) => ({
  choice: ctx.stateOf(neighbour).get("choice"),   // ✓ neighbour-limited
  // choice: neighbour.get("choice")              // ✗ was already public
})
```

`npm run test:browser` asserts both halves in real browsers: a non-neighbour's private value
appears nowhere in the bytes a tab received, while a player attribute does. Mechanism in
`docs/PLATFORM-NOTES.md` §4b.

**The network itself is private too.** The seed and realised edge list are recorded on the
*batch* scope — the one durable scope measured not to be delivered to participants — so a
finished run stays reproducible from stored data without handing the seating plan to the people
inside it. Read them with `readNetwork(game)` / `readSeed(game)`.

They were briefly on the game scope, where every participant received both; that is fixed and
locked by `test/e2e/topology_visibility.test.ts`, which checks the participant's own scope *and*
the raw wire. `docs/PLATFORM-NOTES.md` §4c has the measurement.

**What does not hold: write integrity.** Read privacy is structural; write integrity does not
exist at all, anywhere in Empirica. That is important enough, and general enough, to be at the
top of this file rather than buried here — see
[Read this before running a study on Empirica](#read-this-before-running-a-study-on-empirica).

## Verify it yourself

The read guarantee is the whole point, so it ships as a command rather than a claim:

```sh
node dist/verify/cli.cjs verify --n 4     # from a clone today, after `npm run build`
npx empirica-networks verify --n 4        # once the package is published
```

Requires the Empirica CLI on PATH (`curl https://install.empirica.dev | sh`). It boots a real
Tajriba, connects four headless participants on a ring, and checks the wire:

```
  non-neighbour sentinels received : 0   (must be 0)
  neighbour sentinels delivered    : 8/8 (non-vacuity)
  control values observed          : 12  (must be > 0, proves detection works)

  PASS
```

Three arms, all required. A clean result with a **silent control** means the check is blind,
and a clean result with **nothing delivered** means the projection never ran — both are
reported as failures, because most privacy tests are wrong in exactly one of those two ways.

Sentinels are high-entropy tokens held server-side and injected into projections; nothing
writes them to a scope, and matching is done by substring over raw wire frames, so a leak
through a channel nobody enumerated is still caught.

Note: the CLI compiles a copy of `@empirica/core` in, because Empirica cannot be loaded
unbundled (`docs/PLATFORM-NOTES.md` §3a). It prints the bundled version alongside your
installed one and warns if they differ, rather than implying it tested yours.

## Runnable examples

Three, all in-package and all exercised by this repo's own suite — each one's `callbacks.js` is
imported **unmodified** by a test in `test/e2e/`, so none of them can rot unnoticed. There is
deliberately no template repo; `docs/M5-ADOPTION.md` §2 says why.

| | What it is |
|---|---|
| [`examples/minimal`](examples/minimal) | A stock `empirica create` project with four files changed. Participants on a ring pick a colour and see only their two neighbours'. Start here |
| [`examples/rand2011`](examples/rand2011) | **A reconstruction of the design in** Rand, Arbesman & Christakis (2011), *PNAS*. Cooperation in dynamic networks: rewiring during play, private decisions, four conditions |
| [`examples/shirado2017`](examples/shirado2017) | **A reconstruction of the human-only arm of** Shirado & Christakis (2017), *Nature*. Colour coordination on a scale-free network, with a global objective participants cannot see |

```sh
npm install && node scripts/example-install.mjs minimal   # or: npm run example:install, for all three
cd examples/minimal && empirica
```

Open four windows with different `?participantKey=` values. Each sees 2 of the other 3, and a
different 2.

**Reconstructions, not replications.** The two ported designs were rebuilt from their papers. No
data has been collected with them and nothing has been compared to the authors' results — see
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md), which also explains what each one demonstrates and
what was deliberately left out.

## Usage

Registering the scope kind is **mandatory** and silently fatal if skipped:

```diff
  // server/src/index.js
- import { Classic, classicKinds, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { Classic, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
+ import { networkKinds } from "empirica-networks/admin";

  const ctx = await AdminContext.init(
    argv["url"], argv["sessionTokenPath"], "callbacks", argv["token"], {},
-   classicKinds
+   networkKinds
  );
```

```js
// server/src/callbacks.js
import { withNetwork, topology } from "empirica-networks/admin";

withNetwork(Empirica, {
  topology: ({ playerCount, rng }) => topology.ring(playerCount, { rng }),
  project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
  watch: ["choice"],   // republish neighbours when this changes
});
```

### Keeping views live

`watch` lists the keys your projection depends on — on the player scope or on a private channel,
one list covers both. When one changes, the participants who can see it get a new view, and only
they: a change is republished to the changed player's neighbours, not broadcast. Views that come
out byte-identical are not rewritten at all, so a quiet network costs nothing.

Empirica has no wildcard attribute listener, so this list can't be inferred. That would
normally make it a footgun — forget `"score"` and neighbours never see scores change, with
nothing to indicate it. So `project()` runs against a recording proxy, and anything it reads
that isn't watched is reported once, with the corrected list ready to paste:

```
empirica-networks: project() reads player attribute(s) "score" that are not in
`watch`, so neighbours will NOT see them change.
    withNetwork(Empirica, { watch: ["choice", "score"], ... })
  If they are set once and never change, this is safe to ignore.
```

Leave `watch` empty for a static network whose projection never changes.

### Reading private state on the server

A private key your listeners consume but `project()` never touches — a submitted answer, a
decision — goes in **`read`**, and you read it back with **`net.stateOf()`**:

```js
export const net = withNetwork(Empirica, {
  project: (neighbour, viewer, ctx) => ({ id: neighbour.id, choice: ctx.stateOf(neighbour).get("choice") }),
  watch: ["choice"],          // project() reads it, so a change republishes
  read:  ["rewireAnswers"],   // only the server reads it
});

Empirica.onStageEnded(({ stage }) => {
  const answers = net.stateOf(stage.currentGame.id, playerID, "rewireAnswers");
});
```

The two fields behave identically — they're unioned internally — so misfiling a key between them
can't break anything. What they buy you is `stateOf()`, where **`undefined` means one thing only:
the participant has not written this key.** An undeclared key, an ended game, a player outside the
graph, an unprovisioned channel: every one of those throws, naming the fix.

That matters because the alternative reads the same and lies. `net.inspect().nodes[i].state[key]`
collapses all five cases into `undefined`, and that is how the Rand 2011 reconstruction ran a
whole study in which the manipulation did nothing: `rewireAnswers` was undeclared, every answer
read back as "not submitted", the network never changed in the condition whose defining feature is
that it changes, every screen looked right, and nothing errored (`ISSUES.md` O11). Use `inspect()`
for the seating plan and for the monitor; use `stateOf()` for anything a listener acts on.

### Acting the moment a participant writes

To run something *when* a participant writes one of those keys, use **`onPrivateState`**:

```js
withNetwork(Empirica, {
  watch: ["color"],
  onPrivateState: ({ gameID, playerID, key, value }) => {
    if (key !== "color") return;
    // …check whether the graph is now properly coloured, and end the stage if so
  },
});
```

Fires for any key in `watch` or `read`, on the participant's own private channel — a player-scope
write is broadcast to everyone and is `Empirica.on("player", key, cb)`'s business. You get player
ids and the value, never scopes or topology indices, and it arrives *after* the republish that write
triggered, so a handler that ends the stage does so with everyone's view already current.

**Synchronous.** A returned promise is not awaited, and any write after an `await` inside it lands
outside the runloop's flush and reaches nobody — the same trap as mutating the graph from a timer. A
throw is reported with its stack and swallowed, so one participant's handler failing cannot stop the
other nineteen's events.

The alternative was reaching into the package's key layout — `Empirica.on(NBHD_KIND,
stateKey("color"), …)` — which requires knowing that a plain `.on` escapes the `unique` guard, and
which fires only because `withNetwork` subscribed the admin to the `nbhd` kind. Copied into a
project that does not call `withNetwork`, those three lines produce a listener that never runs, and
nothing says so.

### Register each lifecycle helper once

`onGameStart`, `onRoundStart`, `onStageStart`, `onStageEnded`, `onRoundEnded` and `onGameEnded` are
wrapped by Empirica in a `unique` guard whose "already ran" marker lives on the *scope*, so it is
shared by every listener for that event. **The first callback to run sets it and every later one
silently returns** — a second `onStageEnded` never executes, not once, and Empirica says nothing
(`ISSUES.md` U8). Register each once and dispatch inside; plain `Empirica.on(kind, key, cb)` is not
affected.

`withNetwork` counts your registrations at server start and warns if it finds a duplicate. It
cannot distinguish a duplicated helper from two plain `.on` calls on the same event when both
callbacks are anonymous 2-argument async functions, and the warning says so — so read it rather
than trusting it, and treat it as a net under the rule, not a replacement for it.

```jsx
// client/src/App.jsx
import { EmpiricaNetwork } from "empirica-networks/player";
<EmpiricaParticipant url={url} ns={ns} modeFunc={EmpiricaNetwork}>
```

`EmpiricaNetwork` is a superset of `EmpiricaClassic`, so `usePlayer`, `useGame`, `useStage`
and friends keep working.

```jsx
// client/src/Neighbors.jsx
import { useNeighbors, useNetworkSelf } from "empirica-networks/player/react";

export function Neighbors() {
  const neighbors = useNeighbors();      // exactly what project() returned
  const { degree } = useNetworkSelf();

  if (!neighbors) return <Loading />;    // see below — this branch matters
  return <ul>{neighbors.map((n) => <li key={n.id}>{n.choice}</li>)}</ul>;
}
```

TypeScript users can name the projection: `useNeighbors<{ id: string; choice: string }>()`.

**`useNeighbors()` returns `undefined` until the first publish, and `[]` only for a genuinely
isolated node.** Those two are not the same and the hook refuses to conflate them: a node with
no neighbours is a legitimate result, so returning `[]` while loading would render a
participant as isolated, look entirely normal, and quietly corrupt the data. Branch on it the
same way you already branch on `usePlayer()`.

`useNetworkSelf()` resolves earlier — `playerID` is written when the channel is provisioned —
and reports `degree: undefined` rather than `0` before the first publish, for the same reason.

## `project()` is the only path to a client

Whatever it returns is what gets published, so it is validated before anything is
written — a publish is one batched RPC, and a rejected projection means nothing is sent
at all rather than some participants getting a partial view.

The check that matters most: **returning a scope is refused.**

```js
project: (neighbour) => neighbour            // ✗ throws
project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get("choice") })  // ✓
```

The first line is the natural thing to write if you read `project()` as a filter rather
than a serialiser. An Empirica scope holds a reference to the *global* attribute store, so
publishing one would ship every attribute of every participant to that client — the exact
leak this module exists to prevent, arriving through the one path we cannot lock down,
because you choose what goes in it. Cycles, `BigInt`, functions, `Map`/`Set` and `NaN` are
refused too, each naming the offending field: `the projection at a.b[0] is ...`.

Precisely: **`project()` is the only path by which one participant's data reaches another.** The
server telling *you* something is a different act, and it has its own path — see below.

## Telling one participant one thing

```js
// server, inside a listener
network(game).tell(playerID, "offer", { with: otherID, theirLastAction: "C" });
```

```jsx
// client
import { useNetworkTold } from "empirica-networks/player/react";

const told = useNetworkTold();
const offer = told?.get("offer");
```

Writes to that participant's own channel. **Nobody else receives it — including the person the
value is about.**

**Why this exists, since a second path to a client is exactly where a leak gets in.**
`project()` runs per (viewer, neighbour) pair, over *current neighbours only*, so it structurally
cannot express "show this subject one fact about someone they are not connected to". That is not
a hypothetical: Rand, Arbesman & Christakis (2011) offer a subject the chance to form a *new*
tie and show them that person's last action, and by definition the target is not yet a
neighbour. Every route around it is a broadcast — the player scope and the game scope both reach
every participant, and provisionally adding the tie would tell the other party they had been
named. The full account, including the four rejected alternatives, is in
[`docs/M5-ADOPTION.md`](docs/M5-ADOPTION.md) §7.

What keeps it from weakening the guarantee:

- **Same validation as a projection.** `tell()` runs `validateProjection` on its value, so a
  scope, a cycle, a `BigInt`, a `Map` or a `NaN` is refused identically. A scope would ship every
  attribute of every participant, which is the leak `project()` is guarded against arriving
  through a newer door.
- **A separate namespace.** Server-authored values live under `told:`, participants' own under
  `state:`, so `state.set("offer", …)` cannot overwrite what the server told you and the server
  cannot read a participant's answer back as its own.
- **Read-only on the client.** `useNetworkTold()` has no `set`. Nothing at the wire enforces that
  — a participant can write anywhere (§4a) — so it is an API that does not invite the mistake,
  not a permission check. Server code reading a told value back would be trusting participant
  input.
- **The same rule as the mutators: only from inside a listener** (see below). It **throws** rather
  than dropping the write if the participant's channel has not materialised, because a told value
  is usually a stimulus, and a missing stimulus that still records a choice is worse than a crash.

You choose what goes in it, so the discipline `project()` enforces structurally is yours to keep
here. In particular, do not assemble a "summary" of a third party by hand that you would not have
put in a projection.

## Topologies

```js
import { topology } from "empirica-networks/admin";

// regular
topology.ring(n, { rng })                     // degree 2
topology.ringLattice(n, m, { rng })           // degree 2m
topology.grid(w, h, { rng })                  // degree 2–4; n = w*h
topology.grid(w, h, { periodic: true })       // a torus: degree 4 everywhere
topology.ladder(n, { rng })                   // 2n nodes, degree 2–3
topology.complete(n)                          // degree n-1 — inside the envelope at n <= 50

// centralised
topology.star(n, { rng })                     // hub degree n-1, spokes 1
topology.wheel(n, { rng })                    // hub degree n-1, rim 3

// random
topology.wattsStrogatz(n, k, beta, { rng })   // small world: lattice, rewired
topology.barabasiAlbert(n, m, { rng })        // scale-free, hubs emerge
topology.erdosRenyi(n, p, { rng })            // G(n, p)
topology.geometricRandom(n, radius, { rng })  // spatial, naturally clustered

// controls and arbitrary graphs
topology.pairs(n, { rng })                    // disjoint dyads; degree 1
topology.empty()                              // no edges
topology.fromEdgeList(n, edges)               // normalise your own

// measures
topology.adjacency(n, edges)                  // neighbour lists
topology.degrees(n, edges)
topology.meanDegree(n, edges)
topology.maxDegree(n, edges)
topology.components(n, edges)                 // partition into components
topology.isConnected(n, edges)
```

Or supply your own — `topology` returns a plain edge list:

```js
withNetwork(Empirica, { topology: ({ playerCount }) => myEdges(playerCount) });
```

**Three of Breadboard's sixteen are deliberately absent.** `smallWorld` is the same
construction as `wattsStrogatz`; `lattice` is `grid(w, h, { periodic: true })`; and
`smallWorldColoring` could not be reconstructed from its name with enough confidence to be
worth guessing at a generator that decides who is adjacent to whom.

**Some of these can hand you a disconnected graph, and none of them quietly fixes it.**
`erdosRenyi` and `geometricRandom` below their percolation thresholds, and `wattsStrogatz`
through rewiring, all produce isolated nodes at some parameters. Resampling until connected
would silently change the distribution you are sampling from, so `isConnected(n, edges)` is
offered instead and the choice stays yours.

Degenerate parameters are refused rather than quietly producing something that isn't what it
claims — `ring(2)` throws instead of returning a two-node "ring" of degree 1, and `pairs(7)`
throws rather than stranding one participant.

## Rewiring during play

Ties can be added and dropped while a game runs — the capability that motivated this package.

```js
import { network } from "empirica-networks/admin";

Empirica.onStageStart(({ stage }) => {
  const net = network(stage.currentGame);

  net.neighbors(playerID);        // -> player ids
  net.degree(playerID);
  net.hasEdge(a, b);
  net.edges();                    // -> [playerID, playerID][]

  net.addEdge(a, b);              // returns false if the tie already existed
  net.removeEdge(a, b);
  net.rewire(newEdges);           // replace the whole graph

  net.history();                  // every mutation so far

  net.tell(playerID, key, value); // tell ONE participant ONE thing, privately
});
```

Everything takes and returns **player ids**, never topology indices. Indices are an internal
representation, and asking experiment code to translate is how off-by-one errors get written.

**Mutate only from inside a listener.** The runloop flushes the writes made while it is
processing a callback; a mutation driven from a timer, an HTTP handler or a test updates the
server's own state correctly and then reaches nobody, with no error. Reads are safe anywhere.

No unlinking is involved, which matters because Tajriba does not support it. The link grants a
persistent private *channel*; dropping a tie simply means that neighbour is absent from the
next view written there.

Both the current edge list and an append-only mutation log are recorded on the batch scope.
Two records rather than one, because a snapshot cannot answer "how did it get here" — and for
a rewiring study the sequence is the independent variable.

## Neighbour-scoped chat

Off by default. `chat: true` in `withNetwork(...)` turns it on.

```jsx
import { useNeighborChat } from "empirica-networks/player/react";

const chat = useNeighborChat();
chat?.messages.map((m) => <li key={`${m.from}-${m.seq}`}>{m.text}</li>);
chat?.send("hello");
```

A message goes to whoever is the sender's neighbour **at that moment**, plus the sender. Same
channel as everything else, different key — no second privacy path, which is the point.
`npm test` asserts at the wire that a non-neighbour's traffic never contains the text.

Sending and receiving take different routes on purpose. A participant can only write to their
own channel, so `send` writes to an outbox there and the server fans out. Writing straight into
a neighbour's channel would work — nothing prevents it (`docs/PLATFORM-NOTES.md` §4a) — and
would be building on the absence of write access control.

**Messages land on the recipient's channel**, which decides what a rewire does: dropping a tie
stops new messages without erasing the conversation already delivered. That was left open in
the design as a research-design call; storing per-recipient answers it structurally rather than
by policy. It also keeps chat out of `project()`'s output, so message volume never counts
against `maxViewBytes`.

Retention is capped at 200 messages per participant (`chat: { history: 500 }` to change it),
because the log is server memory and wire payload both.

## Exporting the network

```js
import { network, edgeRows, snapshotRows, toCSV } from "empirica-networks/admin";

const history = network(game).history();
toCSV(edgeRows(game.id, history));      // game_id, t, event, player_a, player_b
toCSV(snapshotRows(game.id, history));  // game_id, t, size, edges
```

`edges.csv` is the `connected`/`disconnected` sequence Breadboard produced, so existing
analysis ports with little change — and it **includes the initial graph**, so a study that
never rewires still exports its network rather than an empty file.

Snapshots are replayed from the events rather than stored separately, so they cannot disagree
with the log they summarise. `historyIsConsistent(history)` checks the recorded edge counts
against that replay.

These take a game id and an event log, not Empirica objects, so the same functions run offline
over data collected months ago — and they have their own subpath for exactly that:

```js
// in an analysis script, run by plain `node`
import { edgeRows, snapshotRows, viewRows, toCSV } from "empirica-networks/export";
```

**Import them from `empirica-networks/export`, not `/admin`, in anything you run outside the
Empirica CLI.** The functions are identical — `/admin` re-exports them — but `/admin` also pulls
in `@empirica/core/admin`, which cannot be loaded from raw Node in either module system
(`docs/PLATFORM-NOTES.md` §3a). An offline script that imports from `/admin` dies on
`cross-fetch/polyfill` before it runs a line. The subpath has no runtime imports at all, pinned by
`test/unit/export_isolation.test.ts`.

### Recording what participants were shown

The edge log says what the network was. It does not say what anyone was *told* — and views are
published `ephemeral`, so unlike edges, attributes, the seed and chat, nothing durable holds
them. Capture is opt-in:

```js
withNetwork(Empirica, {
  project: (neighbour) => ({ id: neighbour.id, choice: neighbour.get("choice") }),
  views: { file: "views.ndjson" },     // or { onView(record) { … } }
});
```

Then, offline:

```js
import { parseNdjson, viewRows, toCSV } from "empirica-networks/export";

const { records, dropped } = parseNdjson(fs.readFileSync("views.ndjson", "utf8"));
toCSV(viewRows(records));   // game_id, viewer, seq, t, neighbour_index, neighbour_id, …
```

`parseNdjson` drops lines that will not parse and **counts** them, because the expected cause is a
hard kill cutting the final record in half — and a recovery that quietly dropped one would be
indistinguishable from a study with one record fewer.

**NDJSON in, CSV out**, and the split is the point. A view is a variable-length array of
whatever `project()` returned, so its columns cannot be known while it is being written — only
afterwards, with the whole log in hand. `viewRows` emits one row per neighbour per delivery, so
the table joins straight onto `edges.csv`; fields `project()` returned become columns, and
nested values are JSON in their cell.

**Worth turning on when `project()` does more than pass values through.** If it buckets a score,
adds noise, or reads `stateOf()`, the delivered view cannot be reconstructed afterwards from the
edge log and the attribute export — those give what someone *could* have known. This also
records *when* they were told, which a reconstruction cannot: views are republished only when
they change, so a record exists per delivery, not per tick.

It is also the audit trail for the neighbour-limited claim on a real study's own data rather
than on this package's tests — `test/e2e/views.test.ts` runs exactly that check over a captured
log.

Off by default, because it is a storage cost a study should choose knowingly: volume is
`writes/sec × degree × duration`, not `n × tick rate`, since only changed views are published.
Records are buffered and flushed on a full batch, a 2-second idle, a game ending, and process
exit — so a hard kill loses at most one batch, which is stated rather than hidden.

### Data that survives a study ending badly

Analysis files are normally written when a game *ends*. A study that is killed, crashes, or is
stopped mid-session never gets there — and a crash mid-study is the **normal** shape of something
going wrong, because a restarted server cannot put participants back in their game anyway
(`ISSUES.md` U2). So the case where partial data matters most was the case that produced none.
Measured, not imagined: a green run of the Rand 2011 reconstruction's tests left a views log and
not one CSV.

```js
withNetwork(Empirica, { …, log: { file: "data/run.ndjson" } });

Empirica.onStageEnded(({ stage }) => {
  net.log(stage.currentGame, { type: "round", round, rows });   // gameID and at are stamped on
});
```

One file for the whole study, not one per game: every record carries its `gameID`, so a batch of
concurrent games interleaves safely and you group by game offline. Read it back with `parseNdjson`.

**Unbuffered by default**, unlike `views`, and the difference is deliberate: a facility that exists
so a killed study still has data must not default to holding its newest records in memory. Raise
`log: { batch: n }` if your design writes enough to care, knowing that a SIGKILL then costs up to
`n` records — measured, at exactly `n`, in `test/unit/sink.test.ts`.

`net.log` **throws** if no log is configured, if the game cannot be resolved, or if the record is
not a plain object. All three are mistakes that show up on the first run; a write that fails
mid-study (a full disk) is reported and swallowed instead, because the study matters more than its
telemetry.

Both example experiments ship a `recover.mjs` that rebuilds their CSVs from this log, and the two
paths produce byte-identical files — asserted in unit tests, and checked end to end against a real
server's output for a session that ended naturally.

### Reproducible by default

Every generator taking randomness takes a seeded RNG, and `withNetwork` records the seed and
the realised edge list on the **batch** scope — not the game scope, which every participant can
read. **The seed alone regenerates the graph participants were actually placed in.**

This is a real gap in Breadboard, not a refinement: it used an unseeded generator, so a
finished run stored the generator and its parameters but not the graph — and for a network
experiment the realised graph is often the independent variable. Verified end to end in
`test/e2e/reproducibility.test.ts`, which checks the recorded seed, the recorded edge list,
and the neighbourhoods that reached clients all agree.

Pass `seed` explicitly to pin a condition across sessions; otherwise it is derived from the
game id.

**Once you rewire, the seed no longer describes the realised network** — it regenerates the
graph as it stood at game start. The recorded edge list plus `network(game).history()` are the
ground truth from then on, which is why both are stored.

### Analysis and rendering, via graphology

Topologies are plain edge lists, which is what gets recorded and exported — but for measuring or
drawing a network you probably want [graphology](https://graphology.github.io) and its ecosystem
(`graphology-metrics`, `-components`, `-shortest-path`, `-communities-louvain`, GEXF export for
Gephi, and sigma.js). There is an adapter:

```js
import { UndirectedGraph } from "graphology";
import { density } from "graphology-metrics/graph/index.js";
import { toGraphology, fromGraphology } from "empirica-networks/topology/graphology";

const g = toGraphology(UndirectedGraph, n, edges, { order });  // order = playerIDs by position
density(g);
g.neighbors("player-3");

fromGraphology(g);  // -> { n, edges, order }, back to this package's representation
```

**graphology is not a dependency of this package** — not even an optional one. The constructor
is injected (graphology's own convention for its generators), so nothing here imports it at
runtime and the subpath loads fine without it installed. Bring your own copy, and your
`instanceof` checks and graphology-\* helpers will all agree with the graph you get back.

Nodes are keyed by `order[i]` when you pass one, and every node carries a `topologyIndex`
attribute so structural position survives the round trip — this package keeps position and
identity separate on purpose, and labelling by playerID alone would lose that.

Two things worth knowing before you trust a number:

- **Pass `UndirectedGraph`, not `Graph`.** graphology's default is a *mixed* graph, whose ratio
  metrics count directed slots this module never fills. `toGraphology(Graph, 12, complete(12))`
  reports a density of `0.333`; `UndirectedGraph` reports `1.000`. Same 66 edges — nothing
  errors, the number is just wrong.
- `graphology-metrics` ships no `exports` map, so under plain Node ESM you need the explicit
  `graphology-metrics/graph/index.js`, not the bare directory. Bundlers resolve either.

`toGraphology` builds from `adjacency()`, so the graph you measure or render is by construction
the one participants are actually in. `DirectedGraph` is refused: a one-way tie is not something
the projection can deliver.

## Watching a study live

`monitor()` serves a live view of a running study: the current graph, nodes carrying each
participant's state, ties appearing and disappearing as you rewire, and a scrubber back through
the edge history. It also shows the things you cannot see from inside the experiment — publish
counts, and any channel that has not materialised.

```js
// server/src/callbacks.js
export const net = withNetwork(Empirica, { topology, project, watch: ["color"] });

// server/src/index.js
if (process.env.MONITOR) {
  const { monitor } = await import("empirica-networks/admin/monitor");
  await monitor(net);        // prints http://127.0.0.1:<port>/?t=<token>
}
```

```
MONITOR=1 empirica
```

**Read this before you expose it.** The monitor shows exactly what participants must never see.
The whole point of this package is that a participant learns only their neighbourhood, and the
realised topology lives on the batch scope specifically because the game scope is broadcast to
everyone. The monitor is the one surface holding the complete graph, the seating plan, and every
participant's private state at once.

Two things follow, and they are not the same kind of thing:

- **Nothing the monitor serves enters Empirica's scope graph.** It is plain HTTP on its own
  port, so no participant's subscription can carry it whatever your listeners do. That is
  structural, and `test/e2e/monitor.test.ts` asserts it against the raw wire with the monitor
  running and reading every secret.
- **Who can open the monitor is access control, and access control is never structural.** It
  binds to `127.0.0.1` and requires a token generated fresh each run. Pass a different `host`
  and it will do as you ask, and say loudly what that costs. The URL contains the token; treat
  it as the secret it is.

The monitor holds **no Empirica credential**. It reads the callbacks process's own memory and
serves JSON — there is no path from the page to `setAttribute`. This matters more than it
sounds: Empirica has no write access control at all (`ISSUES.md` U1), so an admin `srtoken` in a
browser is not a read-only view with a login, it is the ability to write any attribute on any
node, including every participant's player scope. Do not build one.

```js
await monitor(net, {
  port: 0,              // default: the OS picks; the printed URL tells you which
  host: "127.0.0.1",    // default; anything else warns
  token: undefined,     // default: fresh 48-char token per run
  pollMs: 500,          // how often it re-reads state
});
```

Two things it will not pretend to do. It does not survive a **server restart**, because nothing
does — a full restart never reassigns players to their game (U2), so it says the game is gone
rather than showing a stale picture as though it were live. And it is sized for the regime this
package targets, **n ≤ 50**; the layout is a straightforward force simulation, and n ≥ 200 does
not reliably start at all (U7).

If you only need to see what happened rather than what is happening, `views: { file }` plus
`viewRows()` records what each participant was actually shown — the same picture, offline, with
none of the exposure above.

### Reading the graph elsewhere

`GET /api/state` returns `{ snapshot, positions }`, and `snapshot` carries `{ n, edges, order }`
— which is exactly `toGraphology`'s signature. So the monitor is also the shortest route into
the graphology ecosystem on a running study:

```js
const { snapshot } = await (await fetch(url)).json();
const g = toGraphology(UndirectedGraph, snapshot.n, snapshot.edges, { order: snapshot.order });
```

Pass `UndirectedGraph`, not `Graph` — see the warning above.

## Supported envelope

Per-participant payload is O(d), independent of n; server egress is O(n·d).

| Regime | Status |
|---|---|
| **Any density, n ≤ 50** | Measured, including complete graphs — see below. No degree cap by default |
| Sparse (d ≤ 16), n ≤ 150 | Measured on **this** implementation — see below |
| Sparse, n ≥ 200 | **Games do not reliably start.** 1 run in 6 at n=200; not this package's doing, see below |
| Dense, n > 50 | **Unmeasured**, and capped at d ≤ 16 by default. Per-participant payload is O(d), so this is the regime where client bandwidth is the binding constraint |
| Sessions beyond ~10 minutes | **Unverified.** The mechanism is not in doubt — Tajriba holds current values, not per-write history (§14) — but no multi-hour run has been observed |

The regime these were written for is **n ≤ 50**, where every figure below has margin to spare.
The larger cells are here because a claim about n=100 should be measured rather than
extrapolated, not because the package is aimed at that size.

### Density, and a correction

The first row used to read "Dense / complete — **unsupported**", and the default degree cap was a
flat 16 described as measured. That was wrong in a specific way worth recording: the measurement
behind 16 (SPIKE-REPORT §4) swept **sparse** graphs while varying n, so **16 was a number about n
being enforced as a number about degree.** A published design that needs a full neighbourhood at
n=20 — Rand, Arbesman & Christakis (2011) caps degree at nothing — had to override it.

So the missing cells were measured (`npm run bench -- --dense`, 2026-08-16):

```
  n= 20  d= 8  p50    4.1ms  p95    9.8ms   (440 receipts)
  n= 20  d=19  p50    7.5ms  p95   13.9ms  (1045 receipts)   <- complete graph
  n= 50  d= 8  p50   10.1ms  p95   30.3ms   (440 receipts)
  n= 50  d=49  p50   16.1ms  p95   24.6ms  (2695 receipts)   <- complete graph
  n=100  d=16  p50    9.9ms  p95   11.6ms   (880 receipts)
```

A **complete** graph at n=20 (7.5ms) is faster than a degree-8 ring at n=50 (10.1ms), and faster
than the old limit's own cell. Nothing was dropped and no round was silent at any density. Degree
is a second-order term: what these cells track is participants per client process — n=50 over 2
shards and n=100 over 4 both put 25 per process and both land near 10ms.

The default degree cap is therefore `n - 1` at n ≤ 50 and 16 above it, and the error message says
which evidence you have run into. Above n=50 the limit stays exactly where it was measured.

**What that measurement does not cover, and the limit added because of it.** The bench projects
two fields, so it established that degree is cheap *at small view sizes*. Degree × view size is
what a participant's connection actually carries, and it is what the client-bandwidth finding was
about — so `maxNeighbourhoodBytes` (default 64 KiB) now caps what one participant receives in a
single publish. Neither other limit can see it: 49 views of 1.5 KiB are each well inside
`maxViewBytes` and add up to 73 KiB. Lifting a limit is only honest if you name what it was
accidentally guarding.

`npm run bench` measures end-to-end publish latency — a watched attribute changing, to a
neighbour's client holding the new value. Participants run in child processes, and receipts are
taken on the client's own flush:

```
  n= 25  d=8  shards=2  p50    6.6ms  p95    8.1ms  max    9.4ms   (760 receipts)
  n= 50  d=8  shards=2  p50   11.6ms  p95   13.9ms  max   15.9ms   (760 receipts)
  n=100  d=8  shards=4  p50   14.3ms  p95   17.7ms  max   19.5ms   (760 receipts)
  n=150  d=8  shards=6  p50   23.7ms  p95   29.2ms  max   32.0ms   (760 receipts)
  n=200  d=8  shards=8  p50   26.7ms  p95   35.6ms  max   41.0ms   (760 receipts)
```

Every round's delivery is counted at every recipient, so the tail is the slowest neighbour
rather than an average one, and `delivered/expected` is reported alongside: no run above lost a
single receipt once its game started.

**Read these as an upper bound.** Sweeping participants-per-process at n=100 moved p50 from
43.1ms to 10.1ms to 8.0ms as the slice went 50 → 25 → 13, and n=50 in *one* process (36.2ms)
was slower than n=100 across *four* (10.1ms). The dominant term is how many participants share
an event loop — an artefact of measuring hundreds of clients on one machine, which real
participants in separate browsers do not do. The package's own contribution is somewhere below
these numbers; this bench cannot resolve it.

**n ≥ 200 is where games stop starting reliably** — 1 of 6 runs at n=200 against 5/5 at n=100
and 3/3 at n=150. The failure is a malformed websocket close frame during Empirica's O(n²)
game-start burst, it reproduces with stock Classic and no `withNetwork` registered at all, and
the server logs nothing. Detail and reproduction: `docs/PLATFORM-NOTES.md` §16. Once a game
starts, n=200 runs fine — the table row is about *starting*, not about steady state.

Two earlier claims here were wrong and are replaced rather than carried forward. "Verified: ~1×
the theoretical floor" was inherited from the spike, a different codebase measured before
projection, validation, the recording proxy and the private state path existed. The figures that
replaced it (`p50 52.4ms`, praised for a "very tight" distribution) were an artefact of the
bench's own 25ms polling: measured side by side on the same rounds, polled p50 52.4ms against a
true 33.3ms, with 49 of 55 samples on one bin edge. The bench no longer polls.

Each line above is still a single run, where `SPIKE-REPORT.md` §5–6 asks for three with fresh
servers before a number is published.

This is enforced, not just documented. An out-of-envelope topology is refused at game
start — *before* channels are provisioned, since Tajriba cannot unlink and a late failure
would leave links behind:

```js
withNetwork(Empirica, {
  topology: ...,
  envelope: {
    maxDegree: 16,                  // default is `n - 1` at n <= 50, else 16 — measured
    maxViewBytes: 8192,             // NOT measured — a mistake detector
    maxNeighbourhoodBytes: 65536,   // NOT measured either — see below
    onExceed: "throw",              // "warn" to proceed anyway
  },
});
```

**All three rest on different evidence and the error messages say which.**

- `maxDegree` comes from measurement, and since 2026-08-16 it depends on n: `n - 1` at n ≤ 50
  (complete graphs measured there), 16 above it (only sparse graphs measured there). Set a number
  to override; a breach of *your* number says so rather than citing our bench.
- `maxViewBytes` does not come from measurement: a single neighbour view over 8 KiB almost always
  means `project()` returned more than intended. Raise it freely if your projection is genuinely
  that large.
- `maxNeighbourhoodBytes` caps what one participant receives per publish, summed over their
  neighbours. It exists because of a gap in the degree measurement rather than in spite of it —
  the bench that lifted the degree cap published two fields per view, so it says nothing about
  degree × view size, which is the product a connection carries. 49 views of 1.5 KiB are each
  inside `maxViewBytes` and total 73 KiB; only this limit sees that.

## Development

```sh
npm test                                       # unit + mode + e2e
npm test -- unit mode                          # the cheap tiers, no server needed
npm run test:one test/e2e/rand2011.test.ts     # one e2e file, for the inner loop
npm run test:repeat -- test/e2e/chat.test.ts 25   # the same file 25 times, reporting a rate
npm run check
npm run build
npm run example:install                        # pack and install into all three examples
npm run example:build                          # vite build every example client
```

**Reading a red e2e suite.** One failure mode in this suite is intermittent: a 30-second
"gameID assigned" timeout, in whichever file happens to be running when it strikes (`ISSUES.md` O8).
Re-running that file once tells you very little, because the rate is roughly **8% per file** — a green
re-read is the likely outcome whether or not anything is wrong. Measure a rate instead:

```sh
npm run test:repeat -- test/e2e/<the-file-that-failed>.test.ts 25
```

One or two failures in 25 is O8. Twenty-five is a regression.

Orphaned harness servers are swept by the runner itself now, and the count printed, so a dirty machine
cannot masquerade as a code regression. By hand:

```sh
pkill -f "empirica-networks-.*tajriba.toml"
```

The Empirica CLI execs a versioned binary as its own child, so killing the CLI leaves the real
server running and holding its port (`ISSUES.md` U6). Accumulated orphans starve player
assignment, and the suite then fails on a rotating victim — which has cost real investigations more
than once.

Requires **Node 20** and the Empirica CLI. e2e tests are bundled before running, because the
published `@empirica/core` cannot be loaded from raw Node in either module system — see
`docs/PLATFORM-NOTES.md`, which records every platform constraint with the date and versions
it was measured against.
