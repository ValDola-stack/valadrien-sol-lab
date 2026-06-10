/**
 * Heartbeat runner timeout / reaper (VAL-97).
 *
 * WHY THIS EXISTS (VAL-88 incident):
 * On 2026-06-10 the heartbeat runner queue saturated (04:07–04:32): runs piled
 * up queued, and at least one run hung long enough to block the queue behind it.
 * The backlog eventually self-healed, but nothing *bounded* a stuck run. This
 * module is that bound: a watchdog that auto-cancels runs which overstay one of
 * two limits, and records an incident on the OS board for every cancellation so
 * a recurrence is visible instead of silent.
 *
 *   - A run that sits QUEUED longer than `queuedTimeoutMs` (default 2min) without
 *     starting is auto-cancelled (`queued-timeout`). A run that never starts is,
 *     by definition, queued "without progress".
 *   - A run that has been RUNNING longer than `runningTimeoutMs` (default 8min)
 *     is auto-cancelled (`running-timeout`) — a hard cap on a single run so one
 *     hung run cannot block the queue indefinitely.
 *
 * The decision logic (`evaluateRun` / `evaluate`) is pure and clock-injected so
 * it is deterministically unit-testable, mirroring `circuit-breaker.ts`. The
 * registry (`loadRegistry` / `saveRegistry`) is a thin atomic-write wrapper so
 * run lifecycle survives the reaper process restarting. The `RunReaper`
 * supervisor wires the two together with caller-supplied side effects: a
 * `cancel` handler that actually stops the run, and an optional `notify` handler
 * that records the incident (kept out of the pure core so it stays OS-agnostic
 * and testable in isolation).
 */

import fs from "fs";
import path from "path";

export type RunState = "queued" | "running";
export type ReapReason = "queued-timeout" | "running-timeout";

export interface TrackedRun {
  /** Stable run identifier (whatever the executor uses). */
  id: string;
  /** Optional human label (issue id, routine name, …) for incident readability. */
  label?: string;
  state: RunState;
  /** When the run entered the queue (ms epoch). */
  queuedAt: number;
  /** When the run started executing (ms epoch), or null while still queued. */
  startedAt: number | null;
  /** Last time the run reported progress (ms epoch); defaults to its start. */
  lastProgressAt: number | null;
  updatedAt: number;
}

export interface ReaperConfig {
  /** Max time a run may sit queued before auto-cancel (ms). */
  queuedTimeoutMs: number;
  /** Max wall-clock time a run may execute before auto-cancel (ms). */
  runningTimeoutMs: number;
  /** How often the supervisor sweeps the registry (ms). */
  sweepIntervalMs: number;
}

export interface ReapDecision {
  run: TrackedRun;
  reason: ReapReason;
  /** How long the run had overstayed its phase when reaped (ms). */
  ageMs: number;
  /** The threshold the run exceeded (ms). */
  thresholdMs: number;
}

export const DEFAULT_CONFIG: ReaperConfig = {
  queuedTimeoutMs: 2 * 60_000,
  runningTimeoutMs: 8 * 60_000,
  sweepIntervalMs: 30_000,
};

export interface RunRegistry {
  runs: Record<string, TrackedRun>;
}

export function emptyRegistry(): RunRegistry {
  return { runs: {} };
}

// ── Pure lifecycle transitions ───────────────────────────────────────────────
// Each returns a NEW registry; the input is never mutated. The supervisor wraps
// these with persistence.

export function enqueue(
  reg: RunRegistry,
  id: string,
  now: number,
  label?: string
): RunRegistry {
  const run: TrackedRun = {
    id,
    label,
    state: "queued",
    queuedAt: now,
    startedAt: null,
    lastProgressAt: null,
    updatedAt: now,
  };
  return { runs: { ...reg.runs, [id]: run } };
}

export function markRunning(reg: RunRegistry, id: string, now: number): RunRegistry {
  const prev = reg.runs[id];
  if (!prev) return reg;
  const run: TrackedRun = {
    ...prev,
    state: "running",
    startedAt: prev.startedAt ?? now,
    lastProgressAt: now,
    updatedAt: now,
  };
  return { runs: { ...reg.runs, [id]: run } };
}

export function markProgress(reg: RunRegistry, id: string, now: number): RunRegistry {
  const prev = reg.runs[id];
  if (!prev) return reg;
  return {
    runs: { ...reg.runs, [id]: { ...prev, lastProgressAt: now, updatedAt: now } },
  };
}

/** Remove a run from tracking (completed, or already cancelled/reaped). */
export function remove(reg: RunRegistry, id: string): RunRegistry {
  if (!reg.runs[id]) return reg;
  const { [id]: _gone, ...rest } = reg.runs;
  return { runs: rest };
}

// ── Pure decision logic ──────────────────────────────────────────────────────

/** Decide whether a single run should be reaped right now. Null = leave it be. */
export function evaluateRun(
  run: TrackedRun,
  cfg: ReaperConfig,
  now: number
): ReapDecision | null {
  if (run.state === "queued") {
    const ageMs = now - run.queuedAt;
    if (ageMs > cfg.queuedTimeoutMs) {
      return { run, reason: "queued-timeout", ageMs, thresholdMs: cfg.queuedTimeoutMs };
    }
    return null;
  }

  // running: hard wall-clock cap from when it started.
  const startedAt = run.startedAt ?? run.queuedAt;
  const ageMs = now - startedAt;
  if (ageMs > cfg.runningTimeoutMs) {
    return { run, reason: "running-timeout", ageMs, thresholdMs: cfg.runningTimeoutMs };
  }
  return null;
}

/** Evaluate every tracked run; return the set that should be auto-cancelled. */
export function evaluate(
  reg: RunRegistry,
  cfg: ReaperConfig,
  now: number
): ReapDecision[] {
  const decisions: ReapDecision[] = [];
  for (const run of Object.values(reg.runs)) {
    const d = evaluateRun(run, cfg, now);
    if (d) decisions.push(d);
  }
  return decisions;
}

export function describeDecision(d: ReapDecision): string {
  const label = d.run.label ? ` (${d.run.label})` : "";
  const phase = d.reason === "queued-timeout" ? "queued" : "running";
  return (
    `run ${d.run.id}${label} ${phase} for ${Math.round(d.ageMs / 1000)}s ` +
    `(> ${Math.round(d.thresholdMs / 1000)}s limit) — ${d.reason}`
  );
}

// ── Persistence (single registry file, atomic write) ─────────────────────────

export function loadRegistry(file: string): RunRegistry {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<RunRegistry>;
    // Merge over a fresh default so a missing/renamed field can't crash a sweep.
    return { runs: parsed.runs ?? {} };
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(file: string, reg: RunRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, file);
}

// ── Supervisor ───────────────────────────────────────────────────────────────

export type CancelHandler = (
  decision: ReapDecision
) => void | Promise<void>;
export type NotifyHandler = (
  decision: ReapDecision
) => void | Promise<void>;

export interface RunReaperOptions {
  config?: ReaperConfig;
  /** Where run lifecycle is persisted; in-memory only if omitted. */
  registryFile?: string;
  /** Stops the run for real (kill process, call cancel API, …). Required. */
  cancel: CancelHandler;
  /** Records the incident (OS alert sink, log, …). Optional, best-effort. */
  notify?: NotifyHandler;
  /** Injectable clock for tests; defaults to Date.now. */
  clock?: () => number;
  logger?: Pick<Console, "log" | "error">;
}

/**
 * Owns a run registry and periodically sweeps it, auto-cancelling overstayed
 * runs. The executor reports lifecycle via enqueue/markRunning/markProgress/
 * complete; the reaper enforces the timeouts. `cancel` must actually stop the
 * run; `notify` (if given) records the incident and is never allowed to throw
 * the sweep.
 */
export class RunReaper {
  private readonly cfg: ReaperConfig;
  private readonly file?: string;
  private readonly cancel: CancelHandler;
  private readonly notify?: NotifyHandler;
  private readonly clock: () => number;
  private readonly log: Pick<Console, "log" | "error">;
  private reg: RunRegistry;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RunReaperOptions) {
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.file = opts.registryFile;
    this.cancel = opts.cancel;
    this.notify = opts.notify;
    this.clock = opts.clock ?? Date.now;
    this.log = opts.logger ?? console;
    this.reg = this.file ? loadRegistry(this.file) : emptyRegistry();
  }

  private persist(): void {
    if (this.file) saveRegistry(this.file, this.reg);
  }

  enqueue(id: string, label?: string): void {
    this.reg = enqueue(this.reg, id, this.clock(), label);
    this.persist();
  }

  markRunning(id: string): void {
    this.reg = markRunning(this.reg, id, this.clock());
    this.persist();
  }

  markProgress(id: string): void {
    this.reg = markProgress(this.reg, id, this.clock());
    this.persist();
  }

  /** Run finished normally; stop tracking it. */
  complete(id: string): void {
    this.reg = remove(this.reg, id);
    this.persist();
  }

  snapshot(): RunRegistry {
    return { runs: { ...this.reg.runs } };
  }

  /**
   * One reaper pass: cancel every overstayed run, record an incident for each,
   * and drop it from tracking. Returns the decisions acted on. A `cancel` that
   * throws keeps the run tracked (so the next sweep retries) but still records
   * the attempt; a `notify` that throws is swallowed (never blocks reaping).
   */
  async sweep(): Promise<ReapDecision[]> {
    const now = this.clock();
    const decisions = evaluate(this.reg, this.cfg, now);
    const acted: ReapDecision[] = [];

    for (const d of decisions) {
      try {
        await this.cancel(d);
      } catch (err) {
        this.log.error(
          `[run-reaper] cancel failed for ${d.run.id}; leaving tracked for retry:`,
          err
        );
        continue;
      }

      this.reg = remove(this.reg, d.run.id);
      this.persist();
      acted.push(d);
      this.log.log(`[run-reaper] 🛑 auto-cancelled ${describeDecision(d)}`);

      if (this.notify) {
        try {
          await this.notify(d);
        } catch (err) {
          this.log.error(`[run-reaper] incident notify failed for ${d.run.id}:`, err);
        }
      }
    }

    return acted;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.log.error("[run-reaper] sweep error:", err)
      );
    }, this.cfg.sweepIntervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
