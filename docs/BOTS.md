# Bots

Artificial participants: `empirica-networks/bots`.

Empirica v2 ships none — searched, measured, and recorded as
[PLATFORM-NOTES §16](PLATFORM-NOTES.md#16-there-is-no-artificial-player-facility-caution). Empirica v1 had
them, so assuming they exist is the natural mistake. This entry point is the facility, built the
only way the platform allows.

A bot here is a headless participant process. It opens a real Tajriba session, runs the real
participant mode, reads its neighbours through the same `project()` and writes through the same
private channel a browser writes to. There is no server-side path, and that is a design constraint
rather than an unfinished edge: a bot that could read a non-neighbour, see the graph, or learn the
global state would be a different kind of object from the people it is mixed in with, and any
comparison between them would be measuring the difference in access.

This is also a structural requirement rather than a choice. This package's topology is defined over
`game.players`; Empirica creates a player only for a connected participant, and provisioning skips
players with no `participantID`. A node with no participant behind it has no seat and no private
channel.

---

## 1. Visibility of bots on the wire

Every participant in a game receives every other participant's `participantIdentifier` — the
raw value of `?participantKey=`. Classic writes it as an immutable attribute on the player scope at
`PARTICIPANT_CONNECT`, and links every participant to every player node, so it arrives on
everybody's wire. Measured 2026-08-16 against `@empirica/core@1.12.5`; witness
`test/e2e/bots.test.ts`, *"a co-player's recruitment identifier is on the wire"*. Filed as
[`ISSUES.md`](../ISSUES.md) **U10**.

Two consequences, and they are separate.

For bots, there is no naming scheme a bot can use that participants cannot read. `bot-1` is not
a private detail of your runner's configuration; it is on screen, in a browser, one
`JSON.stringify` away. If your design does not tell subjects which of their neighbours are software
— Shirado & Christakis (2017) does not — then a recognisable identifier is not a metadata leak, it
is the manipulation disclosed.

For every study, whether it uses bots or not, `participantKey` carries the recruitment identity in
a deployed study: the Prolific PID, the MTurk worker ID, whatever the recruitment URL put there.
Co-players learn it. That is a property of the upstream platform, and it affects every Empirica
Classic study.

So the API is shaped around it:

- `runBots` takes `identifiers`, and **requires** them. There is no `count` that invents names,
  because inventing them is the decision with the consequence.
- `botIdentifiers(n)` generates keys shaped like the ones Empirica's own client generates — a
  13-digit millisecond timestamp, matching `createNewParticipant`. That is a development
  default. If your humans arrive as 24-character Prolific PIDs, three 13-digit numbers among them
  are the three bots, in order.
- The runner warns, once, if any identifier contains `bot`, `agent`, `robot`, `simulat`,
  `artificial`, `virtual`, `npc`, `fake`, `dummy`, `test` or `debug`. It is a heuristic with false
  positives and false negatives; it catches the mistake that is actually made.
- A duplicate identifier **throws**. Tajriba identifies a participant by that string, so two bots
  sharing one are one participant with two sockets: the game sits one player short of its count
  forever and nothing anywhere says why.

In a real run, pass identifiers drawn from the same space as your recruitment keys.

---

## 2. Structure of a bot script

```js
// bots.mjs — plain `node bots.mjs`, no bundler, no tsx
import { botIdentifiers, runBots } from "empirica-networks/bots";

const run = await runBots({
  url: "http://localhost:3000/query",
  identifiers: process.env.BOT_KEYS.split(","),
  seed: 1,
  policy: {
    tickMs: 1500,
    onTick(ctx) {
      const neighbours = ctx.neighbors();
      if (neighbours === undefined) return;            // no view yet
      const mine = ctx.state().get("choice");
      const next = decide(mine, neighbours, ctx.rng);  // your rule, pure
      if (next !== mine) ctx.state().set("choice", next);
    },
  },
});
```

`url` is the **HTTP** endpoint, not the websocket one. Tajriba derives `ws://` from `http://` (and
`wss://` from `https://`) itself, and rejects a url that already carries a websocket scheme — so
`ws://localhost:3000/query`, which reads like the right answer, is the wrong one. `runBots` checks
the scheme and says so; left to Tajriba it throws the bare string `"invalid URL"`, which has no
stack and names no frame in this package.

`runBots` resolves once every bot has a session, not when a game ends. One fleet plays a whole
batch: Classic reassigns a participant when their game finishes, and the runner follows that —
`onEnd`, then `onStart` for the next game.

### Hooks

| | |
|---|---|
| `onStart(ctx)` | The bot's channel published its first view. Once per game — the earliest point at which `neighbors()`, `self()` and `state()` all return something |
| `onView(ctx)` | What this bot can see changed. Driven by the server's publish counter, so a neighbour rewriting the same value does not wake it |
| `onTick(ctx)` | Every `tickMs`, from the first publish until the game ends. Needed by any policy that must act when *nothing* changed — which includes every deliberately-noisy agent |
| `onEnd(ctx)` | This bot's game is over. For flushing what the policy accumulated, not for a last move |

Every hook is **synchronous**. A returned promise is not awaited, and a write made after an `await`
lands outside the runloop's flush and reaches nobody — the same trap
[PLATFORM-NOTES §14](PLATFORM-NOTES.md#14-writes-only-count-inside-a-callback-caution) documents,
arriving by another road. A throw is caught, logged and swallowed: with three bots in a
twenty-person session, one policy failing must not leave the study one player short.

### What a policy can see

`ctx.neighbors()`, `ctx.self()`, `ctx.state()`, `ctx.told()` — exactly the four a browser has, and
`undefined` before the channel exists. `ctx.neighbors()` returns `undefined` rather than `[]` before
the first publish, for the reason `neighborsOf` does: an empty array is a legitimate result, and
conflating it with "not loaded" would have a bot act on an imagined isolation.

`ctx.rng` is a deterministic stream seeded from `(seed, identifier)`. Use it instead of
`Math.random()`. If the bots' randomness is part of your manipulation — it is the whole
manipulation in Shirado & Christakis — then an unrecorded random stream is an unrecorded
independent variable. Same `seed`, same `identifiers`, same behaviour.

`ctx.log(record)` appends to the runner's log. The bot half of `net.log()`, for the same reason: a
study that is killed mid-session should still have what its bots did.

---

## 3. Recruitment counts

The treatment's `playerCount` is the size of the **network**, bots included. A twenty-node session
with three bots needs seventeen people.

Getting this wrong produces a study that never starts and says nothing about why, which is why the
runner says it instead: a bot stuck in the `waiting` phase prints

> connected but not assigned to a game. Classic assigns on batch start, so either no batch is
> running, or the batch's games are already full. Remember the treatment's playerCount counts bots:
> recruit playerCount - botCount humans, not playerCount.

The six phases are `connecting`, `waiting`, `intro`, `starting`, `playing` and `ended`, in that
order. `run.phases()` returns the current one per bot and is the first thing to look at when a
study will not start; each has a stall reason naming what to check. A bot that sits in any
non-playing phase for 30 s warns once, on stderr and in the log.

---

## 4. Placement

Bots at particular positions — central, peripheral, random — is a manipulation in its own right,
and it is expressed through the topology function:

```js
topology: ({ game, players, playerCount, rng }) => {
  const graph = barabasiAlbert(playerCount, 2, { rng });
  const botSeats = players.flatMap((p, i) => (isBot(p) ? [i] : []));
  return placeBots(graph, playerCount, botSeats, "central", rng);
}
```

`players[i]` is the participant who will occupy topology index `i` — the package's
[seating guarantee](API.md), pinned by `test/unit/seating.test.ts`. Seats are fixed before
`topology` is called, so placement is done by **relabelling the graph**, not by reordering people:
generate the structure you want, then permute the vertex labels so the seats you care about land on
the degrees you want.

Relabelling matters beyond convenience. It keeps the degree distribution identical across arms, so
a "central" condition differs from a "peripheral" one only in *who sits where*. A placement
implemented by generating a different graph would manipulate structure and position at once, and no
analysis could separate them afterwards. `examples/shirado2017/server/src/design.js` has a worked
`placeBots`, and `test/unit/shirado2017.test.ts` asserts the degree sequence is unchanged in every
arm.

The server has to know which players are bots, and can only know by holding the list. There is
no pattern to match on — see §1. Give the same identifiers to both processes:

```sh
export BOT_KEYS=$(node bots.mjs --keys)   # the runner prints a set
BOT_KEYS=$BOT_KEYS empirica               # and the server gets the same one
BOT_KEYS=$BOT_KEYS node bots.mjs
```

Then, server-side, `player.get("participantIdentifier")` against that list.

---

## 5. Informing a bot of its condition

Do not give the runner its own copy of the experimental condition. Two processes each reading their
own config is how a study runs 10%-noise agents and records them as 30%, with nothing anywhere
disagreeing.

Send it down the bot's own private channel instead, so the treatment is the only source:

```js
// server, at stage start — tell() needs the channel to exist
for (const playerID of botPlayerIDs) network(game).tell(playerID, "noise", treatment.botNoise);

// bot
const noise = ctx.told()?.get("noise");
if (typeof noise !== "number") return;   // not configured yet: wait, do not guess
```

The bot then *cannot* act on a value the server did not send. Waiting is the right failure: acting
on a default would run the agent in a condition the session will be labelled with. Warn loudly if
it never arrives — `examples/shirado2017/server/bots.mjs` does, after ten seconds, once.

This does not weaken the read guarantee. `tell()` writes to one participant's own channel, is
validated by the same `validateProjection` as a view, and no participant learns what any other was
told. `project()` remains the only path by which one participant's data reaches another.

---

## 6. Recording which nodes are bots

Nothing in the data says which participants were software. That is the property the bots were built
to have — same key, same kind of channel, same code path — so it has to be recorded deliberately:

- the **seats**, so an analysis can check the placement happened rather than trust the label. A
  placement bug produces a complete, plausible table with the manipulation silently absent;
- a **per-action flag**, so behavioural measures can exclude them. An analysis of human behaviour
  that forgot to would be averaging over a population it chose.

`examples/shirado2017` writes both: `bots`, `bot_placement`, `bot_noise` and `bot_indices` in
`session.csv`, and `is_bot` in `changes.csv`. Note that `bot_noise` is **empty** rather than `0` in
the human-only arm — "no agents" and "agents with zero noise" are two different conditions, and a
`0` in both would merge them.

---

## 7. Running bots with plain `node`

`empirica-networks/bots` ships as a **bundled CJS artefact**, and the export map has a single
`default` condition rather than an `import` that would resolve and then fail. `@empirica/core/admin`
— which the runner needs for `TajribaConnection` — cannot be loaded from bare Node ESM
([§3a](PLATFORM-NOTES.md#3a-the-published-empiricacore-cannot-be-loaded-from-raw-node-at-all-significant-risk)),
so the package does that bundling once instead of asking every study to set up a bundler.

Both forms work:

```js
import { runBots } from "empirica-networks/bots";          // .mjs
const { runBots } = require("empirica-networks/bots");     // .cjs
```

One consequence, stated rather than left to be discovered: the bundle carries its own copy of
`@empirica/core`, so a process importing **both** `empirica-networks/bots` and
`empirica-networks/player` holds two `Scope` classes. Nothing crosses that boundary today — a
policy sees plain JSON and plain accessors — but a bot script that starts passing scope objects
around will find it.

---

## 8. Limitations

- The runner provides no reconnection policy. A bot whose socket drops stays down. Tajriba's client
  reconnects, but nothing here re-establishes a session or re-enters a game, and a restarted server
  cannot put anyone back in their game anyway ([`ISSUES.md`](../ISSUES.md) U2).
- The runner provides no lobby, consent or exit-survey behaviour. It sets `introDone` and nothing
  else on the player scope. A design whose intro steps gate on other player attributes needs the
  policy to write them.
- The runner provides no rate limiting. `tickMs` is the only pace control. Three bots at 100 ms in
  a twenty-person game will out-move the humans, and the speed of an agent is not a neutral
  parameter — see the note on `BOT_INTERVAL_MS` in the Shirado example.
- The runner makes no claim about how human-like anything is. It puts an agent at a node and runs
  your rule. Whether that rule resembles a person is your design's problem, and the paper you are
  reconstructing is the place to argue it.

---

## 9. Worked example

`examples/shirado2017` reconstructs both arms of Shirado & Christakis (2017): the 30 control
sessions and the agent conditions — 3 agents × 3 noise levels × 3 placements — that are the paper's
actual contribution.

| | |
|---|---|
| `server/src/design.js` | `botChoice` and `placeBots`: pure, imports nothing, unit-tested |
| `server/src/callbacks.js` | placement, `tell`-ing each agent its noise level, and `is_bot` in the export |
| `server/bots.mjs` | the runner process — when to ask, and what to do with the answer |
| `.empirica/treatments.yaml` | the eleven arms |

See its README for how to run one, and `ISSUES.md` O10 for what it took.
