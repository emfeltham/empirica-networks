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

/**
 * Why this run cannot be made, if it cannot.
 *
 * Returns the message, or `undefined` to proceed. Separated from `main` for the
 * reason the parser was: `cli.ts` cannot be loaded by the unit tier, so every
 * refusal this command makes was unreachable by any test. A refusal that fires
 * when it should not is a tool that will not run; one that does not fire when it
 * should is a PASS over a check that examined nothing, which is the result this
 * whole command exists to prevent.
 *
 * Shape only. Whether a given GRAPH can establish anything is
 * `preflightCliTopology`'s question and stays there.
 */
export function refuseArgs(args: Args): string | undefined {
  if (args.radii !== undefined && args.radius !== 1) {
    return (
      `--radius and --radii are two spellings of one setting. Pass whichever describes\n` +
      `  your study and not both: a tool that let one silently win would report on a\n` +
      `  study other than yours.`
    );
  }

  for (const r of args.radii ?? []) {
    if (!isRadius(r)) {
      return (
        `--radii takes a comma-separated list of radii, assigned by seat and cycled.\n` +
        `  ${JSON.stringify(r)} is not one of them.\n\n` +
        `    --radii 1,2      even seats see one hop, odd seats see two`
      );
    }
  }

  if (args.radii === undefined && !isRadius(args.radius)) {
    return (
      `--radius must be at least 1 and a multiple of 0.5, or "whole", got ` +
      `${JSON.stringify(args.radius)}.\n` +
      `  floor(radius) bounds the PEOPLE and the fraction decides the TIES, so 2 and\n` +
      `  2.5 show the same faces and differ only in whether the ties between the\n` +
      `  outermost of them come too. They are different studies, so a radius between\n` +
      `  the steps is refused rather than rounded to either.`
    );
  }

  // `whole` for EVERYBODY leaves no non-neighbor, so the confinement arm has an
  // empty denominator and a PASS would mean nothing — the same refusal
  // `--topology complete` gets. A run where only SOME seats are `whole` is a
  // different matter and is allowed: every narrow seat is a live test, and the
  // wide one is the hazard worth watching.
  const everySeat = args.radii ?? [args.radius];
  if (everySeat.every((r) => r === "whole")) {
    return (
      `--radius whole has no confinement to verify: every participant is inside every\n` +
      `  other's radius, so there is no non-neighbor whose state could leak and a PASS\n` +
      `  would mean nothing. This is the same refusal --topology complete gets.\n\n` +
      `  What is still worth checking at that setting — that every delivered tie is\n` +
      `  real, and that the control detects a leak — runs at any finite radius, so\n` +
      `  verify the largest one your study could reach instead. A run where only SOME\n` +
      `  participants are at "whole" is allowed, and is the more interesting shape.`
    );
  }

  return undefined;
}

/** A radius the module would accept. Shared by both checks above. */
function isRadius(r: unknown): boolean {
  return (
    r === "whole" ||
    (typeof r === "number" && Number.isFinite(r) && r >= 1 && r * 2 === Math.floor(r * 2))
  );
}
