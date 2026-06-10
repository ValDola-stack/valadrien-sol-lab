# Deploying the heartbeat runner reaper (VAL-97)

`scripts/reaper-runner.ts` is a watchdog for the heartbeat runner. It sweeps the
run registry on an interval and **auto-cancels runs that overstay their phase**,
filing a de-duped incident on the ValAdrien OS board for every cancellation:

- **Queued > 2min without progress** → auto-cancel (`queued-timeout`). A run that
  never starts is, by definition, stuck in the queue.
- **Running > 8min** → auto-cancel (`running-timeout`). A hard cap on a single
  run so one hung run cannot block the queue behind it (the VAL-88 failure mode).

It is the enforcement half of the design and does **not** submit work itself.

## How a run gets tracked (integration contract)

The reaper enforces timeouts on a shared **registry file** (`REAPER_REGISTRY_FILE`).
The executor that actually runs heartbeats reports lifecycle into that same file
via the helpers in `scripts/run-reaper.ts`:

| Executor event        | Call                      | Effect                                  |
| --------------------- | ------------------------- | --------------------------------------- |
| Run submitted/queued  | `reaper.enqueue(id,label)`| starts the 2-min queued clock           |
| Run starts executing  | `reaper.markRunning(id)`  | clears queued clock, starts 8-min clock |
| Run reports progress  | `reaper.markProgress(id)` | records liveness (advisory)             |
| Run finishes normally | `reaper.complete(id)`     | stops tracking it                       |

The reaper sweeps independently; when a run trips a limit it calls the configured
**cancel** action and records an incident, then drops the run.

## Cancellation action

Dropping a run from the registry is the cancellation *of record* (it stops being
tracked / counted against the queue). To **also** take a hard action on the host,
set `REAPER_CANCEL_COMMAND` — it runs as `sh -c "<cmd>"` with `REAP_RUN_ID` and
`REAP_REASON` in the environment (e.g. `kill "$REAP_RUN_ID"`, or a `curl` to a
cancel API). With no command set the reaper is incident-only (detect + record).

## Prerequisite: a long-lived runner credential

The incident sink files board issues using `VALADRIEN_OS_API_KEY`. In production
this **must be a long-lived agent API key** (`POST /api/agents/{agentId}/keys`),
**not** a per-run heartbeat JWT — same credential gate as the health-check
alerting (tracked on the runner-key approval). Without OS creds the reaper still
runs and still auto-cancels; it just logs the incident locally instead of filing
it on the board.

## Configuration

| Variable                    | Required | Default                          | Purpose                                  |
| --------------------------- | -------- | -------------------------------- | ---------------------------------------- |
| `REAPER_REGISTRY_FILE`      | no       | `<tmp>/valadrien-run-reaper/registry.json` | Shared run-lifecycle registry. |
| `REAPER_QUEUED_TIMEOUT_MS`  | no       | `120000` (2min)                  | Queued auto-cancel threshold.            |
| `REAPER_RUNNING_TIMEOUT_MS` | no       | `480000` (8min)                  | Running auto-cancel threshold.           |
| `REAPER_SWEEP_INTERVAL_MS`  | no       | `30000`                          | Sweep cadence.                           |
| `REAPER_CANCEL_COMMAND`     | no       | —                                | Optional host command to hard-cancel.    |
| `VALADRIEN_OS_API_URL`      | for sink | —                                | Control-plane base URL.                  |
| `VALADRIEN_OS_API_KEY`      | for sink | —                                | **Long-lived** agent key for incidents.  |
| `VALADRIEN_OS_COMPANY_ID`   | for sink | —                                | Company the incident issue lives in.     |
| `HEALTH_ALERT_PROJECT_ID`   | no       | —                                | Project to file incidents under.         |
| `HEALTH_ALERT_ONCALL_AGENT_ID` / `HEALTH_ALERT_ONCALL_NAME` | no | — | On-call @mention on a new incident. |

## Run it

```bash
# systemd (recommended for a VM/bare host) — see deploy/reaper-runner.service:
sudo cp deploy/reaper-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reaper-runner
journalctl -u reaper-runner -f

# Or directly:
npm run reaper:run
```

## Verifying

```bash
# Deterministic unit tests (queued/running timeouts, cancel/notify, persistence):
npm test

# Live, observable proof: spawns real processes, hangs one, and watches the
# reaper kill it. Exits 0 on success.
npm run reaper:sim
```
