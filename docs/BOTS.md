# Bots

The `empirica-networks/bots` module provides artificial participants.

Empirica v2 omits the artificial-player facility available in version 1, as documented in
[PLATFORM-NOTES §16](PLATFORM-NOTES.md#16-there-is-no-artificial-player-facility-caution). This
module restores that capability within the constraints of the current platform.

A bot is a headless participant process. It opens a Tajriba session, runs the participant mode,
reads its neighbors through `project()`, and writes through the same private channel as a browser.
This common access path gives bots and human participants the same information, allowing
comparisons to focus on behavior.

The platform also requires this structure. The package defines its topology over `game.players`,
and Empirica creates a player for each connected participant. Provisioning requires a
`participantID`, so every network node must correspond to a participant with a seat and private
channel.

---

## 1. Visibility of bots on the wire

Every participant in a game receives every other participant's `participantIdentifier`, the
raw value of `?participantKey=`. Classic writes it as an immutable attribute on the player scope at
`PARTICIPANT_CONNECT`, and links every participant to every player node, so it arrives on
everybody's wire. Measured 2026-08-16 against `@empirica/core@1.12.5`; witness
`test/e2e/bots.test.ts`, "a co-player's recruitment identifier is on the wire". Filed as
`docs/PLATFORM-NOTES.md` §21.

This behavior has two distinct consequences.

Participants can read any identifier assigned to a bot. A value such as `bot-1` is therefore part
of the information available in the browser rather than a private runner setting. Studies that
conceal which neighbors are software, as in Shirado and Christakis (2017), should use identifiers
that reveal no bot status.

In any deployed study, `participantKey` may contain a recruitment identifier such as a Prolific
PID. Empirica Classic shares this value with co-players. Use an opaque, study-specific token and
store its mapping to recruitment identities outside Empirica.

So the API is shaped around it:

- `runBots` takes `identifiers`, and requires them. There is no `count` that invents names,
  because inventing them is the decision with the consequence.
- `botIdentifiers(n)` generates keys shaped like the ones Empirica's own client generates: a
  13-digit millisecond timestamp, matching `createNewParticipant`. That is a development
  default. If your humans arrive as 24-character Prolific PIDs, three 13-digit numbers among them
  are the three bots, in order.
- The runner warns, once, if any identifier contains `bot`, `agent`, `robot`, `simulat`,
  `artificial`, `virtual`, `npc`, `fake`, `dummy`, `test` or `debug`. It is a heuristic with false
  positives and false negatives; it catches the mistake that is actually made.
- A duplicate identifier throws. Tajriba identifies a participant by that string, so two bots
  sharing one appear as a single participant with two sockets. The game would otherwise remain
  one player short without an explanatory error.

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
      const neighbors = ctx.neighbors();
      if (neighbors === undefined) return;            // no view yet
      const mine = ctx.state().get("choice");
      const next = decide(mine, neighbors, ctx.rng);  // your rule, pure
      if (next !== mine) ctx.state().set("choice", next);
    },
  },
});
```

`url` is the HTTP endpoint, not the websocket one. Tajriba derives `ws://` from `http://` (and
`wss://` from `https://`) itself, and rejects a url that already carries a websocket scheme, so
`ws://localhost:3000/query`, which reads like the right answer, is the wrong one. `runBots` checks
the scheme and says so; left to Tajriba it throws the bare string `"invalid URL"`, which has no
stack and names no frame in this package.

If the policy imports the study's rules from the server's own source (it should, so that one
file is the rule and the bots are not a second implementation of it), name that shared file
`.mjs`, not `.js`. [Section 7](#7-running-bots-with-plain-node) says why, and why the obvious
alternative breaks the server's build.

`runBots` resolves once every bot has a session, not when a game ends. One fleet plays a whole
batch: Classic reassigns a participant when their game finishes, and the runner follows that:
`onEnd`, then `onStart` for the next game.

### Hooks

| | |
|---|---|
| `onStart(ctx)` | The bot's channel published its first view. Once per game, the earliest point at which `neighbors()`, `self()` and `state()` all return something |
| `onView(ctx)` | What this bot can see changed. Driven by the server's publish counter, so a neighbor rewriting the same value does not wake it |
| `onTick(ctx)` | Every `tickMs`, from the first publish until the game ends. Needed by any policy that must act when nothing changed, which includes every deliberately-noisy agent |
| `onEnd(ctx)` | This bot's game is over. For flushing what the policy accumulated, not for a last move |

Every hook is synchronous. A returned promise is not awaited, and a write made after an `await`
lands outside the runloop's flush and reaches nobody. That is the same trap
[PLATFORM-NOTES §14](PLATFORM-NOTES.md#14-writes-only-count-inside-a-callback-caution) documents,
arriving by another road. A throw is caught, logged and swallowed: with three bots in a
twenty-person session, one policy failing must not leave the study one player short.

### What a policy can see

`ctx.neighbors()`, `ctx.self()`, `ctx.state()`, `ctx.told()`, `ctx.structure()`: exactly the five a
browser has, and `undefined` before the channel exists. `ctx.neighbors()` returns `undefined` rather
than `[]` before the first publish, for the reason `neighborsOf` does: an empty array is a
legitimate result, and conflating it with "not loaded" would have a bot act on an imagined
isolation.

`ctx.structure()` is what this bot can see of the network, and is `undefined` unless the study runs
above `graph: { radius: 1 }`. It exists because the rule above cuts both ways: a bot must not see
more than a human, and above the default it must not see less either. A study can seat bots at a
wider radius and have them reason only locally — that is a design choice — but it should be a
choice, not an asymmetry nobody noticed.

From radius 2 the payload also carries `far`: people the bot can see and is not connected to, each
with the per-viewer name the server gave *this bot* for them — never an id, and never a name any
other participant would recognise. `test/e2e/bots.test.ts` runs a bot on a ring at radius 2 and
checks all of it: two people two hops away, a structure larger than the neighbor list, and no two
bots sharing a name for anybody.

One thing that test had to learn the hard way and a policy should know: on a **static** graph there
is exactly one publish, and the byte-identical check suppresses everything after it — so a policy
that listens only for `onView` never hears anything. `onStart` is where the first structure
arrives. A policy indexing `structure().edges`
by `neighbors()` must mind that boundary — `neighbors()` is distance 1 only — and the boundary is
the point rather than an inconsistency to work around: it is exactly the one a human in that seat
sees. Its third state, `null`, means the payload arrived and cannot be used;
treating it as `undefined` would have a policy reason about a star in a study that is not drawing
one.

`ctx.rng` is a deterministic stream seeded from `(seed, identifier)`. Use it instead of
`Math.random()`. If the bots' randomness is part of your manipulation (it is the whole
manipulation in Shirado & Christakis), then an unrecorded random stream is an unrecorded
independent variable. The same `seed` and the same `identifiers` produce the same behavior.

`ctx.log(record)` appends to the runner's log. The bot half of `net.log()`, for the same reason: a
study that is killed mid-session should still have what its bots did.

---

## 3. Recruitment counts

The treatment's `playerCount` is the size of the network, bots included. A twenty-node session
with three bots needs seventeen people.

An incorrect count prevents the study from starting. To make the cause explicit, a bot that
remains in the `waiting` phase prints

> connected but not assigned to a game. Classic assigns on batch start, so either no batch is
> running, or the batch's games are already full. Remember the treatment's playerCount counts bots:
> recruit playerCount - botCount humans, not playerCount.

The six phases are `connecting`, `waiting`, `intro`, `starting`, `playing` and `ended`, in that
order. `run.phases()` returns the current one per bot and is the first thing to look at when a
study will not start; each has a stall reason naming what to check. A bot that sits in any
non-playing phase for 30 s warns once, on stderr and in the log.

---

## 4. Placement

Placing bots at particular positions (central, peripheral, random) is a manipulation in its own
right, and it is expressed through the topology function:

```js
topology: ({ game, players, playerCount, rng }) => {
  const graph = barabasiAlbert(playerCount, 2, { rng });
  const botSeats = players.flatMap((p, i) => (isBot(p) ? [i] : []));
  return placeBots(graph, playerCount, botSeats, "central", rng);
}
```

`players[i]` is the participant who will occupy topology index `i`, the package's
[seating guarantee](API.md), pinned by `test/unit/seating.test.ts`. Seats are fixed before
`topology` is called, so placement is done by relabeling the graph, not by reordering people:
generate the structure you want, then permute the vertex labels so the seats you care about land on
the degrees you want.

Relabeling matters beyond convenience. It keeps the degree distribution identical across arms, so
a "central" condition differs from a "peripheral" one only in who sits where. A placement
implemented by generating a different graph would manipulate structure and position at once, and no
analysis could separate them afterwards. `examples/shirado2017/server/src/design.mjs` has a worked
`placeBots`, and `test/unit/shirado2017.test.ts` asserts the degree sequence is unchanged in every
arm.

The server has to know which players are bots, and can only know by holding the list. There is
no pattern to match on, as §1 explains. Give the same identifiers to both processes:

```sh
export BOT_KEYS=$(node bots.mjs --keys)   # the runner prints a set
BOT_KEYS=$BOT_KEYS empirica               # and the server gets the same one
BOT_KEYS=$BOT_KEYS node bots.mjs
```

Then, server-side, `player.get("participantIdentifier")` against that list.

---

## 5. Informing a bot of its condition

Use the server as the sole source of the experimental condition. Separate configuration in the
runner can allow a study to execute 10%-noise agents while recording them as 30%-noise agents,
without producing an internal inconsistency.

Send the condition through the bot's private channel so that the treatment remains authoritative:

```js
// server, at stage start — tell() needs the channel to exist
for (const playerID of botPlayerIDs) network(game).tell(playerID, "noise", treatment.botNoise);

// bot
const noise = ctx.told()?.get("noise");
if (typeof noise !== "number") return;   // not configured yet: wait, do not guess
```

The bot acts only after receiving a value from the server. Waiting preserves consistency between
the agent's behavior and the session label, whereas a default could place them in different
conditions. `examples/shirado2017/server/bots.mjs` emits one warning if the value remains absent
for ten seconds.

The read guarantee remains intact. `tell()` writes to one participant's channel and uses the same
`validateProjection` validation as a view. Each message remains private to its recipient, while
`project()` continues to provide the exclusive path for data shared between participants.

---

## 6. Recording which nodes are bots

Nothing in the data says which participants were software. That is the property the bots were built
to have (same key, same kind of channel, same code path), so it has to be recorded deliberately:

- the seats, so an analysis can check the placement happened rather than trust the label. A
  placement bug produces a complete, plausible table with the manipulation silently absent;
- a per-action flag, so behavioral measures can exclude them. An analysis of human behavior
  that forgot to would be averaging over a population it chose.

`examples/shirado2017` writes both: `bots`, `bot_placement`, `bot_noise` and `bot_indices` in
`session.csv`, and `is_bot` in `changes.csv`. Note that `bot_noise` is empty rather than `0` in
the human-only arm, since "no agents" and "agents with zero noise" are two different conditions,
and a `0` in both would merge them.

---

## 7. Running bots with plain `node`

`empirica-networks/bots` ships as a bundled CJS artifact, and the export map has a single
`default` condition rather than an `import` that would resolve and then fail. `@empirica/core/admin`
(which the runner needs for `TajribaConnection`) cannot be loaded from bare Node ESM
([§3a](PLATFORM-NOTES.md#3a-the-published-empiricacore-cannot-be-loaded-from-raw-node-at-all-significant-risk)),
so the package does that bundling once instead of asking every study to set up a bundler.

Both forms work:

```js
import { runBots } from "empirica-networks/bots";          // .mjs
const { runBots } = require("empirica-networks/bots");     // .cjs
```

One consequence, stated rather than left to be discovered: the bundle carries its own copy of
`@empirica/core`, so a process importing both `empirica-networks/bots` and
`empirica-networks/player` holds two `Scope` classes. Nothing crosses that boundary today (a
policy sees plain JSON and plain accessors), but a bot script that starts passing scope objects
around will find it.

### The module the bot script shares with the server

Give it an `.mjs` extension. This is a two-line rule with a fifteen-minute failure behind it, in
both directions.

The Empirica scaffold's `server/package.json` declares no `"type"`, so a `.js` file of ESM syntax
is a CommonJS file to Node. Importing one from `bots.mjs` fails, below Node 20.19, with
`SyntaxError: Unexpected token 'export'` pointing at a line of your own valid ESM; from Node 20.19
it is reparsed as ESM and merely warns `MODULE_TYPELESS_PACKAGE_JSON`, so the same script runs on
one machine and not another. The reflex fix, adding `"type": "module"`, breaks the server
instead: `npm run build` bundles `src/index.js` to CommonJS with esbuild and nothing writes a
`package.json` into `dist/`, so `dist/index.js` inherits the field, loads as ESM, and dies with
`ReferenceError: require is not defined` before the server listens.

The extension is the fix that costs nothing:

```
server/
  package.json      # no "type" field — the scaffold's build depends on that
  src/design.mjs    # the rules: imported by callbacks.js AND by bots.mjs
  src/index.js      # bundled to CommonJS by esbuild, as the scaffold expects
  bots.mjs          # plain `node bots.mjs`
```

`examples/shirado2017` is laid out exactly this way, and so is its offline `recover.mjs`.

---

## 8. Limitations

- The runner provides no reconnection policy. A bot whose socket drops stays down. Tajriba's client
  reconnects, but nothing here re-establishes a session or re-enters a game, and a restarted server
  cannot put anyone back in their game anyway.
- The runner provides no lobby, consent or exit-survey behavior. It sets `introDone` and nothing
  else on the player scope. A design whose intro steps gate on other player attributes needs the
  policy to write them.
- The runner provides no rate limiting. `tickMs` is the only pace control. Three bots at 100 ms in
  a twenty-person game will out-move the humans, and the speed of an agent is not a neutral
  parameter; see the note on `BOT_INTERVAL_MS` in the Shirado example.
- The runner makes no claim about how human-like anything is. It puts an agent at a node and runs
  your rule. Whether that rule resembles a person is your design's problem, and the paper you are
  reconstructing is the place to argue it.

---

## 9. Worked example

`examples/shirado2017` reconstructs both arms of Shirado & Christakis (2017): the 30 control
sessions and the agent conditions (3 agents × 3 noise levels × 3 placements) that are the paper's
actual contribution.

| | |
|---|---|
| `server/src/design.mjs` | `botChoice` and `placeBots`: pure, imports nothing, unit-tested |
| `server/src/callbacks.js` | placement, `tell`-ing each agent its noise level, and `is_bot` in the export |
| `server/bots.mjs` | the runner process: when to ask, and what to do with the answer |
| `.empirica/treatments.yaml` | the eleven arms |

See its README for how to run one, and `ISSUES.md` O10 for what it took.
