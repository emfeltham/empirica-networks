/**
 * `npx empirica-networks verify`
 *
 * Runs the leak check against the consumer's OWN installed versions of the
 * Empirica CLI and @empirica/core. The point is that the module's central claim
 * — a participant never receives a non-neighbour's state — is something a
 * researcher, a collaborator, or a reviewer can reproduce in about thirty
 * seconds rather than take on trust. It doubles as the upgrade canary.
 *
 * Shipped BUNDLED AS CJS. The published @empirica/core cannot be loaded from raw
 * Node in either module system (docs/PLATFORM-NOTES.md §3a), so a plain-ESM CLI
 * would fail on every user's machine.
 */
import { createRequire } from "node:module";
import { setLogLevel } from "@empirica/core/console";
import { formatLeakResult, runLeakCheck } from "./leak_test.js";

/** Version of @empirica/core compiled into this CLI. */
const BUNDLED_CORE = "1.12.5";

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

interface Args {
  command: string;
  n: number;
  topology: "ring";
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", n: 4, topology: "ring", quiet: false, help: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--n" || a === "-n") args.n = Number(argv[++i]);
    else if (a.startsWith("--n=")) args.n = Number(a.slice(4));
    else if (a === "--topology") args.topology = argv[++i] as "ring";
    else if (a.startsWith("--topology=")) args.topology = a.slice(11) as "ring";
    else rest.push(a);
  }
  args.command = rest[0] ?? "";
  return args;
}

const USAGE = `
empirica-networks verify — reproduce the neighbour-limited visibility guarantee

Usage:
  npx empirica-networks verify [options]

Options:
  -n, --n <count>        participants (default 4, minimum 4)
      --topology <name>  ring (default)
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
      `\n  n must be at least 4: on a smaller ring everyone is everyone's neighbour,\n` +
        `  so there is no non-neighbour and the check proves nothing.\n\n`
    );
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
      process.stdout.write(`  @empirica/core bundled into this CLI : ${BUNDLED_CORE}\n`);
      process.stdout.write(`  @empirica/core installed here        : ${installed ?? "could not determine"}\n`);
      if (installed && installed !== BUNDLED_CORE) {
        process.stdout.write(
          `\n  NOTE: these differ. This run verifies the mechanism against ${BUNDLED_CORE},\n` +
            `  not against your installed ${installed}. Empirica cannot be loaded unbundled\n` +
            `  (see the module's PLATFORM-NOTES), so the CLI must compile a copy in.\n`
        );
      }
      process.stdout.write("\n");
    }

    const result = await runLeakCheck({
      n: args.n,
      topology: args.topology,
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
