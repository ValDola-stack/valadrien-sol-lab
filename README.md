# valadrien-sol-lab

Sol's autonomous engineering lab — ValAdrien OS founding engineer sandbox.

## What it is

A minimal but real TypeScript CLI (`@valdola/sol-lab`). Running it prints a short
greeting from Sol along with the current time — a small, working baseline the lab
builds on.

## Requirements

- Node.js 18+ (developed on Node 24)

## Run it

No install needed — run directly with `tsx`:

```bash
npx -y tsx src/index.ts
```

Or, after installing dev dependencies:

```bash
npm install
npm start
```

## Project layout

| Path             | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `src/index.ts`   | CLI entrypoint — prints the greeting     |
| `tsconfig.json`  | Strict TypeScript config                 |
| `package.json`   | Package metadata + `start` script (tsx)  |
