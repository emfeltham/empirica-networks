/**
 * `npx empirica-networks verify`
 *
 * Runs the leak check against the consumer's OWN installed versions of the
 * Empirica CLI and @empirica/core. The point is that the module's central claim
 * — a participant never receives a non-neighbor's state — is something a
 * researcher, a collaborator, or a reviewer can reproduce in about thirty
 * seconds rather than take on trust. It doubles as the upgrade canary.
 *
 * Shipped BUNDLED AS CJS. The published @empirica/core cannot be loaded from raw
 * Node in either module system (docs/PLATFORM-NOTES.md §3a), so a plain-ESM CLI
 * would fail on every user's machine.
 */
import { createRequire } from "node:module";
import { setLogLevel } from "@empirica/core/console";
// The version printed below is NOT declared here. It is the repository's single
// pin declaration (src/harness/compat.ts), because a CLI that prints a version
// number of its own is a CLI that can print the wrong one — see the note there.
import type { Radius } from "../topology/index.js";
import { parseArgs, type Args } from "./args.js";
import { VERIFIED_CORE } from "../harness/compat.js";
import { formatLeakResult, runLeakCheck } from "./leak_test.js";
import { CLI_TOPOLOGY_NAMES, preflightCliTopology } from "./topologies.js";

/**
 * The @empirica/core version actually installed where the CLI is being run.
 *
 * core does not export ./package.json, so resolve a subpath and walk up to the
 * package root. Best-effort: if it cannot be determined we say so rather than
 * guess.
 */
function installedCoreVersion(): string | undefined {
  try {
    const req = createRequire(process.cwd() + "/");
    const entry = req.resolve("@empirica/core/admin");
    const marker = "/node_modules/@empirica/core/";
    const idx = entry.lastIndexOf(marker);
    if (idx === -1) return undefined;
    const pkg = entry.slice(0, idx + marker.length) + "package.json";
    return req(pkg)?.version as string | undefined;
  } catch {
    return undefined;
  }
}




const USAGE = `
empirica-networks verify — reproduce the neighbor-limited visibility guarantee

Usage:
  npx empirica-networks verify [options]

Options:
  -n, --n <count>        participants (default 4, minimum 4)
      --topology <name>  ring (default), star, wheel, pairs, ladder, complete,
                         ringLattice (m fixed at 2, needs n >= 5)
                         Refused when the shape would prove nothing: a complete
                         graph has no non-neighbor to leak to, and a wheel of 4
                         is a complete graph. Parameterised generators (grid,
                         wattsStrogatz, erdosRenyi, …) take an argument a flag
                         cannot carry — pass the generator to runLeakCheck().
      --radius <r>       the radius your study runs at (default 1). 1, 1.5, 2,
                         2.5, … — floor(r) bounds the people and the fraction
                         decides whether the ties among the outermost of them
                         come too. At 1 this
                         also checks that NO structure is sent, which is what
                         makes the default free. At 1.5 it checks the ties
                         between a participant's neighbors are contained and
                         complete — arms the sentinel check cannot see, because
                         those bytes are integers rather than anybody's state.
                         Refused wherever the setting would deliver nothing the
                         step below already delivers: a triangle-free shape at
                         1.5, a shape smaller than its own diameter at 2, and
                         'whole' always, which leaves no non-neighbor at all.
      --radii <a,b,…>    per-seat radii, assigned by seat index and cycled, for a
                         study where some participants see further than others.
                         --radii 1,2 puts even seats at 1 and odd at 2.
                         Mutually exclusive with --radius. Only a MIXED run can
                         tell a build that keys delivery on the viewer's radius
                         from one that keys it on the subject's, so the run is
                         refused on a graph where no pair disagrees.
      --project-far      your study sets graph.projectFar, so participants learn
                         something ABOUT people they are not connected to. It
                         changes what the leak arm is about — without it the data
                         rule is "neighbors only" at every radius — so it cannot
                         be inferred, and verifying the wrong one would report
                         cleanly on a study other than yours.
  -q, --quiet            only print the verdict
  -h, --help             show this

Requires the Empirica CLI on PATH:
  curl https://install.empirica.dev | sh

Exit code 0 on PASS, 1 on FAIL or error.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (args.command !== "verify" && args.command !== "")) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }

  if (!Number.isFinite(args.n) || args.n < 4) {
    process.stderr.write(
      `\n  n must be at least 4: below that every named topology makes everyone\n` +
        `  everyone's neighbor, so there is no non-neighbor and the check proves\n` +
        `  nothing.\n\n`
    );
    return 1;
  }

  // Refused rather than rounded, and refused before the topology is judged,
  // because the radius is one of the two things that decides whether a shape can
  // prove anything. A tool that quietly verified radius 1 for somebody who typed
  // 2 would be reporting on a study other than theirs.
  if (args.radii !== undefined && args.radius !== 1) {
    process.stderr.write(
      `\n  --radius and --radii are two spellings of one setting. Pass whichever\n` +
        `  describes your study and not both: a tool that let one silently win would\n` +
        `  report on a study other than yours.\n\n`
    );
    return 1;
  }
  for (const r of args.radii ?? []) {
    if (!(r === "whole" || (typeof r === "number" && Number.isFinite(r) && r >= 1 && r * 2 === Math.floor(r * 2)))) {
      process.stderr.write(
        `\n  --radii takes a comma-separated list of radii, assigned by seat and\n` +
          `  cycled. ${JSON.stringify(r)} is not one of them.\n\n` +
          `    --radii 1,2      even seats see one hop, odd seats see two\n\n`
      );
      return 1;
    }
  }
  const r = args.radius;
  const legal =
    r === "whole" ||
    (typeof r === "number" && Number.isFinite(r) && r >= 1 && r * 2 === Math.floor(r * 2));
  if (!legal) {
    process.stderr.write(
      `\n  --radius must be at least 1 and a multiple of 0.5, or "whole", got ` +
        `${JSON.stringify(args.radius)}.\n` +
        `  floor(radius) bounds the PEOPLE and the fraction decides the TIES, so 2 and\n` +
        `  2.5 show the same faces and differ only in whether the ties between the\n` +
        `  outermost of them come too. They are different studies, so a radius between\n` +
        `  the steps is refused rather than rounded to either.\n\n`
    );
    return 1;
  }
  // `whole` makes no confinement claim to verify: every participant is inside
  // every other's radius by definition, exactly as `--topology complete` leaves
  // no non-neighbor. Refused here rather than reported as a PASS over an empty
  // check, which is the shape of result this whole command exists to prevent.
  if (r === "whole") {
    process.stderr.write(
      `\n  --radius whole has no confinement to verify: every participant is inside\n` +
        `  every other's radius, so there is no non-neighbor whose state could leak and\n` +
        `  a PASS would mean nothing. This is the same refusal --topology complete gets.\n\n` +
        `  What is still worth checking at that setting — that every delivered tie is\n` +
        `  real, and that the control detects a leak — runs at any finite radius, so\n` +
        `  verify the largest one your study could reach instead.\n\n`
    );
    return 1;
  }

  // Refused before anything boots. Every named shape is pure over `n`, so whether
  // the run could establish the guarantee is knowable now rather than twenty
  // seconds from now — and the same accounting the run itself uses decides it, so
  // there is no list of known-bad names to keep in step. It catches `complete` at
  // any n and `wheel` at 4 (hub plus a three-node rim is K4) without naming
  // either, and at `--radius 1.5` it also catches every triangle-free shape.
  const preflight = preflightCliTopology(args.topology, args.n, args.radius);
  if ("refusal" in preflight) {
    process.stderr.write(`\n  ${preflight.refusal}\n\n`);
    return 1;
  }

  // Quiet the "unknown scope kind: nbhd" warning. It is expected and harmless —
  // EmpiricaClassic's scope tree does not model our kind, and composition means
  // both trees see every scope — but it fires once per channel and drowns the
  // verdict. Errors are still shown: this lowers the threshold, it does not
  // silence failures.
  setLogLevel("error");

  try {
    if (!args.quiet) {
      const installed = installedCoreVersion();
      process.stdout.write(`  @empirica/core bundled into this CLI : ${VERIFIED_CORE}\n`);
      process.stdout.write(`  @empirica/core installed here        : ${installed ?? "could not determine"}\n`);
      if (installed && installed !== VERIFIED_CORE) {
        process.stdout.write(
          `\n  NOTE: these differ. This run verifies the mechanism against ${VERIFIED_CORE},\n` +
            `  not against your installed ${installed}. Empirica cannot be loaded unbundled\n` +
            `  (see the module's PLATFORM-NOTES), so the CLI must compile a copy in.\n`
        );
      }
      process.stdout.write("\n");
    }

    const result = await runLeakCheck({
      n: args.n,
      topology: args.topology,
      radius:
        args.radii !== undefined
          ? Array.from({ length: args.n }, (_, i) => args.radii![i % args.radii!.length]!)
          : args.radius,
      projectFar: args.projectFar,
      onProgress: args.quiet ? undefined : (m) => process.stdout.write(`  … ${m}\n`),
    });
    process.stdout.write(args.quiet ? `${result.pass ? "PASS" : "FAIL"}\n` : formatLeakResult(result));
    return result.pass ? 0 : 1;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`\n  verify could not run: ${message}\n\n`);
    if (/spawn|ENOENT|empirica/i.test(message)) {
      process.stderr.write(
        `  This usually means the Empirica CLI is not on PATH:\n` +
          `    curl https://install.empirica.dev | sh\n\n`
      );
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
