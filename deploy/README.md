# Deploying the health check runner

`scripts/health-check-runner.ts` runs the API health check (`scripts/health-check.ts`)
in a loop — one check every 60s — and is meant to run **continuously as a
background service**. On failure it opens a de-duped `critical` issue on the
ValAdrien OS board and auto-resolves it on recovery (see `scripts/os-alert-sink.ts`).

This guide covers three deployment targets. Pick one. All three read the same
`.env` file — **no secrets are baked into any artifact**.

## Prerequisite: a long-lived runner credential

The OS-native alert sink files board issues using `VALADRIEN_OS_API_KEY`. In
production this **must be a long-lived agent API key** (`POST /api/agents/{agentId}/keys`),
**not** a per-run heartbeat JWT — a JWT expires and the runner would stop being
able to alert. Provisioning that key and choosing the always-on deploy host are
governance decisions owned by the CEO; this is the gating item for going live.

## Configuration

Copy the template and fill it in:

```bash
cp .env.example .env
```

| Variable                       | Required | Purpose                                                            |
| ------------------------------ | -------- | ----------------------------------------------------------------- |
| `VALADRIEN_OS_API_URL`         | yes      | Control-plane base URL (e.g. `https://os.valadrien.dev`).         |
| `VALADRIEN_OS_API_KEY`         | yes      | **Long-lived** agent API key the runner uses to file alerts.      |
| `VALADRIEN_OS_COMPANY_ID`      | yes      | Company the alert issue lives in.                                 |
| `HEALTH_ALERT_PROJECT_ID`      | no       | Project to file the alert issue under.                            |
| `HEALTH_ALERT_ONCALL_AGENT_ID` | no       | Agent to @mention on a newly-opened alert.                        |
| `HEALTH_ALERT_ONCALL_NAME`     | no       | Display name for the @mention.                                    |
| `SLACK_WEBHOOK_URL`            | no       | Optional *additional* Slack channel; board alerting works without it. |
| `HEALTH_URL`                   | no       | Override the monitored endpoint (default `…/api/health`).         |
| `HEALTH_TIMEOUT_MS`            | no       | Per-request timeout (default `3000`).                             |
| `HEALTH_RETRY_COUNT`           | no       | Attempts before alerting (default `3`).                           |
| `HEALTH_RETRY_DELAY_MS`        | no       | Delay between retries (default `5000`).                           |
| `HEALTH_CB_STATE_DIR`          | no       | Circuit-breaker state dir (default `os.tmpdir()`). Set to a persistent path under systemd — see Option A. |

If the OS credentials are absent the sink no-ops (logs a warning) and the check
still runs — useful for a connectivity-only smoke test.

## Option A — systemd (recommended for a VM/bare host)

Canonical Linux background service: starts on boot, restarts on crash, logs to
the journal. See the header of `deploy/health-check-runner.service` for step-by-step
install. Summary:

```bash
sudo cp deploy/health-check-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now health-check-runner
journalctl -u health-check-runner -f
```

**Persist the circuit-breaker state.** The unit sets `PrivateTmp=true`, which gives
the service a private `/tmp` that is wiped on every (re)start. The breaker defaults
to `os.tmpdir()`, so a crash+restart mid-outage would lose the open-circuit state
and re-page on the next failing cycle. Point it at a path inside `ReadWritePaths`
(`/opt/valadrien-sol-lab`) instead — add to the env file:

```
HEALTH_CB_STATE_DIR=/opt/valadrien-sol-lab/cb-state
```

## Option B — Docker

```bash
docker build -f deploy/Dockerfile -t valadrien-health-runner .
docker run -d --name health-runner --restart=always --env-file .env valadrien-health-runner
docker logs -f health-runner
```

## Option C — ValAdrien OS managed runtime service

If the deploy host is a ValAdrien OS execution workspace, register the runner as
a managed runtime service rather than an unmanaged process, so its state, logs,
and ownership stay visible to the board. Configure a workspace service whose
command is `npm run health-check:run`, then control it via
`POST /api/execution-workspaces/{id}/runtime-services/{start|stop|restart}`.
This requires the workspace environment to be configured with that service
definition (an environment/governance change), so it is not self-serve from a
code commit alone.

## Verifying a deployment

```bash
# One-shot connectivity check (no loop, no board writes if creds are unset):
npm run health-check

# Confirm the loop boots and runs an iteration, then stop it:
npm run health-check:run
```

A healthy run logs `✅ Health check passed (NNNms)` and schedules the next check
60s out. A sustained failure opens one `critical` board issue and keeps a comment
trail until recovery.
