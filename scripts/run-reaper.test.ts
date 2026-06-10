/**
 * Tests for the heartbeat runner reaper (VAL-97).
 *
 * The headline behaviour is the acceptance criterion: a run that overstays the
 * queued (>2min) or running (>8min) limit is auto-cancelled, the cancel handler
 * fires exactly once, an incident is recorded, and the run is dropped from
 * tracking. Logic is clock-injected so these are deterministic.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  emptyRegistry,
  enqueue,
  markRunning,
  markProgress,
  remove,
  evaluate,
  evaluateRun,
  loadRegistry,
  saveRegistry,
  RunReaper,
  type ReaperConfig,
  type ReapDecision,
} from "./run-reaper.js";

const MIN = 60_000;
const CFG: ReaperConfig = DEFAULT_CONFIG;

test("default thresholds are the VAL-97 spec: queued 2min, running 8min", () => {
  assert.equal(CFG.queuedTimeoutMs, 2 * MIN);
  assert.equal(CFG.runningTimeoutMs, 8 * MIN);
});

test("a run queued under 2min is left alone; over 2min is reaped (queued-timeout)", () => {
  let reg = enqueue(emptyRegistry(), "r1", 0, "issue-1");

  // 119s queued — under the limit.
  assert.equal(evaluate(reg, CFG, 119_000).length, 0);

  // 121s queued — over the limit.
  const d = evaluate(reg, CFG, 121_000);
  assert.equal(d.length, 1);
  assert.equal(d[0].reason, "queued-timeout");
  assert.equal(d[0].run.id, "r1");
});

test("starting a run clears the queued timeout (progress was made)", () => {
  let reg = enqueue(emptyRegistry(), "r1", 0);
  reg = markRunning(reg, "r1", 30_000); // started at 30s, before the 2min queued cap

  // At t=121s it is running for 91s — well under the 8min running cap, not reaped.
  assert.equal(evaluate(reg, CFG, 121_000).length, 0);
});

test("a run running over 8min is reaped (running-timeout)", () => {
  let reg = enqueue(emptyRegistry(), "r1", 0);
  reg = markRunning(reg, "r1", 1_000); // started at 1s

  // 7min after start — fine.
  assert.equal(evaluate(reg, CFG, 1_000 + 7 * MIN).length, 0);

  // 8min1s after start — reaped.
  const d = evaluate(reg, CFG, 1_000 + 8 * MIN + 1_000);
  assert.equal(d.length, 1);
  assert.equal(d[0].reason, "running-timeout");
});

test("progress does NOT extend the hard running cap (a busy-looping run is still bounded)", () => {
  let reg = enqueue(emptyRegistry(), "r1", 0);
  reg = markRunning(reg, "r1", 0);
  // Report progress right up to the cap…
  reg = markProgress(reg, "r1", 7 * MIN);
  // …it is still reaped once wall-clock since START exceeds 8min.
  const d = evaluateRun(reg.runs["r1"], CFG, 8 * MIN + 1);
  assert.equal(d?.reason, "running-timeout");
});

test("a completed run is removed and never reaped", () => {
  let reg = enqueue(emptyRegistry(), "r1", 0);
  reg = markRunning(reg, "r1", 0);
  reg = remove(reg, "r1"); // executor reported completion
  assert.equal(Object.keys(reg.runs).length, 0);
  assert.equal(evaluate(reg, CFG, 100 * MIN).length, 0);
});

test("evaluate isolates runs: one stuck run does not affect a healthy sibling", () => {
  let reg = enqueue(emptyRegistry(), "stuck", 0);
  reg = enqueue(reg, "healthy", 0);
  reg = markRunning(reg, "healthy", 10_000);

  const d = evaluate(reg, CFG, 5 * MIN);
  assert.equal(d.length, 1);
  assert.equal(d[0].run.id, "stuck");
  assert.equal(d[0].reason, "queued-timeout");
});

test("supervisor sweep cancels, notifies once each, and drains the run", async () => {
  let clock = 0;
  const cancelled: string[] = [];
  const notified: ReapDecision[] = [];
  const reaper = new RunReaper({
    config: CFG,
    clock: () => clock,
    cancel: (d) => {
      cancelled.push(d.run.id);
    },
    notify: (d) => {
      notified.push(d);
    },
  });

  reaper.enqueue("stuck-queued", "issue-q");
  reaper.enqueue("will-run", "issue-r");
  reaper.markRunning("will-run");

  clock = 3 * MIN; // queued run is over 2min; running run only 3min in (under 8min)
  const acted = await reaper.sweep();

  assert.deepEqual(cancelled, ["stuck-queued"]);
  assert.equal(notified.length, 1);
  assert.equal(acted.length, 1);
  assert.equal(acted[0].reason, "queued-timeout");
  // Reaped run is gone; the healthy running run is still tracked.
  assert.deepEqual(Object.keys(reaper.snapshot().runs), ["will-run"]);

  // A second sweep at the same time is a no-op (already drained).
  assert.equal((await reaper.sweep()).length, 0);
  assert.equal(cancelled.length, 1);
});

test("a cancel that throws keeps the run tracked for the next sweep (no incident yet)", async () => {
  let clock = 0;
  let attempts = 0;
  const notified: ReapDecision[] = [];
  const reaper = new RunReaper({
    config: CFG,
    clock: () => clock,
    logger: { log() {}, error() {} },
    cancel: () => {
      attempts++;
      if (attempts === 1) throw new Error("cancel API flaked");
    },
    notify: (d) => {
      notified.push(d);
    },
  });

  reaper.enqueue("flaky", "issue-x");
  clock = 3 * MIN;

  // First sweep: cancel throws → run stays tracked, no incident recorded.
  assert.equal((await reaper.sweep()).length, 0);
  assert.equal(notified.length, 0);
  assert.deepEqual(Object.keys(reaper.snapshot().runs), ["flaky"]);

  // Second sweep: cancel succeeds → reaped + one incident.
  const acted = await reaper.sweep();
  assert.equal(acted.length, 1);
  assert.equal(notified.length, 1);
  assert.equal(Object.keys(reaper.snapshot().runs).length, 0);
});

test("a notify that throws never blocks the reaping (run is still cancelled)", async () => {
  let clock = 0;
  const cancelled: string[] = [];
  const reaper = new RunReaper({
    config: CFG,
    clock: () => clock,
    logger: { log() {}, error() {} },
    cancel: (d) => {
      cancelled.push(d.run.id);
    },
    notify: () => {
      throw new Error("OS sink unreachable");
    },
  });

  reaper.enqueue("stuck", "issue-y");
  clock = 3 * MIN;

  const acted = await reaper.sweep();
  assert.equal(acted.length, 1);
  assert.deepEqual(cancelled, ["stuck"]);
  assert.equal(Object.keys(reaper.snapshot().runs).length, 0);
});

test("registry persists across reaper restarts (atomic round-trip)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-test-"));
  const file = path.join(dir, "registry.json");
  try {
    let clock = 1_000;
    const first = new RunReaper({
      config: CFG,
      registryFile: file,
      clock: () => clock,
      cancel: () => {},
    });
    first.enqueue("survivor", "issue-z");
    first.markRunning("survivor");

    // New supervisor (process restart) loads the persisted run.
    const second = new RunReaper({
      config: CFG,
      registryFile: file,
      clock: () => clock,
      cancel: () => {},
    });
    assert.deepEqual(Object.keys(second.snapshot().runs), ["survivor"]);
    assert.equal(second.snapshot().runs["survivor"].state, "running");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt/missing registry file degrades to an empty registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-test-"));
  try {
    const file = path.join(dir, "registry.json");
    fs.writeFileSync(file, "{ not valid json");
    assert.deepEqual(loadRegistry(file), emptyRegistry());

    // And a save followed by load round-trips cleanly.
    let reg = enqueue(emptyRegistry(), "a", 5);
    saveRegistry(file, reg);
    assert.deepEqual(loadRegistry(file).runs["a"].id, "a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
