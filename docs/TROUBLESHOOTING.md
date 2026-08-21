# Troubleshooting — symptom first

Indexed by **what you observed**, because that is the only key a stuck person has. Everything
here is documented somewhere else in more depth; this page exists so you do not have to already
know the answer in order to find it.

Most of this package's failure modes are *silent* — a listener that does not run, a read that
returns `undefined`, a view that never updates — so the first section is for when nothing has
gone wrong loudly. If you have an error message, jump to [§2](#2-errors-this-package-raises).

---

## 1. Nothing errored, and something is wrong anyway

### Every participant is stuck on "Waiting for other players", with a full game

And the server log is full of zod stack traces mentioning neither this package nor anything
recognisable.

**Cause: two copies of `@empirica/core` in one bundle.** You installed with a `file:` link, npm
made a symlink, and the linked directory has its own `node_modules/@empirica/core`. Every
`instanceof` inside Empirica then fails against the other copy's classes.

Counting strings in the bundle does not reveal it. Comparing class identity does:

```js
import { classicKinds } from "@empirica/core/admin/classic";
import { networkKinds } from "empirica-networks/admin";
classicKinds.game === networkKinds.game;   // false → you have two copies
```

**Fix:** install from a packed tarball instead. `npm pack` in this repo, then
`npm --prefix server install /path/to/empirica-networks-0.0.0.tgz`. `npm run example:install`
does exactly this for the bundled examples.

`docs/PLATFORM-NOTES.md` §11 · `docs/GETTING-STARTED.md` §2

### Participants sit with empty neighbourhoods forever, and nothing errors

**Cause: `networkKinds` was not registered**, so the private channels are never modelled, and
there is nothing to write views to.

**This is detected.** Once the first game's channels have had time to come back and none has, you
get:

```
empirica-networks: 2 private channels were created 5s ago and none has materialised. Two
things do this, and this process cannot tell them apart.

1. THE "nbhd" SCOPE KIND IS NOT REGISTERED — the likely one, and silently fatal: …
   … the diff …
2. The subscription is only slow. …
```

**Fix:** in `server/src/index.js`, pass `networkKinds` to `AdminContext.init` instead of
`classicKinds`. `docs/GETTING-STARTED.md` §3 has the diff, and the warning prints it too.

To fail *before* the server starts rather than a few seconds into the first game, call the eager
check where you build the map:

```js
import { assertKindsRegistered, networkKinds } from "empirica-networks/admin";
assertKindsRegistered(networkKinds);   // throws with the diff
const ctx = await AdminContext.init(…, networkKinds);
```

**If it IS registered and you see this warning**, the subscription was merely slow, and the
package will retract the warning itself the moment a channel arrives:

```
empirica-networks: RETRACTING the registration warning above — it was wrong. A channel
materialised 24.1s after 200 were created, past the 20s deadline …
```

Nothing to fix when you see that. The deadline scales with the number of channels
(`docs/API.md` "Registration") and is sized from latencies measured up to n=200, so a retraction
means your setup beat the measurement — worth reporting with the participant count.
`net.inspect(gameID).pendingChannels` lists who is still missing;
`net.stats().firstChannelMs` is the figure itself.

`docs/PLATFORM-NOTES.md` §6, §16a

### A private value reads back as `undefined`, and the manipulation silently does nothing

The participants submitted. The screens looked right. The server read their answers as "not
submitted" and did nothing.

**Cause: the key is in neither `watch` nor `read`.** `net.inspect().nodes[i].state[key]` returns
`undefined` for an undeclared key, an ended game, a player outside the graph, and a channel that
has not materialised — all of which look identical to "they have not written it yet".

This is how `examples/rand2011` ran a whole study in which the rewiring manipulation did nothing:
`rewireAnswers` was undeclared, every answer read back as `undefined`, and the network never
changed in the condition whose defining feature is that it changes.

**Fix:** declare the key, and read it with `net.stateOf(game, playerID, key)` rather than through
`inspect()`. `stateOf()` throws for all four of those cases, naming the fix; `undefined` from it
means exactly one thing — they have not written the key.

```js
withNetwork(Empirica, { …, read: ["rewireAnswers"] });
const answers = net.stateOf(stage.currentGame, playerID, "rewireAnswers");
```

`ISSUES.md` O11 · `docs/GETTING-STARTED.md` §4

### The second `onStageEnded` (or `onGameStart`, or …) never runs

```js
Empirica.onStageEnded(({ stage }) => { if (stage.get("name") === "decide") … });   // runs
Empirica.onStageEnded(({ stage }) => { if (stage.get("name") === "rewire") … });   // NEVER runs
```

**Cause: upstream U8.** The six lifecycle helpers are wrapped in a `unique` guard whose
"already ran" marker is stored on the *scope*, so it is shared by every listener for that event.
The first callback to run sets it and every later one silently returns.

**Fix:** one registration per event, dispatch inside it.

`withNetwork` counts registrations at server start and warns:

```
empirica-networks: a lifecycle listener is registered more than once, and ONLY THE FIRST WILL EVER RUN.

    onStageEnded()  registered 2 times  (stage/ended)
```

Read the warning rather than trusting it blindly — it cannot distinguish a duplicated helper from
two plain `Empirica.on("stage", "ended", cb)` calls when both callbacks are anonymous 2-argument
async functions, and those are legitimate. Plain `Empirica.on(kind, key, cb)` is **not** affected
by U8.

`docs/PLATFORM-NOTES.md` §18, §18a · `ISSUES.md` U8

### A mutation reaches nobody, and the server's own state looks correct

```js
setInterval(() => network(game).addEdge(a, b), 1000);   // ✗ silently reaches nobody
```

**Cause: writes only count inside a callback.** The runloop flushes the `set()` calls made while
it is processing one. A mutation driven from a timer, an HTTP handler or a test updates the
server's own memory correctly and then never goes out.

**Fix:** drive it from a listener, or queue it and apply it from one.

**Reads are safe anywhere** — `inspect()`, `stateOf()` and `net.log()` can be called from a
timer, an HTTP handler or a REPL.

The same trap arrives by a different road inside `onPrivateState`: the hook is **synchronous**, a
returned promise is not awaited, and any write made after an `await` inside it lands outside the
flush.

`docs/PLATFORM-NOTES.md` §15

### Everyone can see a value that was supposed to be neighbour-limited

**Cause: it was written with `player.set()`.** Classic cross-links every participant to every
player node, so a player attribute is broadcast to everyone. Projecting it restricts nothing —
the raw attribute is already out.

**Fix:**

```jsx
const state = useNetworkState();
state.set("choice", "A");    // ✓ private: this participant's own channel
player.set("choice", "A");   // ✗ broadcast, whatever your topology
```

And on the server, read neighbour state through `ctx.stateOf(neighbour)`, not `neighbour.get(…)`.

`docs/GETTING-STARTED.md` §5 · `docs/ARCHITECTURE.md` §5

### `useNeighbors()` is `undefined`

**Not a bug.** `undefined` means no view has been published to this participant yet; `[]` means a
genuinely isolated node. The hook refuses to conflate them, because returning `[]` while loading
would render a participant as isolated, look entirely normal, and quietly corrupt the data.

Branch on it the way you already branch on `usePlayer()`.

If it *stays* `undefined` after the game starts, one participant in the game has no channel — see
the next entry.

`docs/GETTING-STARTED.md` §5

### One participant has no channel, and now nobody's view updates

**Cause: a player with no `participantID` gets no channel, and `publish` refuses to send a
partial view** — so one unprovisioned player blocks every view in the game. This is deliberate: a
partial publish leaves participants stale with no signal.

It is not silent. Look for:

```
empirica-networks: N of M players have no participantID …
```

**It repairs itself when they connect.** Provisioning otherwise runs once, at game start, so
`ParticipantConnect` re-runs it for whoever is still missing and everyone's view unblocks
together. If the message names players who never connect, the game stays blank: end it or restart
the batch.

`docs/ARCHITECTURE.md` §3 step 7 · `ISSUES.md` O4

### Views never update after the first publish

**Cause: the key your `project()` reads is not in `watch`.** Empirica has no wildcard attribute
listener, so the list cannot be inferred.

It is not silent — `project()` runs against a recording proxy, so anything it reads that is not
declared is reported:

```
empirica-networks: project() reads player attribute(s) …
```

**Fix:** add the key to `watch`. (Not `read` — mechanically identical, but `watch` is the one
that says "the projection depends on this".)

### Chat messages never arrive

**First cause: chat is off.** It costs a listener and per-channel storage, so it is opt-in, and
`useNeighborChat()` returns `undefined` until it is on.

```js
withNetwork(Empirica, { …, chat: true });      // or { history: 200 }
```

**Second cause: the recipient was not a neighbour when the message was sent.** A message goes to
whoever is the sender's neighbour *at that moment*, plus the sender. Messages land on the
**recipient's** channel, so a rewire stops new messages arriving without erasing the conversation
already delivered — which is the intended behaviour and can read as "chat broke" in a design that
rewires mid-conversation.

`docs/API.md` `chat?:`

### A restart brought the server back, and no game resumed

**Cause: upstream U2.** A full restart reloads the store, but `gameID` is never restored and no
game resumes. It can also leave two player scopes for one participant.

**There is no fix.** No amount of configuration or documentation makes a crashed study resumable.
Plan for a crash mid-study to end the games in progress, and turn on the run log
(`log: { file }`) so a killed study still leaves analysable data — `onGameEnded` only fires when
a game ends *naturally*.

`ISSUES.md` U2 · `docs/PLATFORM-NOTES.md` §4e

### The session ran, and `data/` is empty

**Cause: your exports are written in `onGameEnded`, which fires only when a game ends
*naturally*.** A session that was killed, crashed, or stopped by hand never reaches it, and
neither does a test that tears its server down first. Measured: a green run of
`test/e2e/rand2011.test.ts` left `views.ndjson` and not one CSV.

**Fix, and it has to be in place before the run:** turn on the run log and write to it as you go.

```js
withNetwork(Empirica, { …, log: { file: "data/run.ndjson" } });
net.log(stage.currentGame, { type: "round", round, rows });
```

It is unbuffered by default, so a hard kill loses nothing, and one file covers the whole study —
every record carries its `gameID`. Both reconstructions ship a `recover.mjs` that rebuilds their
CSVs from it, byte-identically to a clean finish.

**Log the events, not the state they add up to.** A script that reconstructs an edge list from a
final snapshot recovers an empty `edges.csv` for a static network, or one whose timestamps it
invented; logging `network(game).history()` verbatim recovers the real table.

`docs/DATA-AND-ANALYSIS.md` §6 · `docs/GETTING-STARTED.md` §9

### Games do not reliably start at n ≥ 200

**Cause: upstream U7.** Game start corrupts the websocket stream at scale — measured at 1 run in
6 at n=200, and it reproduces with stock Classic, without this package.

**Fix:** stay inside the measured regime. n ≤ 50 at any density is where everything here has
margin.

`ISSUES.md` U7 · `docs/PLATFORM-NOTES.md` §16

### The bots are connected and the study never starts

**Cause: the treatment's `playerCount` counts the bots.** It is the size of the network, so a
twenty-node session with three agents needs **seventeen** people. Recruit `playerCount` humans
instead and the games are permanently one short of full.

It is not quite silent — a bot that sits in one non-playing phase for 30 s says so once, on
stderr and in the log, and names this:

```
connected but not assigned to a game. Classic assigns on batch start, so either no batch is
running, or the batch's games are already full. Remember the treatment's playerCount counts
bots: recruit playerCount - botCount humans, not playerCount.
```

**Fix:** `run.phases()` is the first thing to read — it gives the current phase per bot, and each
of `connecting → waiting → intro → starting → playing → ended` has its own stall reason naming
what to check.

`docs/BOTS.md` §3

### The bots are in the game and never act

Three causes, in the order they are worth checking.

**A policy with no `onTick` only acts when something changed.** `onView` fires on the server's
publish counter, so an agent that must move when nothing moved — which includes every
deliberately-noisy one — needs `onTick` and a `tickMs`. Setting `onTick` without `tickMs` throws
rather than producing a bot that never fires.

**The view has not arrived.** `ctx.neighbors()` is `undefined` before the first publish, and a
policy that returns early on `undefined` is correct; if it stays `undefined`, the bot's channel
never materialised — see "empty neighbourhoods forever" above.

**The condition never arrived.** A policy told its parameters over `ctx.told()` should wait
rather than guess, so a `tell()` that was never sent leaves it idle by design. Warn loudly on the
bot side when it does not arrive; `examples/shirado2017/server/bots.mjs` does, after ten seconds,
once.

And a policy that **throws** is caught, logged and swallowed — one failing agent must not leave
the study a player short — so a bot that stopped acting after one tick is in the log, not in an
exception.

`docs/BOTS.md` §2, §5

### An offline analysis script dies on import

```
Error [ERR_REQUIRE_ESM] / Cannot find module … @empirica/core
```

**Cause:** `@empirica/core` cannot be loaded from raw Node in either module system, and anything
importing `empirica-networks/admin` pulls it in.

**Fix:** import the pure helpers from the offline subpath, which has no `@empirica/core` in its
graph:

```js
import { edgeRows, snapshotRows, viewRows, parseNdjson, toCSV } from "empirica-networks/export";
```

`docs/PLATFORM-NOTES.md` §3a · `ISSUES.md` O13

### The e2e suite is red on a rotating victim, with a "gameID assigned" timeout

**Two different causes, in this order.**

First, **orphaned harness servers**. The Empirica CLI execs a versioned binary as its own child,
so killing the CLI leaves the real server running and holding its port. Accumulated orphans
starve player assignment.

```sh
pkill -f "empirica-networks-.*tajriba.toml"
```

Second, **whole-run weight**. `npm test -- e2e` is the reliable signal. A full `npm test`
intermittently loses one or two of O8's documented victims (`scope_visibility`, `told`,
`topology_visibility`) on `gameID assigned`, and an orphan sweep immediately beforehand does not
prevent it. That is run weight, not a regression.

**Read a red run in the right place:** sweep orphans → re-run the tier alone → run the file alone
(`npm run test:one <file>`) before concluding anything.

`ISSUES.md` O6, O8 · `docs/M6-HARDENING.md` Tier 4

---

## 2. Errors this package raises

Every one of these is deliberate — each replaced a silent failure. The message names the fix; this
table is for finding the *context*.

| Message begins | What happened | Where to look |
|---|---|---|
| `the "nbhd" scope kind is not registered` | `networkKinds` not passed to `AdminContext.init` | GETTING-STARTED §3 |
| `stateOf() was asked for private key …` | The key is in neither `watch` nor `read` | §1, "reads back as `undefined`" |
| `topology exceeds the supported envelope` | The graph is denser than `maxDegree`. Refused **at game start**, before any channel exists, so the experiment is still abandonable. The message names the worst node and the two overrides | API.md, [Envelope](API.md#envelope) · TOPOLOGIES |
| `N neighbour view(s) exceed … bytes` | One neighbour's projection is over `maxViewBytes` (8192) | API.md, [Envelope](API.md#envelope) |
| `N participant(s) would receive more than … bytes in one publish` | Degree × view size is over `maxNeighbourhoodBytes` (64 KiB). Each view is individually legal; together they are not | API.md, [Envelope](API.md#envelope) |
| `the projection at … is a function` / `a BigInt` / `contains a cycle` / `is a scope` | `project()` returned something JSON cannot carry, or the scope itself. Nothing was sent — validation runs before the publish | API.md, `project()` |
| `no network for game …` | The game has not started, has ended, or `withNetwork()` was never called on this collector | ARCHITECTURE §3 |
| `game … is not networked by this process` | Ended, never started, or lost to a restart (U2) | ARCHITECTURE §3 |
| `game … was networked by a previous process but has no recorded edge list` | A restart found the game but not its network, so it cannot be recovered (warning) | `ISSUES.md` U2 |
| `player … has no materialised channel in game …` | Channel has not arrived yet, or the player has no `participantID` | ARCHITECTURE §3 step 7 |
| `player … is not in game …'s network` | Player is outside the topology — check your `order` assumptions | — |
| `project() threw while building X's view of Y` | Your projection threw; the cause is attached | — |
| `project() reads player attribute(s) …` | Declare them in `watch` (warning, not an error) | §1, "views never update" |
| `game … has no batch` | The realised network cannot be recorded, so the run is neither reproducible nor restart-survivable | ARCHITECTURE §3 step 6 |
| `net.log() was called but no run log is configured` | Add `log: { file }` to the config | DATA-AND-ANALYSIS |
| `a lifecycle listener is registered more than once` | U8 (warning) | §1, "the second `onStageEnded`" |
| `N of M players have no participantID` | Unprovisioned players are blocking every publish (warning) | ARCHITECTURE §3 step 7 |
| `the neighbourhood scope exists but its attributes are unreadable` | `DonesWiringError` — the client-side dones protocol broke, almost certainly an upstream version change | ARCHITECTURE §8 |
| `the participant context was built without the network mode` | `modeFunc={EmpiricaNetwork}` is missing from `<EmpiricaParticipant>` | GETTING-STARTED §5 |
| `EmpiricaClassic no longer returns "…"` | Upstream changed the classic context shape; the composed mode is out of date | ARCHITECTURE §6 |
| `monitor() needs the handle returned by withNetwork()` | Pass `net`, not the collector | API.md, [`monitor()`](API.md#monitornet-options) |
| `cannot connect X to itself` | A self-loop was requested | — |
| `runBots needs at least one identifier` | The list is the bot count; there is no `count` that invents names | BOTS §1 |
| `duplicate bot identifier(s): …` | Two bots sharing a key are one participant with two sockets, and the game sits one short forever | BOTS §1 |
| `a policy with onTick must set tickMs` | Without it the tick would never fire, so it is refused rather than silently idle | BOTS §2 |
| `N of M bot identifier(s) …` | An identifier names itself (`bot`, `agent`, `robot`, …) and participants can read it (warning, U10) | BOTS §1 |
| `bot X has been in phase "…" for …` | A bot has been stuck in one non-playing phase for 30 s (warning). The message names what to check for that phase | §1, "the bots are connected and the study never starts" |

---

## 3. When it is none of these

1. **Run `verify`.** If the guarantee itself is intact, the problem is in your design rather than
   the mechanism:
   ```sh
   node dist/verify/cli.cjs verify --n 4     # from a clone
   ```
2. **Turn on the monitor** (`MONITOR=1 empirica`) and look at the graph, the per-node state, the
   publish counts, and any channel that has not materialised. It shows the things you cannot see
   from inside the experiment. Do not expose it beyond localhost.
3. **Check `ISSUES.md`** — U-numbered entries are upstream and generally cannot be fixed here.
4. **Check `docs/PLATFORM-NOTES.md`** — every constraint is recorded with the date and version it
   was measured against, so a behaviour that contradicts one may simply be newer than the note.

Found something not on this page? It belongs here. This is the file that should grow fastest.
