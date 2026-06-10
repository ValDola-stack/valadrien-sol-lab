#!/usr/bin/env tsx
/**
 * Simulated-stuck-run demonstration for the reaper (VAL-97 acceptance criterion
 * "tested with a simulated stuck run").
 *
 * Spawns three real child processes against a RunReaper with deliberately tiny
 * thresholds (queued 1s / running 2s, swept every 250ms):
 *   - `fast`   finishes in ~300ms        → completes normally, never reaped.
 *   - `hang`   sleeps effectively forever → exceeds the running limit, and the
 *              reaper's cancel handler ACTUALLY kills its PID.
 *   - `zombie` is enqueued but never started → exceeds the queued limit.
 *
 * It asserts the hung process is reaped (and dead), the zombie is reaped, and
 * the healthy run is untouched, then exits 0. This is a live, observable proof
 * that auto-cancel fires — complementary to the deterministic unit tests in
 * run-reaper.test.ts. Run: npm run reaper:sim
 */

import { spawn, type ChildProcess } from "child_process";
import { RunReaper, type ReaperConfig, type ReapDecision } from "./run-reaper.js";

const CONFIG: ReaperConfig = {
  queuedTimeoutMs: 1_000,
  runningTimeoutMs: 2_000,
  sweepIntervalMs: 250,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const procs = new Map<string, ChildProcess>();
  const reaped: ReapDecision[] = [];

  // cancel handler: actually kill the run's process if we have one.
  const reaper = new RunReaper({
    config: CONFIG,
    cancel: (d) => {
      const proc = procs.get(d.run.id);
      if (proc?.pid && isAlive(proc.pid)) {
        process.kill(proc.pid, "SIGKILL");
      }
    },
    notify: (d) => {
      reaped.push(d);
      console.log(`  ↳ incident: ${d.reason} for ${d.run.id} (${Math.round(d.ageMs / 1000)}s)`);
    },
  });

  console.log("Spawning simulated runs (queued>1s / running>2s)…");

  // healthy fast run — starts, finishes well under the running limit.
  const fast = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),300)"]);
  procs.set("fast", fast);
  reaper.enqueue("fast", "healthy-fast-run");
  reaper.markRunning("fast");
  let fastExited = false;
  fast.on("exit", () => {
    fastExited = true;
    reaper.complete("fast"); // executor reports normal completion
  });

  // hung run — starts, then sleeps far beyond the running limit.
  const hang = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
  procs.set("hang", hang);
  reaper.enqueue("hang", "stuck-running-run");
  reaper.markRunning("hang");

  // zombie run — enqueued but the executor never starts it.
  reaper.enqueue("zombie", "stuck-queued-run");

  reaper.start();

  // Run long enough for both limits to trip and the sweeps to act.
  await sleep(3_500);
  reaper.stop();

  // ── Assertions ──────────────────────────────────────────────────────────────
  const reasons = new Map(reaped.map((d) => [d.run.id, d.reason]));
  const failures: string[] = [];

  if (!fastExited) failures.push("fast run did not exit on its own");
  if (reasons.has("fast")) failures.push("healthy fast run was wrongly reaped");
  if (reasons.get("hang") !== "running-timeout")
    failures.push(`hung run not reaped with running-timeout (got ${reasons.get("hang") ?? "none"})`);
  if (hang.pid && isAlive(hang.pid)) failures.push("hung process is still alive after reaping");
  if (reasons.get("zombie") !== "queued-timeout")
    failures.push(`zombie run not reaped with queued-timeout (got ${reasons.get("zombie") ?? "none"})`);
  if (reaper.snapshot().runs && Object.keys(reaper.snapshot().runs).length !== 0)
    failures.push("registry not empty after reaping");

  // Clean up any survivors so the sim never leaks a process.
  for (const p of procs.values()) if (p.pid && isAlive(p.pid)) p.kill("SIGKILL");

  if (failures.length) {
    console.error("\n❌ Reaper simulation FAILED:");
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }

  console.log("\n✅ Reaper simulation passed:");
  console.log("   - healthy fast run completed normally (not reaped)");
  console.log("   - stuck running run auto-cancelled (running-timeout) and process killed");
  console.log("   - stuck queued run auto-cancelled (queued-timeout)");
  console.log("   - registry drained after reaping");
}

main().catch((err) => {
  console.error("Simulation error:", err);
  process.exit(1);
});
