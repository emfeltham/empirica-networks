/**
 * Remove `dist/` before a build.
 *
 * This exists because `clean: true` inside a tsup config is NOT safe here.
 * `tsup.config.ts` exports three build groups and tsup runs them CONCURRENTLY,
 * so the `lib` group's clean races every other group's output. Measured
 * 2026-08-16: tsup reported writing `dist/bots/index.d.cts` and the file was not
 * on disk afterwards — the declaration build for `bots` finished at 525 ms and
 * `lib`'s cleaned directory landed on top of it.
 *
 * Silent, and that is why it was worth a script rather than a shrug: the build
 * said "Build success" and printed the filename. Nothing failed until the export
 * map pointed at a `types` file that did not exist, which a consumer would have
 * met as their editor quietly losing every type in `empirica-networks/bots`.
 *
 * So: every group is `clean: false`, and the one clean happens here, before tsup
 * starts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
