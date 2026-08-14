import assert from "node:assert/strict";
import test from "node:test";
import { TimeoutError, waitFor, waitForValue } from "../../src/shared/wait.js";

test("resolves once the condition holds", async () => {
  let n = 0;
  await waitFor(() => ++n >= 3, { label: "third call", intervalMs: 1 });
  assert.equal(n, 3);
});

test("resolves immediately when already true, without waiting an interval", async () => {
  const t0 = Date.now();
  await waitFor(() => true, { label: "already true", intervalMs: 5_000 });
  assert.ok(Date.now() - t0 < 1_000, "did not sleep a full interval first");
});

test("throws TimeoutError, naming what it was waiting for", async () => {
  await assert.rejects(
    () => waitFor(() => false, { label: "never true", timeoutMs: 50, intervalMs: 5 }),
    (e: unknown) => {
      assert.ok(e instanceof TimeoutError);
      assert.match((e as Error).message, /never true/);
      return true;
    }
  );
});

test("a throwing condition counts as not-yet, and can still succeed", async () => {
  let n = 0;
  await waitFor(
    () => {
      if (++n < 3) throw new Error("not ready");
      return true;
    },
    { label: "eventually stops throwing", intervalMs: 1 }
  );
  assert.equal(n, 3);
});

test("surfaces the condition's last error in the timeout message", async () => {
  // Without this, a genuine bug inside the condition is indistinguishable from
  // a slow system — the failure mode that makes polling helpers frustrating.
  await assert.rejects(
    () =>
      waitFor(
        () => {
          throw new Error("boom from inside the condition");
        },
        { label: "always throws", timeoutMs: 30, intervalMs: 5 }
      ),
    /boom from inside the condition/
  );
});

test("accepts async conditions", async () => {
  let n = 0;
  await waitFor(async () => ++n >= 2, { label: "async", intervalMs: 1 });
  assert.equal(n, 2);
});

test("waitForValue resolves on a matching subject value", async () => {
  let v = false;
  const subject = { getValue: () => v };
  setTimeout(() => {
    v = true;
  }, 20);
  await waitForValue(subject, true, "subject becomes true", 2_000);
  assert.equal(v, true);
});
