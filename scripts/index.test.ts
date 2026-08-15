/**
 * Smoke test for the CLI greeting (VAL-475).
 *
 * Verifies greet() produces the expected shape without exercising any side
 * effects. The entrypoint's main() guard means importing this module does not
 * print to stdout.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { greet } from "../src/index.js";

test("greet returns a greeting containing Sol and the lab, with the given time", () => {
  const now = new Date("2026-08-15T13:04:57.000Z");
  const greeting = greet(now);

  assert.equal(typeof greeting, "string");
  assert.ok(greeting.length > 0, "greeting should not be empty");
  assert.ok(greeting.includes("Sol"), "greeting should mention Sol");
  assert.ok(greeting.includes("lab is live"), "greeting should indicate the lab is live");
  assert.ok(
    greeting.includes(now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })),
    "greeting should embed the provided timestamp"
  );
});

test("greet embeds the exact timestamp for the supplied date", () => {
  const now = new Date("2020-01-02T03:04:05.000Z");
  const expected = now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" });
  assert.ok(greet(now).includes(expected));
});
