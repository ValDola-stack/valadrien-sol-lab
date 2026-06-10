#!/usr/bin/env tsx
/**
 * Health Check Runner — executes health check every 60s in a loop
 * Designed to run as a background process
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_CHECK_SCRIPT = path.join(__dirname, "health-check.ts");
const INTERVAL_MS = 60000; // 60 seconds
const STAGGER_MS = 500; // stagger runs by 500ms to avoid exact alignment

async function runHealthCheck(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", HEALTH_CHECK_SCRIPT], {
      stdio: "inherit",
      env: { ...process.env },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Health check timed out after 30s"));
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Health check exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Health Check Runner started`);

  let iteration = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    iteration++;
    const nextRunTime = new Date(Date.now() + INTERVAL_MS);

    try {
      await runHealthCheck();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] Health check iteration ${iteration} failed:`,
        err
      );
    }

    console.log(
      `[${new Date().toISOString()}] Next health check in ${INTERVAL_MS}ms (${nextRunTime.toISOString()})`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, INTERVAL_MS - STAGGER_MS)
    );
  }
}

main().catch((err) => {
  console.error("Runner fatal error:", err);
  process.exit(1);
});
