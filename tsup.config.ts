import { defineConfig } from "tsup";

/**
 * Three build groups, for a reason that is not stylistic.
 *
 * Library entries stay ESM with @empirica/* EXTERNAL. Bundling core would give
 * the consumer two copies of the `Scope` class, and `instanceof` checks would
 * silently start failing.
 *
 * The `verify` CLI and the `bots` runner are the exceptions: both must be
 * BUNDLED AS CJS, because both run as their own Node process against Empirica's
 * own client stack rather than inside a consumer's build. `@empirica/tajriba`
 * imports `cross-fetch/polyfill`, a legacy directory subpath with no `exports`
 * map, which bare Node ESM refuses with ERR_UNSUPPORTED_DIR_IMPORT. Verified on
 * 2026-08-14 against @empirica/core@1.12.5 / @empirica/tajriba@1.7.3:
 *
 *   bare node ESM   -> ERR_UNSUPPORTED_DIR_IMPORT
 *   tsx             -> works  (hence tsx for dev + tests)
 *   esbuild --cjs   -> works  (hence this bundle)
 *
 * cross-fetch@4.1.0 still ships no `exports` map, so an npm `overrides` bump does
 * not fix it. Shipping the CLI as plain ESM would fail on the consumer's machine.
 */
export default defineConfig([
  {
    name: "lib",
    // Entries are added as each milestone builds them. Declaring an entry that
    // does not exist yet makes `npm run build` fail, and an export map entry
    // that does not exist is worse: it fails only in the consumer's build.
    entry: {
      index: "src/index.ts",
      "topology/index": "src/topology/index.ts",
      "topology/graphology": "src/topology/graphology.ts",
      "admin/index": "src/admin/index.ts",
      // The row builders and CSV writer, on their own subpath.
      //
      // They are pure functions over plain data — `src/admin/export.ts` has one
      // TYPE import and nothing else — and the README tells analysts they "run
      // offline over data collected months ago". They could not: reaching them
      // through `admin/index` drags in `@empirica/core/admin`, which cannot be
      // loaded from raw Node in either module system (PLATFORM-NOTES §3a), so an
      // offline analysis script died on `cross-fetch/polyfill` before running a
      // line. Found by writing exactly such a script — `examples/*/recover.mjs`.
      //
      // Pinned by `test/unit/export_isolation.test.ts`, which fails if anything
      // with a dependency ever reaches this entry.
      "export/index": "src/admin/export.ts",
      // A separate entry, not folded into admin/index. The monitor imports
      // node:http and serves the complete graph; keeping it behind its own
      // subpath means a server that never opts in never loads it, and means
      // "who can reach the monitor" is answerable by grepping for one import.
      "admin/monitor/index": "src/admin/monitor/index.ts",
      "player/index": "src/player/index.ts",
      "player/react/index": "src/player/react/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    // Every group is clean:false — tsup runs these configs CONCURRENTLY, so a
    // clean here races the other groups' output and silently deleted
    // `dist/bots/index.d.cts`. `scripts/clean-dist.mjs` does it once, before.
    clean: false,
    target: "es2020",
    external: ["@empirica/core", "@empirica/tajriba", "react", "react-dom"],
  },
  {
    /**
     * The bot runner: CJS, bundled, for the SAME reason as the verify CLI below.
     *
     * A bot is a headless participant, so it needs `TajribaConnection` — which
     * lives in `@empirica/core/admin` and drags in `cross-fetch/polyfill`. Left
     * as an ESM library entry it would resolve fine and then fail at import time
     * on the researcher's machine, which is the shape of failure this repository
     * spends most of its guards on. Bundled CJS is loadable by both `require`
     * and `import`, so the export map has a single `default` condition rather
     * than an `import` that is a trap.
     *
     * The consequence is the same one the CLI accepts, and is worth stating
     * rather than leaving to be discovered: this bundle carries its own copy of
     * `@empirica/core`, so a process importing BOTH `empirica-networks/bots` and
     * `empirica-networks/player` holds two `Scope` classes. Nothing crosses that
     * boundary today — a policy sees plain JSON and plain accessors — but a bot
     * script that starts passing scope objects around will find it.
     */
    name: "bots",
    entry: { "bots/index": "src/bots/index.ts" },
    format: ["cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    platform: "node",
    target: "node20",
    noExternal: [/.*/],
  },
  {
    name: "verify-cli",
    entry: { "verify/cli": "src/verify/cli.ts" },
    format: ["cjs"],
    dts: false,
    sourcemap: true,
    clean: false,
    platform: "node",
    target: "node20",
    // NOTHING is external. @empirica/core must be inlined too, not just
    // tajriba: leaving core external makes the CLI `require()` it at runtime,
    // which takes the CJS path and dies on core's nested @empirica/tajriba
    // having no CJS export (PLATFORM-NOTES §3a). Verified by running the built
    // CLI, which is the only way this shows up.
    //
    // The consequence is honest but real: the CLI verifies the mechanism
    // against the @empirica/core this package was BUILT against, not against
    // the consumer's copy. The CLI prints both versions and warns on mismatch
    // rather than implying it tested theirs.
    noExternal: [/.*/],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
