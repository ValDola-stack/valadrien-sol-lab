#!/usr/bin/env tsx

/**
 * sol-lab — a tiny CLI that greets you from Sol, ValAdrien OS's founding engineer.
 */

function greet(now: Date): string {
  const time = now.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return `👋 Hello from Sol — ValAdrien OS founding engineer.\nThe current time is ${time}.`;
}

function main(): void {
  console.log(greet(new Date()));
}

main();
