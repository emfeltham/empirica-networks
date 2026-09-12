/**
 * The shared append-only NDJSON writer.
 *
 * These tests were `test/unit/views.test.ts`'s, and they moved here with the
 * code — deliberately moved rather than rewritten, since
 * every one of them was written for a defect that had actually happened. What is
 * new is the durability pair at the bottom: the whole reason `net.log` exists is
 * that a killed study should still have data, and until now nothing measured what
 * a kill actually costs.
 *
 * Two of those spawn a real process, because a hard kill cannot be simulated
 * in-process: `process.once("exit")` is the hedge for a clean shutdown, and SIGKILL
 * is precisely the case where no handler runs at all.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLogSink, makeNdjsonSink } from "../../src/admin/sink.js";

interface Row {
  gameID: string;
  n: number;
}

const ROWS: Row[] = [
  { gameID: "g1", n: 1 },
  { gameID: "g1", n: 2 },
];

const OPTS = { label: "log.onRecord", describe: (r: Row) => `game ${r.gameID}`, defaultBatch: 256 };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "en-sink-"));
}

function lines(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return text.length === 0 ? [] : text.trim().split("\n").filter(Boolean);
}

test("no config means no sink, so the caller pays nothing", () => {
  assert.equal(makeNdjsonSink(undefined, OPTS), undefined);
  assert.equal(makeNdjsonSink({}, OPTS), undefined);
});

test("every record reaches onRecord", () => {
  const seen: Row[] = [];
  const sink = makeNdjsonSink<Row>({ onRecord: (r) => seen.push(r) }, OPTS)!;
  for (const r of ROWS) sink.record(r);
  assert.deepEqual(seen, ROWS);
});

test("a throwing onRecord does not take the caller down with it", () => {
  // The study matters more than its telemetry: a sink that throws must not abort
  // a publish that is mid-flight to every participant, or a listener that is
  // about to end the stage.
  const sink = makeNdjsonSink<Row>(
    {
      onRecord: () => {
        throw new Error("sink is on fire");
      },
    },
    OPTS
  )!;
  const errors: string[] = [];
  const real = console.error;
  console.error = (m: unknown) => errors.push(String(m));
  try {
    assert.doesNotThrow(() => sink.record(ROWS[0]!));
  } finally {
    console.error = real;
  }
  // Reported, and reported specifically enough to find. Two sinks share this
  // code, so a message that named neither the field nor the record would send
  // the reader to the wrong callback.
  assert.match(errors[0]!, /log\.onRecord threw for game g1/);
  assert.match(errors[0]!, /sink is on fire/);
});

test("the file sink writes NDJSON that parses back to what went in", () => {
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    const sink = makeNdjsonSink<Row>({ file }, OPTS)!;
    for (const r of ROWS) sink.record(r);
    // Buffered by design at this batch size, which is the trade that keeps a
    // syscall out of the publish path.
    assert.equal(fs.readFileSync(file, "utf8"), "", "buffered until flushed");
    sink.close();
    assert.deepEqual(lines(file).map((l) => JSON.parse(l)), ROWS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a full batch flushes without waiting", () => {
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    const sink = makeNdjsonSink<Row>({ file, batch: 2 }, OPTS)!;
    sink.record(ROWS[0]!);
    assert.equal(fs.readFileSync(file, "utf8"), "", "one record, batch of two");
    sink.record(ROWS[1]!);
    assert.equal(lines(file).length, 2, "the second record fills the batch and writes both");
    sink.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("batch 1 writes every record as it arrives", () => {
  // The run log's default, and the reason it differs from `views`': a facility
  // that exists so a killed study still has data must not be holding its newest
  // rows in memory when the kill arrives.
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    const sink = makeNdjsonSink<Row>({ file, batch: 1 }, OPTS)!;
    sink.record(ROWS[0]!);
    assert.equal(lines(file).length, 1, "on disk with no flush and no close");
    sink.record(ROWS[1]!);
    assert.equal(lines(file).length, 2);
    sink.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the run log defaults to unbuffered, and views to 256", () => {
  // The defaults are the decision, so they are asserted rather than left to the
  // doc comment. Checked through behavior: one record, and whether it is on disk.
  const dir = tmp();
  try {
    const logFile = path.join(dir, "run.ndjson");
    makeLogSink({ file: logFile })!.record({ gameID: "g", at: 0, type: "x" });
    assert.equal(lines(logFile).length, 1, "the run log wrote immediately");

    const viewFile = path.join(dir, "views.ndjson");
    makeNdjsonSink<Row>({ file: viewFile }, OPTS)!.record(ROWS[0]!);
    assert.equal(lines(viewFile).length, 0, "views buffered");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file is appended, so a restart does not erase the study so far", () => {
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    const first = makeNdjsonSink<Row>({ file }, OPTS)!;
    first.record(ROWS[0]!);
    first.close();

    const second = makeNdjsonSink<Row>({ file }, OPTS)!;
    second.record(ROWS[1]!);
    second.close();

    assert.equal(lines(file).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested file path creates its directory", () => {
  // Regression for a defect found by running the Rand 2011 reconstruction:
  // `views: { file: "data/views.ndjson" }` is the natural thing to write, and it
  // used to throw a bare ENOENT from inside `withNetwork` at game start — after
  // participants had joined, naming neither the option nor the fix.
  const root = tmp();
  const nested = path.join(root, "deep", "deeper", "out.ndjson");
  try {
    assert.equal(fs.existsSync(path.dirname(nested)), false, "the directory is absent to start");
    const sink = makeNdjsonSink<Row>({ file: nested }, OPTS)!;
    sink.record(ROWS[0]!);
    sink.close();
    assert.match(fs.readFileSync(nested, "utf8"), /"gameID":"g1"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Run `code` in a fresh process with tsx, so the sink's own lifecycle is real.
 *
 * `kill` sends SIGKILL from inside that process once the records are written —
 * the case no handler can catch, which is the case the buffering trade is about.
 */
function inChild(code: string, { kill = false }: { kill?: boolean } = {}): void {
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const src = path.join(process.cwd(), "src", "admin", "sink.ts");
  const program = `import { makeNdjsonSink } from ${JSON.stringify(src)};\n${code}\n${
    kill ? "process.kill(process.pid, 'SIGKILL');\n" : ""
  }`;
  if (kill) {
    // Expected to die by signal, so `spawnSync`: `execFileSync` would throw on
    // the non-zero exit and the throw is not the finding.
    const r = spawnSync(tsx, ["-e", program], { encoding: "utf8" });
    // `tsx` runs the program in a process of its own and relays the death as an
    // exit code, so the SIGKILL arrives here as status 137 (128 + 9) rather than
    // as `signal`. Both are accepted, because which one shows up is a property of
    // the launcher and not of what is being measured — and asserting that the
    // child died SOMEHOW is the part that matters: a child that exited cleanly
    // would have run its exit handler and flushed, making the count below
    // meaningless.
    assert.ok(
      r.signal === "SIGKILL" || r.status === 137,
      `the child was meant to be killed, not to exit with ${r.status}: ${r.stderr}`
    );
    return;
  }
  execFileSync(tsx, ["-e", program], { encoding: "utf8" });
}

test("a clean exit flushes the tail, with nobody calling close", () => {
  // The hedge in `makeNdjsonSink`: a server shut down normally must not lose the
  // records still in its buffer. Untestable in-process — the handler runs on
  // `exit` — so this spawns a process that records and returns.
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    inChild(
      `const s = makeNdjsonSink({ file: ${JSON.stringify(file)}, batch: 256 }, ` +
        `{ label: "t", defaultBatch: 256 });\n` +
        `s.record({ n: 1 }); s.record({ n: 2 });`
    );
    assert.deepEqual(lines(file).map((l) => JSON.parse(l)), [{ n: 1 }, { n: 2 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL mid-study costs at most one batch, and not one record more", () => {
  /**
   * The claim the whole facility rests on, measured rather than asserted in a
   * comment. 300 records at `batch: 256`: the first 256 are on disk because the
   * batch filled, the remaining 44 are in memory, and SIGKILL runs no handler.
   *
   * Both halves matter. That ≥256 survive is the durability promise. That
   * EXACTLY 256 survive is the cost of buffering, stated in the one place a
   * reader will believe it — which is why the run log defaults to `batch: 1`,
   * where this number would be 300.
   */
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    inChild(
      `const s = makeNdjsonSink({ file: ${JSON.stringify(file)}, batch: 256 }, ` +
        `{ label: "t", defaultBatch: 256 });\n` +
        `for (let i = 0; i < 300; i++) s.record({ i });`,
      { kill: true }
    );
    assert.equal(lines(file).length, 256, "one batch on disk, the rest lost with the process");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("batch 1 survives SIGKILL with everything", () => {
  // The other side of the trade, and the reason the run log's default is what it
  // is: with no buffer there is nothing for a kill to take.
  const dir = tmp();
  const file = path.join(dir, "out.ndjson");
  try {
    inChild(
      `const s = makeNdjsonSink({ file: ${JSON.stringify(file)}, batch: 1 }, ` +
        `{ label: "t", defaultBatch: 1 });\n` +
        `for (let i = 0; i < 300; i++) s.record({ i });`,
      { kill: true }
    );
    assert.equal(lines(file).length, 300, "every record was already on disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
