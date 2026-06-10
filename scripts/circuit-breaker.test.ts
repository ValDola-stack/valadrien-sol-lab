/**
 * Tests for the health-check circuit breaker (VAL-96).
 *
 * The headline test (`sustained outage does not saturate`) is the acceptance
 * criterion: one endpoint failing continuously for an hour must NOT produce a
 * board write (and therefore an automation run) every cycle.
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
  initialState,
  onFailure,
  onSuccess,
  loadState,
  saveState,
  stateFilePath,
  type BreakerConfig,
  type BreakerState,
} from "./circuit-breaker.js";

const ENDPOINT = "http://127.0.0.1:9";
const MIN = 60_000;

test("sustained outage does not saturate: ~60 failing cycles → only a handful of notifications", () => {
  let state: BreakerState = initialState(ENDPOINT, 0);
  let notifications = 0;

  // Simulate one full hour of failures, one cycle every 60s (60 cycles).
  for (let cycle = 0; cycle < 60; cycle++) {
    const now = cycle * MIN;
    const res = onFailure(state, DEFAULT_CONFIG, now);
    state = res.state;
    if (res.decision.shouldNotify) notifications++;
  }

  // Without the breaker this would be ~60 board writes (one per cycle). With
  // threshold=2 + exponential backoff (5,10,20,30,30… min) it must be tiny.
  assert.ok(
    notifications <= 8,
    `expected a handful of notifications over an hour, got ${notifications}`
  );
  assert.ok(notifications >= 1, "outage must still page at least once");
  assert.equal(state.state, "open");
});

test("below threshold a single transient failing cycle is held (not escalated)", () => {
  const s0 = initialState(ENDPOINT, 0);
  const { state, decision } = onFailure(s0, DEFAULT_CONFIG, 0);
  assert.equal(decision.shouldNotify, false);
  assert.equal(state.state, "closed");
  assert.equal(state.consecutiveFailures, 1);
});

test("circuit opens and notifies exactly once on the threshold-crossing cycle", () => {
  let state = initialState(ENDPOINT, 0);
  state = onFailure(state, DEFAULT_CONFIG, 0).state; // 1/2 — held
  const second = onFailure(state, DEFAULT_CONFIG, MIN); // 2/2 — opens
  assert.equal(second.decision.shouldNotify, true);
  assert.equal(second.state.state, "open");
  assert.equal(second.state.notifyCount, 1);
});

test("notifications obey exponential backoff while open", () => {
  const cfg: BreakerConfig = { failureThreshold: 1, notifyBaseMs: 5 * MIN, notifyMaxMs: 30 * MIN };
  let state = initialState(ENDPOINT, 0);

  // t=0 opens + notifies.
  let r = onFailure(state, cfg, 0);
  state = r.state;
  assert.equal(r.decision.shouldNotify, true);

  // t=4min: still inside the 5min backoff window → suppressed.
  r = onFailure(state, cfg, 4 * MIN);
  state = r.state;
  assert.equal(r.decision.shouldNotify, false);

  // t=5min: backoff elapsed → notify (2nd).
  r = onFailure(state, cfg, 5 * MIN);
  state = r.state;
  assert.equal(r.decision.shouldNotify, true);
  assert.equal(state.notifyCount, 2);

  // Next backoff is 10min: t=10min (only 5min later) suppressed.
  r = onFailure(state, cfg, 10 * MIN);
  state = r.state;
  assert.equal(r.decision.shouldNotify, false);

  // t=15min (10min later) → notify (3rd).
  r = onFailure(state, cfg, 15 * MIN);
  assert.equal(r.decision.shouldNotify, true);
  assert.equal(r.state.notifyCount, 3);
});

test("recovery resolves once on open→closed and is silent when already healthy", () => {
  const cfg: BreakerConfig = { failureThreshold: 1, notifyBaseMs: 5 * MIN, notifyMaxMs: 30 * MIN };
  let state = initialState(ENDPOINT, 0);

  state = onFailure(state, cfg, 0).state; // open
  assert.equal(state.state, "open");

  const recover = onSuccess(state, cfg, MIN);
  state = recover.state;
  assert.equal(recover.decision.shouldNotifyRecovery, true);
  assert.equal(state.state, "closed");
  assert.equal(state.consecutiveFailures, 0);

  // A second consecutive healthy cycle must not touch the board again.
  const stillHealthy = onSuccess(state, cfg, 2 * MIN);
  assert.equal(stillHealthy.decision.shouldNotifyRecovery, false);
});

test("flap (fail→recover→fail) re-opens and re-notifies on each new episode", () => {
  const cfg: BreakerConfig = { failureThreshold: 1, notifyBaseMs: 5 * MIN, notifyMaxMs: 30 * MIN };
  let state = initialState(ENDPOINT, 0);

  state = onFailure(state, cfg, 0).state; // open #1
  state = onSuccess(state, cfg, MIN).state; // recover
  const reopen = onFailure(state, cfg, 2 * MIN); // open #2
  assert.equal(reopen.decision.shouldNotify, true);
  assert.equal(reopen.state.notifyCount, 1);
});

test("state persists per-endpoint and isolates endpoints from each other", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-"));
  try {
    const a = "http://a.example/health";
    const b = "http://b.example/health";

    // Open A's breaker; B should be untouched.
    let sa = onFailure(loadState(dir, a, 0), { ...DEFAULT_CONFIG, failureThreshold: 1 }, 0).state;
    saveState(dir, sa);

    const reloadedA = loadState(dir, a, MIN);
    assert.equal(reloadedA.state, "open");

    const freshB = loadState(dir, b, MIN);
    assert.equal(freshB.state, "closed", "B's breaker must not be affected by A");

    // Per-endpoint files, not a shared one.
    assert.notEqual(stateFilePath(dir, a), stateFilePath(dir, b));
    assert.ok(fs.existsSync(stateFilePath(dir, a)));
    assert.ok(!fs.existsSync(stateFilePath(dir, b)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt/missing state files degrade to a fresh closed breaker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-"));
  try {
    fs.writeFileSync(stateFilePath(dir, ENDPOINT), "{ not valid json");
    const s = loadState(dir, ENDPOINT, 123);
    assert.equal(s.state, "closed");
    assert.equal(s.endpoint, ENDPOINT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
