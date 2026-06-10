/**
 * Circuit breaker for the API health check alerting path.
 *
 * WHY THIS EXISTS (VAL-96 / VAL-88 incident):
 * The runner re-runs the health check every 60s. Before this module, EVERY
 * failing cycle wrote to the OS board (it created one de-duped alert issue but
 * then commented on it every 60s). Each board write on that `critical` issue
 * wakes the assignee → one automation run. A sustained endpoint outage thus
 * produced a wake/run every 60 seconds, which saturated the runner queue.
 *
 * This breaker gates the cascade driver — the board writes — rather than the
 * cheap read-only probe. It is NOT a classic half-open breaker: we keep probing
 * the endpoint every cycle (a single GET with a hard timeout is cheap and is
 * what tells us when we've recovered). What the breaker controls is how often a
 * failure is allowed to *notify* (open the alert issue / comment on it):
 *
 *   - CLOSED: healthy, or fewer than `failureThreshold` consecutive failing
 *     cycles. Below threshold we hold the alert (this is the cycle-level analog
 *     of "retry before declaring failure" — a single transient cycle is not
 *     escalated to the board).
 *   - OPEN: threshold reached. We notify ONCE on the transition (open the alert
 *     issue), then throttle further notifications with exponential backoff
 *     (base → 2×base → 4×base … capped at `notifyMaxMs`). A 1-hour outage thus
 *     produces a handful of board writes instead of ~60.
 *
 * On recovery we notify once (to auto-resolve the alert) and reset to CLOSED.
 *
 * State is keyed per-endpoint and persisted to disk so it survives the
 * per-cycle subprocess spawned by the runner AND isolates endpoints from each
 * other — one failing endpoint never throttles or opens another's breaker.
 *
 * The decision logic (`onFailure` / `onSuccess`) is pure and clock-injected so
 * it can be unit-tested deterministically; persistence is a thin wrapper.
 */

import fs from "fs";
import path from "path";

export type CircuitState = "closed" | "open";

export interface BreakerConfig {
  /** Consecutive failing cycles required before the breaker opens / notifies. */
  failureThreshold: number;
  /** Base delay between notifications while open (ms). */
  notifyBaseMs: number;
  /** Cap on the exponential notification backoff (ms). */
  notifyMaxMs: number;
}

export interface BreakerState {
  endpoint: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** When the circuit last opened (ms epoch), or null while closed. */
  openedAt: number | null;
  /** When we last emitted a failure notification (ms epoch), or null. */
  lastNotifyAt: number | null;
  /** Number of failure notifications emitted in the current open episode. */
  notifyCount: number;
  updatedAt: number;
}

export interface FailureDecision {
  state: CircuitState;
  /** True when the caller should write the failure to the alert sink. */
  shouldNotify: boolean;
  /** True when this failure was intentionally NOT escalated. */
  suppressed: boolean;
  reason: string;
  /** When suppressed while open, how long until the next notification is due. */
  nextNotifyInMs?: number;
}

export interface RecoveryDecision {
  state: CircuitState;
  /** True when the caller should record a recovery / resolve the alert. */
  shouldNotifyRecovery: boolean;
  reason: string;
}

export const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 2,
  notifyBaseMs: 5 * 60_000,
  notifyMaxMs: 30 * 60_000,
};

export function initialState(endpoint: string, now: number): BreakerState {
  return {
    endpoint,
    state: "closed",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    lastNotifyAt: null,
    notifyCount: 0,
    updatedAt: now,
  };
}

/**
 * Backoff before the Nth+1 notification, given how many we've already sent in
 * this open episode. notifyCount=1 → wait base; =2 → 2×base; capped at max.
 */
export function notifyBackoffMs(cfg: BreakerConfig, notifyCount: number): number {
  const exp = Math.max(0, notifyCount - 1);
  return Math.min(cfg.notifyBaseMs * Math.pow(2, exp), cfg.notifyMaxMs);
}

/** Pure reducer: advance state on a failing cycle and decide whether to notify. */
export function onFailure(
  prev: BreakerState,
  cfg: BreakerConfig,
  now: number
): { state: BreakerState; decision: FailureDecision } {
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const base = { ...prev, consecutiveFailures, consecutiveSuccesses: 0, updatedAt: now };

  // Below threshold: hold the alert. One transient failing cycle should not
  // escalate to the board (cycle-level "retry before declaring failure").
  if (consecutiveFailures < cfg.failureThreshold) {
    return {
      state: { ...base, state: "closed" },
      decision: {
        state: "closed",
        shouldNotify: false,
        suppressed: true,
        reason: `failure ${consecutiveFailures}/${cfg.failureThreshold} — below threshold, holding alert`,
      },
    };
  }

  // Transition into OPEN: notify once (opens the alert issue / pages on-call).
  if (prev.state !== "open") {
    return {
      state: {
        ...base,
        state: "open",
        openedAt: prev.openedAt ?? now,
        lastNotifyAt: now,
        notifyCount: 1,
      },
      decision: {
        state: "open",
        shouldNotify: true,
        suppressed: false,
        reason: `circuit opened after ${consecutiveFailures} consecutive failures`,
      },
    };
  }

  // Already OPEN: throttle by exponential backoff.
  const backoff = notifyBackoffMs(cfg, prev.notifyCount);
  const elapsed = now - (prev.lastNotifyAt ?? 0);
  if (elapsed >= backoff) {
    return {
      state: { ...base, state: "open", lastNotifyAt: now, notifyCount: prev.notifyCount + 1 },
      decision: {
        state: "open",
        shouldNotify: true,
        suppressed: false,
        reason: `re-notify after ${Math.round(elapsed / 1000)}s (backoff ${Math.round(backoff / 1000)}s)`,
      },
    };
  }
  return {
    state: { ...base, state: "open" },
    decision: {
      state: "open",
      shouldNotify: false,
      suppressed: true,
      reason: `suppressed by circuit breaker; next notify in ${Math.round((backoff - elapsed) / 1000)}s`,
      nextNotifyInMs: backoff - elapsed,
    },
  };
}

/** Pure reducer: advance state on a healthy cycle and decide whether to resolve. */
export function onSuccess(
  prev: BreakerState,
  _cfg: BreakerConfig,
  now: number
): { state: BreakerState; decision: RecoveryDecision } {
  const wasOpen = prev.state === "open";
  return {
    state: {
      ...prev,
      state: "closed",
      consecutiveFailures: 0,
      consecutiveSuccesses: prev.consecutiveSuccesses + 1,
      openedAt: null,
      lastNotifyAt: null,
      notifyCount: 0,
      updatedAt: now,
    },
    decision: {
      state: "closed",
      shouldNotifyRecovery: wasOpen,
      reason: wasOpen ? "recovered — circuit closed, resolving alert" : "healthy",
    },
  };
}

// ── Persistence (per-endpoint state file) ────────────────────────────────────

function slugify(endpoint: string): string {
  return (
    endpoint
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .toLowerCase() || "unknown"
  );
}

export function stateFilePath(dir: string, endpoint: string): string {
  return path.join(dir, `cb-${slugify(endpoint)}.json`);
}

/** Load persisted state for an endpoint, or a fresh closed state if absent/corrupt. */
export function loadState(dir: string, endpoint: string, now: number): BreakerState {
  try {
    const raw = fs.readFileSync(stateFilePath(dir, endpoint), "utf8");
    const parsed = JSON.parse(raw) as Partial<BreakerState>;
    // Merge over a fresh default so missing/renamed fields can't crash the run.
    return { ...initialState(endpoint, now), ...parsed, endpoint };
  } catch {
    return initialState(endpoint, now);
  }
}

/** Persist state atomically (write to a temp file, then rename). */
export function saveState(dir: string, state: BreakerState): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = stateFilePath(dir, state.endpoint);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}
