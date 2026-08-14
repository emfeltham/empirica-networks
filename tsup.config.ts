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
      "topology/index": "src/topology/index.ts",
      "admin/index": "src/admin/index.ts",
      "player/index": "src/player/index.ts",
      "player/react/index": "src/player/react/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    external: ["@empirica/core", "@empirica/tajriba", "react", "react-dom"],
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
