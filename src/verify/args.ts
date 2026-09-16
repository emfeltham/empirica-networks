/**
 * How `verify` reads its arguments.
 *
 * A module of its own, with no runtime import, so it can be tested. `cli.ts`
 * reaches for `node:module` and cannot be loaded by the unit tier at all, which
 * left the parser the one part of this command nothing could check — and flag
 * parsing is precisely where a setting quietly becomes a different setting. This
 * repository has had that bug twice: `examples/minimal` compared `NBHD_RADIUS`
 * against the string `"1.5"` and sent every other value to the default without a
 * word, and `readRadius` tested for a number and read a recorded `"whole"` back
 * as nothing recorded. Both were invisible from outside.
 */
import type { Radius } from "../topology/index.js";

/** `"whole"` stays a word; anything else becomes a number so a typo is refused. */
function parseRadius(raw: string | undefined): Radius {
  const text = (raw ?? "").trim();
  if (text === "whole") return "whole";
  return Number(text);
}

export interface Args {
  command: string;
  n: number;
  /** Unvalidated as parsed; `main` refuses an unknown or vacuous one. */
  topology: string;
  /** Unvalidated as parsed, for the same reason. */
  radius: Radius;
  radii?: Radius[];
  projectFar: boolean;
  quiet: boolean;
  help: boolean;
}

/**
 * Exported for testing, and the reason is a bug this repository has already had
 * twice: `examples/minimal` matched `NBHD_RADIUS === "1.5"` and sent every other
 * value silently to the default, and `readRadius` tested `typeof raw ===
 * "number"` and read `"whole"` back as unrecorded. Flag parsing is where a
 * setting quietly becomes a different setting, and it was the one part of this
 * command nothing could reach.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    n: 4,
    topology: "ring",
    radius: 1,
    projectFar: false,
    quiet: false,
    help: false,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--n" || a === "-n") args.n = Number(argv[++i]);
    else if (a.startsWith("--n=")) args.n = Number(a.slice(4));
    // Stored as written. The casts that used to be here (`as "ring"`) made every
    // string typecheck and none of them take effect: `--topology=star` ran a ring
    // and the verdict printed "topology: star". A verification tool reporting a
    // shape it did not run is the one bug it must not have.
    else if (a === "--topology") args.topology = argv[++i] ?? "";
    else if (a.startsWith("--topology=")) args.topology = a.slice(11);
    // `"whole"` passes through as a word; everything else becomes a number so a
    // typo lands on the refusal below rather than on NaN.
    else if (a === "--project-far") args.projectFar = true;
    // Per seat, cycled by index. Deterministic rather than random, for the
    // reason `topologies.ts` gives about not forwarding an rng here.
    else if (a === "--radii") args.radii = String(argv[++i] ?? "").split(",").map(parseRadius);
    else if (a.startsWith("--radii=")) args.radii = a.slice(8).split(",").map(parseRadius);
    else if (a === "--radius") args.radius = parseRadius(argv[++i]);
    else if (a.startsWith("--radius=")) args.radius = parseRadius(a.slice(9));
    else rest.push(a);
  }
  args.command = rest[0] ?? "";
  return args;
}
