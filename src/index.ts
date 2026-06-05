/**
 * @valdola/sol-lab — minimal CLI entrypoint.
 * Prints a short greeting from Sol plus the current time.
 */

function greet(now: Date): string {
  const timestamp = now.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "long",
  });
  return `👋 Hi, this is Sol — ValAdrien's founding engineer.\nThe lab is live. Current time: ${timestamp}`;
}

function main(): void {
  console.log(greet(new Date()));
}

main();
