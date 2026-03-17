#!/usr/bin/env bun
/**
 * Operational GitHub mention/assignment matrix runner.
 *
 * Runs the protocol test script, maps status to PASS/BLOCKED/FAIL,
 * and writes required JSON/Markdown reports into reports/.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Args = {
  issueRepo: string;
  prRepo?: string;
  discussionRepo: string;
  discussionNumber?: number;
  assignmentHandle?: string;
  databaseUrl?: string;
  hookTarget: string;
  webhookSecret: string;
  timeoutSec: number;
  pollSec: number;
};

type ProtocolResult = {
  name: string;
  status: "pass" | "blocked" | "fail";
  details: string;
  url?: string;
};

type ProtocolSummary = {
  appHandle: string;
  appLogin: string;
  discussionNumber?: number;
  issueRepo: string;
  prRepo: string;
  discussionRepo?: string;
  results: ProtocolResult[];
};

type MatrixStatus = "PASS" | "BLOCKED" | "FAIL";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    issueRepo: "dzianisv/codebridge-test",
    discussionRepo: "VibeTechnologies/vibeteam-eval-hello-world",
    discussionNumber: 6,
    hookTarget: process.env.EVAL_HOOK_TARGET?.trim() || "http://127.0.0.1:8788/github/webhook",
    webhookSecret: process.env.EVAL_WEBHOOK_SECRET?.trim() || process.env.GITHUB_WEBHOOK_SECRET?.trim() || "",
    timeoutSec: 120,
    pollSec: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--issue-repo" && next) {
      args.issueRepo = next;
      i += 1;
    } else if (arg === "--pr-repo" && next) {
      args.prRepo = next;
      i += 1;
    } else if (arg === "--discussion-repo" && next) {
      args.discussionRepo = next;
      i += 1;
    } else if (arg === "--discussion-number" && next) {
      args.discussionNumber = Number(next);
      i += 1;
    } else if (arg === "--assignment-handle" && next) {
      args.assignmentHandle = next.startsWith("@") ? next : `@${next}`;
      i += 1;
    } else if (arg === "--database-url" && next) {
      args.databaseUrl = next;
      i += 1;
    } else if (arg === "--hook-target" && next) {
      args.hookTarget = next;
      i += 1;
    } else if (arg === "--webhook-secret" && next) {
      args.webhookSecret = next;
      i += 1;
    } else if (arg === "--timeout" && next) {
      args.timeoutSec = Number(next);
      i += 1;
    } else if (arg === "--poll" && next) {
      args.pollSec = Number(next);
      i += 1;
    }
  }
  return args;
}

function extractJsonObject(stdout: string): ProtocolSummary {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Unable to parse protocol JSON from script output");
  }
  const jsonText = stdout.slice(start, end + 1);
  return JSON.parse(jsonText) as ProtocolSummary;
}

function mapStatus(status: ProtocolResult["status"]): MatrixStatus {
  if (status === "pass") return "PASS";
  if (status === "blocked") return "BLOCKED";
  return "FAIL";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const prRepo = args.prRepo ?? args.issueRepo;

  const protocolArgs = [
    "scripts/test-github-protocol.ts",
    "--issue-repo",
    args.issueRepo,
    "--pr-repo",
    prRepo,
    "--discussion-repo",
    args.discussionRepo,
    "--timeout",
    String(args.timeoutSec),
    "--poll",
    String(args.pollSec),
  ];
  if (Number.isFinite(args.discussionNumber) && (args.discussionNumber ?? 0) > 0) {
    protocolArgs.push("--discussion-number", String(args.discussionNumber));
  }
  if (args.assignmentHandle) {
    protocolArgs.push("--assignment-handle", args.assignmentHandle);
  }
  if (args.databaseUrl) {
    protocolArgs.push("--database-url", args.databaseUrl);
  }
  if (args.hookTarget) {
    protocolArgs.push("--hook-target", args.hookTarget);
  }
  if (args.webhookSecret) {
    protocolArgs.push("--webhook-secret", args.webhookSecret);
  }

  const result = spawnSync("bun", protocolArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`Protocol runner failed to start: ${result.error.message}`);
  }

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const parsed = extractJsonObject(stdout);
  const finishedAt = new Date().toISOString();

  const mappedCases = parsed.results.map((entry) => ({
    name: entry.name,
    status: mapStatus(entry.status),
    details: entry.details,
    url: entry.url,
  }));
  const failures = mappedCases.filter((entry) => entry.status === "FAIL");

  const report = {
    startedAt,
    finishedAt,
    command: ["bun", ...protocolArgs].join(" "),
    appHandle: parsed.appHandle,
    appLogin: parsed.appLogin,
    issueRepo: parsed.issueRepo,
    prRepo: parsed.prRepo,
    discussionRepo: parsed.discussionRepo,
    discussionNumber: parsed.discussionNumber,
    exitCode: result.status ?? 1,
    stderr,
    tests: mappedCases,
  };

  const reportsDir = path.join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(reportsDir, `codebridge-test-report-${stamp}.json`);
  const mdPath = path.join(reportsDir, `codebridge-test-report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const markdown = [
    "# GitHub Mention E2E Report",
    "",
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Command: \`${report.command}\``,
    `- App handle: ${parsed.appHandle}`,
    "",
    "## Results",
    "",
    "| Case | Status | Details | URL |",
    "| --- | --- | --- | --- |",
    ...mappedCases.map((entry) => {
      const url = entry.url ?? "";
      const details = entry.details.replace(/\|/g, "\\|");
      return `| ${entry.name} | ${entry.status} | ${details} | ${url} |`;
    }),
    "",
    "## Exit",
    "",
    `- Protocol exit code: ${report.exitCode}`,
    `- FAIL count: ${failures.length}`,
    "",
  ].join("\n");
  writeFileSync(mdPath, markdown);

  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
