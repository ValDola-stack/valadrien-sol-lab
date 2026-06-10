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

### Failure isolation & circuit breaker (VAL-96)

A failing endpoint must not be able to flood the board. Without a guard, a
sustained outage wrote to the OS board **every 60s** — and each write on the
`critical` alert issue wakes an automation run — which saturated the runner
queue ([VAL-88](https://github.com/ValDola-stack/valadrien-sol-lab) incident).

`scripts/circuit-breaker.ts` gates the board-write side-effect (the cascade
driver), not the cheap read-only probe:

- **Threshold:** the breaker only escalates after `HEALTH_CB_FAILURE_THRESHOLD`
  consecutive failing *cycles* (default `2`). A single transient cycle is held,
  not paged — a cycle-level complement to the in-check retries below.
- **Open + exponential backoff:** on the threshold-crossing cycle it notifies
  once (opens the alert issue), then throttles further notifications with
  exponential backoff (`HEALTH_CB_NOTIFY_BASE_MS` → 2× → 4× …, capped at
  `HEALTH_CB_NOTIFY_MAX_MS`). A 1-hour outage produces **4 board writes**
  (at +1, +6, +16, +36 min) instead of ~60, then at most one per 30 min.
- **Recovery:** the first healthy cycle after an outage resolves the alert once
  and resets the breaker. Steady-state healthy cycles never touch the board.
- **Per-endpoint isolation:** breaker state is keyed and persisted per endpoint
  (`HEALTH_CB_STATE_DIR`, default a `valadrien-health-cb` dir in the system temp
  dir), so one failing endpoint never opens or throttles another's breaker. The
  state file also survives the per-cycle subprocess the runner spawns.

The runner additionally isolates a *hung* check at the process level: each cycle
runs in its own subprocess that is killed after 30s, so a stuck request can't
block the loop.

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

### Configuration / tuning

All values are env-overridable (defaults shown). See `.env.example`.

| Env var                       | Default  | Purpose                                                        |
| ----------------------------- | -------- | -------------------------------------------------------------- |
| `HEALTH_URL`                  | `…/api/health` | Endpoint to probe                                        |
| `HEALTH_TIMEOUT_MS`           | `3000`   | Per-request timeout; a slower response is a failure            |
| `HEALTH_RETRY_COUNT`          | `3`      | Attempts per cycle before the cycle is declared failed         |
| `HEALTH_RETRY_DELAY_MS`       | `5000`   | Delay between in-cycle retries (rides out transient blips)     |
| `HEALTH_CB_FAILURE_THRESHOLD` | `2`      | Consecutive failing cycles before the breaker opens / pages    |
| `HEALTH_CB_NOTIFY_BASE_MS`    | `300000` | Base backoff between notifications while open (5 min)          |
| `HEALTH_CB_NOTIFY_MAX_MS`     | `1800000`| Cap on the exponential notification backoff (30 min)           |
| `HEALTH_CB_STATE_DIR`         | temp dir | Where per-endpoint breaker state is persisted                  |

**Retry vs. circuit-breaker — two layers, two jobs.** In-cycle retries
(`HEALTH_RETRY_*`) ride out a transient blip *within* one check. The breaker
(`HEALTH_CB_*`) governs escalation *across* cycles so a real, sustained outage
is paged once and then throttled — never re-paged every 60s.

## Tests

```bash
npm test        # node:test suite (circuit-breaker behaviour)
npm run typecheck
```

The headline test (`sustained outage does not saturate`) is the VAL-96
acceptance check: 60 consecutive failing cycles produce ≤ a handful of board
writes, proving one endpoint failure can't trigger queue saturation.
