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
| `package.json`   | Package metadata + npm scripts           |

## Health Check

Recurring API health check that monitors `https://os.valadrien.dev/api/health` and alerts to Slack #eng-alerts on failures.

### Setup

1. **Create `.env` from template:**
   ```bash
   cp .env.example .env
   ```

2. **Configure Slack webhook:**
   - Add the `SLACK_WEBHOOK_URL` to your `.env` file
   - Get the webhook URL from:
     - ValAdrien OS secrets store (preferred)
     - Slack workspace admin (create incoming webhook for #eng-alerts)
   - Format: `https://hooks.slack.com/services/T.../B.../...`

3. **Validate configuration:**
   ```bash
   npm run health-check:validate-slack
   ```
   This sends a test message to #eng-alerts and confirms the webhook is working.

### Running

**Single health check:**
```bash
npm run health-check
```

**Continuous (every 60s):**
```bash
npm run health-check:run
```

### Configuration

- **Timeout threshold:** 3 seconds (configurable in `scripts/health-check.ts`)
- **Retry attempts:** 3 with 5-second delays
- **Alert channel:** #eng-alerts (via Slack webhook)

See `.env.example` for all available configuration options.
