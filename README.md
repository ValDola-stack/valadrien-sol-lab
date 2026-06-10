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

Recurring check that monitors `https://os.valadrien.dev/api/health` and alerts
on failure. Readiness is `status == "ok"` and not still `booting`.

### Alerting

**Primary — ValAdrien OS board (no external secret):** on failure the check
opens a `critical` issue via the OS API using the runner's own credential, and
@mentions on-call. It is **de-duped** — while the check stays red, new failures
are added as comments on the existing issue instead of spawning a new one each
cycle — and it **auto-resolves** (closes the issue with a "recovered" note) when
the check goes green again. See `scripts/os-alert-sink.ts`.

**Optional — Slack:** if `SLACK_WEBHOOK_URL` is set, alerts are *also* posted to
#eng-alerts, in addition to the OS issue. Leave it blank to use the board only.

### Setup

1. **Create `.env` from template:**
   ```bash
   cp .env.example .env
   ```

2. **Configure OS credentials** (`VALADRIEN_OS_API_URL`, `VALADRIEN_OS_API_KEY`,
   `VALADRIEN_OS_COMPANY_ID`) so the runner can file alert issues. In production
   give the runner a long-lived agent key (`POST /api/agents/{agentId}/keys`),
   not a per-run JWT. Optionally set `HEALTH_ALERT_PROJECT_ID` and
   `HEALTH_ALERT_ONCALL_AGENT_ID` / `HEALTH_ALERT_ONCALL_NAME`.

3. **(Optional) Configure Slack** by setting `SLACK_WEBHOOK_URL`, then validate:
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

To run this continuously as a **background service** (systemd, Docker, or an
OS-managed runtime service), see [`deploy/README.md`](deploy/README.md).

### Configuration

- **Timeout threshold:** 3 seconds (configurable in `scripts/health-check.ts`)
- **Retry attempts:** 3 with 5-second delays
- **Alert channel:** #eng-alerts (via Slack webhook)

See `.env.example` for all available configuration options.
