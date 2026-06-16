/**
 * App-level retry wrapper for transient database / connection-pooler failures.
 *
 * WHY THIS EXISTS (VAL-483, parent investigation VAL-482 → VAL-480 → VAL-479):
 * The OS backend talks to Postgres through the Supabase connection pooler. Under
 * load the pooler episodically drops or refuses connections — CONNECT_TIMEOUT,
 * "Connection terminated unexpectedly", EDBHANDLEREXITED, ECONNRESET, admin
 * shutdown (57P01) — and these surface as one-shot query failures that bubble
 * all the way up and blow the 600s heartbeat cap (VAL-479). They are *transient*:
 * a retry a few hundred ms later on a warm connection almost always succeeds.
 *
 * This module is the framework-agnostic, dependency-free building block for the
 * fix: a `withDbRetry(fn)` wrapper that
 *   1. classifies the thrown error (transient pooler/connection fault vs a
 *      permanent error like a constraint violation or syntax error),
 *   2. retries ONLY transient errors, with exponential backoff + jitter
 *      (50 → 100 → 200 → 500 ms, capped at 2s), up to a small attempt limit,
 *   3. records counters so retry pressure is observable.
 *
 * Permanent errors are re-thrown immediately — we never paper over a real bug by
 * retrying it. A transient error that exhausts the attempt budget is re-thrown
 * too (callers see the original failure, just after we genuinely tried).
 *
 * Design mirrors `circuit-breaker.ts`: the decision logic is PURE and its sources
 * of nondeterminism — the clock/sleep and the jitter RNG — are injected, so the
 * backoff schedule and retry behaviour are unit-testable without real timers.
 *
 * SCOPE: this is the reusable primitive. The integration points named in VAL-483
 * (heartbeat loops, issue checkout, feedback flush) live in ValAdrien OS platform
 * code that is not reachable from this tenant repo; wiring `withDbRetry` around
 * those critical DB operations is forwarded to the OS platform maintainers.
 */

export type DbErrorClass = "transient" | "permanent";

export interface RetryConfig {
  /** Total attempts including the first try (e.g. 4 ⇒ up to 3 retries). */
  maxAttempts: number;
  /**
   * Base delay (ms) BEFORE each retry, indexed by retry number (0-based):
   * schedule[0] is the wait before retry #1, schedule[1] before retry #2, …
   * Retries past the end of the array reuse the last entry (then get capped).
   */
  backoffScheduleMs: number[];
  /** Hard cap on any single backoff delay (ms), applied before jitter. */
  maxDelayMs: number;
  /**
   * Jitter strategy applied to each delay to avoid synchronized retry storms
   * ("thundering herd") when many callers fail at once:
   *   - "equal": delay/2 + random(0, delay/2)  (default — keeps a sane floor)
   *   - "full":  random(0, delay)               (max decorrelation)
   *   - "none":  delay                           (deterministic, for debugging)
   */
  jitter: "equal" | "full" | "none";
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  backoffScheduleMs: [50, 100, 200, 500],
  maxDelayMs: 2000,
  jitter: "equal",
};

/**
 * Substrings / Postgres SQLSTATE codes that mark an error as a transient
 * connection-layer fault worth retrying. Matched case-insensitively against the
 * error's `code` and `message`. Kept conservative on purpose: when in doubt we
 * treat an error as permanent (do NOT retry) so we never mask a real fault.
 */
export const TRANSIENT_ERROR_SIGNATURES: readonly string[] = [
  // Node / socket level
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // node-postgres / pooler phrasings
  "EDBHANDLEREXITED",
  "CONNECTION TERMINATED",
  "CONNECTION TERMINATED UNEXPECTEDLY",
  "TIMEOUT EXCEEDED WHEN TRYING TO CONNECT",
  "CONNECTION ERROR",
  "SERVER CLOSED THE CONNECTION",
  "TERMINATING CONNECTION DUE TO ADMINISTRATOR COMMAND",
  "TOO MANY CLIENTS ALREADY",
  // Postgres SQLSTATE class 08 (connection exception) + a few specific codes
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
];

/** Pull comparable text out of an unknown thrown value. */
function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; cause?: unknown };
    const parts = [e.code, e.message]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    // Pooler errors are frequently wrapped; recurse one level into `cause`.
    const causeText = e.cause && e.cause !== err ? ` ${errorText(e.cause)}` : "";
    return `${parts}${causeText}`;
  }
  return String(err);
}

/**
 * Classify a thrown DB error as transient (retry) or permanent (re-throw).
 * Pure: depends only on the error's own text.
 */
export function classifyDbError(err: unknown): DbErrorClass {
  const haystack = errorText(err).toUpperCase();
  if (!haystack) return "permanent";
  for (const sig of TRANSIENT_ERROR_SIGNATURES) {
    if (haystack.includes(sig)) return "transient";
  }
  return "permanent";
}

/**
 * Pure backoff calculator. `retryIndex` is 0-based (0 = the wait before the
 * first retry). `rand` must return a value in [0, 1); it is injected so jitter
 * is deterministic in tests. Returns the delay in ms to sleep before the retry.
 */
export function retryDelayMs(cfg: RetryConfig, retryIndex: number, rand: () => number): number {
  const schedule = cfg.backoffScheduleMs;
  const raw =
    schedule.length === 0
      ? cfg.maxDelayMs
      : schedule[Math.min(retryIndex, schedule.length - 1)];
  const capped = Math.min(raw, cfg.maxDelayMs);
  switch (cfg.jitter) {
    case "none":
      return capped;
    case "full":
      return rand() * capped;
    case "equal":
    default:
      return capped / 2 + rand() * (capped / 2);
  }
}

/** Mutable counters for observability. One accumulator per logical caller/path. */
export interface RetryMetrics {
  /** Total wrapped invocations (each call to withDbRetry increments once). */
  calls: number;
  /** Total attempts made across all calls (first tries + retries). */
  attempts: number;
  /** Total retries performed (attempts beyond the first). */
  retries: number;
  /** Transient errors observed (each one drives a retry decision). */
  transientErrors: number;
  /** Permanent errors observed (re-thrown immediately, never retried). */
  permanentErrors: number;
  /** Calls that ultimately succeeded, but only after ≥1 retry. */
  succeededAfterRetry: number;
  /** Calls that exhausted the attempt budget on transient errors and failed. */
  exhausted: number;
}

export function createRetryMetrics(): RetryMetrics {
  return {
    calls: 0,
    attempts: 0,
    retries: 0,
    transientErrors: 0,
    permanentErrors: 0,
    succeededAfterRetry: 0,
    exhausted: 0,
  };
}

export interface RetryHooks {
  /** Counters to accumulate into (optional). */
  metrics?: RetryMetrics;
  /**
   * Called just before sleeping for a retry. Useful for structured logging.
   * `attempt` is the just-failed attempt number (1-based).
   */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: unknown;
    classification: DbErrorClass;
  }) => void;
  /** Sleep implementation (injected for tests). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter RNG in [0,1) (injected for tests). Defaults to Math.random. */
  rand?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying ONLY transient DB/pooler errors with exponential backoff +
 * jitter. Permanent errors and exhausted transient errors are re-thrown with the
 * original error preserved. The resolved value of `fn` is returned unchanged.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig = DEFAULT_RETRY_CONFIG,
  hooks: RetryHooks = {}
): Promise<T> {
  const { metrics, onRetry } = hooks;
  const sleep = hooks.sleep ?? realSleep;
  const rand = hooks.rand ?? Math.random;
  const maxAttempts = Math.max(1, cfg.maxAttempts);

  if (metrics) metrics.calls++;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    if (metrics) metrics.attempts++;
    try {
      const result = await fn();
      if (metrics && attempt > 1) metrics.succeededAfterRetry++;
      return result;
    } catch (err) {
      const classification = classifyDbError(err);
      if (metrics) {
        if (classification === "transient") metrics.transientErrors++;
        else metrics.permanentErrors++;
      }

      // Permanent error, or budget exhausted → give up, surface the real error.
      if (classification === "permanent" || attempt >= maxAttempts) {
        if (metrics && classification === "transient" && attempt >= maxAttempts) {
          metrics.exhausted++;
        }
        throw err;
      }

      // Transient + budget remaining → back off (retryIndex is 0-based) & retry.
      const delayMs = retryDelayMs(cfg, attempt - 1, rand);
      if (metrics) metrics.retries++;
      onRetry?.({ attempt, delayMs, error: err, classification });
      await sleep(delayMs);
    }
  }
}
