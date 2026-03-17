#!/usr/bin/env bun
/**
 * Promptfoo-based hard evaluation gate for CodeBridge.
 *
 * Required scenarios:
 * - python-hello-world (mention)
 * - typescript-bun-hello (mention)
 * - mention-bootstrap-status-only (mention)
 * - direct-assignment-no-mention (assignment -> verify agent started)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePreferredAssignmentHandle } from "./github-assignment-handle.js";

type TriggerType = "mention" | "assignment";
type CompletionMode = "started" | "terminal";

type EvalCase = {
  id: string;
  title: string;
  trigger: TriggerType;
  completionMode: CompletionMode;
  task: string;
  rubric: string;
};

type Args = {
  repo: string;
  repoPath?: string;
  appHandle: string;
  assignmentHandle?: string;
  timeoutSec: number;
  pollSec: number;
  keepArtifacts: boolean;
};

type IssueRef = {
  number: number;
  url: string;
  nodeId: string;
};

type BotComment = {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string };
};

type AssignmentResult = {
  attemptedLogins: string[];
  assigneesAfter: string[];
  apiCallErrors: string[];
  assignmentAccepted: boolean;
  triggerMode: string;
  assignableActors: AssignableActor[];
  matchedActorLogin?: string;
  matchedActorId?: string;
  matchedReason?: string;
};

type CaseCollected = {
  caseId: string;
  title: string;
  trigger: TriggerType;
  completionMode: CompletionMode;
  issueNumber: number;
  issueUrl: string;
  task: string;
  assignmentAttempted: boolean;
  attemptedAssigneeLogins: string[];
  assigneesAfterAssignment: string[];
  assignmentAccepted: boolean;
  triggerMode: string;
  assignmentHandle: string;
  assignableActors: Array<{ login: string; id: string; type: "User" | "Bot" }>;
  matchedAssignmentActorLogin?: string;
  matchedAssignmentActorId?: string;
  matchedAssignmentReason?: string;
  botStarted: boolean;
  botCompleted: boolean;
  timedOut: boolean;
  firstBotComment: string;
  botResponse: string;
  fileChanges: string | null;
  notes: string[];
  rubric: string;
};

const EVAL_CASES: EvalCase[] = [
  {
    id: "python-hello-world",
    title: "Create a Python hello world",
    trigger: "mention",
    completionMode: "terminal",
    task: "Create a file called hello.py that prints 'Hello, World!' to stdout. Only create the file, nothing else.",
    rubric: [
      "Pass if the JSON evidence shows the run completed and output indicates hello.py with Hello, World was created.",
      "Fail if timed_out is true, bot_completed is false, or output contradicts task completion.",
      "Focus on evidence fields: bot_response and file_changes.",
    ].join("\n"),
  },
  {
    id: "typescript-bun-hello",
    title: "Create a TypeScript/Bun hello world",
    trigger: "mention",
    completionMode: "terminal",
    task: "Create a file called hello.ts that uses console.log to print 'Hello from Bun!'. Only create the file, nothing else.",
    rubric: [
      "Pass if the JSON evidence shows the run completed and output indicates hello.ts with Hello from Bun was created.",
      "Fail if timed_out is true, bot_completed is false, or output contradicts task completion.",
      "Focus on evidence fields: bot_response and file_changes.",
    ].join("\n"),
  },
  {
    id: "mention-bootstrap-status-only",
    title: "Issue mention bootstrap status",
    trigger: "mention",
    completionMode: "started",
    task: "Acknowledge this issue and start working. Post a Codex run status update. Do not modify files.",
    rubric: [
      "Pass if the JSON evidence shows the mention trigger started a Codex run status comment.",
      "Fail if timed_out is true or bot_started is false.",
      "This case validates mention bootstrap behavior, not final task output quality.",
    ].join("\n"),
  },
  {
    id: "direct-assignment-no-mention",
    title: "Direct assignment trigger without mention",
    trigger: "assignment",
    completionMode: "started",
    task: "You are assigned directly. Start working this issue and post run status.",
    rubric: [
      "Pass if assignment_attempted is true and bot_started is true.",
      "Pass if trigger_mode is direct-assignment and first_bot_comment indicates Codex run started.",
      "Fail if bot_started is false, timed_out is true, or assignment_attempted is false.",
      "This case validates bootstrap start behavior, not full task completion.",
    ].join("\n"),
  },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: "dzianisv/codebridge-test",
    repoPath: undefined,
    appHandle: "@codexengineer",
    timeoutSec: 180,
    pollSec: 10,
    keepArtifacts: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      args.repo = next;
      i += 1;
    } else if (arg === "--repo-path" && next) {
      args.repoPath = next;
      i += 1;
    } else if (arg === "--app-handle" && next) {
      args.appHandle = next.startsWith("@") ? next : `@${next}`;
      i += 1;
    } else if (arg === "--assignment-handle" && next) {
      args.assignmentHandle = next.startsWith("@") ? next : `@${next}`;
      i += 1;
    } else if (arg === "--timeout" && next) {
      args.timeoutSec = Number(next);
      i += 1;
    } else if (arg === "--poll" && next) {
      args.pollSec = Number(next);
      i += 1;
    } else if (arg === "--keep") {
      args.keepArtifacts = true;
    }
  }

  return args;
}

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

type AssignableActor = {
  login: string;
  id: string;
  type: "User" | "Bot";
};

type IssueAssignee = {
  login: string;
  nodeId: string;
};

function buildAssigneeCandidates(handle: string): string[] {
  const raw = handle.trim().replace(/^@/, "");
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const variants = raw.match(/\[bot\]$/i)
    ? [raw, raw.replace(/\[bot\]$/i, ""), lower, lower.replace(/\[bot\]$/i, "")]
    : [raw, `${raw}[bot]`, lower, `${lower}[bot]`];
  return [...new Set(variants.filter(Boolean))];
}

function parseRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name: ${repoFullName}`);
  }
  return { owner, repo };
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

function resolveUserNodeId(login: string): string | null {
  const response = safeGh(["api", `users/${encodeURIComponent(login)}`]);
  if (!response.ok || !response.stdout) return null;
  try {
    const parsed = JSON.parse(response.stdout) as { node_id?: string };
    return parsed.node_id?.trim() || null;
  } catch {
    return null;
  }
}

function resolveAssignmentActor(repoFullName: string, assignmentHandle: string): {
  actor: AssignableActor | null;
  reason: string;
  candidates: string[];
  actors: AssignableActor[];
} {
  const actors = listAssignableActors(repoFullName);
  const byLogin = new Map(actors.map((actor) => [actor.login.toLowerCase(), actor]));
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const candidates = buildAssigneeCandidates(assignmentHandle);

  for (const candidate of candidates) {
    const direct = byLogin.get(candidate.toLowerCase());
    if (direct) {
      return {
        actor: direct,
        reason: `matched assignable actor login "${direct.login}"`,
        candidates,
        actors,
      };
    }
  }

  for (const candidate of candidates) {
    const nodeId = resolveUserNodeId(candidate);
    if (!nodeId) continue;
    const mapped = byId.get(nodeId);
    if (mapped) {
      return {
        actor: mapped,
        reason: `candidate "${candidate}" resolved to assignable actor id ${nodeId}`,
        candidates,
        actors,
      };
    }
  }

  return {
    actor: null,
    reason: "no assignable actor matched assignment handle",
    candidates,
    actors,
  };
}

function readIssueAssignmentState(repoFullName: string, issueNumber: number): { issueNodeId: string; assignees: IssueAssignee[] } {
  const raw = gh(["api", `repos/${repoFullName}/issues/${issueNumber}`]);
  const parsed = JSON.parse(raw) as {
    node_id?: string;
    assignees?: Array<{ login?: string; node_id?: string }>;
  };
  const assignees: IssueAssignee[] = (parsed.assignees ?? [])
    .map((entry) => ({
      login: (entry.login ?? "").trim(),
      nodeId: (entry.node_id ?? "").trim(),
    }))
    .filter((entry) => entry.login && entry.nodeId);
  return {
    issueNodeId: (parsed.node_id ?? "").trim(),
    assignees,
  };
}

function assignIssueToActor(input: { issueNodeId: string; actorId: string }): { ok: boolean; error?: string } {
  const result = safeGh([
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
  if (!result.ok) {
    return { ok: false, error: result.stderr || result.stdout || "unknown gh graphql error" };
  }
  return { ok: true };
}

function cleanRepo(repoPath: string | undefined): void {
  if (!repoPath) return;
  const reset = spawnSync("git", ["-C", repoPath, "reset", "--hard", "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if ((reset.status ?? 1) !== 0) {
    throw new Error(`Failed git reset in ${repoPath}: ${(reset.stderr || reset.stdout).trim()}`);
  }

  const clean = spawnSync("git", ["-C", repoPath, "clean", "-fd"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if ((clean.status ?? 1) !== 0) {
    throw new Error(`Failed git clean in ${repoPath}: ${(clean.stderr || clean.stdout).trim()}`);
  }
}

function createIssue(repo: string, title: string, body: string): IssueRef {
  const raw = gh([
    "api",
    "-X",
    "POST",
    `repos/${repo}/issues`,
    "-f",
    `title=${title}`,
    "-f",
    `body=${body}`,
  ]);
  const parsed = JSON.parse(raw) as { number?: number; html_url?: string; node_id?: string };
  const number = Number(parsed.number);
  const url = parsed.html_url ?? "";
  const nodeId = parsed.node_id?.trim() ?? "";
  if (!number || !url || !nodeId) throw new Error(`Invalid issue create response: ${raw}`);
  return { number, url, nodeId };
}

function postIssueComment(repo: string, issueNumber: number, body: string): void {
  gh([
    "api",
    "-X",
    "POST",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "-f",
    `body=${body}`,
  ]);
}

function tryAssignment(input: {
  repo: string;
  issueNodeId: string;
  issueNumber: number;
  assignmentHandle: string;
}): AssignmentResult {
  const attemptedLogins = buildAssigneeCandidates(input.assignmentHandle);
  const apiCallErrors: string[] = [];
  const actorProbe = resolveAssignmentActor(input.repo, input.assignmentHandle);
  if (!actorProbe.actor) {
    const assignableLogins = actorProbe.actors.map((actor) => `${actor.login}(${actor.type})`).join(", ") || "(none)";
    return {
      attemptedLogins,
      assigneesAfter: [],
      apiCallErrors: [
        `Native assignment unavailable for ${input.assignmentHandle}: candidates=${actorProbe.candidates.join(", ") || "(none)"} assignableActors=${assignableLogins}`,
      ],
      assignmentAccepted: false,
      triggerMode: "assignment-not-assignable",
      assignableActors: actorProbe.actors,
      matchedReason: actorProbe.reason,
    };
  }

  const assignment = assignIssueToActor({
    issueNodeId: input.issueNodeId,
    actorId: actorProbe.actor.id,
  });
  if (!assignment.ok) {
    apiCallErrors.push(`Native assignment mutation failed: ${assignment.error ?? "unknown error"}`);
  }

  const state = readIssueAssignmentState(input.repo, input.issueNumber);
  const assigneesAfter = state.assignees.map((entry) => entry.login.toLowerCase());
  const assignmentAccepted = state.assignees.some((entry) => entry.nodeId === actorProbe.actor?.id);
  if (!assignmentAccepted) {
    const byNode = state.assignees.map((entry) => `${entry.login}(${entry.nodeId})`).join(", ") || "(none)";
    apiCallErrors.push(
      `Assignment actor ${actorProbe.actor.login}(${actorProbe.actor.id}) was not applied; assigneesAfter=${byNode}; matchedBy=${actorProbe.reason}`,
    );
  }

  return {
    attemptedLogins,
    assigneesAfter,
    apiCallErrors,
    assignmentAccepted,
    triggerMode: assignmentAccepted ? "direct-assignment" : "assignment-not-effective",
    assignableActors: actorProbe.actors,
    matchedActorLogin: actorProbe.actor.login,
    matchedActorId: actorProbe.actor.id,
    matchedReason: actorProbe.reason,
  };
}

function shouldCollectCodexEvidence(assignmentHandle: string): boolean {
  return buildAssigneeCandidates(assignmentHandle).some((candidate) => candidate.toLowerCase().includes("codexengineer"));
}

function isTerminalBotComment(body: string): boolean {
  const firstLine = body.split("\n")[0]?.trim().toLowerCase() ?? "";
  if (/^codex run\s+\S+\s+complete$/.test(firstLine)) return true;
  const statusMatch = body.match(/^\s*status:\s*([a-z-]+)/im);
  if (!statusMatch) return false;
  const status = statusMatch[1].toLowerCase();
  return status === "completed" || status === "failed" || status === "succeeded";
}

async function waitForBot(input: {
  repo: string;
  issueNumber: number;
  botLogins: string[];
  mode: CompletionMode;
  timeoutSec: number;
  pollSec: number;
}): Promise<{ started: boolean; completed: boolean; timedOut: boolean; first: string; combined: string }> {
  const deadline = Date.now() + input.timeoutSec * 1000;
  const botSet = new Set(input.botLogins.map((value) => value.toLowerCase()));

  while (Date.now() < deadline) {
    const raw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`]);
    const all = JSON.parse(raw) as BotComment[];
    const botComments = all.filter((comment) => botSet.has((comment.user?.login ?? "").toLowerCase()));

    const started = botComments.length > 0;
    const completed = botComments.some((comment) => isTerminalBotComment(comment.body ?? ""));

    if ((input.mode === "started" && started) || (input.mode === "terminal" && completed)) {
      return {
        started,
        completed,
        timedOut: false,
        first: botComments[0]?.body ?? "",
        combined: botComments.map((entry) => entry.body).join("\n\n---\n\n"),
      };
    }

    await sleep(input.pollSec * 1000);
  }

  const raw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`]);
  const all = JSON.parse(raw) as BotComment[];
  const botComments = all.filter((comment) => botSet.has((comment.user?.login ?? "").toLowerCase()));
  const started = botComments.length > 0;
  const completed = botComments.some((comment) => isTerminalBotComment(comment.body ?? ""));
  const doneAtDeadline = input.mode === "started" ? started : completed;
  return {
    started,
    completed,
    timedOut: !doneAtDeadline,
    first: botComments[0]?.body ?? "",
    combined: started ? botComments.map((entry) => entry.body).join("\n\n---\n\n") : "(no reply within timeout)",
  };
}

function getPrDiff(repo: string, issueNumber: number): string | null {
  try {
    const raw = gh(["api", `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`]);
    const events = JSON.parse(raw) as Array<{ source?: { issue?: { number?: number; pull_request?: { html_url?: string } } } }>;
    const prEvent = events.find((event) => event.source?.issue?.pull_request?.html_url);
    if (!prEvent?.source?.issue?.number) return null;
    return gh(["pr", "diff", String(prEvent.source.issue.number), "--repo", repo]);
  } catch {
    return null;
  }
}

function parsePromptfooCounts(payload: any): { passed: number; failed: number; errors: number } {
  const stats = payload?.results?.stats ?? payload?.stats;
  if (stats) {
    return {
      passed: Number(stats.successes ?? stats.passed ?? 0),
      failed: Number(stats.failures ?? stats.failed ?? 0),
      errors: Number(stats.errors ?? 0),
    };
  }
  return { passed: 0, failed: 1, errors: 1 };
}

function buildEvalTests(results: CaseCollected[]) {
  return results.map((entry) => {
    const outputJson = JSON.stringify(entry);
    const assertions: any[] = [
      {
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return obj.timedOut === false;",
        ].join("\n"),
      },
    ];

    if (entry.trigger === "mention" && entry.completionMode === "terminal") {
      assertions.push({
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return obj.botCompleted === true;",
        ].join("\n"),
      });
    } else if (entry.trigger === "mention") {
      assertions.push({
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return obj.botStarted === true;",
        ].join("\n"),
      });
    } else {
      assertions.push({
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          [
            "return obj.assignmentAttempted === true",
            "&& obj.assignmentAccepted === true",
            "&& obj.triggerMode === \"direct-assignment\"",
            "&& obj.botStarted === true;",
          ].join(" "),
        ].join("\n"),
      });
    }

    if (entry.completionMode === "terminal") {
      assertions.push({
        type: "llm-rubric",
        value: entry.rubric,
      });
    }

    return {
      description: entry.caseId,
      vars: { output_json: outputJson },
      assert: assertions,
    };
  });
}

function normalizeAzureBaseUrl(raw: string | undefined): string {
  if (!raw) return "https://vibebrowser-dev.openai.azure.com";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/openai\/.*$/i, "").replace(/\/$/, "");
  }
}

function resolveAzureJudgeConfig(): { apiBaseUrl: string; apiHost: string } {
  const apiBaseUrl = normalizeAzureBaseUrl(process.env.AZURE_OPENAI_BASE_URL?.trim());
  try {
    return { apiBaseUrl, apiHost: new URL(apiBaseUrl).host };
  } catch {
    return { apiBaseUrl, apiHost: "vibebrowser-dev.openai.azure.com" };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preferredAssignment = await resolvePreferredAssignmentHandle({
    repo: args.repo,
    appHandle: args.appHandle,
    explicitAssignmentHandle: args.assignmentHandle,
    isAssignable: async (handle) => resolveAssignmentActor(args.repo, handle).actor !== null
  });
  const assignmentHandle = preferredAssignment.handle;
  const azureJudge = resolveAzureJudgeConfig();
  console.log(`[hard-eval] start repo=${args.repo} app=${args.appHandle} timeout=${args.timeoutSec}s poll=${args.pollSec}s`);
  console.log(`[hard-eval] assignment handle=${assignmentHandle} (${preferredAssignment.reason})`);

  const appLogin = args.appHandle.replace(/^@/, "").toLowerCase();
  const botLogins = [appLogin, appLogin.endsWith("[bot]") ? appLogin : `${appLogin}[bot]`];

  const reportsDir = path.join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const collected: CaseCollected[] = [];

  for (const evalCase of EVAL_CASES) {
    cleanRepo(args.repoPath);

    const issue = createIssue(
      args.repo,
      `[eval] ${evalCase.title} (${Date.now()})`,
      `Automated eval case: ${evalCase.id}\n\nTask:\n${evalCase.task}`,
    );

    let assignment: AssignmentResult = {
      attemptedLogins: [],
      assigneesAfter: [],
      apiCallErrors: [],
      assignmentAccepted: false,
      triggerMode: "mention-comment",
      assignableActors: [],
    };

    if (evalCase.trigger === "mention") {
      postIssueComment(args.repo, issue.number, `${args.appHandle} run ${evalCase.task}`);
    } else {
      assignment = tryAssignment({
        repo: args.repo,
        issueNodeId: issue.nodeId,
        issueNumber: issue.number,
        assignmentHandle,
      });
    }

    const bot = await waitForBot({
      repo: args.repo,
      issueNumber: issue.number,
      botLogins,
      mode: evalCase.completionMode,
      timeoutSec: args.timeoutSec,
      pollSec: args.pollSec,
    });

    collected.push({
      caseId: evalCase.id,
      title: evalCase.title,
      trigger: evalCase.trigger,
      completionMode: evalCase.completionMode,
      issueNumber: issue.number,
      issueUrl: issue.url,
      task: evalCase.task,
      assignmentAttempted: evalCase.trigger === "assignment",
      attemptedAssigneeLogins: assignment.attemptedLogins,
      assigneesAfterAssignment: assignment.assigneesAfter,
      assignmentAccepted: assignment.assignmentAccepted,
      triggerMode: assignment.triggerMode,
      assignmentHandle,
      assignableActors: assignment.assignableActors,
      matchedAssignmentActorLogin: assignment.matchedActorLogin,
      matchedAssignmentActorId: assignment.matchedActorId,
      matchedAssignmentReason: assignment.matchedReason,
      botStarted: bot.started,
      botCompleted: bot.completed,
      timedOut: bot.timedOut,
      firstBotComment: bot.first,
      botResponse: bot.combined,
      fileChanges: getPrDiff(args.repo, issue.number),
      notes: assignment.apiCallErrors,
      rubric: evalCase.rubric,
    });

    cleanRepo(args.repoPath);
  }

  const tests = buildEvalTests(collected);
  const promptfooConfig = {
    description: `CodeBridge hard eval ${new Date().toISOString()}`,
    providers: ["echo"],
    prompts: ["{{output_json}}"],
    tests,
    defaultTest: {
      options: {
        provider: {
          id: "azure:chat:gpt-4.1",
          config: {
            apiBaseUrl: azureJudge.apiBaseUrl,
            apiHost: azureJudge.apiHost,
            apiVersion: "2024-10-01-preview",
          },
        },
      },
    },
  };

  const configPath = path.join(reportsDir, `eval-config-${stamp}.json`);
  const rawPath = path.join(reportsDir, `eval-raw-${stamp}.json`);
  const outputPath = path.join(reportsDir, `eval-output-${stamp}.json`);
  writeFileSync(configPath, JSON.stringify(promptfooConfig, null, 2));
  writeFileSync(
    rawPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        repo: args.repo,
        appHandle: args.appHandle,
        assignmentHandle,
        results: collected,
      },
      null,
      2,
    ),
  );

  if (shouldCollectCodexEvidence(assignmentHandle)) {
    const assignmentCase = collected.find((entry) => entry.caseId === "direct-assignment-no-mention");
    if (assignmentCase && assignmentCase.triggerMode !== "direct-assignment") {
      const evidencePath = path.join(reportsDir, `codexengineer-assignment-evidence-${stamp}.json`);
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            repo: args.repo,
            appHandle: args.appHandle,
            assignmentHandle,
            caseId: assignmentCase.caseId,
            issueNumber: assignmentCase.issueNumber,
            issueUrl: assignmentCase.issueUrl,
            triggerMode: assignmentCase.triggerMode,
            assignmentAccepted: assignmentCase.assignmentAccepted,
            attemptedAssigneeLogins: assignmentCase.attemptedAssigneeLogins,
            assigneesAfterAssignment: assignmentCase.assigneesAfterAssignment,
            assignableActors: assignmentCase.assignableActors,
            matchedAssignmentActorLogin: assignmentCase.matchedAssignmentActorLogin,
            matchedAssignmentActorId: assignmentCase.matchedAssignmentActorId,
            matchedAssignmentReason: assignmentCase.matchedAssignmentReason,
            notes: assignmentCase.notes,
            guidance: "Strict @codexengineer acceptance remains blocked until codexengineer appears in suggestedActors(CAN_BE_ASSIGNED) and direct assignment succeeds.",
          },
          null,
          2,
        ),
      );
      console.log(`codexengineer assignment evidence: ${evidencePath}`);
    }
  }

  const localPromptfoo = path.join(process.cwd(), "node_modules", ".bin", "promptfoo");
  const hasLocalPromptfoo = existsSync(localPromptfoo);
  const cmd = hasLocalPromptfoo ? localPromptfoo : "npx";
  const cmdArgs = hasLocalPromptfoo
    ? ["eval", "-c", configPath, "-o", outputPath, "--no-cache"]
    : ["promptfoo@latest", "eval", "-c", configPath, "-o", outputPath, "--no-cache"];

  const promptfooRun = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    encoding: "utf-8",
  });

  const outputRaw = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : "{}";
  const parsed = JSON.parse(outputRaw);
  const counts = parsePromptfooCounts(parsed);

  console.log(`Promptfoo summary: ${counts.passed} passed, ${counts.failed} failed, ${counts.errors} errors`);
  console.log(`promptfoo config: ${configPath}`);
  console.log(`promptfoo output: ${outputPath}`);
  console.log(`raw results: ${rawPath}`);
  for (const entry of collected) {
    console.log(`- ${entry.caseId}: trigger=${entry.trigger} mode=${entry.triggerMode} started=${entry.botStarted} completed=${entry.botCompleted} issue=${entry.issueUrl}`);
  }

  if (!args.keepArtifacts) {
    for (const entry of collected) {
      try {
        gh(["issue", "close", String(entry.issueNumber), "--repo", args.repo]);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  const nonZero = (promptfooRun.status ?? 1) !== 0;
  if (nonZero || counts.failed > 0 || counts.errors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
