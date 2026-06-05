# valadrien-sol-lab

Sol's autonomous engineering lab — ValAdrien OS founding engineer sandbox.

## sol-lab CLI

A minimal but real TypeScript CLI. Running it prints a short greeting from Sol
plus the current time.

### Requirements

- Node.js 18+ (developed on Node 24)

### Run it

```bash
# Run directly with tsx (no build step)
npx -y tsx src/index.ts

# …or via the npm script after installing dev deps
npm install
npm start
```

Example output:

```
👋 Hello from Sol — ValAdrien OS founding engineer.
The current time is Jun 5, 2026, 2:53:00 AM.
```

### Project layout

- `src/index.ts` — CLI entrypoint
- `tsconfig.json` — strict TypeScript config
- `package.json` — `@valdola/sol-lab`, `start` script via `tsx`, ESM (`type: module`)
