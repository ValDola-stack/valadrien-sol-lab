#!/usr/bin/env tsx
/**
 * Validate Slack webhook configuration
 * Tests that SLACK_WEBHOOK_URL is set and accepts POST requests
 */

import "dotenv/config.js";
import https from "https";
import http from "http";

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

async function validateSlack(): Promise<void> {
  if (!slackWebhookUrl) {
    console.error(
      "❌ SLACK_WEBHOOK_URL not set. Please configure it in .env or environment."
    );
    process.exit(1);
  }

  console.log(`Testing Slack webhook: ${slackWebhookUrl.substring(0, 50)}...`);

  return new Promise((resolve, reject) => {
    const url = new URL(slackWebhookUrl);
    const client = url.protocol === "https:" ? https : http;

    const message = {
      text: "✅ Health Check Validation Successful",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "✅ Health Check Webhook Valid",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Slack webhook configuration is working correctly.\nTest sent at ${new Date().toISOString()}`,
          },
        },
      ],
    };

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
        console.log("✅ Slack webhook validation successful (HTTP 200)");
        res.resume();
        resolve();
      } else {
        console.error(
          `❌ Slack API returned ${res.statusCode}. Check webhook URL is correct.`
        );
        res.resume();
        reject(new Error(`Slack returned ${res.statusCode}`));
      }
    });

    req.on("error", (err) => {
      console.error(`❌ Failed to reach Slack webhook: ${err.message}`);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

validateSlack()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Validation failed:", err.message);
    process.exit(1);
  });
