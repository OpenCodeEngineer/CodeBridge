#!/usr/bin/env bun
/**
 * Collect support-ready diagnostics for GitHub assignment actor visibility.
 *
 * This script is intentionally read-mostly and only creates a temporary issue
 * to probe assignment mutation behavior with explicit actor IDs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

type Args = {
  repo: string;
  assignmentHandle: string;
  keepIssue: boolean;
};

type AssignableActor = {
  login: string;
  id: string;
  type: "User" | "Bot";
};

type CandidateLookup = {
  candidate: string;
  userApiFound: boolean;
  userNodeId?: string;
  userType?: string;
  userLogin?: string;
  error?: string;
};

type MutationAttempt = {
  actorId: string;
  source: "suggested-actor" | "user-node-id";
  candidate: string;
  ok: boolean;
  error?: string;
  graphQLErrors?: Array<{ type?: string; message?: string }>;
  assigneesAfterMutation?: Array<{ login: string; id: string }>;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    repo: "dzianisv/codebridge-test",
    assignmentHandle: "@codexengineer",
    keepIssue: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      args.repo = next;
      i += 1;
    } else if (arg === "--assignment-handle" && next) {
      args.assignmentHandle = next.startsWith("@") ? next : `@${next}`;
      i += 1;
    } else if (arg === "--keep-issue") {
      args.keepIssue = true;
    }
  }

  return args;
};

function gh(args: string[]): string {
  const result = spawnSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`gh ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return (result.stdout || "").trim();
}

function safeGh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    encoding: "utf-8",
  });
  return {
    ok: (result.status ?? 1) === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function parseRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name: ${repoFullName}`);
  }
  return { owner, repo };
}

function buildAssignmentCandidates(handle: string): string[] {
  const raw = handle.trim().replace(/^@/, "");
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const variants = raw.match(/\[bot\]$/i)
    ? [raw, raw.replace(/\[bot\]$/i, ""), lower, lower.replace(/\[bot\]$/i, "")]
    : [raw, `${raw}[bot]`, lower, `${lower}[bot]`];
  return [...new Set(variants.filter(Boolean))];
}

function listAssignableActors(repoFullName: string): AssignableActor[] {
  const { owner, repo } = parseRepo(repoFullName);
  const raw = gh([
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{__typename ... on User {login id} ... on Bot {login id}}}}}",
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
  ]);
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        suggestedActors?: {
          nodes?: Array<{
            __typename?: string;
            login?: string;
            id?: string;
          }>;
        };
      } | null;
    };
  };
  const nodes = parsed.data?.repository?.suggestedActors?.nodes ?? [];
  return nodes
    .map((node) => {
      const login = (node.login ?? "").trim();
      const id = (node.id ?? "").trim();
      const type = node.__typename === "Bot" ? "Bot" : node.__typename === "User" ? "User" : null;
      if (!login || !id || !type) return null;
      return { login, id, type };
    })
    .filter((entry): entry is AssignableActor => entry !== null);
}

function lookupCandidateUser(candidate: string): CandidateLookup {
  const response = safeGh(["api", `users/${encodeURIComponent(candidate)}`]);
  if (!response.ok || !response.stdout) {
    return {
      candidate,
      userApiFound: false,
      error: response.stderr || response.stdout || "candidate not found by users API",
    };
  }
  try {
    const parsed = JSON.parse(response.stdout) as {
      login?: string;
      node_id?: string;
      type?: string;
    };
    return {
      candidate,
      userApiFound: true,
      userNodeId: parsed.node_id?.trim(),
      userType: parsed.type?.trim(),
      userLogin: parsed.login?.trim(),
    };
  } catch (error) {
    return {
      candidate,
      userApiFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createProbeIssue(repoFullName: string): { number: number; url: string; nodeId: string } {
  const created = gh([
    "api",
    "-X",
    "POST",
    `repos/${repoFullName}/issues`,
    "-f",
    `title=[assignability-probe] ${new Date().toISOString()}`,
    "-f",
    "body=Temporary issue created by collect-github-assignment-evidence.ts",
  ]);
  const parsed = JSON.parse(created) as { number?: number; html_url?: string; node_id?: string };
  const number = Number(parsed.number);
  const url = parsed.html_url ?? "";
  const nodeId = (parsed.node_id ?? "").trim();
  if (!number || !url || !nodeId) {
    throw new Error(`Invalid issue create response: ${created}`);
  }
  return { number, url, nodeId };
}

function readIssueAssignees(repoFullName: string, issueNumber: number): Array<{ login: string; id: string }> {
  const issue = gh(["api", `repos/${repoFullName}/issues/${issueNumber}`]);
  const parsed = JSON.parse(issue) as { assignees?: Array<{ login?: string; node_id?: string }> };
  return (parsed.assignees ?? [])
    .map((entry) => ({
      login: (entry.login ?? "").trim(),
      id: (entry.node_id ?? "").trim(),
    }))
    .filter((entry) => entry.login && entry.id);
}

function runAssignmentMutation(input: {
  issueNodeId: string;
  actorId: string;
}): { ok: boolean; error?: string; graphQLErrors?: Array<{ type?: string; message?: string }>; assignees?: Array<{ login: string; id: string }> } {
  const response = safeGh([
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: copilot_api",
    "-f",
    "query=mutation($assignable:ID!,$actor:ID!){addAssigneesToAssignable(input:{assignableId:$assignable,assigneeIds:[$actor]}){assignable{... on Issue {number assignees(first:20){nodes{login id}}}}}}",
    "-f",
    `assignable=${input.issueNodeId}`,
    "-f",
    `actor=${input.actorId}`,
  ]);
  const output = response.stdout || response.stderr;
  if (!output) {
    return { ok: response.ok, error: "no output from gh graphql command" };
  }
  try {
    const parsed = JSON.parse(output) as {
      data?: {
        addAssigneesToAssignable?: {
          assignable?: {
            assignees?: {
              nodes?: Array<{ login?: string; id?: string }>;
            };
          };
        };
      };
      errors?: Array<{ type?: string; message?: string }>;
      message?: string;
    };
    const assignees = (parsed.data?.addAssigneesToAssignable?.assignable?.assignees?.nodes ?? [])
      .map((entry) => ({
        login: (entry.login ?? "").trim(),
        id: (entry.id ?? "").trim(),
      }))
      .filter((entry) => entry.login && entry.id);
    const hasErrors = (parsed.errors?.length ?? 0) > 0;
    return {
      ok: response.ok && !hasErrors,
      error: hasErrors ? parsed.errors?.map(err => err.message).join("; ") : undefined,
      graphQLErrors: parsed.errors,
      assignees,
    };
  } catch {
    return {
      ok: response.ok,
      error: output,
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = buildAssignmentCandidates(args.assignmentHandle);
  const assignableActors = listAssignableActors(args.repo);
  const actorsByLogin = new Map(assignableActors.map((entry) => [entry.login.toLowerCase(), entry]));
  const candidateLookups = candidates.map(lookupCandidateUser);

  const probeIssue = createProbeIssue(args.repo);
  const mutationAttempts: MutationAttempt[] = [];

  const actorAttempts: Array<{ actorId: string; source: "suggested-actor" | "user-node-id"; candidate: string }> = [];
  for (const candidate of candidates) {
    const actor = actorsByLogin.get(candidate.toLowerCase());
    if (actor) {
      actorAttempts.push({
        actorId: actor.id,
        source: "suggested-actor",
        candidate,
      });
    }
  }
  for (const lookup of candidateLookups) {
    if (!lookup.userNodeId) continue;
    actorAttempts.push({
      actorId: lookup.userNodeId,
      source: "user-node-id",
      candidate: lookup.candidate,
    });
  }

  const seen = new Set<string>();
  const dedupedAttempts = actorAttempts.filter((entry) => {
    const key = `${entry.actorId}:${entry.source}:${entry.candidate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const attempt of dedupedAttempts) {
    const result = runAssignmentMutation({
      issueNodeId: probeIssue.nodeId,
      actorId: attempt.actorId,
    });
    mutationAttempts.push({
      actorId: attempt.actorId,
      source: attempt.source,
      candidate: attempt.candidate,
      ok: result.ok,
      error: result.error,
      graphQLErrors: result.graphQLErrors,
      assigneesAfterMutation: result.assignees,
    });
  }

  const finalAssignees = readIssueAssignees(args.repo, probeIssue.number);

  if (!args.keepIssue) {
    safeGh(["issue", "close", String(probeIssue.number), "--repo", args.repo]);
  }

  const reportsDir = path.join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `github-assignment-evidence-${stamp}.json`);

  const report = {
    timestamp: new Date().toISOString(),
    repo: args.repo,
    assignmentHandle: args.assignmentHandle,
    candidates,
    assignableActors,
    candidateLookups,
    probeIssue,
    mutationAttempts,
    finalAssignees,
    note: "For exact @codexengineer assignment acceptance, codexengineer must appear in assignableActors and assignment mutation must apply that actor to the issue.",
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`Evidence report: ${reportPath}`);
  console.log(JSON.stringify({
    repo: report.repo,
    assignmentHandle: report.assignmentHandle,
    assignableActorLogins: report.assignableActors.map(entry => entry.login),
    finalAssignees: report.finalAssignees.map(entry => entry.login),
    probeIssue: report.probeIssue.url,
  }, null, 2));
}

main();
