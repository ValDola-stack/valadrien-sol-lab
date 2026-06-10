#!/usr/bin/env tsx
/**
 * Recurring API health check — runs every 60s
 * Detects timeouts (>3s) or non-200 responses
 * Alerts to #eng-alerts on failure
 */

import "dotenv/config.js";
import https from "https";
import http from "http";

const HEALTH_URL = "https://os.valadrien.dev/api/health";
const TIMEOUT_MS = 3000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5000;

interface HealthCheckResult {
  ok: boolean;
  status?: number;
  time?: number;
  error?: string;
  endpoint?: string;
}

async function checkHealth(): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    const url = new URL(HEALTH_URL);
    const client = url.protocol === "https:" ? https : http;

    const startTime = Date.now();
    const timeout = setTimeout(() => {
      req.abort();
      resolve({
        ok: false,
        status: 0,
        error: `Timeout after ${TIMEOUT_MS}ms`,
        endpoint: HEALTH_URL,
      });
    }, TIMEOUT_MS);

    const req = client.get(url.toString(), (res) => {
      clearTimeout(timeout);
      const elapsed = Date.now() - startTime;

      if (res.statusCode !== 200) {
        resolve({
          ok: false,
          status: res.statusCode,
          time: elapsed,
          error: `Non-200 response: ${res.statusCode}`,
          endpoint: HEALTH_URL,
        });
        res.resume();
      } else {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(data);
            const isHealthy =
              body.status === "ok" && body.bootstrapStatus === "ready";
            resolve({
              ok: isHealthy,
              status: res.statusCode,
              time: elapsed,
              error: isHealthy ? undefined : "Status not ok or bootstrapping",
              endpoint: HEALTH_URL,
            });
          } catch {
            resolve({
              ok: false,
              status: res.statusCode,
              time: elapsed,
              error: "Failed to parse health response",
              endpoint: HEALTH_URL,
            });
          }
        });
      }
    });

    req.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: err.message,
        endpoint: HEALTH_URL,
      });
    });
  });
}

async function alertToSlack(result: HealthCheckResult): Promise<void> {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackWebhookUrl) {
    console.error("SLACK_WEBHOOK_URL not set, cannot alert to Slack");
    return;
  }

  const message = {
    channel: "#eng-alerts",
    text: "🔴 API Health Check Failed",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🔴 API Health Check Failed",
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Endpoint:*\n${result.endpoint}`,
          },
          {
            type: "mrkdwn",
            text: `*Status Code:*\n${result.status || "N/A"}`,
          },
          {
            type: "mrkdwn",
            text: `*Response Time:*\n${result.time}ms`,
          },
          {
            type: "mrkdwn",
            text: `*Error:*\n${result.error}`,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<!here> Detected at ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };

  return new Promise((resolve, reject) => {
    const url = new URL(slackWebhookUrl);
    const client = url.protocol === "https:" ? https : http;
    const body = JSON.stringify(message);

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = client.request(url, options, (res) => {
      if (res.statusCode === 200) {
        resolve();
      } else {
        reject(new Error(`Slack API returned ${res.statusCode}`));
      }
      res.resume();
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  console.log(`[${new Date().toISOString()}] Running API health check...`);

  let lastError: HealthCheckResult | null = null;
  let attempts = 0;

  for (let i = 0; i < RETRY_COUNT; i++) {
    attempts++;
    const result = await checkHealth();

    if (result.ok) {
      console.log(
        `[${new Date().toISOString()}] ✅ Health check passed (${result.time}ms)`
      );
      return;
    }

    lastError = result;
    console.log(
      `[${new Date().toISOString()}] ❌ Attempt ${i + 1}/${RETRY_COUNT} failed: ${result.error}`
    );

    if (i < RETRY_COUNT - 1) {
      console.log(`   Retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  // All retries failed
  console.error(
    `[${new Date().toISOString()}] ❌ Health check failed after ${attempts} attempts`
  );
  console.error(`   Final error: ${lastError?.error}`);

  try {
    await alertToSlack(lastError!);
    console.log(`[${new Date().toISOString()}] 📢 Alert posted to #eng-alerts`);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] ❌ Failed to alert to Slack:`,
      err
    );
  }
}

run().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
