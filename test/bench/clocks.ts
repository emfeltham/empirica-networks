/**
 * What the host will admit about its own clock speed.
 *
 * `ISSUES.md` O1 closed its original goal by discovering that the goal was
 * unreachable on this class of machine: the same n=25 cell measured 3.3 to
 * 18.3 ms across one session, repeats *within* any sweep agreed to 4-17%, and
 * the identifying detail was that the coordinator burned 1.1 CPU-seconds idle
 * against 0.7 loaded for identical work. That is a clock-frequency signature —
 * DVFS, plausibly with efficiency-core placement (PLATFORM-NOTES §19). A bench
 * that leaves the machine nearly idle asks for the slowest clock it has.
 *
 * What survived is a specification: an absolute figure needs FIXED CLOCKS. This
 * file is that specification made checkable, so the difference between a number
 * measured on a pinned host and one measured on a laptop is a line of output
 * rather than something the reader has to know to ask about.
 *
 * WHAT COUNTS AS PINNED. Both halves, because either one alone still moves:
 *
 *   1. Every CPU on the `performance` governor. `powersave`/`schedutil` choose
 *      frequency from utilization, and this bench's duty cycle is 2-3% — the
 *      exact regime where they choose the lowest.
 *   2. Turbo/boost off. Turbo makes the ceiling a function of thermal headroom,
 *      so a long sweep drifts downward through itself as the package warms.
 *
 * ONLY LINUX CAN PROVE IT. macOS exposes no governor at all — the frequency
 * decision is entirely the platform's, which is why O1's numbers move — and a
 * cloud instance that genuinely has no burst usually exposes no `cpufreq`
 * sysfs either, so the absence of evidence is not evidence of absence there.
 * That second case is real and would otherwise be locked out, so an operator
 * can attest to it in words (`--attest-clocks`); the attestation is then
 * printed with the numbers, which is the point of taking it in words.
 */
import fs from "node:fs";
import os from "node:os";

export interface ClockFacts {
  host: string;
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  /** Distinct governors across CPUs, on Linux. Empty where the OS has no such notion. */
  governors: string[];
  /** Turbo/boost as the kernel reports it: "off", "on", or "unknown". */
  boost: "off" | "on" | "unknown";
  /** True only when the kernel itself says the frequency cannot move. */
  pinned: boolean;
  /** Why the clock is not pinned, in one line. Empty when it is. */
  why: string;
}

const read = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
};

const CPU_ROOT = "/sys/devices/system/cpu";

/** One governor name per CPU that reports one, deduplicated. */
function governors(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(CPU_ROOT);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const n of names) {
    if (!/^cpu\d+$/.test(n)) continue;
    const g = read(`${CPU_ROOT}/${n}/cpufreq/scaling_governor`);
    if (g) seen.add(g);
  }
  return [...seen].sort();
}

/**
 * Two spellings of the same switch, and they are inverted with respect to each
 * other: `intel_pstate/no_turbo` is 1 when turbo is OFF, `cpufreq/boost` is 1
 * when boost is ON. Reading either one with the other's sense is the obvious
 * way to get this backwards, so both are named here.
 */
function boostState(): "off" | "on" | "unknown" {
  const noTurbo = read(`${CPU_ROOT}/intel_pstate/no_turbo`);
  if (noTurbo === "1") return "off";
  if (noTurbo === "0") return "on";
  const boost = read(`${CPU_ROOT}/cpufreq/boost`);
  if (boost === "0") return "off";
  if (boost === "1") return "on";
  return "unknown";
}

export function clockFacts(): ClockFacts {
  const cpus = os.cpus();
  const base = {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
  };

  if (process.platform !== "linux") {
    return {
      ...base,
      governors: [],
      boost: "unknown",
      pinned: false,
      why: `${process.platform} exposes no CPU governor, so frequency cannot be pinned (ISSUES.md O1)`,
    };
  }

  const govs = governors();
  const boost = boostState();
  const bad: string[] = [];
  if (govs.length === 0) bad.push("no cpufreq sysfs (a VM, or a kernel without it)");
  else if (govs.some((g) => g !== "performance")) bad.push(`governor ${govs.join("+")}, not performance`);
  if (boost !== "off") bad.push(`turbo/boost ${boost}`);

  return {
    ...base,
    governors: govs,
    boost,
    pinned: bad.length === 0,
    why: bad.join("; "),
  };
}

/** One line, for the header of a run. Everything a published figure should carry. */
export function describeClocks(f: ClockFacts, attested?: string): string {
  const where = `${f.host} ${f.platform}/${f.arch} ${f.cores}x ${f.cpu}`;
  if (f.pinned) return `${where} — clocks PINNED (governor performance, boost off)`;
  if (attested) return `${where} — clocks attested by operator: ${attested}`;
  return `${where} — clocks NOT pinned: ${f.why}`;
}
