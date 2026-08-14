import { defineConfig } from "tsup";

/**
 * Two build groups, for a reason that is not stylistic.
 *
 * Library entries stay ESM with @empirica/* EXTERNAL. Bundling core would give
 * the consumer two copies of the `Scope` class, and `instanceof` checks would
 * silently start failing.
 *
 * The `verify` CLI is the exception: it must be BUNDLED AS CJS. `@empirica/tajriba`
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
      // "topology/index":     Task 10
      // "admin/index":        Task 3
      // "player/index":       Task 5
      // "player/react/index": Task 7
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    external: ["@empirica/core", "@empirica/tajriba", "react", "react-dom"],
  },
  // Task 6 re-enables this once src/verify/cli.ts exists.
  /* {
    name: "verify-cli",
    entry: { "verify/cli": "src/verify/cli.ts" },
    format: ["cjs"],
    dts: false,
    sourcemap: true,
    clean: false,
    platform: "node",
    target: "node20",
    // Deliberately NOT external: the whole point is to inline cross-fetch.
    noExternal: ["@empirica/tajriba"],
    external: ["@empirica/core"],
    banner: { js: "#!/usr/bin/env node" },
  }, */
]);
