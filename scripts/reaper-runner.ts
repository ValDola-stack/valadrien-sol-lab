#!/usr/bin/env tsx
/**
 * Heartbeat runner reaper service (VAL-97).
 *
 * Long-running watchdog that sweeps the run registry every `sweepIntervalMs`
 * and auto-cancels runs that overstay the queued (>2min) or running (>8min)
 * limits, recording an incident on the OS board for each cancellation. Designed
 * to run as a background service (see deploy/reaper-runner.service), exactly
 * like the health-check runner.
 *
 * Integration contract:
 *   The executor that owns the runs reports lifecycle into the SAME registry
 *   file this service sweeps (REAPER_REGISTRY_FILE). It calls enqueue on submit,
 *   markRunning on start, markProgress on heartbeat, and complete on finish
 *   (see run-reaper.ts). This service is the enforcement half; it does not
 *   submit work itself.
 *
 * Cancellation:
 *   Dropping a run from the registry is the cancellation of record (it stops
 *   being tracked / counted against the queue). To ALSO take a hard action on
 *   the host — kill a PID, hit a cancel API — set REAPER_CANCEL_COMMAND; it is
 *   run as `sh -c "<cmd>"` with REAP_RUN_ID / REAP_REASON in the environment.
 *
 * Config (environment; OS_* vars are shared with the alert sink):
 *   REAPER_REGISTRY_FILE     registry path (default: <tmp>/valadrien-run-reaper/registry.json)
 *   REAPER_QUEUED_TIMEOUT_MS queued auto-cancel threshold (default 120000)
 *   REAPER_RUNNING_TIMEOUT_MS running auto-cancel threshold (default 480000)
 *   REAPER_SWEEP_INTERVAL_MS  sweep cadence (default 30000)
 *   REAPER_CANCEL_COMMAND     optional shell command to hard-cancel a run
 *   VALADRIEN_OS_API_URL/_API_KEY/_COMPANY_ID  for the OS incident sink
 */

import "dotenv/config.js";
import os from "os";
import path from "path";
import { exec } from "child_process";
import {
  RunReaper,
  type ReaperConfig,
  type ReapDecision,
  describeDecision,
} from "./run-reaper.js";
import { recordIncident } from "./os-alert-sink.js";

const REGISTRY_FILE =
  process.env.REAPER_REGISTRY_FILE ??
  path.join(os.tmpdir(), "valadrien-run-reaper", "registry.json");

const CONFIG: ReaperConfig = {
  queuedTimeoutMs: Number(process.env.REAPER_QUEUED_TIMEOUT_MS ?? 2 * 60_000),
  runningTimeoutMs: Number(process.env.REAPER_RUNNING_TIMEOUT_MS ?? 8 * 60_000),
  sweepIntervalMs: Number(process.env.REAPER_SWEEP_INTERVAL_MS ?? 30_000),
};

const CANCEL_COMMAND = process.env.REAPER_CANCEL_COMMAND;

/** Optional hard-cancel hook: run a host command with the reaped run's context. */
function hardCancel(decision: ReapDecision): Promise<void> {
  if (!CANCEL_COMMAND) return Promise.resolve();
  return new Promise((resolve, reject) => {
    exec(
      CANCEL_COMMAND,
      {
        env: {
          ...process.env,
          REAP_RUN_ID: decision.run.id,
          REAP_REASON: decision.reason,
        },
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/** Record one incident per auto-cancel via the OS alert sink (de-duped). */
async function notify(decision: ReapDecision): Promise<void> {
  const at = new Date().toISOString();
  const res = await recordIncident(
    {
      key: "runner-reaper",
      title: "🛑 Heartbeat runner reaper: stuck run auto-cancelled",
      summary: `Auto-cancelled ${describeDecision(decision)}.`,
      details: {
        "Run ID": decision.run.id,
        Label: decision.run.label,
        Reason: decision.reason,
        "Overstayed by": `${Math.round(decision.ageMs / 1000)}s`,
        Limit: `${Math.round(decision.thresholdMs / 1000)}s`,
      },
      priority: "high",
    },
    at
  );
  if (res) {
    console.log(
      `[${at}] 📢 Incident ${res.created ? "issue created" : "de-duped onto"} ${res.identifier ?? res.id}`
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `[${new Date().toISOString()}] Run reaper started — registry=${REGISTRY_FILE} ` +
      `queued>${CONFIG.queuedTimeoutMs}ms running>${CONFIG.runningTimeoutMs}ms ` +
      `sweep=${CONFIG.sweepIntervalMs}ms` +
      (CANCEL_COMMAND ? " (hard-cancel command set)" : " (incident-only)")
  );

  const reaper = new RunReaper({
    config: CONFIG,
    registryFile: REGISTRY_FILE,
    cancel: hardCancel,
    notify,
  });

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${new Date().toISOString()}] ${sig} — stopping reaper`);
    reaper.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Sweep immediately on boot (catch runs already over limit), then on a timer.
  await reaper.sweep().catch((err) => console.error("Initial sweep error:", err));
  reaper.start();

  // Keep the process alive; the unref'd interval won't hold the loop on its own.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Reaper fatal error:", err);
  process.exit(1);
});
