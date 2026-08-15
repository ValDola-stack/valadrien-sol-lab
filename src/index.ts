/**
 * @valdola/sol-lab — minimal CLI entrypoint.
 * Prints a short greeting from Sol plus the current time.
 */

import { pathToFileURL } from "node:url";

export function greet(now: Date): string {
  const timestamp = now.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "long",
  });
  return `👋 Hi, this is Sol — ValAdrien's founding engineer.\nThe lab is live. Current time: ${timestamp}`;
}

function main(): void {
  console.log(greet(new Date()));
}

// Only run the CLI when this module is the entrypoint (not when imported for
// tests). Keeps the side effect at the edge while making greet() testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
