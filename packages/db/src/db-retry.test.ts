import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETRY_CONFIG,
  classifyDbError,
  retryDelayMs,
  withDbRetry,
  createRetryMetrics,
  type RetryConfig,
} from "./db-retry.js";

function recordingSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { delays, sleep };
}

function seqRand(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("classifyDbError", () => {
  it("classifies transient pooler errors", () => {
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
      expect(classifyDbError(e)).toBe("transient");
    }
  });

  it("classifies real application errors as permanent", () => {
    for (const e of [
      { code: "23505", message: "duplicate key value violates unique constraint" },
      { code: "42P01", message: 'relation "issues" does not exist' },
      new Error("null value in column violates not-null constraint"),
      new TypeError("cannot read properties of undefined"),
      null,
      undefined,
      {},
    ]) {
      expect(classifyDbError(e)).toBe("permanent");
    }
  });

  it("unwraps a transient error nested in `cause`", () => {
    const wrapped = new Error("query failed");
    (wrapped as { cause?: unknown }).cause = { code: "ECONNRESET" };
    expect(classifyDbError(wrapped)).toBe("transient");
  });
});

describe("retryDelayMs", () => {
  it("backoff with jitter disabled follows the documented 50→100→200→500 schedule", () => {
    const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, jitter: "none" };
    const rand = () => 0;
    expect([0, 1, 2, 3].map((i) => retryDelayMs(cfg, i, rand))).toEqual([50, 100, 200, 500]);
  });

  it("backoff caps at maxDelayMs and reuses the last schedule entry past its end", () => {
    const cfg: RetryConfig = {
      maxAttempts: 10,
      backoffScheduleMs: [50, 100, 200, 500, 1000, 4000],
      maxDelayMs: 2000,
      jitter: "none",
    };
    const rand = () => 0;
    expect(retryDelayMs(cfg, 5, rand)).toBe(2000);
    expect(retryDelayMs(cfg, 9, rand)).toBe(2000);
  });

  it("equal jitter keeps the delay within [raw/2, raw]", () => {
    const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, jitter: "equal" };
    expect(retryDelayMs(cfg, 0, () => 0)).toBe(25);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = retryDelayMs(cfg, 0, () => r);
      expect(d).toBeGreaterThanOrEqual(25);
      expect(d).toBeLessThanOrEqual(50);
    }
  });

  it("full jitter keeps the delay within [0, raw]", () => {
    const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, jitter: "full" };
    for (const r of [0, 0.5, 0.999]) {
      const d = retryDelayMs(cfg, 0, () => r);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(50);
    }
  });
});

describe("withDbRetry", () => {
  it("transient connection drops are retried and self-heal (acceptance)", async () => {
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
      { metrics, sleep },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 100]);
    expect(metrics.attempts).toBe(3);
    expect(metrics.retries).toBe(2);
    expect(metrics.transientErrors).toBe(2);
    expect(metrics.succeededAfterRetry).toBe(1);
    expect(metrics.exhausted).toBe(0);
  });

  it("permanent errors are thrown immediately without any retry", async () => {
    const { delays, sleep } = recordingSleep();
    const metrics = createRetryMetrics();
    let calls = 0;

    await expect(
      withDbRetry(
        async () => {
          calls++;
          throw { code: "23505", message: "duplicate key" };
        },
        DEFAULT_RETRY_CONFIG,
        { metrics, sleep },
      ),
    ).rejects.toMatchObject({ code: "23505" });

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(metrics.permanentErrors).toBe(1);
    expect(metrics.retries).toBe(0);
  });

  it("a transient error that never clears exhausts the budget and re-throws the original", async () => {
    const { delays, sleep } = recordingSleep();
    const metrics = createRetryMetrics();
    let calls = 0;

    await expect(
      withDbRetry(
        async () => {
          calls++;
          throw new Error("Connection terminated unexpectedly");
        },
        { maxAttempts: 4, backoffScheduleMs: [50, 100, 200, 500], maxDelayMs: 2000, jitter: "none" },
        { metrics, sleep },
      ),
    ).rejects.toThrow("Connection terminated unexpectedly");

    expect(calls).toBe(4);
    expect(delays).toEqual([50, 100, 200]);
    expect(metrics.attempts).toBe(4);
    expect(metrics.retries).toBe(3);
    expect(metrics.exhausted).toBe(1);
    expect(metrics.succeededAfterRetry).toBe(0);
  });

  it("onRetry hook fires once per retry with attempt/delay/classification", async () => {
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
          expect(classification).toBe("transient");
          seen.push({ attempt, delayMs });
        },
      },
    );

    expect(seen).toEqual([{ attempt: 1, delayMs: 50 }]);
  });

  it("maxAttempts=1 disables retries entirely", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await expect(
      withDbRetry(
        async () => {
          calls++;
          throw { code: "ECONNRESET" };
        },
        { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 },
        { sleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("jitter RNG is honoured end-to-end", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await withDbRetry(
      async () => {
        calls++;
        if (calls <= 2) throw { code: "CONNECT_TIMEOUT" };
        return "ok";
      },
      { ...DEFAULT_RETRY_CONFIG, jitter: "equal" },
      { sleep, rand: seqRand([0, 0]) },
    );
    expect(delays).toEqual([25, 50]);
  });
});
