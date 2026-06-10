/**
 * OS-native alert sink for the API health check.
 *
 * On failure this opens (or updates) a `critical` issue on the ValAdrien OS
 * board using the runner's own API credential — no external secret required.
 * It de-dupes so a sustained outage produces ONE issue with a running comment
 * trail rather than a new issue every 60s, and auto-resolves the issue when
 * the check recovers.
 *
 * Config (environment):
 *   VALADRIEN_OS_API_URL        required — control-plane base URL
 *   VALADRIEN_OS_API_KEY        required — agent API key (NOT a per-run JWT; in
 *                                production give the runner a long-lived key via
 *                                POST /api/agents/{agentId}/keys)
 *   VALADRIEN_OS_COMPANY_ID     required — company the alert issue lives in
 *   HEALTH_ALERT_PROJECT_ID     optional — project to file the alert under
 *   HEALTH_ALERT_ONCALL_AGENT_ID optional — agent to @mention on a new alert
 *   HEALTH_ALERT_ONCALL_NAME    optional — display name for the @mention
 *   VALADRIEN_OS_RUN_ID         optional — added to the audit-trail header
 */

export interface HealthCheckResult {
  ok: boolean;
  status?: number;
  time?: number;
  error?: string;
  endpoint?: string;
}

interface SinkConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  projectId?: string;
  onCallAgentId?: string;
  onCallName?: string;
  runId?: string;
}

function loadConfig(): SinkConfig | null {
  const apiUrl = process.env.VALADRIEN_OS_API_URL;
  const apiKey = process.env.VALADRIEN_OS_API_KEY;
  const companyId = process.env.VALADRIEN_OS_COMPANY_ID;
  if (!apiUrl || !apiKey || !companyId) {
    return null;
  }
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    apiKey,
    companyId,
    projectId: process.env.HEALTH_ALERT_PROJECT_ID,
    onCallAgentId: process.env.HEALTH_ALERT_ONCALL_AGENT_ID,
    onCallName: process.env.HEALTH_ALERT_ONCALL_NAME,
    runId: process.env.VALADRIEN_OS_RUN_ID,
  };
}

// Open (non-terminal) statuses an alert issue can be in.
const OPEN_STATUSES = ["todo", "in_progress", "in_review", "blocked"];

/**
 * Stable de-dupe key for a given check. One alert issue exists per key at a
 * time. Derived from the endpoint so multiple monitored endpoints don't collide.
 */
export function alertKeyFor(endpoint: string | undefined): string {
  const slug = (endpoint ?? "unknown")
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();
  return `health-alert:${slug}`;
}

function markerLine(key: string): string {
  // Hidden, machine-greppable marker used to locate the existing alert issue.
  return `<!-- ${key} -->`;
}

async function api<T>(
  cfg: SinkConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };
  if (cfg.runId) headers["X-Valadrien-Os-Run-Id"] = cfg.runId;

  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OS API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface IssueLite {
  id: string;
  identifier?: string;
  status?: string;
  description?: string;
  title?: string;
}

/** Find the currently-open alert issue for this key, or null. */
async function findOpenAlert(
  cfg: SinkConfig,
  key: string
): Promise<IssueLite | null> {
  const q = encodeURIComponent(key);
  const status = encodeURIComponent(OPEN_STATUSES.join(","));
  const data = await api<{ issues?: IssueLite[] } | IssueLite[]>(
    cfg,
    "GET",
    `/api/companies/${cfg.companyId}/issues?q=${q}&status=${status}`
  );
  const issues = Array.isArray(data) ? data : (data.issues ?? []);
  const marker = markerLine(key);
  return (
    issues.find(
      (i) =>
        (i.description ?? "").includes(marker) &&
        OPEN_STATUSES.includes(i.status ?? "")
    ) ?? null
  );
}

function mention(cfg: SinkConfig): string {
  if (!cfg.onCallAgentId) return "";
  const name = cfg.onCallName ?? "on-call";
  return `[@${name}](agent://${cfg.onCallAgentId})`;
}

function failureDetails(result: HealthCheckResult, at: string): string {
  return [
    `- **Endpoint:** ${result.endpoint ?? "n/a"}`,
    `- **Status code:** ${result.status ?? "n/a"}`,
    `- **Response time:** ${result.time != null ? `${result.time}ms` : "n/a"}`,
    `- **Error:** ${result.error ?? "n/a"}`,
    `- **Detected at:** ${at}`,
  ].join("\n");
}

/**
 * Record a health-check failure. Creates a critical alert issue the first time,
 * and on subsequent failures comments on the existing issue (de-dupe).
 * Returns the issue identifier/id touched, or null if the sink is unconfigured.
 */
export async function recordFailure(
  result: HealthCheckResult,
  at: string
): Promise<{ id: string; identifier?: string; created: boolean } | null> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(
      "[os-alert-sink] OS credentials not configured (VALADRIEN_OS_API_URL/API_KEY/COMPANY_ID); skipping OS alert."
    );
    return null;
  }
  const key = alertKeyFor(result.endpoint);
  const existing = await findOpenAlert(cfg, key);

  if (existing) {
    // NOTE: the POST /comments route expects `body`; the PATCH /issues route
    // uses `comment`. They are not interchangeable.
    await api(cfg, "POST", `/api/issues/${existing.id}/comments`, {
      body: `🔴 Health check still failing.\n\n${failureDetails(result, at)}`,
    });
    return { id: existing.id, identifier: existing.identifier, created: false };
  }

  const m = mention(cfg);
  const description = [
    `${markerLine(key)}`,
    `## 🔴 API health check is failing`,
    ``,
    `The automated health check could not confirm \`${result.endpoint}\` is healthy.`,
    ``,
    failureDetails(result, at),
    ``,
    `This issue auto-de-dupes: while the check stays red, new failures are added`,
    `as comments here instead of opening new issues. It will be resolved`,
    `automatically when the check recovers.`,
    m ? `\n${m} — paging on-call.` : ``,
  ].join("\n");

  const created = await api<IssueLite>(
    cfg,
    "POST",
    `/api/companies/${cfg.companyId}/issues`,
    {
      title: `🔴 API health check failing: ${result.endpoint}`,
      description,
      priority: "critical",
      status: "todo",
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
    }
  );
  return { id: created.id, identifier: created.identifier, created: true };
}

// ── Generic incident recorder ────────────────────────────────────────────────

export type IncidentPriority = "critical" | "high" | "medium" | "low";

export interface Incident {
  /** Stable de-dupe key — one rolling issue exists per key at a time. */
  key: string;
  /** Issue title used when a fresh incident issue is opened. */
  title: string;
  /** One-line summary of what happened. */
  summary: string;
  /** Optional structured detail rendered as a bullet list. */
  details?: Record<string, string | number | undefined>;
  /** Priority for a newly-opened issue (default `high`). */
  priority?: IncidentPriority;
}

function detailLines(details: Record<string, string | number | undefined>): string {
  return Object.entries(details)
    .map(([k, v]) => `- **${k}:** ${v ?? "n/a"}`)
    .join("\n");
}

/**
 * Record a generic incident on the OS board, reusing the same credential and
 * de-dupe machinery as the health alert. The first incident for a key opens an
 * issue; subsequent incidents with the same key append a comment to it (so a
 * burst of events — e.g. several stuck runs reaped in one sweep — produces ONE
 * issue with a running trail rather than a flood of issues / wakes, the same
 * anti-saturation lesson as VAL-96). Returns the issue touched, or null if the
 * sink is unconfigured.
 */
export async function recordIncident(
  incident: Incident,
  at: string
): Promise<{ id: string; identifier?: string; created: boolean } | null> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(
      "[os-alert-sink] OS credentials not configured; skipping incident record."
    );
    return null;
  }

  const body = [
    incident.summary,
    incident.details ? `\n${detailLines(incident.details)}` : "",
    `\n- **At:** ${at}`,
  ].join("");

  const existing = await findOpenAlert(cfg, incident.key);
  if (existing) {
    await api(cfg, "POST", `/api/issues/${existing.id}/comments`, {
      body: `🛑 ${body}`,
    });
    return { id: existing.id, identifier: existing.identifier, created: false };
  }

  const m = mention(cfg);
  const description = [
    markerLine(incident.key),
    `## 🛑 ${incident.title}`,
    ``,
    body,
    ``,
    `This issue auto-de-dupes: further incidents with the same key are added as`,
    `comments here instead of opening new issues.`,
    m ? `\n${m} — paging on-call.` : ``,
  ].join("\n");

  const created = await api<IssueLite>(
    cfg,
    "POST",
    `/api/companies/${cfg.companyId}/issues`,
    {
      title: incident.title,
      description,
      priority: incident.priority ?? "high",
      status: "todo",
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
    }
  );
  return { id: created.id, identifier: created.identifier, created: true };
}

/**
 * Record a recovery. If an open alert issue exists for this endpoint, comment
 * "recovered" and close it (status `done`). No-op if nothing is open.
 * Returns the resolved issue id/identifier, or null.
 */
export async function recordRecovery(
  endpoint: string | undefined,
  at: string
): Promise<{ id: string; identifier?: string } | null> {
  const cfg = loadConfig();
  if (!cfg) return null;
  const key = alertKeyFor(endpoint);
  const existing = await findOpenAlert(cfg, key);
  if (!existing) return null;

  await api(cfg, "PATCH", `/api/issues/${existing.id}`, {
    status: "done",
    comment: `✅ Health check recovered at ${at}. \`${endpoint}\` is healthy again; auto-resolving this alert.`,
  });
  return { id: existing.id, identifier: existing.identifier };
}
