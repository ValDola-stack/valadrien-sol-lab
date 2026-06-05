# Contributing to `@valdola/sol-lab`

Thanks for taking the time to dig in. This document explains what the project is
for, how to get it running, the conventions we hold the code to, and the
mechanics of adding a new command. Read it once before your first change; after
that it should mostly stay out of your way.

## Project intent

`@valdola/sol-lab` is Sol's autonomous engineering lab — the founding engineer's
sandbox for ValAdrien OS. It is deliberately small: a single, real, runnable
TypeScript CLI that we treat as a production-quality baseline rather than a
throwaway scratchpad. The goal is not feature breadth; it is to keep a clean,
strict, immediately-runnable foundation that we can grow one well-considered
command at a time.

Because this is where engineering conventions for the wider org get exercised
first, we hold it to the standard we want everything else to meet: strict types,
no dead code, small reviewable commits, and a working tree that is always
deployable. If a change would make the lab harder to reason about, that is a
reason to slow down, not to merge.

## Requirements

- **Node.js 18 or newer.** The lab is developed on Node 24, and we lean on modern
  ESM and standard-library features, so older runtimes are unsupported.
- **npm** for dependency management. The committed `package-lock.json` is the
  source of truth — prefer `npm ci` in clean environments and `npm install` when
  you are intentionally changing dependencies.

## Getting it running

The project is pure ESM (`"type": "module"`) and runs directly through
[`tsx`](https://github.com/privatenumber/tsx), so there is no build step in the
normal loop.

```bash
# Run it with zero install:
npx -y tsx src/index.ts

# Or install dev dependencies once and use the npm script:
npm install
npm start
```

`npm start` is just `tsx src/index.ts`. You should see a short greeting from Sol
and the current time. If you change `src/index.ts` and re-run, the new output
should appear immediately — there is no cached build to clear.

To type-check without running (the strict config is the real gate, see below):

```bash
npx tsc --noEmit
```

## Code style

We let the tooling enforce most of this so reviews can focus on substance.

- **TypeScript, strict mode, no exceptions.** `tsconfig.json` enables `strict`
  along with `noUnusedLocals`, `noUnusedParameters`, and
  `noFallthroughCasesInSwitch`. A change that does not pass `tsc --noEmit` is not
  ready. Do not silence the compiler with `any` or `// @ts-ignore`; if the types
  are fighting you, the design usually needs the attention.
- **ES modules only.** Use `import`/`export`, not `require`. Keep imports at the
  top of the file.
- **Small, pure, named functions.** Follow the shape already in `src/index.ts`:
  pull logic into a named function that takes its inputs as parameters (e.g.
  `greet(now: Date)`) and keep side effects — `console.log`, process exit,
  filesystem — at the edges in `main()`. This keeps the core logic testable
  without mocking the world.
- **Explicit return types** on exported and top-level functions. Let inference
  handle local intermediates.
- **Match the surrounding code.** Two-space indentation, double quotes, and the
  existing comment density. A short top-of-file doc comment describing what a
  module does is welcome; narrating obvious lines is not.
- **No dead code and no stray dependencies.** If you add a dependency, it should
  be load-bearing, and dev-only tooling belongs in `devDependencies`.

## Commit conventions

- **Small, logical commits.** One coherent change per commit; do not bundle an
  unrelated refactor into a feature commit. If you find unrelated local changes
  in your tree, leave them alone rather than reverting or folding them in.
- **Imperative, present-tense subjects** that describe the change, e.g.
  `Add a status command` or `Tighten greeting timestamp formatting`. Keep the
  subject under ~72 characters; add a body when the *why* is not obvious from the
  diff.
- **Every commit must keep the tree deployable** — it should type-check and run.
  Do not commit a broken intermediate state to `main`.
- **Co-authorship trailer.** End every commit message with exactly:

  ```
  Co-Authored-By: ValAdrien OS <noreply@TODO_DOMAIN>
  ```

- **Pushing.** `main` is the working branch for this lab. Push only when the work
  is good and verified (`git push origin main`). Never force-push shared history,
  and never commit secrets, credentials, or customer data — if you spot any in a
  diff, stop and escalate rather than committing.

## How to add a command

Today the CLI has a single entrypoint (`src/index.ts`) that runs one behavior.
The intended growth path is a small command dispatcher rather than an
ever-growing `main()`. When you add the first real subcommand, follow this shape
so the structure stays predictable:

1. **Create a module per command** under `src/commands/`, e.g.
   `src/commands/status.ts`. Export a single named function that takes its inputs
   as plain parameters and returns its result as data — keep `console.log` out of
   it where you can, so the command can be tested directly:

   ```ts
   // src/commands/status.ts
   export function status(now: Date): string {
     return `lab ok — ${now.toISOString()}`;
   }
   ```

2. **Register it in the entrypoint.** In `src/index.ts`, read the subcommand from
   `process.argv.slice(2)`, dispatch to the matching command function, print its
   result, and exit non-zero on an unknown command with a short usage line. Keep
   the dispatch table explicit (a `switch` or a small map) so every command is
   discoverable in one place.

3. **Keep effects at the edges.** The command function computes; `main()` reads
   argv, calls it, and handles output and exit codes. This mirrors the existing
   `greet` / `main` split.

4. **Verify before you commit.** Run `npx tsc --noEmit` and exercise the new
   command end-to-end (`npx tsx src/index.ts <your-command>`). State how you
   verified it in the commit or PR description.

5. **Document it.** Add the command to the README's usage/layout section so the
   surface stays discoverable.

If a command needs to grow beyond this — flags, configuration, async I/O — raise
it before reaching for a heavy CLI framework. The lab favors a small, legible
dispatcher we fully understand over a dependency we do not.

## Before you open a change

A quick self-check that mirrors what review will look for:

- `npx tsc --noEmit` passes (no type or unused-code errors).
- The command runs and does what the change claims (`npm start` or
  `npx tsx src/index.ts ...`).
- The commit is small, has an imperative subject, and ends with the co-author
  trailer.
- No secrets, no unrelated reverts, no dead code, and the README reflects any new
  surface.

That is the whole bar: keep it strict, keep it small, keep it runnable.
