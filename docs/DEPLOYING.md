# Deploying a study — not yet documented

**Status, 2026-08-16: this package has never been deployed.** No study has been run with real
participants, and no data has been collected with either reconstruction
(`PUBLICATION-PLAN.md` §3). Every runnable instruction in this repository ends at `empirica` on
localhost with a handful of `?participantKey=` URLs.

This file is a placeholder that says so, rather than a guide assembled by reading Empirica's
documentation and inferring the rest. Instructions that look right and have never been run are
the exact hazard `docs/M5-ADOPTION.md` §1 calls **H-A** — a port that runs but silently deviates
— and a deployment guide is where that does the most damage, because the person who discovers
the error is running a study with people in it.

What *is* written down is the part that does not depend on having deployed: the decisions to make
before you do, and the things known to be hard. Those are below.

It will be written properly as a by-product of `PUBLICATION-PLAN.md` §3 — recorded while doing
it, dated and versioned like `PLATFORM-NOTES.md`, rather than reconstructed afterwards.

---

## 1. Pre-flight, before real participants

Every item here is checkable today, on localhost, and each one has bitten something in this
repository.

- [ ] **`networkKinds` is registered** in `server/src/index.js`. Silently fatal if not; it now
      throws. `docs/GETTING-STARTED.md` §3
- [ ] **`verify` passes on the machine you will deploy to**, not only on your laptop.
      `node dist/verify/cli.cjs verify --n 4`
- [ ] **Every private key is declared** in `watch` or `read`. An undeclared key reads back as
      `undefined`, which is indistinguishable from "they did not submit" — this is how a whole
      reconstruction ran with its manipulation doing nothing. `ISSUES.md` O11
- [ ] **No lifecycle listener is registered twice.** Check the server's startup output for the
      duplicate warning. Only the first ever runs. `ISSUES.md` U8
- [ ] **View capture is on** if `project()` does anything beyond passing values through. It
      cannot be turned on retroactively. `docs/DATA-AND-ANALYSIS.md`
- [ ] **The run log is on** (`log: { file }`) if losing a killed session's data would matter.
      `onGameEnded` fires only on a natural end.
- [ ] **Nothing that matters is on a player or game scope.** Both are broadcast to every
      participant. Payoffs and any record of account belong on the batch scope. `ISSUES.md` U1
- [ ] **`?participantKey=` is an opaque per-study token**, not a Prolific PID or an MTurk worker
      ID. Every participant receives every co-player's, and platform worker IDs are stable across
      studies — so keep the mapping outside Empirica. This is decided when you build the
      recruitment links, and cannot be undone afterwards. `ISSUES.md` U10
- [ ] **Bot identifiers, if any, are drawn from that same space.** Three 13-digit numbers among
      24-character PIDs are the three bots, in order, to anyone who looks. `docs/BOTS.md` §1
- [ ] **A dry run at the real *n***, with the real treatment, on the real host. Degree ×
      projection size is what a participant's connection carries, and it is capped at 64 KiB per
      publish by default.
- [ ] **The target regime is n ≤ 50.** At n ≥ 200 games do not reliably start — 1 run in 6,
      upstream, reproduces without this package. `ISSUES.md` U7

## 2. The things known to be hard

Not a procedure. These are the parts where a naive deployment goes wrong, and they are what the
real document will have to answer.

### A crashed study cannot be resumed

A full server restart reloads the store, but `gameID` is never restored and **no game resumes**.
It can also leave two player scopes for one participant. This is upstream (`ISSUES.md` U2) and no
amount of configuration changes it.

So a crash, a deploy, or a `^C` mid-session **ends the games in progress**. Plan for that
outcome rather than for a recovery procedure that does not exist:

- turn on the run log, so a killed study still leaves analysable data;
- decide in advance what you will pay participants whose session dies;
- decide in advance whether a partial session is analysable or discarded, and write it down
  before you see the data;
- do not deploy while a batch is running.

### There is no write access control

Any participant who knows a node id can set any attribute on it, including on another
participant's player scope. `protected: true` is documented as preventing this and does not
(`ISSUES.md` U1, currently in private disclosure).

For a deployment this means: treat every participant-written value as untrusted input, keep the
record of account on the batch scope, and judge whether your design gives anyone a reason to
bother — a study where altering someone else's state pays is exposed in a way a survey is not.

It also means **do not put an admin `srtoken` anywhere a browser can reach it.** With no write
ACL, an admin credential is not a read-only view with a login; it is the ability to write any
attribute on any node.

### The monitor shows exactly what participants must never see

The complete graph, the seating plan, and every participant's private state, on one page. It
binds to `127.0.0.1` and requires a per-run token for that reason, and it warns loudly if you
bind it elsewhere.

**Reach it through an SSH tunnel**, not by changing `host`:

```sh
ssh -L 8080:127.0.0.1:<port> your-server
```

The URL contains the token; treat it as the secret it is. The monitor holds no Empirica
credential and there is no path from the page to `setAttribute` — that is structural, and
`test/e2e/monitor.test.ts` asserts it against the raw wire. Who can *open* it is access control,
and access control is never structural.

### Data at rest is identifiable

`.empirica/local/tajriba.json` holds every attribute including every participant's private state.
It was neighbour-limited in transit; it is not anonymised at rest. Captured views, if enabled, are
the only copy of what each participant was shown and cannot be regenerated.

Back up the store and the NDJSON files; decide retention before the run; and remember that U1 and
U10 belong in an IRB protocol's risk section for *any* Empirica study, not just this one — the
first because a participant can alter another's data, the second because participants are handed
each other's recruitment identifiers.

### Sessions beyond ~10 minutes are unverified

The mechanism is not in doubt — Tajriba holds current values, not per-write history — but no
multi-hour run has been observed. If your design runs long, pilot at length before running at
size.

## 3. What the real document will need to cover

Recorded so the gaps are visible to anyone deciding whether this package is ready for their study,
and so whoever writes the real document is not starting from a blank page:

1. Bundling and serving — the Empirica CLI's production path, with exact commands and versions.
2. Hosting shape — process supervision, TLS termination, websockets through a reverse proxy,
   where the store lives and how it is backed up.
3. Recruitment — participant identification, link structure, batch and treatment configuration,
   lobby behaviour, what a participant who reloads or drops sees.
4. Incentives — both reconstructions pay nothing, and both originals were incentivised. No
   behavioural comparison carries across without this.
5. Monitoring during a run, and what to watch for.
6. The crash procedure, in the honest form: detect, salvage, decide.
7. Scale in production, with the deployment-side variables rather than the library-side ones.

Until then: [`GETTING-STARTED.md`](GETTING-STARTED.md) takes you as far as a verified study on
localhost, and that is genuinely as far as this repository can currently take you.
