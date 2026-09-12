/**
 * The agents of Shirado & Christakis (2017), as a headless participant process.
 *
 *   cd examples/shirado2017/server
 *   SHIRADO2017_BOT_KEYS=$(node bots.mjs --keys) node bots.mjs
 *
 * or, in one step, letting the script print the line to export:
 *
 *   node bots.mjs --keys        # prints three participant keys
 *   node bots.mjs               # runs the agents (reads SHIRADO2017_BOT_KEYS)
 *
 * The SAME keys must be in the server's environment, because that list is how
 * `src/callbacks.js` knows which seated participants are agents. There is no
 * pattern to match on: every participant receives every other participant's
 * `?participantKey=`, so a recognisable key would tell subjects
 * which of their neighbors are software — which in this design is the
 * manipulation, disclosed.
 *
 * ## Recruit playerCount MINUS botCount humans
 *
 * The treatment's `playerCount` is the size of the NETWORK, agents included. A
 * `Color coordination (n=20, 3 central agents, 10% noise)` session seats 20
 * participants, of which three are this process. Recruit seventeen. Getting this
 * wrong produces a study that never starts, and the runner says so — see the
 * `waiting` stall message in `src/bots/lifecycle.ts`.
 *
 * ## Why plain `node` works here
 *
 * `empirica-networks/bots` is shipped as a bundled CJS artifact precisely so that
 * this file needs no tsx, no build step and no bundler: `@empirica/core/admin`
 * cannot be loaded from bare Node ESM (`docs/PLATFORM-NOTES.md` §3a), so the
 * package does the bundling once rather than asking every study to.
 */
import fs from "node:fs";
import { botIdentifiers, runBots } from "empirica-networks/bots";
import { BOT_COUNT, BOT_INTERVAL_MS, botChoice } from "./src/design.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

// `--keys` prints a fresh set and exits, so the two processes can be given the
// same list without anyone inventing one by hand and getting it subtly wrong.
if (args.includes("--keys")) {
  process.stdout.write(botIdentifiers(Number(flag("count", BOT_COUNT))).join(",") + "\n");
  process.exit(0);
}

const url = process.env["SHIRADO2017_TAJRIBA_URL"] ?? "http://localhost:3000/query";
const keys = (process.env["SHIRADO2017_BOT_KEYS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (keys.length === 0) {
  console.error(
    "shirado2017: SHIRADO2017_BOT_KEYS is empty. Generate a set with `node bots.mjs --keys`\n" +
      "and put the SAME value in this process's environment and the server's."
  );
  process.exit(1);
}

/**
 * The run log for the agents' half of the session.
 *
 * Separate from the server's `data/run.ndjson` because it is a separate process
 * and merging two writers into one file is how a run log ends up with torn lines.
 * Both are NDJSON stamped with `at`, so an analysis interleaves them by timestamp.
 *
 * Written as it happens, for the same reason the server's is: this experiment's
 * dependent variable is the change log, and a session that is killed at four
 * minutes is the one you most want.
 */
const logFile = process.env["SHIRADO2017_BOT_LOG"] ?? "data/bots.ndjson";
fs.mkdirSync(logFile.slice(0, logFile.lastIndexOf("/")) || ".", { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: "a" });

/**
 * A "locally noisy autonomous agent".
 *
 * All the behavior is `botChoice` in `src/design.mjs` — pure, imports nothing,
 * unit-tested. What is left here is when to call it and what to do with the answer,
 * which is the part that needs a live channel.
 *
 * It reads its neighbors' colors through the projection and writes its own to
 * its own private channel: the same two operations a browser performs, through the
 * same code. There is deliberately no server-side path — an agent that could see
 * the graph or the global conflict count would turn the bot conditions into a
 * comparison between two different games.
 */
const warned = new Set();

const policy = {
  tickMs: Number(flag("interval", BOT_INTERVAL_MS)),

  onStart(ctx) {
    // Nothing yet. The agent's first move happens on the first tick, so its
    // opening color is drawn on the same clock as every later one rather than
    // arriving instantly and anchoring its neighbors before anyone has moved.
    ctx.log({ type: "seated", playerID: ctx.playerID, degree: ctx.self()?.degree });
  },

  onTick(ctx) {
    const noise = ctx.told()?.get("noise");
    if (typeof noise !== "number") {
      // The server has not told this agent its condition yet. Waiting is right —
      // acting would run the agent at whatever default this file invented, in a
      // condition the session will be labeled with. Loud after ten seconds, and
      // once, because a silent no-op agent is indistinguishable from a working one
      // that happens not to be moving.
      if (ctx.elapsedMs() > 10_000 && !warned.has(ctx.identifier)) {
        warned.add(ctx.identifier);
        console.error(
          `shirado2017: agent ${ctx.identifier} has had no noise level after 10s and is ` +
            `NOT PLAYING. The server sends it with net.tell at stage start — check that ` +
            `this key is in the server's SHIRADO2017_BOT_KEYS.`
        );
        ctx.log({ type: "noCondition" });
      }
      return;
    }

    const neighbors = ctx.neighbors();
    if (neighbors === undefined) return;

    const state = ctx.state();
    const ownColor = state?.get("color");
    const neighborColors = neighbors.map((nb) => nb.color);
    const next = botChoice({ ownColor, neighborColors, noise, rng: ctx.rng });

    // Only on a change. A rewrite of the same value would add a row to
    // `changes.csv` for a move nobody made, and the dependent variable IS that
    // table.
    if (next === ownColor) return;
    state.set("color", next);
    ctx.log({
      type: "move",
      tMs: ctx.elapsedMs(),
      from: ownColor ?? null,
      to: next,
      noise,
      degree: ctx.self()?.degree,
      localConflicts: neighborColors.filter((c) => c === next).length,
    });
  },

  onEnd(ctx) {
    ctx.log({ type: "done", playerID: ctx.playerID });
  },
};

const run = await runBots({
  url,
  identifiers: keys,
  policy,
  // Fixed, and recorded in the log below: the agents' randomness is the
  // manipulation, so an unrecorded stream is an unrecorded independent variable.
  seed: Number(process.env["SHIRADO2017_BOT_SEED"] ?? 1),
  log: (record) => logStream.write(JSON.stringify(record) + "\n"),
});

console.log(
  `shirado2017: ${keys.length} agent(s) connected to ${url}; logging to ${logFile}.\n` +
    `The server must have SHIRADO2017_BOT_KEYS=${keys.join(",")}\n` +
    `Recruit (playerCount - ${keys.length}) humans. Ctrl-C to stop.`
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    run.stop().then(() => {
      logStream.end();
      process.exit(0);
    });
  });
}
