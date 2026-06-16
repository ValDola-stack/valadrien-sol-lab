/**
 * Tests for the transient-pooler retry wrapper (VAL-483).
 *
 * The headline test (`transient connection drops are retried and self-heal`) is
 * the acceptance criterion: a flow that fails a few times with the exact errors
 * VAL-482 observed (CONNECT_TIMEOUT / connection-terminated) must succeed on a
 * warm retry instead of bubbling a heartbeat-killing failure.
 *
 * All nondeterminism (sleep + jitter RNG) is injected so the suite is fast and
 * deterministic. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETRY_CONFIG,
  classifyDbError,
  retryDelayMs,
  withDbRetry,
  createRetryMetrics,
  type RetryConfig,
} from "./db-retry.js";

// A sleep stub that records the delays it was asked to wait, without waiting.
function recordingSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { delays, sleep };
}

// Deterministic "RNG": replays a fixed sequence (then holds the last value).
function seqRand(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

// ── Error classification ──────────────────────────────────────────────────────

test("classifies the transient pooler errors VAL-482 observed", () => {
  for (const e of [
    { code: "CONNECT_TIMEOUT", message: "pooler connect timeout" },
    new Error("Connection terminated unexpectedly"),
    { code: "ECONNRESET", message: "read ECONNRESET" },
    { code: "57P01", message: "terminating connection due to administrator command" },
    { code: "08006", message: "connection failure" },
    { message: "timeout exceeded when trying to connect" },
    { message: "remaining connection slots", code: "53300" },
    "EDBHANDLEREXITED while spawning",
  ]) {
    assert.equal(classifyDbError(e), "transient", `expected transient: ${JSON.stringify(e)}`);
  }
});

test("classifies real application errors as permanent (never retried)", () => {
  for (const e of [
    { code: "23505", message: "duplicate key value violates unique constraint" },
    { code: "42P01", message: 'relation "issues" does not exist' },
    new Error("null value in column violates not-null constraint"),
    new TypeError("cannot read properties of undefined"),
    null,
    undefined,
    {},
  ]) {
    assert.equal(classifyDbError(e), "permanent", `expected permanent: ${JSON.stringify(e)}`);
  }
});

test("unwraps a transient error nested in `cause`", () => {
  const wrapped = new Error("query failed");
  (wrapped as { cause?: unknown }).cause = { code: "ECONNRESET" };
  assert.equal(classifyDbError(wrapped), "transient");
});

// ── Backoff schedule + jitter ─────────────────────────────────────────────────

test("backoff with jitter disabled follows the documented 50→100→200→500 schedule", () => {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, jitter: "none" };
  const rand = () => 0;
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => retryDelayMs(cfg, i, rand)),
    [50, 100, 200, 500]
  );
});

test("backoff caps at maxDelayMs and reuses the last schedule entry past its end", () => {
  const cfg: RetryConfig = {
    maxAttempts: 10,
    backoffScheduleMs: [50, 100, 200, 500, 1000, 4000],
    maxDelayMs: 2000,
    jitter: "none",
  };
  const rand = () => 0;
  assert.equal(retryDelayMs(cfg, 5, rand), 2000, "4000 must cap to 2000");
  assert.equal(retryDelayMs(cfg, 9, rand), 2000, "past end reuses last (4000) → capped 2000");
});

test("equal jitter keeps the delay within [raw/2, raw]", () => {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, jitter: "equal" };
  assert.equal(retryDelayMs(cfg, 0, () => 0), 25, "rand=0 → raw/2 (floor)");
  assert.ok(retryDelayMs(cfg, 0, () => 0.9999999) < 50, "rand→1 approaches but stays under raw");
  // Bound check across the range.
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const d = retryDelayMs(cfg, 0, () => r);
    assert.ok(d >= 25 && d <= 50, `equal jitter out of bounds: ${d}`);
  }
});

test("full jitter keeps the delay within [0, raw]", () => {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, jitter: "full" };
  for (const r of [0, 0.5, 0.999]) {
    const d = retryDelayMs(cfg, 0, () => r);
    assert.ok(d >= 0 && d <= 50, `full jitter out of bounds: ${d}`);
  }
});

// ── withDbRetry behaviour ─────────────────────────────────────────────────────

test("transient connection drops are retried and self-heal (acceptance)", async () => {
  const { delays, sleep } = recordingSleep();
  const metrics = createRetryMetrics();
  let calls = 0;

  const result = await withDbRetry(
    async () => {
      calls++;
      if (calls <= 2) throw { code: "CONNECT_TIMEOUT", message: "pooler connect timeout" };
      return "ok";
    },
    { ...DEFAULT_RETRY_CONFIG, jitter: "none" },
    { metrics, sleep }
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3, "should fail twice then succeed on the 3rd attempt");
  assert.deepEqual(delays, [50, 100], "backed off before each retry");
  assert.equal(metrics.attempts, 3);
  assert.equal(metrics.retries, 2);
  assert.equal(metrics.transientErrors, 2);
  assert.equal(metrics.succeededAfterRetry, 1);
  assert.equal(metrics.exhausted, 0);
});

test("permanent errors are thrown immediately without any retry", async () => {
  const { delays, sleep } = recordingSleep();
  const metrics = createRetryMetrics();
  let calls = 0;

  await assert.rejects(
    () =>
      withDbRetry(
        async () => {
          calls++;
          throw { code: "23505", message: "duplicate key" };
        },
        DEFAULT_RETRY_CONFIG,
        { metrics, sleep }
      ),
    (err: unknown) => (err as { code?: string }).code === "23505"
  );

  assert.equal(calls, 1, "permanent error must not be retried");
  assert.deepEqual(delays, [], "no backoff for permanent errors");
  assert.equal(metrics.permanentErrors, 1);
  assert.equal(metrics.retries, 0);
});

test("a transient error that never clears exhausts the budget and re-throws the original", async () => {
  const { delays, sleep } = recordingSleep();
  const metrics = createRetryMetrics();
  let calls = 0;

  await assert.rejects(
    () =>
      withDbRetry(
        async () => {
          calls++;
          throw new Error("Connection terminated unexpectedly");
        },
        { maxAttempts: 4, backoffScheduleMs: [50, 100, 200, 500], maxDelayMs: 2000, jitter: "none" },
        { metrics, sleep }
      ),
    /Connection terminated unexpectedly/
  );

  assert.equal(calls, 4, "4 attempts total (1 + 3 retries)");
  assert.deepEqual(delays, [50, 100, 200], "3 backoffs between 4 attempts");
  assert.equal(metrics.attempts, 4);
  assert.equal(metrics.retries, 3);
  assert.equal(metrics.exhausted, 1);
  assert.equal(metrics.succeededAfterRetry, 0);
});

test("onRetry hook fires once per retry with attempt/delay/classification", async () => {
  const { sleep } = recordingSleep();
  const seen: Array<{ attempt: number; delayMs: number }> = [];
  let calls = 0;

  await withDbRetry(
    async () => {
      calls++;
      if (calls <= 1) throw { code: "ECONNRESET" };
      return 42;
    },
    { ...DEFAULT_RETRY_CONFIG, jitter: "none" },
    {
      sleep,
      onRetry: ({ attempt, delayMs, classification }) => {
        assert.equal(classification, "transient");
        seen.push({ attempt, delayMs });
      },
    }
  );

  assert.deepEqual(seen, [{ attempt: 1, delayMs: 50 }]);
});

test("maxAttempts=1 disables retries entirely", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(() =>
    withDbRetry(
      async () => {
        calls++;
        throw { code: "ECONNRESET" };
      },
      { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 },
      { sleep }
    )
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("jitter RNG is honoured end-to-end (delays reflect injected rand)", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  // equal jitter: delay = raw/2 + rand*raw/2. rand=0 → raw/2 exactly.
  await withDbRetry(
    async () => {
      calls++;
      if (calls <= 2) throw { code: "CONNECT_TIMEOUT" };
      return "ok";
    },
    { ...DEFAULT_RETRY_CONFIG, jitter: "equal" },
    { sleep, rand: seqRand([0, 0]) }
  );
  assert.deepEqual(delays, [25, 50], "equal jitter with rand=0 halves each base delay");
});
