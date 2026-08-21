# Contributing

For someone changing the package. If you are trying to *use* it, start at
[GETTING-STARTED](GETTING-STARTED.md); if you are trying to understand it, start at
[ARCHITECTURE](ARCHITECTURE.md).

```sh
git clone … && cd empirica-networks
npm install
npm run check && npm test -- unit mode     # fast; no server needed
npm test                                    # the whole thing; needs the Empirica CLI
```

**Prerequisites:** Node 20+ and the Empirica CLI (`curl https://install.empirica.dev | sh`).

---

## 1. Layout

See [ARCHITECTURE §2](ARCHITECTURE.md#2-module-map) for the annotated module map. The short
version:

```
src/admin/     server side — imports @empirica/core/admin
src/player/    client side — imports @empirica/core/player* ONLY
src/topology/  pure, zero-dependency
src/shared/    isomorphic; every scope kind and attribute key lives in keys.ts
src/verify/    the verify CLI
test/          unit · mode · e2e · bench · browser
examples/      three runnable projects, each imported by an e2e test
scripts/       runners; see TESTING.md §3
docs/          see docs/README.md
```

## 2. Rules that are not style

Each of these has a failure behind it, and each fails **silently** if broken.

### The entry-point rule

`src/index.ts` re-exports **only** `shared/`. Never re-export `admin`, `player`, `react` or
`topology` from it. Pulling them into one barrel is the mistake in `@empirica/core`'s own
`index.ts`, which drags server-only code — and its `tmp` → `require("fs")` problem — into client
bundles. Each is its own `exports` subpath.

Corollaries:

- **`src/player/**` must never import from `src/admin/**`.** A client bundle that reaches
  `@empirica/core/admin` is broken in a way that only shows up in the consumer's build.
- **`src/admin/export.ts` must have no runtime imports at all** — not even `node:fs`. It is the
  `empirica-networks/export` entry, which analysts load from plain Node. Pinned by
  `test/unit/export_isolation.test.ts`. This is why `parseNdjson` takes text rather than a path.
- **`monitor` stays behind its own subpath**, so a server that never opts in never loads
  `node:http` or the served page, and *"does this deployment expose the whole graph"* is one grep.

### Keys go in `src/shared/keys.ts`

Every scope kind and attribute key, in one place. The spike scattered these literals across five
files — `"nbhd"` alone appeared in four — which is how the `player`-vs-`nbhd` distinction, *the
entire privacy guarantee*, became easy to get wrong by typo. Centralised, a rename is a compile
error rather than a silent leak.

### Nothing of ours goes on the game scope

`GAME_KEYS` is a named, **empty** record, and it should stay that way. The game scope is delivered
to every participant. Two things were kept there and both had to move: the channel index (whose
ids are, with no write ACL, the capability to write into someone else's channel) and the realised
network.

### Per-game state is keyed by game, or `releaseGame` will not find it

Nine of the module's structures are keyed by game id and are dropped in `releaseGame`. Anything
keyed by something else has to be released there **explicitly**, and the question to ask of new
state is *what is this keyed by, and is that the thing that ends?*

The cost of getting it wrong is not the memory. `lastOutbox` — the chat relay's duplicate guard —
is keyed by player, so it survived its game; Classic reuses a participant's player scope across
sequential games while the client's message counter restarts with each new channel, so the stale
mark made the relay swallow the opening messages of the next game with nothing logged
(`ISSUES.md` O5). A leak that is only a leak is the lucky version of this.

### Writes only count inside a callback

Applies to the package's own code as much as a consumer's. The runloop flushes `set()` calls made
while it is processing one; anything else reaches nobody, with no error.

## 3. Build

```sh
npm run build     # tsup
```

Two build groups in `tsup.config.ts`, and the split is not stylistic:

- **`lib`** — ESM, `@empirica/*` and React **external**. Bundling core would give the consumer two
  copies of the `Scope` class, and every `instanceof` would silently start failing.
- **`verify-cli`** — CJS, and **nothing external**, including `@empirica/core` itself. Bare Node
  ESM refuses `cross-fetch/polyfill` (a legacy directory subpath with no `exports` map) with
  `ERR_UNSUPPORTED_DIR_IMPORT`; leaving core external makes the CLI `require()` it and die on
  core's nested `@empirica/tajriba` having no CJS export.

  The honest consequence: **the CLI verifies against the `@empirica/core` this package was built
  against, not the consumer's copy.** It prints both versions and warns on mismatch rather than
  implying otherwise.
- **`bots`** — CJS, nothing external, for the same reason: a bot needs `TajribaConnection` from
  `@empirica/core/admin`. Its `exports` entry has a single `default` condition rather than an
  `import`, because an ESM entry here would resolve and then fail on the researcher's machine —
  the export map should not offer a path that cannot work.

**The clean happens in `scripts/clean-dist.mjs`, not in a config.** tsup runs the three groups
**concurrently**, so `clean: true` in one races the others' output: it silently deleted
`dist/bots/index.d.cts` after tsup had reported writing it, and the only symptom would have been
a consumer's editor quietly losing every type in `empirica-networks/bots`.

**Adding an entry point means three edits**, and missing one fails late: `tsup.config.ts` `entry`,
`package.json` `exports`, and a test that imports it through the built path. A declared entry that
does not exist fails `npm run build`; an `exports` entry that does not exist fails only in the
*consumer's* build, which is worse.

## 4. Adding things

**A topology generator.** Pure, index-based, returns `Edge[]`. Takes `opts.rng` if it makes any
random choice, and **throws without one** if the result would otherwise be irreproducible.
Refuse degenerate parameters rather than returning something that is not what it claims
(`ring(2)` throws). Needs: a unit test, a row in [TOPOLOGIES.md](TOPOLOGIES.md) stating degree,
whether it can disconnect, and its envelope implications.

**A `NetworkConfig` field.** A field rather than a method, when the thing must be known before
wiring — a method invites registration after the admin has started, and a listener registered too
late never fires (this is why `onPrivateState` is a field). Needs: an e2e test, an
[API.md](API.md) entry, and a sentence on what happens when it is *not* set.

**A client hook.** Put the derivation in `src/player/` and make the hook a thin wrapper — headless
clients and the verify harness need the same logic. Return `undefined` for "not resolved yet" and
never conflate it with an empty result. Needs: a mode test.

**A new silent-failure guard.** Prefer, in order: (1) make it impossible by construction;
(2) throw, naming the fix and the corrected code to paste; (3) warn once, and say what the warning
cannot distinguish; (4) document it in [TROUBLESHOOTING](TROUBLESHOOTING.md) indexed by symptom.
Do not stop at (4) if (1)–(3) are reachable.

## 5. Tests

See [TESTING.md](TESTING.md) for the tiers and what each can prove. The rules for new work:

- **Watching the wire is free, but say so.** `wireStream()` shares the mode's own subscription;
  if your test subscribes after the scenario starts and needs the history, pass
  `recordWire: true` to `withScenario`. Getting this wrong is how `ISSUES.md` O8 lived for four
  milestones.
- **Anything that could fail silently needs an e2e witness.** The unit tier is blind to *the
  platform's* wiring, and that is where every documented failure in this package lives. It is not
  blind to ours: `test/unit/fake_admin.ts` supplies a collector and an event context, so the admin
  lifecycle is drivable there — the right home for anything needing several sequential games, or a
  specific arrival order. Two defects were found that way (`ISSUES.md` O4, O5). See
  [TESTING §1](TESTING.md#1-the-three-tiers) for where that stops being true.
- **Ask what the smallest scenario is that can observe the behaviour.** The cost of a test is a
  property of the test — one file was spending two full games on a warning that fires before any
  participant connects, and the participant-free version costs 0.27 s.
- **A guard needs a test that fails when the guard is removed.** Removing `onPrivateState`'s one
  call site fails two tests; that is the standard.
- **Examples are documentation and are imported unmodified by e2e**, so an API change that breaks
  one breaks the suite. That is deliberate — do not fix it by loosening the test.

## 6. Documentation

Documentation is part of the change, not a follow-up.

| If you changed | Update |
|---|---|
| A public export | [API.md](API.md) |
| A CLI flag, or what `verify` prints | [API.md → The `verify` CLI](API.md#the-verify-cli) |
| A generator | [TOPOLOGIES.md](TOPOLOGIES.md) |
| Anything in the lifecycle or publish path | [ARCHITECTURE.md](ARCHITECTURE.md) |
| An exported row type or file format | [DATA-AND-ANALYSIS.md](DATA-AND-ANALYSIS.md) |
| Anything that can now fail differently | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| A measured fact about the platform | [PLATFORM-NOTES.md](PLATFORM-NOTES.md), **with the date and the version** |
| A defect you found and did not fix | [`../ISSUES.md`](../ISSUES.md) |

Conventions, which the existing documents follow:

- **Cite the witness.** A claim about behaviour names the test that pins it. "Impossible by
  construction" must name a test; a claim resting on package code must name the **call site**, not
  the definition. Both rules exist because `ISSUES.md` O14 broke the second one and shipped for
  four milestones.
- **Date and version every measurement.** "Measured 2026-08-16 against `@empirica/core@1.12.5`",
  not "measured". The version half is enforced: `test/unit/upstream_pin.test.ts` fails when the
  `@empirica/core` pin is bumped and lists every claim still citing the old one. That is a prompt
  to **re-measure**, not to find-and-replace — the new version is the reason to doubt the number.
- **Give every `../ISSUES.md` entry a *Done when*.** An entry without one is a claim nobody has
  undertaken to check: O7b had none, and turned out to assert a gap that did not exist. The `U`
  entries are exempt — they close upstream, not here. `O1` and `O4` are the two of ours still
  without one.
- **Record what a plan got wrong**, above the plan rather than instead of it. Both milestone
  documents do this, and the corrections are the most useful parts of them.
- **`npm run check:links`** validates relative paths and section anchors. It runs in CI.

The "not published yet" caveat lives in **one place** — the README's Installing section — and
everything else links to it. At publish time that is one edit rather than a search.

## 7. Releasing

Not yet applicable: the package is `private: true` at `0.0.0` pending disclosure. When it is:

1. `PUBLICATION-PLAN.md` §1 — the disclosure window has to close first. This is blocking.
2. Freeze the surface (§2) and give [API.md](API.md) a read-through against it — the CLI's flags
   and exit codes are surface too, and freeze with the rest.
3. Remove `private: true`, set a real semver, and move `CHANGELOG.md`'s `[Unreleased]` section
   under that version.
4. Update the README's status line and the single "not published yet" block; drop the
   `node dist/verify/cli.cjs` forms in favour of `npx empirica-networks`.
5. `npm run build && npm test && npm run check:links && npm run check:docs`, then publish.

## 8. Where the reasoning lives

`MODULE-DESIGN.md` — why the package is shaped the way it is — is deliberately **not** in this
repo; it is kept with the investigation that produced it. In-repo,
[ARCHITECTURE](ARCHITECTURE.md) answers *how it works*, the two milestone documents
([M5](M5-ADOPTION.md), [M6](M6-HARDENING.md)) carry the decisions and what they cost, and
[PLATFORM-NOTES](PLATFORM-NOTES.md) is the evidence everything else cites.
