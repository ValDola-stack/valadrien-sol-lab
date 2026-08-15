/**
 * Tests for the OS alert-sink de-dupe key (VAL-475).
 *
 * alertKeyFor() is the pure decision that keeps a sustained outage on ONE
 * alert issue per endpoint. These tests cover the stable key derivation, not
 * the network calls.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { alertKeyFor } from "./os-alert-sink.js";

test("alert key is stable for the same endpoint", () => {
  assert.equal(
    alertKeyFor("https://os.valadrien.dev/api/health"),
    alertKeyFor("https://os.valadrien.dev/api/health")
  );
});

test("alert key is prefixed and lowercased", () => {
  assert.ok(alertKeyFor("https://os.valadrien.dev/api/health").startsWith("health-alert:"));
  const key = alertKeyFor("HTTPS://OS.VALADRIEN.DEV/api/health");
  assert.equal(key, key.toLowerCase());
});

test("different endpoints map to different keys (no cross-endpoint collision)", () => {
  const a = alertKeyFor("https://os.valadrien.dev/api/health");
  const b = alertKeyFor("https://os.valadrien.dev/api/other");
  assert.notEqual(a, b);
});

test("scheme prefix is stripped from the slug", () => {
  const withScheme = alertKeyFor("https://example.com/x");
  const bare = alertKeyFor("example.com/x");
  assert.equal(withScheme, bare);
});

test("undefined endpoint degrades to a stable 'unknown' key", () => {
  assert.equal(alertKeyFor(undefined), "health-alert:unknown");
});
