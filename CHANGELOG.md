# Changelog

Notable changes to `empirica-networks`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html) from the first release.

## [Unreleased]

Nothing has been released. The package is `private: true` at `0.0.0` while the public API is
still unfrozen. This section will become `0.1.0` at the first publish, and that freeze is what
makes the entries below meaningful as a baseline rather than a moving target.

### Added

- The radius a game ran at is recorded on the batch scope (`networkRadius:<gameID>`) and read back
  with `readRadius(game)`, alongside the edge list and the seed. Nothing else in a finished dataset
  implies it: two studies on one topology, one at each radius, leave identical edge lists,
  identical seeds and identical attribute exports, and showed their participants different things.
  Written at every radius including the default, so an absent value means "predates the key" and
  never "drew a star" — `readRadius` returns `undefined` rather than `1` for that reason.
  `GameSnapshot.radius` carries the live value.

  A game already under way is recovered rather than re-recorded, so a process restarted with a
  different `graph.radius` would have left the old value in place while showing participants the
  new one — a session with two radii and no artifact naming the second. That now warns loudly and
  keeps the game running; refusing to publish would strand the participants inside it.

- `ViewRecord.graph` — captured views record the structure delivered at radius 1.5, not just
  `project()` output. Half of what a participant is given at that radius was going unrecorded by a
  facility whose own doc calls itself "the only record of what a participant was told", and whose
  file `docs/DATA-AND-ANALYSIS.md` calls "irreplaceable: this is the only copy". Positions are kept
  as well as edges, because they are warm-started and therefore follow the session's history rather
  than its final graph — they are not a function of anything else stored, which is the same
  criterion that makes capture worth turning on at all. Absent at radius 1, where `JSON.stringify`
  omits it and the NDJSON is byte-identical to before.

- `structureRows()` and `positionRows()` on `empirica-networks/export`, flattening that structure
  for analysis. Separate builders from `viewRows` rather than an extension of it: the grain differs
  (one row per tie, one per node, one per neighbor), and a viewer with no ties still has a position.
  Both carry local indices as well as resolved ids, so they join to `edges.csv` on the ids and to
  `views.csv` on the indices — which still works for a projection carrying no `id` — and both carry
  the `radius` the delivery was made at, so a table read on its own says which study it describes.

- `NetworkConfig.graph: { radius: 1.5 }`: show each participant the ties BETWEEN their own
  connections — the subgraph induced on their closed neighborhood — with positions laid out
  server-side. Off by default, and opt-in because it widens what a participant is told rather than
  because it is expensive: it discloses which of their connections know each other, and on a
  coordination task it makes the problem easier. Radii above 1.5 are refused, not rounded down.

  What travels is integers. Edges are pairs of indices into the array the browser already holds, so
  no seating plan reaches a participant (`PLATFORM-NOTES` §4b), and the mapping is built from the
  neighbors actually published rather than from the adjacency list — a dropped neighbor renumbers
  everyone after them, and getting that wrong draws a well-formed graph connecting the wrong
  people. Counts toward `envelope.maxNeighborhoodBytes`, not `maxViewBytes`.

  Client-side, `useNetworkStructure()` distinguishes three states: absent (radius 1, draw a star),
  unusable (wait — a star here is a correct-looking picture of a different study), and usable.

- `verify --radius <1|1.5>`, and two new arms behind it. The three sentinel arms are about state
  and cannot see structure at all: the bytes radius 1.5 adds are integers, so a payload naming ties
  to strangers or ties that do not exist carries no sentinel and every existing arm stays clean.
  The new arms read the RAW wire — not `networkGraphOf`, which drops out-of-range edges by design
  and would make the containment check assert nothing — and require that every delivered tie joins
  two people the viewer can see and really exists, and that all of them arrive. At `--radius 1` the
  same arm asserts no structure is sent at all, which turns the default's "costs nothing" into a
  checked claim. `accountVacuity` gained `expectedBeyondStar` and takes the radius, so a
  triangle-free shape is refused before a server boots rather than passing vacuously.

- A participant-facing node-link view of the neighborhood: `useNetworkGraph()`, `<NetworkGraph>`,
  `<NetworkGraphStyles>` and the pure model behind them (`graphModelOf`, `egoRingLayout`,
  `svgAttrs`), all on the existing `empirica-networks/player/react` subpath. The picture is a
  star — the viewer, their neighbors, and a line to each — because it is derived from
  `useNeighbors()`, so **no new data crosses the wire and no envelope or leak assertion changes**.
  Breadboard's participants saw the same ego-only diagram, enforced there server-side.

  Nodes and edges carry the server's values as SVG attributes, so an experiment is restyled in CSS
  rather than in the component. Breadboard's own two palettes ship with it (`DARK2_CSS`,
  `COOPERATION_CSS`).

### Changed

- The three examples now draw the neighborhood instead of listing it, and `docs/EXPERIMENTS.md`
  records why the earlier "reconstructs a design, not an interface" position was reversed: the
  interface is documented — eight screenshots in the Shirado & Christakis SI, plus the stylesheets
  in Breadboard's distribution — so a list was the further departure from the published
  description, not the safer one. The claim stays narrow, and what the screens withhold is
  unchanged.
- `ISSUES.md` gained O19–O26, recording what radius 1.5 did not reach. Those closed since are
  listed individually below; what remains open is named there.
- Documentation caught up with the branch. `README.md` shows the graph display in its quick start
  and names it in the navigation table — it was mentioned nowhere outside the verifier's output.
  `docs/EXPERIMENTS.md` **corrects a claim that had become false**: it said the graph "can only ever
  draw the subject and their own connections", which is true of both reconstructions and no longer
  true of the package, and it now states that neither reconstruction sets a radius and what turning
  one on would mean. `docs/TESTING.md` lists all four browser files rather than two, and its
  baseline counts are current. `docs/GLOSSARY.md` defines "radius" and "structure".
- `verify --topology ringLattice` (`ISSUES.md` O23), with its `m` fixed at 2 and said so. Until now
  `wheel` was the only named shape that could demonstrate radius 1.5 — every other one a flag can
  name is triangle-free or refused for having no non-neighbor — and a verification tool with one
  usable subject is one shape away from having none. It is the only exception to "parameterised
  generators are not here": `barabasiAlbert` and `geometricRandom` refuse to build without an rng
  this table cannot supply, and `wattsStrogatz(n, k, 0)` is a ring lattice by a longer name.
- `simulate`'s manifest records the radius its sessions ran at, and names the structure payload
  among what the rig does not exercise (`ISSUES.md` O26). It reads the value off the same snapshot
  it already takes the seed from, and for the same reason: the package writes it to the batch scope,
  the harness's store is in memory, and once the server stops this file is the only artifact that
  could say what these sessions showed people. Every arm runs at the default radius — the example's
  config is a literal fixed when its module loads, with no path from a flag to it — so "1 because
  that is what ran" is now distinguishable from "1 because nobody wrote it down".
- `auditViews` checks the structure (`ISSUES.md` O21), so `simulate`'s leak check is no longer
  silent about half a radius 1.5 delivery. Every delivered tie must join two people the viewer could
  see and must exist in the edge log, and a run that delivered structure without ever showing a tie
  beyond a viewer's own star is reported as vacuous — that is what radius 1 already draws.

  The root cause was a duplicate type: `audit.ts` restated `ViewRecord` structurally, under a
  comment naming `src/shared/keys.ts` as its source, and did not follow it when `graph` was added.
  It now imports the canonical one; `import type` is erased, so the module is still import-free at
  runtime.
- The monitor states the radius (`ISSUES.md` O22). It draws the complete network, so an operator
  could not tell whether the people in it were looking at a star or at the ties among their own
  connections. `GameSnapshot.recordedRadius` carries what the run's own data says alongside what is
  being published now — optional, because a record predating the key is a real state and defaulting
  it to `1` would assert a study drew a star when nobody knows what it drew. When the two disagree,
  which happens when a game is recovered at a changed radius, both appear and a banner says the
  session has no single radius. It is ranked below the stalled-game and broken-history banners,
  which are wrong now rather than wrong in the record.
- `BotContext.structure()` (`ISSUES.md` O20). At radius 1.5 a browser was shown the ties among its
  own neighbors and a bot in the same seat was not — an asymmetry that would have appeared nowhere
  in a study's data, in exactly the designs artificial participants exist for. The bytes already
  reached the bot: it runs the same participant mode, and the runner simply never exposed them. It
  reads through the same `networkGraphOf` a browser does, so a malformed tie is dropped for both,
  and needs no new wake mechanism because the structure is written in the publish that moves `_seq`.
  `policy.ts` no longer says a bot has "no way to see the graph": that was written when no
  participant could, and the rule it states — a bot must not exceed a human — now also means it must
  not fall short of one.
- `line[making="1"]` is gone from `COOPERATION_CSS` (`ISSUES.md` O24). Nothing could set it: an
  offer to form a tie is about somebody the viewer is not connected to, so that person is not on
  the viewer's graph and there is no line to style. Its absence is now stated in the sheet, because
  Breadboard's own carries such a rule and a reader would otherwise conclude this component can
  draw one.
- The comment on `provision.ts`'s channel index no longer claims restart recovery is unimplemented
  and tracked as a known gap. It is implemented — `adoptChannel`, called from the OWNER listener,
  is what lets `tryRecover` rebuild a live game — and it was tracked nowhere, so the comment sent a
  reader looking for a register entry that never existed.
- `edgeKey` has one implementation instead of three. `monitor/payload.ts` had a private copy and
  `graph_payload.ts` inlined a third, which is two too many for a function whose whole job is that
  two callers agree about when a graph has changed — and the inlined one skipped the `a < b`
  normalization, relying on an invariant held in another file. `beyondStar` is gone: nothing in
  `src/` called it, both places that count the quantity must tally it while validating each edge
  rather than over a whole array, and its docstring claimed an e2e test depended on it that never
  imported it.
- `StructureRow` and `PositionRow` are `type` aliases rather than `interface`s, so
  `toCSV(structureRows(…))` compiles. They were interfaces, which is the exact defect the note at
  the top of `src/admin/export.ts` exists to prevent — and it went unnoticed for exactly the reason
  that note predicts, that nothing composed the two functions until a test did.
- `src/admin/monitor/layout.ts` moved to `src/admin/layout.ts`. Participants' own neighborhoods are
  laid out with it at radius 1.5, and reaching for it through the monitor's subpath would undo the
  property that subpath exists for — that a server never opting into the monitor never loads
  `node:http` or the served page.
- `envelope` gained `MeasuredPayload.aggregateOnly`, for bytes that travel on a participant's
  connection without being a neighbor view.
- `NetworkStats.cachedLayouts`, so the new per-scope map is covered by the exhaustive retention
  assertions rather than leaking the way `lastOutbox` did (`ISSUES.md` O5).
- `scripts/test-browser.mjs` sweeps orphaned processes between files, not only ports. `empirica`
  starts the experiment's callbacks server through an npm wrapper chain that lands in its own
  process group, so a browser test that kills its dev server's group still leaves that server
  running. It holds no port, so a port check cannot see it — but it is a live Tajriba client, and
  it reconnects to the NEXT file's server and registers the previous example's listeners beside the
  new one's. Measured: two browser files failed three times with three different assertions,
  including a reported leak, and passed every time either ran alone.
- `tools/shirado-figure.ts` captures the whole screen rather than one column, and waits for each
  drawing to agree with its own heading rather than sleeping — a screenshot taken between the two
  would be a correct-looking picture of a different neighborhood.
- Normalized spelling to American English throughout the package, including the public API:
  `envelope.maxNeighbourhoodBytes` → `maxNeighborhoodBytes`, `checkNeighbourhoodBytes` →
  `checkNeighborhoodBytes`, `ProjectContext.neighbourIndex` → `neighborIndex`, and the
  `views.csv` column headers `neighbour_index` / `neighbour_id` → `neighbor_index` /
  `neighbor_id`. Safe to do now, before the freeze; there are no released consumers of any of
  these names yet.

### Added since M5 (all 2026-08-16)

- `NetworkConfig.read`: declare private keys the server consumes but `project()` never touches,
  and `net.stateOf()` to read them loudly. Previously `watch` did both jobs under one name,
  and an unlisted key read back as `undefined`, indistinguishable from "not submitted"
  (`ISSUES.md` O11).
- `NetworkConfig.log` and `net.log()`: an append-only run log written as the study happens,
  because analysis files were only written at a natural game end and a killed study produced none
  (`ISSUES.md` O12).
- `NetworkConfig.onPrivateState`: a first-class hook for "a participant wrote private state",
  replacing a pattern that reached into the package's key layout (`ISSUES.md` O13).
- Duplicate-lifecycle-listener detection at server start, for the upstream defect where only
  the first registration of a lifecycle helper ever runs.
- `net.activeGames()`, replacing `net.games()`; `GameRef` and `gameIDOf()` so every entry point
  takes either a game scope or its id.
- `envelope.maxNeighborhoodBytes` (64 KiB default).
- `NetworkStats.endedGames` and `NetworkStats.chatSeqs`: the two counts that outlive a game, so
  retention is assertable exactly rather than by watching a heap graph.
- `empirica-networks/bots`: artificial participants, which Empirica ships none of
  (`docs/PLATFORM-NOTES.md` §16, `ISSUES.md` O10). A bot is a headless participant process:
  it opens a real Tajriba session, sets `introDone` (without which a game never reaches its
  player count), reads its neighbors through the same `project()`, and writes through the same
  private channel a browser writes to. There is deliberately no server-side path; a bot that could
  read a non-neighbor or see the graph would make a bot condition a comparison between two
  different games rather than between two kinds of player.

  `runBots({ url, identifiers, policy, seed })`, with `onStart` / `onView` / `onTick` / `onEnd`,
  a per-bot deterministic `ctx.rng`, and the same four accessors a browser has. Shipped as a
  bundled CJS artifact so a bot script runs under plain `node`: `@empirica/core/admin` cannot be
  loaded from bare Node ESM (§3a), so the package does that once instead of asking every study to.

  The lifecycle is the part that fails silently and so the part with the most machinery behind it.
  A bot that never plays throws nothing, logs nothing and times nothing out; the study simply waits
  for a game that will never fill. Three separate causes produced that identical symptom while
  building this. So the phase (`connecting → waiting → intro → starting → playing → ended`) is a
  pure function, each phase has a reason naming what to check, and 30 s in a non-playing phase
  warns once. The `waiting` reason names the trap the package can predict: the treatment's
  `playerCount` counts bots, so recruit `playerCount - botCount` humans.

- `NetworkConfig.topology` now receives `players`, in seat order: `players[i]` is the
  participant who will occupy topology index `i`. Without it a design cannot place anybody
  deliberately, which made Shirado & Christakis's central/peripheral/random manipulation
  inexpressible. It was previously true by accident (the same array is used for `order` two lines
  later) and is now a contract, pinned by `test/unit/seating.test.ts`, whose point is the failure
  that would otherwise pass silently: a broken mapping still produces a perfectly correct graph,
  over the wrong people.

### Changed

- `envelope.maxDegree` now depends on n: `n - 1` at n ≤ 50, `16` above. The old flat cap of 16
  came from a sweep of sparse graphs while varying n, so it was a number about n enforced as a
  number about degree. Measured properly in `docs/PLATFORM-NOTES.md` §19.
- `EdgeRow` and `SnapshotRow` are `type` aliases rather than interfaces, so `toCSV(edgeRows(…))`
  typechecks.
- The kind-registration warning stops naming a cause it cannot establish, and takes itself back
  when it is wrong (`ISSUES.md` O15). Its deadline was a flat 5 s and its message said the kind
  was "almost certainly not registered". Measured: the first channel takes 4287 ms at n=150
  (inside the supported envelope) and at n=200 the warning fired on a run that went on to
  deliver every one of its 760 receipts. `registrationWaitMs(created)` now adds 100 ms per channel
  above a 5 s floor, the message names both causes and diagnoses neither, and a channel arriving
  after the warning prints a retraction saying nothing needs fixing. New:
  `net.stats().firstChannelMs`, `REGISTRATION_CHECK_PER_CHANNEL_MS`,
  `registrationRetractionMessage`. `registrationCheckMs()` is replaced by `registrationWaitMs()`,
  which takes the channel count.

### Reconstructed

- `examples/shirado2017` now has both arms, including the paper's actual contribution: 3
  agents x 3 noise levels x 3 placements, plus the deterministic-agent control. The agents run as
  `server/bots.mjs`; all their behavior is `botChoice` and `placeBots` in `design.mjs`, which
  imports nothing and is unit-tested.

  Two arrangements in it are the general lesson rather than the example's detail. The condition
  travels down the bot's own private channel: the server `tell()`s each agent its noise level,
  so the treatment is the single source of truth and the runner cannot act on a value it was not
  sent; two processes each reading their own config is how a study runs 10%-noise agents and
  records them as 30%. And placement relabels the generated graph rather than generating a
  different one, so every arm draws from the same distribution of structures; an arm whose
  degree distribution also differed would confound position with structure at the root.

  Recorded per session: `bots`, `bot_placement`, `bot_noise`, `bot_indices`, and `is_bot` per
  change. Nothing else distinguishes an agent's move from a human's (same key, same channel kind,
  same code path), which is exactly the property the agents were built to have.

### Measurement

- `npm run bench -- --repeats N`: N runs per cell against a fresh server, reporting the median of
  the per-run p50s with the observed range. What `SPIKE-REPORT.md` §5–6 asks for before a figure is
  published, and what every figure so far had lacked (`ISSUES.md` O1).
- `npm run bench -- --payload B`: pads each neighbor view, so the bench measures degree × view
  size rather than degree alone. That product is what a participant's uplink carries and what
  `maxNeighborhoodBytes` was added to guard on a guess.
- The bench reports first-channel latency per run and the slowest across repeats, including
  for runs that did not complete: at n=200 most do not (`docs/PLATFORM-NOTES.md` §15), and those
  are exactly the runs in which the registration check misfires. The measurement behind
  `ISSUES.md` O15 and §15a.
- `npm run bench -- --assert` and `npm run soak -- --assert`: exit non-zero on a delivery or
  retention regression, never on a slow or memory-hungry one. This is what lets both run in CI
  (`ISSUES.md` O6, `.github/workflows/perf.yml`, weekly).
- The bench can run its participants on a second machine (2026-09-11). `npm run bench --
  --agent` on the client host, `--clients HOST:PORT` on the server host. Until now "sharded" meant
  more processes on the same machine, so every published figure included the participants competing
  with the server for cores, an upper bound, and a systematic one that repeats cannot touch. The
  timing survives the split without a clock protocol because both endpoints of every sample are
  participants and all of them are on the client host; the server never timestamps anything
  (`test/bench/host.ts`).
- Every run reports the clock conditions it was measured under, and `--absolute` refuses to run a
  sweep that could not produce an absolute figure (2026-09-11). Host, CPU, governor and turbo
  state for both machines, because `ISSUES.md` O1's finding is that the host's frequency decision
  moves the number by 5× while the run looks identical. `--absolute` requires fixed clocks on both
  hosts, clients off the server host, and three repeats; `--attest-clocks "<why>"` covers the case
  the kernel cannot confirm (a cloud instance without burst exposes no `cpufreq` sysfs), and the
  words are printed with the numbers (`test/bench/clocks.ts`).

- The late-joiner repair path is counted and announced instead of silent (2026-09-11).
  `net.stats().pendingAtStart` and `net.stats().lateProvisioned`, both per process and neither
  reset between games, plus a warning when the repair fires. `ISSUES.md` O4 offers "ruled out at
  runtime rather than by inference" as a way to close, and that was unavailable: the repair fired
  silently, so a study could have taken the path in every session it ran and left nothing behind.
  Zero is the expected value and is the evidence; `npm run soak` prints the pair in its summary.

- The leak check runs any topology, not only a ring (2026-09-11). `runLeakCheck`'s `topology`
  takes a name (`ring`, `star`, `wheel`, `pairs`, `ladder`, `complete`) or the same generator
  function a study hands `withNetwork`, so a study can verify the graph it actually runs,
  including a `fromEdgeList` one, rather than a ring standing in for it. What a run can establish
  is now computed from the realized graph: a participant adjacent to everyone (a star's hub) or to
  nobody (a disconnected graph) is counted and excused instead of failing the run, and a graph
  where no participant has a non-neighbor is refused. `src/verify/topologies.ts` holds that
  accounting, pure over `(n, edges)` and unit-tested across all fourteen generators.

### Documentation

- New: [`docs/API.md`](docs/API.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md),
  [`docs/DATA-AND-ANALYSIS.md`](docs/DATA-AND-ANALYSIS.md),
  [`docs/TOPOLOGIES.md`](docs/TOPOLOGIES.md), [`docs/DEPLOYING.md`](docs/DEPLOYING.md) (a stub,
  deployment is genuinely undocumented), [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md),
  [`docs/TESTING.md`](docs/TESTING.md), [`docs/GLOSSARY.md`](docs/GLOSSARY.md), and an index.
- The README is a front door again: the API reference moved to `docs/API.md`.
- `LICENSE` added. The package claimed MIT in metadata and shipped no license text.
- Two CI checks: `check:links` (relative paths and section anchors) and `check:docs` (every
  documented `empirica-networks` import, resolved against the built package).

### Fixed

- The leak check did not retain its wire history, and could have failed spuriously
  (2026-09-11). `runLeakCheck` subscribes to each participant's wire after the scenario has
  started, but did not pass `recordWire: true`, so `wireStream()` was a plain `share()` and the
  subscription saw nothing published before it opened. If the first publish had won that race, arm
  3 would read `delivered: 0` and the run would fail for a reason unrelated to the guarantee.
  `docs/TESTING.md` §3 had asked for this from "every leak test" and `withScenario`'s own docstring
  says the same; this file was the one not honoring it. Argued from the code, never observed:
  measured 0/8 before and 0/8 after at 7.1s per repetition, so the measurement shows the fix is
  free rather than that the race was firing. It also makes every arm strictly stronger: arm 1 now
  scans frames from before the subscription, where previously a leak that early was invisible.

- `verify --topology` was reported as honored and silently ignored (`ISSUES.md` O16).
  It was parsed with a cast, so every string typechecked and none took effect:
  `verify --topology=star` ran a ring and printed `topology: star of N … PASS`. A false
  attestation from the one command a reviewer runs to decide whether the central claim holds. The
  name is now resolved and an unknown one refused. In the same class and fixed with it, arm 1
  printed a numerator with no denominator (`0` reads identically whether four non-neighbor pairs
  were examined and none leaked or the graph was complete and none existed), so it now prints
  `0/4 pairs`, and a run whose denominator is zero fails rather than passing.

- `runBots({ url })` was documented with the wrong scheme, in every place it was documented.
  Six occurrences said `ws://localhost:3000/query`: `README.md`, `docs/API.md` (twice),
  `docs/BOTS.md`, the `BotRunOptions.url` JSDoc, and the `SHIRADO2017_TAJRIBA_URL` fallback in
  `examples/shirado2017/server/bots.mjs`. Tajriba accepts only an HTTP address and derives the
  websocket one itself; given a `ws://` url its `wsURL` getter runs `throw "invalid URL"`, a
  string, so it carries no stack, and the process dies with Node's ESM loader frames and no
  frame in this package or the caller's. Every documented bot command was therefore broken as
  written, and produced the least diagnosable error the platform can emit.

  Found by an outside tester working the Getting Started path on a fresh machine, who correctly
  eliminated the folder, the package, the Node version, the identifiers, the example's design
  module and its log setup, and still could not reach it: the missing stack is what made the
  URL argument itself look exonerated.

  The suite never caught it because every test builds its url from
  `src/harness/server.ts` (`http://`) and passes that to `runBots`. Nothing exercised the string
  the documentation told users to type. `runBots` now rejects a non-HTTP url up front, before
  identifier validation, with an `Error` that names the fix, and `test/e2e/bots.test.ts` asserts
  the rejection against the exact documented-and-wrong string.

- A bot script cannot import an ESM `.js` module from an Empirica `server/`, and the fix for
  that breaks the server. The scaffold's `server/package.json` declares no `"type"`, so
  `bots.mjs` importing the study's own rules from `src/design.js` dies on Node below 20.19 with
  `SyntaxError: Unexpected token 'export'` at a line of valid ESM, and only warns above it, so
  the same script runs on one machine and not another. Adding `"type": "module"` moves the failure
  rather than removing it: `npm run build` bundles `src/index.js` to CommonJS with esbuild and
  writes no `package.json` into `dist/`, so the bundle then loads as ESM and the server dies at
  startup with `ReferenceError: require is not defined`, including under the `empirica` CLI,
  which is the documented way to run the example.

  `examples/shirado2017/server/src/design.js` is now `design.mjs` and the `"type"` field is gone,
  which is the one arrangement where both plain `node` and the scaffold's build are correct.
  `docs/BOTS.md` §7 states the rule for studies writing their own bot script, §2 points at it, and
  `docs/TROUBLESHOOTING.md` §1 carries both error strings, since neither names the file that is
  actually wrong.

- `ISSUES.md` O7b: a version pin with a guard in only one direction.
  `.github/workflows/drift.yml` fires when upstream moves; nothing fired when we move to it, and
  forty claims across `src`, `test` and `docs` are dated to `@empirica/core@1.12.5` under the
  "date and version every measurement" convention: seventeen in `PLATFORM-NOTES` alone. A bump
  could re-date none of them in silence. `test/unit/upstream_pin.test.ts` now fails on a bump and
  lists every stale citation by `file:line`, saying that re-dating is not the remedy.

  Found by disproving the issue itself: O7b claimed nothing would notice if `attributes()`
  started working, and the drift job running the e2e tier against `@empirica/core@latest` weekly
  means something would. Two real defects came out of the disproof: the assertion that carries
  that news asked only for a test rewrite, never mentioning that a working `attributes()` would
  unforce `ISSUES.md`
  O11's declared-keys design; and `VERIFIED_CORE` in `src/harness/compat.ts` was exported and read by
  nothing, a second copy of the pin beside a first in `cli.ts` that a test did check. Collapsed
  to one declaration.

- `ISSUES.md` O9: the monitor kept the complete graph on screen after the game was gone.
  `gone()` set the badge and the banner and left the payload alone, so every seat, every tie and
  every watched private value stayed drawn, and the table view kept the full seating plan. The
  page's own comment had claimed the opposite since M4 ("deliberately not keep showing the last
  picture"): an operator who scrolled past the banner read a dead study as a running one, which is
  the misreport the monitor's `gone` state exists to prevent.

  Found by writing the test the issue asked for: the served script was the one surface with no
  behavioral coverage. Witness: `test/browser/monitor_page.ts`, real Chromium against the real
  `serveMonitor` with only the snapshot source synthetic (no CLI, no server, ~4 s). It also pins
  the scrubber's index arithmetic, the color scale's stability under changing counts, and the
  fact that a lost stream deliberately does not clear the graph while `gone` does.
  `npm run test:browser` now discovers `test/browser/` and takes a substring filter.

- `ISSUES.md` O14: the one mandatory consumer edit (registering `networkKinds`) was still
  silently fatal: `assertKindsRegistered` was exported and called by nothing, while three
  documents recorded the trap as "impossible to skip silently" on the strength of it. Found while
  writing the architecture document, by trying to say which function runs at which point in the
  lifecycle and finding this one ran at no point at all.

  `withNetwork` now detects the consequence (channels created by `addScopes`, none ever
  materialising as modeled scopes) and warns with the diff after 5 s. It cannot check the cause:
  it holds the collector, not the kind map. `assertKindsRegistered` remains as the eager, opt-in
  check for `server/src/index.js`, which is the one place that does hold the map. Witness:
  `test/e2e/kind_registration.test.ts`.

- `ISSUES.md` O8: the e2e suite's long-standing intermittent hang on `gameID assigned`
  ("1 green in 3" since M4) was the test harness, not Empirica. `wireStream()` called
  `part.changes()`, which opens a whole new GraphQL subscription, so watching n participants
  doubled the server traffic for each, and several tests did it for every participant before
  `createBatch`, through Classic's O(n²) assignment burst.

  `makeSharedProvider` now shares one subscription between the mode and every observer. Worst
  victim went 1-2/15 → 0/20; the tier is green on four consecutive runs and the full
  `npm test` on two. Tests that subscribe late and need the history pass `recordWire: true`
  (off by default, `bench`/`soak` measure RSS).

- `ISSUES.md` O4 (partial): the late-joiner net repaired a missing channel without a seat
  index, so it wrote `topologyIndex: -1`; the seat recorder takes `idx >= 0` only, and
  `tryRecover` refuses a game whose seating plan has a gap. A game repaired by that path ran
  correctly and was quietly unrecoverable at the next restart. Found by writing the first test for
  a path nobody expected to run. Witness: `test/unit/late_joiner.test.ts`.

  O4 itself stays open: whether Classic can produce a player with no `participantID` at game start
  is still unreproduced, though the reasoning that said it could not has been retired
  (`docs/PLATFORM-NOTES.md` §20).

- `ISSUES.md` O5: two structures survived their game. `endedGames`, the list of finished
  games kept so their channels are not re-adopted on a subscription replay, was unbounded in the
  number of games a process ran; it is now capped (`src/admin/retention.ts`), and forgetting the
  oldest is safe because the replay that would re-adopt an evicted game's channels also replays
  that game's `start` attribute, which releases it again.

  The second one was not a memory bug. `lastOutbox` (the chat relay's duplicate guard) is keyed
  by player, so no game-keyed delete reached it. Classic reuses a participant's player scope
  across sequential games while the client derives its message counter from the outbox attribute
  on its own channel, which is new each game and restarts at 1. A participant who chatted in one
  game therefore had their opening messages of the next game dropped silently. Witness:
  `test/unit/retention.test.ts`, which drives the whole admin lifecycle against a fake collector
  and needs no server: the shape needs several sequential games, which is what the e2e tier can
  least afford.

### Measured

- `maxNeighborhoodBytes` is no longer a guess (`ISSUES.md` O1, PLATFORM-NOTES §19). A design
  sitting just under the 64 KiB default (53 KiB per participant per publish, n=50 d=49) delivers
  at p50 67 ms against 10–25 ms for a small-view design, and drops nothing. A slope, not a
  cliff. Payload also costs more at higher degree, confirming that degree × view size is the
  product neither per-view nor per-degree limits can see alone.
- A bench figure is worth less than it looks, and the reason is the measuring machine
  (`ISSUES.md` O1, PLATFORM-NOTES §19). The same cell ranged 3.3–18.3 ms across one afternoon while
  repeats within any sweep agreed to 4–17%. Imposed-load testing found the cause and it runs
  backwards: a busier host measures faster, non-monotonically, because an idle machine clocks
  its cores down; the coordinator burns 1.1 CPU-seconds idle against 0.7 loaded for identical
  work. Six other hypotheses were eliminated first, including one with a convincing mechanism
  (append-only attribute growth) that was simply wrong.

  Consequences: absolute latency figures from this class of machine are not reproducible and the
  README now says so; paired comparisons inside one sweep remain sound and are the supported way to
  ask a performance question; and `perf.yml` gating on delivery rather than latency gains a second,
  stronger justification, since a quiet CI runner may measure slower than a busy one.
