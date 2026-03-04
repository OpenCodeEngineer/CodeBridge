#!/usr/bin/env node

const payloadArg = process.argv.at(-1);
if (!payloadArg) process.exit(0);

let payload;
try {
  payload = JSON.parse(payloadArg);
} catch {
  process.exit(0);
}

const targetUrl = process.env.CODEBRIDGE_NOTIFY_URL || process.env.CODEX_BRIDGE_NOTIFY_URL || "http://127.0.0.1:8788/codex/notify";
const timeoutMs = Number.parseInt(process.env.CODEBRIDGE_NOTIFY_TIMEOUT_MS || process.env.CODEX_BRIDGE_NOTIFY_TIMEOUT_MS || "2500", 10);
const token = process.env.CODEBRIDGE_NOTIFY_TOKEN || process.env.CODEX_BRIDGE_NOTIFY_TOKEN;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2500);

const headers = {
  "content-type": "application/json",
};
if (token) {
  headers["x-codebridge-token"] = token;
}

fetch(targetUrl, {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
  signal: controller.signal,
}).catch(() => {
  // Best-effort telemetry only.
}).finally(() => {
  clearTimeout(timer);
});
