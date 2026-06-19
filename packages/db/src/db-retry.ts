export type DbErrorClass = "transient" | "permanent";

export interface RetryConfig {
  maxAttempts: number;
  backoffScheduleMs: number[];
  maxDelayMs: number;
  jitter: "equal" | "full" | "none";
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  backoffScheduleMs: [50, 100, 200, 500],
  maxDelayMs: 2000,
  jitter: "equal",
};

export const TRANSIENT_ERROR_SIGNATURES: readonly string[] = [
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EDBHANDLEREXITED",
  "CONNECTION TERMINATED",
  "CONNECTION TERMINATED UNEXPECTEDLY",
  "TIMEOUT EXCEEDED WHEN TRYING TO CONNECT",
  "CONNECTION ERROR",
  "SERVER CLOSED THE CONNECTION",
  "TERMINATING CONNECTION DUE TO ADMINISTRATOR COMMAND",
  "TOO MANY CLIENTS ALREADY",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P03",
  "53300",
];

function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; cause?: unknown };
    const parts = [e.code, e.message]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    const causeText = e.cause && e.cause !== err ? ` ${errorText(e.cause)}` : "";
    return `${parts}${causeText}`;
  }
  return String(err);
}

export function classifyDbError(err: unknown): DbErrorClass {
  const haystack = errorText(err).toUpperCase();
  if (!haystack) return "permanent";
  for (const sig of TRANSIENT_ERROR_SIGNATURES) {
    if (haystack.includes(sig)) return "transient";
  }
  return "permanent";
}

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

export interface RetryMetrics {
  calls: number;
  attempts: number;
  retries: number;
  transientErrors: number;
  permanentErrors: number;
  succeededAfterRetry: number;
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
  metrics?: RetryMetrics;
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: unknown;
    classification: DbErrorClass;
  }) => void;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig = DEFAULT_RETRY_CONFIG,
  hooks: RetryHooks = {},
): Promise<T> {
  const { metrics, onRetry } = hooks;
  const sleep = hooks.sleep ?? realSleep;
  const rand = hooks.rand ?? Math.random;
  const maxAttempts = Math.max(1, cfg.maxAttempts);

  if (metrics) metrics.calls++;

  let attempt = 0;
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

      if (classification === "permanent" || attempt >= maxAttempts) {
        if (metrics && classification === "transient" && attempt >= maxAttempts) {
          metrics.exhausted++;
        }
        throw err;
      }

      const delayMs = retryDelayMs(cfg, attempt - 1, rand);
      if (metrics) metrics.retries++;
      onRetry?.({ attempt, delayMs, error: err, classification });
      await sleep(delayMs);
    }
  }
}
