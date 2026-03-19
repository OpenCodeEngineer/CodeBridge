#!/usr/bin/env tsx

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { Pool } from "pg"
import {
  botLoginMatchesExpected,
  issueLinkMentioned,
  normalizeBotLogins,
  textMentionsUrl,
  textStartsWithHandle,
  verifyKnowledgeResponse,
  type KnowledgeVerification
} from "./eval-customer-flow-lib.js"
import {
  resolveExpectedBotLogin,
  resolveExpectedHandle,
  resolveRequiredEvalGithubAppsFromEnv
} from "./live-eval-github-apps.js"

type AgentBackend = "codex" | "opencode"

type Args = {
  repo: string
  workspaceRoot?: string
  databaseUrl?: string
  only: "all" | "codex" | "opencode"
  codexHandle?: string
  codexBotLogin?: string
  codexAppKey: string
  opencodeHandle?: string
  opencodeBotLogin?: string
  opencodeAppKey: string
  timeoutSec: number
  pollSec: number
  keepArtifacts: boolean
}

type MissionCaseDefinition = {
  id: string
  title: string
  appHandle: string
  appKey: string
  expectedBotLogin: string
  botLogins: string[]
  expectedBackend: AgentBackend
  issueBody: string
  buildTask: (issueNumber: number) => string
  verificationKind: "knowledge" | "bun-pr"
  rubric: string
}

type IssueRef = {
  number: number
  url: string
}

type IssueCommentRef = {
  id: number
  url: string
  body: string
}

type BotComment = {
  id: number
  body: string
  created_at: string
  user?: { login?: string }
}

type LinkedPr = {
  number: number
  url: string
}

type DbRunEvidence = {
  id: string
  status: string
  backend: string
  githubAppKey?: string
  repoPath?: string
  prUrl?: string
  branchName?: string
  createdAt: string
  updatedAt: string
}

type WorkspaceVerification = {
  workspaceRoot: string
  expectedBaseClonePath: string
  repoPath: string
  repoPathWithinWorkspace: boolean
  repoPathUsesWorktreeLayout: boolean
  repoPathEqualsBaseClone: boolean
}

type PrDetails = {
  number: number
  url: string
  title: string
  body: string
  authorLogin?: string
  headRefName?: string
}

type PrVerification = {
  expectedDirectory: string
  expectedFiles: string[]
  presentFiles: string[]
  hasExpectedFiles: boolean
  helloFileHasExpectedString: boolean
  prBodyLinksIssue: boolean
  prAuthorLogin?: string
  testCommand: string
  testExitCode: number
  testStdout: string
  testStderr: string
  runCommand: string
  runExitCode: number
  runStdout: string
  runStderr: string
  runOutputMatches: boolean
}

type CaseCollected = {
  caseId: string
  title: string
  issueUrl: string
  issueNumber: number
  appHandle: string
  triggerCommentUrl: string
  triggerCommentUsesExpectedHandle: boolean
  expectedBackend: AgentBackend
  expectedAppKey: string
  expectedBotLogin: string
  expectedBotLogins: string[]
  task: string
  timedOut: boolean
  botStarted: boolean
  botCompleted: boolean
  botCommentUrls: string[]
  botCommentAuthorLogins: string[]
  botCommentAuthorsMatchExpected: boolean
  latestBotCommentUrl?: string
  botResponse: string
  labels: string[]
  linkedPrUrl?: string
  linkedPrNumber?: number
  linkedPrTitle?: string
  linkedPrAuthorLogin?: string
  linkedPrAuthorMatchesExpectedBot?: boolean
  linkedPrBody?: string
  dbRun?: DbRunEvidence | null
  workspaceVerification?: WorkspaceVerification
  knowledgeVerification?: KnowledgeVerification
  prVerification?: PrVerification
  botResponseMentionsPr: boolean
  rubric: string
}

type CommandResult = {
  command: string
  exitCode: number
  stdout: string
  stderr: string
}

const RUN_COMMENT_RE = /\b(?:codex|opencode)\s+run\b/i

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: "dzianisv/codebridge-test",
    workspaceRoot: undefined,
    databaseUrl: undefined,
    only: "all",
    codexHandle: undefined,
    codexBotLogin: undefined,
    codexAppKey: "codex",
    opencodeHandle: undefined,
    opencodeBotLogin: undefined,
    opencodeAppKey: "opencode",
    timeoutSec: 300,
    pollSec: 10,
    keepArtifacts: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--repo" && next) {
      args.repo = next
      index += 1
    } else if (arg === "--workspace-root" && next) {
      args.workspaceRoot = next
      index += 1
    } else if (arg === "--database-url" && next) {
      args.databaseUrl = next
      index += 1
    } else if (arg === "--only" && next) {
      args.only = next === "codex" || next === "opencode" ? next : "all"
      index += 1
    } else if (arg === "--codex-handle" && next) {
      args.codexHandle = normalizeHandle(next)
      index += 1
    } else if (arg === "--codex-bot-login" && next) {
      args.codexBotLogin = next
      index += 1
    } else if (arg === "--codex-app-key" && next) {
      args.codexAppKey = next
      index += 1
    } else if (arg === "--opencode-handle" && next) {
      args.opencodeHandle = normalizeHandle(next)
      index += 1
    } else if (arg === "--opencode-bot-login" && next) {
      args.opencodeBotLogin = next
      index += 1
    } else if (arg === "--opencode-app-key" && next) {
      args.opencodeAppKey = next
      index += 1
    } else if (arg === "--timeout" && next) {
      args.timeoutSec = Number(next)
      index += 1
    } else if (arg === "--poll" && next) {
      args.pollSec = Number(next)
      index += 1
    } else if (arg === "--keep") {
      args.keepArtifacts = true
    }
  }

  return args
}

function buildGhEnv() {
  const env = { ...process.env }
  if (env.GH_TOKEN?.trim()) return env
  delete env.GITHUB_TOKEN
  return env
}

function gh(args: string[]): string {
  const result = spawnSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildGhEnv(),
    encoding: "utf-8"
  })
  if (result.error) {
    throw new Error(`gh ${args.join(" ")} failed to start: ${result.error.message}`)
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return (result.stdout || "").trim()
}

function runCommand(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  })
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? (result.error ? -1 : 0),
    stdout: (result.stdout || "").trim(),
    stderr: [result.error?.message, result.stderr || ""].filter(Boolean).join("\n").trim()
  }
}

function normalizeHandle(value: string): string {
  return value.startsWith("@") ? value : `@${value}`
}

function cleanWorkspaceRoot(workspaceRoot: string | undefined): void {
  if (!workspaceRoot) return
  rmSync(workspaceRoot, { recursive: true, force: true })
  mkdirSync(workspaceRoot, { recursive: true })
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
    `body=${body}`
  ])
  const parsed = JSON.parse(raw) as { number?: number; html_url?: string }
  const number = Number(parsed.number)
  const url = parsed.html_url ?? ""
  if (!number || !url) {
    throw new Error(`Invalid issue create response: ${raw}`)
  }
  return { number, url }
}

function postIssueComment(repo: string, issueNumber: number, body: string): IssueCommentRef {
  const result = spawnSync(
    "gh",
    ["api", "-X", "POST", `repos/${repo}/issues/${issueNumber}/comments`, "--input", "-"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildGhEnv(),
      input: JSON.stringify({ body }),
      encoding: "utf-8"
    }
  )
  if (result.error) {
    throw new Error(`gh issue comment failed to start: ${result.error.message}`)
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`gh issue comment failed: ${(result.stderr || result.stdout).trim()}`)
  }
  const parsed = JSON.parse((result.stdout || "").trim()) as { id?: number; html_url?: string }
  const id = Number(parsed.id)
  const url = parsed.html_url ?? `https://github.com/${repo}/issues/${issueNumber}`
  const commentBody = typeof (parsed as { body?: string }).body === "string"
    ? (parsed as { body?: string }).body ?? ""
    : ""
  if (!id) {
    throw new Error(`gh issue comment returned invalid response: ${(result.stdout || "").trim()}`)
  }
  return { id, url, body: commentBody }
}

function listIssueComments(repo: string, issueNumber: number): BotComment[] {
  const raw = gh(["api", `repos/${repo}/issues/${issueNumber}/comments?per_page=100`])
  return JSON.parse(raw) as BotComment[]
}

function getIssueLabels(repo: string, issueNumber: number): string[] {
  try {
    const raw = gh(["api", `repos/${repo}/issues/${issueNumber}`])
    const issue = JSON.parse(raw) as { labels?: Array<{ name?: string }> }
    return (issue.labels ?? []).map(label => label.name ?? "").filter(Boolean)
  } catch {
    return []
  }
}

function isAgentRunComment(body: string): boolean {
  return RUN_COMMENT_RE.test(body)
}

function isTerminalBotComment(body: string): boolean {
  const firstLine = body.split("\n")[0]?.trim().toLowerCase() ?? ""
  if (/^(?:codex|opencode) run\s+\S+\s+complete$/.test(firstLine)) return true
  const statusMatch = body.match(/^\s*status:\s*([a-z-]+)/im)
  if (!statusMatch) return false
  const status = statusMatch[1].toLowerCase()
  return status === "succeeded" || status === "failed" || status === "completed"
}

async function sleep(ms: number) {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForBot(input: {
  repo: string
  issueNumber: number
  botLogins: string[]
  timeoutSec: number
  pollSec: number
  nudgeAfterSec?: number
  onNoReplyNudge?: () => void
}): Promise<{
  started: boolean
  completed: boolean
  timedOut: boolean
  comments: BotComment[]
  combined: string
}> {
  const deadline = Date.now() + input.timeoutSec * 1000
  const startedAt = Date.now()
  const botSet = new Set(input.botLogins.map(value => value.toLowerCase()))
  const nudgeAfterMs = (input.nudgeAfterSec ?? 60) * 1000
  let nudged = false

  while (Date.now() < deadline) {
    const botComments = listIssueComments(input.repo, input.issueNumber).filter(comment => {
      return botSet.has((comment.user?.login ?? "").toLowerCase())
    })
    const started = botComments.some(comment => isAgentRunComment(comment.body))
    const completed = botComments.some(comment => isTerminalBotComment(comment.body))
    if (completed) {
      return {
        started,
        completed,
        timedOut: false,
        comments: botComments,
        combined: botComments.map(entry => entry.body).join("\n\n---\n\n")
      }
    }
    if (!nudged && botComments.length === 0 && Date.now() - startedAt >= nudgeAfterMs && input.onNoReplyNudge) {
      input.onNoReplyNudge()
      nudged = true
    }
    await sleep(input.pollSec * 1000)
  }

  const botComments = listIssueComments(input.repo, input.issueNumber).filter(comment => {
    return botSet.has((comment.user?.login ?? "").toLowerCase())
  })
  const started = botComments.some(comment => isAgentRunComment(comment.body))
  const completed = botComments.some(comment => isTerminalBotComment(comment.body))
  return {
    started,
    completed,
    timedOut: !completed,
    comments: botComments,
    combined: botComments.length > 0 ? botComments.map(entry => entry.body).join("\n\n---\n\n") : "(no reply within timeout)"
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parsePrUrlFromText(text: string, repo: string): string | null {
  const regex = new RegExp(`https://github\\.com/${escapeRegExp(repo)}/pull/\\d+`, "i")
  return text.match(regex)?.[0] ?? null
}

function parseIssueOrPrNumber(url: string | undefined): number | undefined {
  if (!url) return undefined
  const match = url.match(/\/(?:issues|pull)\/(\d+)(?:$|[?#])/)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

function getLinkedPr(repo: string, issueNumber: number, fallbackText: string, dbPrUrl?: string): LinkedPr | null {
  const candidateUrls: string[] = []
  if (dbPrUrl?.trim()) candidateUrls.push(dbPrUrl.trim())
  try {
    const raw = gh(["api", `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`])
    const events = JSON.parse(raw) as Array<{ source?: { issue?: { pull_request?: { html_url?: string } } } }>
    for (const event of events) {
      const url = event.source?.issue?.pull_request?.html_url?.trim()
      if (url) candidateUrls.push(url)
    }
  } catch {
    // ignore timeline gaps
  }
  const fallbackUrl = parsePrUrlFromText(fallbackText, repo)
  if (fallbackUrl) candidateUrls.push(fallbackUrl)

  const url = candidateUrls.find(Boolean)
  const number = parseIssueOrPrNumber(url)
  if (!url || !number) return null
  return { number, url }
}

function getPrDetails(repo: string, prNumber: number): PrDetails {
  const raw = gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "author,body,headRefName,title,url,number"
  ])
  const parsed = JSON.parse(raw) as {
    number: number
    url: string
    title?: string
    body?: string
    headRefName?: string
    author?: { login?: string }
  }
  return {
    number: parsed.number,
    url: parsed.url,
    title: parsed.title ?? "",
    body: parsed.body ?? "",
    headRefName: parsed.headRefName ?? undefined,
    authorLogin: parsed.author?.login ?? undefined
  }
}

function isSqliteUrl(databaseUrl: string): boolean {
  const normalized = databaseUrl.toLowerCase()
  return normalized.startsWith("sqlite:") || normalized.endsWith(".db") || normalized === ":memory:"
}

function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:") return databaseUrl
  if (databaseUrl.startsWith("sqlite://")) {
    return databaseUrl.slice("sqlite://".length)
  }
  if (databaseUrl.startsWith("sqlite:")) {
    return databaseUrl.slice("sqlite:".length) || ":memory:"
  }
  return databaseUrl
}

async function readLatestRun(
  databaseUrl: string,
  repo: string,
  issueNumber: number,
  triggerCommentIds?: number[]
): Promise<DbRunEvidence | null> {
  const activeTriggerIds = (triggerCommentIds ?? []).filter(value => Number.isFinite(value) && value > 0)
  if (isSqliteUrl(databaseUrl)) {
    const db = new Database(resolveSqlitePath(databaseUrl), { readonly: true })
    try {
      const clause = activeTriggerIds.length > 0
        ? ` AND github_trigger_comment_id IN (${activeTriggerIds.map(() => "?").join(",")})`
        : ""
      const row = db.prepare(
        `SELECT id, status, backend, github_app_key, repo_path, pr_url, branch_name, created_at, updated_at
         FROM runs
         WHERE repo_full_name = ? AND github_issue_number = ?${clause}
         ORDER BY datetime(created_at) DESC
         LIMIT 1`
      ).get(repo, issueNumber, ...activeTriggerIds) as
        | {
            id: string
            status: string
            backend: string
            github_app_key?: string
            repo_path?: string
            pr_url?: string
            branch_name?: string
            created_at: string
            updated_at: string
          }
        | undefined
      if (!row) return null
      return {
        id: row.id,
        status: row.status,
        backend: row.backend,
        githubAppKey: row.github_app_key ?? undefined,
        repoPath: row.repo_path ?? undefined,
        prUrl: row.pr_url ?? undefined,
        branchName: row.branch_name ?? undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      }
    } finally {
      db.close()
    }
  }

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const extraParams = activeTriggerIds
    const triggerClause = extraParams.length > 0
      ? ` AND github_trigger_comment_id = ANY($3)`
      : ""
    const result = await pool.query(
      `SELECT id, status, backend, github_app_key, repo_path, pr_url, branch_name, created_at, updated_at
       FROM runs
       WHERE repo_full_name = $1 AND github_issue_number = $2${triggerClause}
       ORDER BY created_at DESC
       LIMIT 1`,
      extraParams.length > 0 ? [repo, issueNumber, extraParams] : [repo, issueNumber]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      backend: row.backend,
      githubAppKey: row.github_app_key ?? undefined,
      repoPath: row.repo_path ?? undefined,
      prUrl: row.pr_url ?? undefined,
      branchName: row.branch_name ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }
  } finally {
    await pool.end()
  }
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status === "failed" || status === "succeeded" || status === "no_changes"
}

async function waitForDbRun(input: {
  databaseUrl?: string
  repo: string
  issueNumber: number
  triggerCommentIds?: number[]
  timeoutSec: number
  pollSec: number
}): Promise<DbRunEvidence | null> {
  if (!input.databaseUrl) return null
  const deadline = Date.now() + input.timeoutSec * 1000
  while (Date.now() < deadline) {
    const run = await readLatestRun(input.databaseUrl, input.repo, input.issueNumber, input.triggerCommentIds)
    if (run && isTerminalRunStatus(run.status)) {
      return run
    }
    await sleep(input.pollSec * 1000)
  }
  return await readLatestRun(input.databaseUrl, input.repo, input.issueNumber, input.triggerCommentIds)
}

function verifyPrCase(input: {
  repo: string
  issueNumber: number
  pr: LinkedPr
  prDetails: PrDetails
}): PrVerification {
  const expectedDirectory = path.posix.join("customer-flow", `issue-${input.issueNumber}`)
  const expectedFiles = [
    path.posix.join(expectedDirectory, "package.json"),
    path.posix.join(expectedDirectory, "src", "hello.ts"),
    path.posix.join(expectedDirectory, "src", "main.ts"),
    path.posix.join(expectedDirectory, "src", "hello.test.ts")
  ]

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebridge-pr-eval-"))
  try {
    const clone = runCommand("git", ["clone", `https://github.com/${input.repo}.git`, tempDir])
    if (clone.exitCode !== 0) {
      return {
        expectedDirectory,
        expectedFiles,
        presentFiles: [],
        hasExpectedFiles: false,
        helloFileHasExpectedString: false,
        prBodyLinksIssue: issueLinkMentioned(input.prDetails.body, input.issueNumber),
        prAuthorLogin: input.prDetails.authorLogin,
        testCommand: "bun test",
        testExitCode: -1,
        testStdout: "",
        testStderr: clone.stderr || clone.stdout,
        runCommand: "bun run src/main.ts",
        runExitCode: -1,
        runStdout: "",
        runStderr: clone.stderr || clone.stdout,
        runOutputMatches: false
      }
    }

    const fetch = runCommand("git", ["-C", tempDir, "fetch", "origin", `pull/${input.pr.number}/head:pr-${input.pr.number}`])
    const checkout = runCommand("git", ["-C", tempDir, "checkout", `pr-${input.pr.number}`])
    const listFiles = runCommand("git", ["-C", tempDir, "ls-files"])
    const presentFiles = listFiles.stdout ? listFiles.stdout.split(/\r?\n/).filter(Boolean) : []
    const hasExpectedFiles = expectedFiles.every(file => presentFiles.includes(file))
    const helloFilePath = path.join(tempDir, expectedDirectory, "src", "hello.ts")
    const helloFileHasExpectedString = existsSync(helloFilePath)
      ? readFileSync(helloFilePath, "utf8").includes("Hello, world!")
      : false

    const cwd = path.join(tempDir, expectedDirectory)
    const testResult = fetch.exitCode === 0 && checkout.exitCode === 0
      ? runCommand("bun", ["test"], cwd)
      : {
          command: "bun test",
          exitCode: -1,
          stdout: "",
          stderr: [fetch.stderr || fetch.stdout, checkout.stderr || checkout.stdout].filter(Boolean).join("\n").trim()
        }
    const runResult = fetch.exitCode === 0 && checkout.exitCode === 0
      ? runCommand("bun", ["run", "src/main.ts"], cwd)
      : {
          command: "bun run src/main.ts",
          exitCode: -1,
          stdout: "",
          stderr: [fetch.stderr || fetch.stdout, checkout.stderr || checkout.stdout].filter(Boolean).join("\n").trim()
        }

    return {
      expectedDirectory,
      expectedFiles,
      presentFiles,
      hasExpectedFiles,
      helloFileHasExpectedString,
      prBodyLinksIssue: issueLinkMentioned(input.prDetails.body, input.issueNumber),
      prAuthorLogin: input.prDetails.authorLogin,
      testCommand: testResult.command,
      testExitCode: testResult.exitCode,
      testStdout: testResult.stdout,
      testStderr: testResult.stderr,
      runCommand: runResult.command,
      runExitCode: runResult.exitCode,
      runStdout: runResult.stdout,
      runStderr: runResult.stderr,
      runOutputMatches: runResult.stdout.trim() === "Hello, world!"
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function buildMissionCases(args: Args): MissionCaseDefinition[] {
  const cases: MissionCaseDefinition[] = [
    {
      id: "codex-knowledge-answer",
      title: "Codex issue flow answers the GPT-1 release question",
      appHandle: args.codexHandle,
      appKey: args.codexAppKey,
      expectedBotLogin: args.codexBotLogin ?? "",
      botLogins: normalizeBotLogins(args.codexBotLogin),
      expectedBackend: "codex",
      issueBody: [
        "Customer-flow acceptance test for the Codex route.",
        "",
        "Expected behavior:",
        "- mention-triggered GitHub issue flow",
        "- answer posted back on GitHub",
        "- no file changes or PR"
      ].join("\n"),
      buildTask: () => [
        "Research this question and reply on this GitHub issue only:",
        "When was the first GPT model released by OpenAI?",
        "",
        "Requirements:",
        "- Use Wikipedia or another authoritative public source.",
        "- State the year, and include the month if you can verify it.",
        "- Mention GPT-1 explicitly if relevant.",
        "- Do not change files.",
        "- Do not open a pull request."
      ].join("\n"),
      verificationKind: "knowledge",
      rubric: [
        "Pass only if the GitHub issue flow visibly answered the question on the issue thread itself.",
        "The correct answer is GPT-1 in 2018; June 2018 is stronger.",
        "Fail if the answer says GPT-2, GPT-3, ChatGPT, or any year other than 2018 as the first GPT model.",
        "Fail if the run opened a pull request or changed code for this knowledge-only task.",
        "Use the JSON evidence fields botResponse, knowledgeVerification, and dbRun."
      ].join("\n")
    },
    {
      id: "opencode-bun-pr",
      title: "OpenCode issue flow creates a Bun TypeScript PR",
      appHandle: args.opencodeHandle,
      appKey: args.opencodeAppKey,
      expectedBotLogin: args.opencodeBotLogin ?? "",
      botLogins: normalizeBotLogins(args.opencodeBotLogin),
      expectedBackend: "opencode",
      issueBody: [
        "Customer-flow acceptance test for the OpenCode route.",
        "",
        "Expected behavior:",
        "- mention-triggered GitHub issue flow",
        "- code changes made in the mapped local checkout",
        "- pull request created in dzianisv/codebridge-test",
        "- final PR link and test results reported back on GitHub"
      ].join("\n"),
      buildTask: (issueNumber: number) => {
        const workDir = `customer-flow/issue-${issueNumber}`
        return [
          `Create a zero-dependency Bun + TypeScript hello world under \`${workDir}/\`.`,
          "",
          "Requirements:",
          `- Only modify files under \`${workDir}/\`.`,
          `- Add \`${workDir}/package.json\` if needed.`,
          `- Add \`${workDir}/src/hello.ts\` exporting \`hello(): string\` that returns exactly \`Hello, world!\`.`,
          `- Add \`${workDir}/src/main.ts\` that prints the return value of \`hello()\`.`,
          `- Add \`${workDir}/src/hello.test.ts\` using Bun's built-in test runner to verify \`hello()\` returns exactly \`Hello, world!\`.`,
          `- Run \`bun test\` inside \`${workDir}\`.`,
          `- Run \`bun run src/main.ts\` inside \`${workDir}\`.`,
          "- Do not use gh, GitHub MCP/integrations/tools, the GitHub website, or any GitHub API/CLI from inside the task.",
          "- Do not open or update a pull request yourself, and do not run git push.",
          `- Leave the repository locally ready for CodeBridge to open a pull request that closes #${issueNumber}.`,
          "- Include the command results in your final response."
        ].join("\n")
      },
      verificationKind: "bun-pr",
      rubric: [
        "Pass only if the GitHub issue flow created a real PR and reported that PR back on the originating issue thread.",
        "The PR should contain a Bun-based TypeScript hello world in the requested issue-scoped directory.",
        "The verification evidence must show that bun test passed and bun run src/main.ts printed exactly Hello, world! on the PR branch.",
        "The PR body should link the issue with a closing keyword such as Closes #<issue>.",
        "Use the JSON evidence fields linkedPrUrl, prVerification, botResponse, and dbRun."
      ].join("\n")
    }
  ]

  if (args.only === "codex") {
    return cases.filter(entry => entry.expectedBackend === "codex")
  }
  if (args.only === "opencode") {
    return cases.filter(entry => entry.expectedBackend === "opencode")
  }
  return cases
}

async function resolveLiveEvalArgs(args: Args): Promise<Args> {
  const apps = await resolveRequiredEvalGithubAppsFromEnv()

  return {
    ...args,
    codexHandle: resolveExpectedHandle("codex", args.codexHandle, apps.codex.handle),
    codexBotLogin: resolveExpectedBotLogin("codex", args.codexBotLogin, apps.codex.botLogin),
    opencodeHandle: resolveExpectedHandle("opencode", args.opencodeHandle, apps.opencode.handle),
    opencodeBotLogin: resolveExpectedBotLogin("opencode", args.opencodeBotLogin, apps.opencode.botLogin)
  }
}

function buildEvalTests(results: CaseCollected[]) {
  return results.map(entry => {
    const assertions: any[] = [
      {
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return obj.triggerCommentUsesExpectedHandle === true;"
        ].join("\n")
      },
      {
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return obj.timedOut === false && obj.botCompleted === true;"
        ].join("\n")
      },
      {
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return Array.isArray(obj.botCommentAuthorLogins)",
          "&& obj.botCommentAuthorLogins.length > 0",
          "&& obj.botCommentAuthorsMatchExpected === true;"
        ].join("\n")
      },
      {
        type: "javascript",
        value: [
          "const obj = JSON.parse(output);",
          "return obj.dbRun && obj.dbRun.backend === obj.expectedBackend && obj.dbRun.githubAppKey === obj.expectedAppKey;"
        ].join("\n")
      }
    ]

    if (entry.caseId === "codex-knowledge-answer") {
      assertions.push(
        {
          type: "javascript",
          value: [
            "const obj = JSON.parse(output);",
            "return obj.dbRun && obj.dbRun.status === 'no_changes';"
          ].join("\n")
        },
        {
          type: "javascript",
          value: [
            "const obj = JSON.parse(output);",
            "return obj.knowledgeVerification",
            "&& obj.knowledgeVerification.answerHas2018 === true",
            "&& obj.knowledgeVerification.unexpectedPr === false;"
          ].join("\n")
        }
      )
    } else {
      assertions.push(
        {
          type: "javascript",
          value: [
            "const obj = JSON.parse(output);",
            "return obj.dbRun && obj.dbRun.status === 'succeeded' && !!obj.linkedPrUrl && obj.botResponseMentionsPr === true;"
          ].join("\n")
        },
        {
          type: "javascript",
          value: [
            "const obj = JSON.parse(output);",
            "return obj.prVerification",
            "&& obj.linkedPrAuthorMatchesExpectedBot === true",
            "&& obj.prVerification.hasExpectedFiles === true",
            "&& obj.prVerification.helloFileHasExpectedString === true",
            "&& obj.prVerification.prBodyLinksIssue === true",
            "&& obj.prVerification.testExitCode === 0",
            "&& obj.prVerification.runExitCode === 0",
            "&& obj.prVerification.runOutputMatches === true;"
          ].join("\n")
        }
      )
    }

    assertions.push({
      type: "llm-rubric",
      value: entry.rubric
    })

    return {
      description: entry.caseId,
      vars: {
        output_json: JSON.stringify(entry)
      },
      assert: assertions
    }
  })
}

function assertCollectedIdentityEvidence(results: CaseCollected[]) {
  const handleOwners = new Map<string, string>()
  const botOwners = new Map<string, string>()

  for (const entry of results) {
    const normalizedHandle = entry.appHandle.trim().toLowerCase()
    const existingHandleOwner = handleOwners.get(normalizedHandle)
    if (existingHandleOwner && existingHandleOwner !== entry.caseId) {
      throw new Error(
        `Hard-gate eval requires distinct real GitHub App handles per route. Both ${existingHandleOwner} and ${entry.caseId} used ${entry.appHandle}.`
      )
    }
    handleOwners.set(normalizedHandle, entry.caseId)

    const normalizedBot = entry.expectedBotLogin.trim().toLowerCase()
    const existingBotOwner = botOwners.get(normalizedBot)
    if (existingBotOwner && existingBotOwner !== entry.caseId) {
      throw new Error(
        `Hard-gate eval requires distinct real GitHub App bot authors per route. Both ${existingBotOwner} and ${entry.caseId} used ${entry.expectedBotLogin}.`
      )
    }
    botOwners.set(normalizedBot, entry.caseId)

    if (!entry.triggerCommentUsesExpectedHandle) {
      throw new Error(`Hard-gate eval requires the real GitHub App handle in the trigger comment for ${entry.caseId}.`)
    }

    if (!entry.botCommentAuthorsMatchExpected || entry.botCommentAuthorLogins.length === 0) {
      throw new Error(
        `Hard-gate eval requires issue-thread replies from ${entry.expectedBotLogin} for ${entry.caseId}, got ${entry.botCommentAuthorLogins.join(", ") || "none"}.`
      )
    }

    if (entry.linkedPrUrl && entry.linkedPrAuthorMatchesExpectedBot !== true) {
      throw new Error(
        `Hard-gate eval requires PR ${entry.linkedPrUrl} to be authored by ${entry.expectedBotLogin}, got ${entry.linkedPrAuthorLogin ?? "unknown"}.`
      )
    }
  }
}

function verifyWorkspaceRunPath(input: {
  repo: string
  repoPath: string
  workspaceRoot: string
}): WorkspaceVerification {
  const repoName = input.repo.split("/")[1]
  if (!repoName) {
    throw new Error(`Unable to derive repo name from ${input.repo}`)
  }

  const normalizedWorkspaceRoot = path.resolve(input.workspaceRoot)
  const normalizedRepoPath = path.resolve(input.repoPath)
  const expectedBaseClonePath = path.join(normalizedWorkspaceRoot, repoName)
  const expectedWorktreeRoot = path.join(normalizedWorkspaceRoot, ".codebridge", "worktrees")

  return {
    workspaceRoot: normalizedWorkspaceRoot,
    expectedBaseClonePath,
    repoPath: normalizedRepoPath,
    repoPathWithinWorkspace: normalizedRepoPath.startsWith(`${normalizedWorkspaceRoot}${path.sep}`),
    repoPathUsesWorktreeLayout:
      normalizedRepoPath.startsWith(`${expectedWorktreeRoot}${path.sep}`),
    repoPathEqualsBaseClone: normalizedRepoPath === expectedBaseClonePath
  }
}

function assertWorkspaceEvidence(results: CaseCollected[]) {
  for (const entry of results) {
    if (!entry.workspaceVerification) continue

    if (!entry.workspaceVerification.repoPathWithinWorkspace) {
      throw new Error(
        `Hard-gate eval requires ${entry.caseId} to run inside the managed workspace root, got ${entry.workspaceVerification.repoPath}.`
      )
    }

    if (!entry.workspaceVerification.repoPathUsesWorktreeLayout) {
      throw new Error(
        `Hard-gate eval requires ${entry.caseId} to use a per-task worktree path, got ${entry.workspaceVerification.repoPath}.`
      )
    }

    if (entry.workspaceVerification.repoPathEqualsBaseClone) {
      throw new Error(
        `Hard-gate eval requires ${entry.caseId} to avoid mutating the base clone directly, got ${entry.workspaceVerification.repoPath}.`
      )
    }
  }
}

function parsePromptfooCounts(payload: any): { passed: number; failed: number; errors: number } {
  const stats = payload?.results?.stats ?? payload?.stats
  if (stats) {
    return {
      passed: Number(stats.successes ?? stats.passed ?? 0),
      failed: Number(stats.failures ?? stats.failed ?? 0),
      errors: Number(stats.errors ?? 0)
    }
  }
  return { passed: 0, failed: 1, errors: 1 }
}

function normalizeAzureBaseUrl(raw: string | undefined): string {
  if (!raw) return "https://vibebrowser-dev.openai.azure.com"
  try {
    return new URL(raw).origin
  } catch {
    return raw.replace(/\/openai\/.*$/i, "").replace(/\/$/, "")
  }
}

function resolveAzureJudgeConfig(): { apiBaseUrl: string; apiHost: string } {
  const apiBaseUrl = normalizeAzureBaseUrl(process.env.AZURE_OPENAI_BASE_URL?.trim())
  try {
    return { apiBaseUrl, apiHost: new URL(apiBaseUrl).host }
  } catch {
    return { apiBaseUrl, apiHost: "vibebrowser-dev.openai.azure.com" }
  }
}

function writeMarkdownReport(input: {
  path: string
  command: string
  counts: { passed: number; failed: number; errors: number }
  results: CaseCollected[]
  promptfooConfigPath: string
  promptfooOutputPath: string
  rawPath: string
}) {
  const lines = [
    "# Customer-Flow Eval Report",
    "",
    `- Command: \`${input.command}\``,
    `- Promptfoo config: \`${input.promptfooConfigPath}\``,
    `- Promptfoo output: \`${input.promptfooOutputPath}\``,
    `- Raw evidence: \`${input.rawPath}\``,
    `- Summary: ${input.counts.passed} passed, ${input.counts.failed} failed, ${input.counts.errors} errors`,
    "",
    "## Cases",
    ""
  ]

  for (const entry of input.results) {
    lines.push(`### ${entry.caseId}`)
    lines.push("")
    lines.push(`- Issue: ${entry.issueUrl}`)
    if (entry.latestBotCommentUrl) lines.push(`- Final bot comment: ${entry.latestBotCommentUrl}`)
    lines.push(`- Expected backend/app: ${entry.expectedBackend} / ${entry.expectedAppKey}`)
    lines.push(`- DB run: ${entry.dbRun ? `${entry.dbRun.id} (${entry.dbRun.status}, backend=${entry.dbRun.backend}, appKey=${entry.dbRun.githubAppKey ?? "n/a"})` : "missing"}`)
    if (entry.workspaceVerification) {
      lines.push(`- Workspace path: ${entry.workspaceVerification.repoPath}`)
      lines.push(`- Workspace worktree evidence: withinRoot=${entry.workspaceVerification.repoPathWithinWorkspace}, worktreeLayout=${entry.workspaceVerification.repoPathUsesWorktreeLayout}, equalsBaseClone=${entry.workspaceVerification.repoPathEqualsBaseClone}`)
    }
    if (entry.linkedPrUrl) lines.push(`- PR: ${entry.linkedPrUrl}`)
    if (entry.knowledgeVerification) {
      lines.push(`- Knowledge answer evidence: 2018=${entry.knowledgeVerification.answerHas2018}, June 2018=${entry.knowledgeVerification.answerHasJune2018}, GPT-1=${entry.knowledgeVerification.mentionsGpt1}`)
    }
    if (entry.prVerification) {
      lines.push(`- PR verification: files=${entry.prVerification.hasExpectedFiles}, bun test=${entry.prVerification.testExitCode}, bun run=${entry.prVerification.runExitCode}, stdout=${JSON.stringify(entry.prVerification.runStdout)}`)
    }
    lines.push("")
  }

  writeFileSync(input.path, lines.join("\n"))
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2))
  const args = await resolveLiveEvalArgs(parsedArgs)
  const azureJudge = resolveAzureJudgeConfig()
  const reportsDir = path.join(process.cwd(), "reports")
  mkdirSync(reportsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  const cases = buildMissionCases(args)
  const collected: CaseCollected[] = []

  console.log(`[customer-flow-eval] repo=${args.repo} timeout=${args.timeoutSec}s poll=${args.pollSec}s`)
  if (args.databaseUrl) {
    console.log(`[customer-flow-eval] database=${args.databaseUrl}`)
  }
  if (args.workspaceRoot) {
    console.log(`[customer-flow-eval] workspaceRoot=${args.workspaceRoot}`)
    cleanWorkspaceRoot(args.workspaceRoot)
  }

  for (const missionCase of cases) {
    const issue = createIssue(
      args.repo,
      `[eval] ${missionCase.title} (${Date.now()})`,
      missionCase.issueBody
    )
    const task = missionCase.buildTask(issue.number)
    const commandBody = `${missionCase.appHandle} run Please solve this issue exactly as written below.\n\n${task}`
    const triggerComment = postIssueComment(args.repo, issue.number, commandBody)
    const triggerCommentIds: number[] = [triggerComment.id]

    const bot = await waitForBot({
      repo: args.repo,
      issueNumber: issue.number,
      botLogins: missionCase.botLogins,
      timeoutSec: args.timeoutSec,
      pollSec: args.pollSec,
      nudgeAfterSec: 60,
      onNoReplyNudge: () => {
        triggerCommentIds.push(postIssueComment(args.repo, issue.number, commandBody).id)
      }
    })
    const dbRun = await waitForDbRun({
      databaseUrl: args.databaseUrl,
      repo: args.repo,
      issueNumber: issue.number,
      triggerCommentIds,
      timeoutSec: args.timeoutSec,
      pollSec: args.pollSec
    })
    const linkedPr = getLinkedPr(args.repo, issue.number, bot.combined, dbRun?.prUrl)
    const prDetails = linkedPr ? getPrDetails(args.repo, linkedPr.number) : null
    const labels = getIssueLabels(args.repo, issue.number)
    const botCommentUrls = bot.comments.map(comment => {
      return `https://github.com/${args.repo}/issues/${issue.number}#issuecomment-${comment.id}`
    })
    const botCommentAuthorLogins = [...new Set(
      bot.comments
        .map(comment => comment.user?.login?.trim())
        .filter((value): value is string => Boolean(value))
    )]
    const latestBotCommentUrl = botCommentUrls[botCommentUrls.length - 1]
    const linkedPrAuthorMatchesExpectedBot = linkedPr?.url
      ? botLoginMatchesExpected(prDetails?.authorLogin, missionCase.botLogins)
      : undefined

    collected.push({
      caseId: missionCase.id,
      title: missionCase.title,
      issueUrl: issue.url,
      issueNumber: issue.number,
      appHandle: missionCase.appHandle,
      triggerCommentUrl: triggerComment.url,
      triggerCommentUsesExpectedHandle: textStartsWithHandle(triggerComment.body || commandBody, missionCase.appHandle),
      expectedBackend: missionCase.expectedBackend,
      expectedAppKey: missionCase.appKey,
      expectedBotLogin: missionCase.expectedBotLogin,
      expectedBotLogins: missionCase.botLogins,
      task,
      timedOut: bot.timedOut,
      botStarted: bot.started,
      botCompleted: bot.completed,
      botCommentUrls,
      botCommentAuthorLogins,
      botCommentAuthorsMatchExpected:
        botCommentAuthorLogins.length > 0
        && botCommentAuthorLogins.every(login => botLoginMatchesExpected(login, missionCase.botLogins)),
      latestBotCommentUrl,
      botResponse: bot.combined,
      labels,
      linkedPrUrl: linkedPr?.url,
      linkedPrNumber: linkedPr?.number,
      linkedPrTitle: prDetails?.title,
      linkedPrAuthorLogin: prDetails?.authorLogin,
      linkedPrAuthorMatchesExpectedBot,
      linkedPrBody: prDetails?.body,
      dbRun,
      workspaceVerification:
        args.workspaceRoot && dbRun?.repoPath
          ? verifyWorkspaceRunPath({
              repo: args.repo,
              repoPath: dbRun.repoPath,
              workspaceRoot: args.workspaceRoot
            })
          : undefined,
      knowledgeVerification:
        missionCase.verificationKind === "knowledge"
          ? verifyKnowledgeResponse(bot.combined, linkedPr?.url)
          : undefined,
      prVerification:
        missionCase.verificationKind === "bun-pr" && linkedPr && prDetails
          ? verifyPrCase({
              repo: args.repo,
              issueNumber: issue.number,
              pr: linkedPr,
              prDetails
            })
          : undefined,
      botResponseMentionsPr: textMentionsUrl(bot.combined, linkedPr?.url),
      rubric: missionCase.rubric
    })
  }

  assertCollectedIdentityEvidence(collected)
  assertWorkspaceEvidence(collected)

  const tests = buildEvalTests(collected)
  const promptfooConfig = {
    description: `CodeBridge customer-flow eval ${new Date().toISOString()}`,
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
            apiVersion: "2024-10-01-preview"
          }
        }
      }
    }
  }

  const configPath = path.join(reportsDir, `customer-flow-eval-config-${stamp}.json`)
  const rawPath = path.join(reportsDir, `customer-flow-eval-raw-${stamp}.json`)
  const outputPath = path.join(reportsDir, `customer-flow-eval-output-${stamp}.json`)
  const markdownPath = path.join(reportsDir, `customer-flow-eval-report-${stamp}.md`)

  writeFileSync(configPath, JSON.stringify(promptfooConfig, null, 2))
  writeFileSync(
    rawPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        repo: args.repo,
        databaseUrl: args.databaseUrl,
        results: collected
      },
      null,
      2
    )
  )

  const localPromptfoo = path.join(process.cwd(), "node_modules", ".bin", "promptfoo")
  const hasLocalPromptfoo = existsSync(localPromptfoo)
  const command = hasLocalPromptfoo ? localPromptfoo : "npx"
  const commandArgs = hasLocalPromptfoo
    ? ["eval", "-c", configPath, "-o", outputPath, "--no-cache"]
    : ["promptfoo@latest", "eval", "-c", configPath, "-o", outputPath, "--no-cache"]
  const promptfooRun = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: process.env,
    encoding: "utf-8"
  })

  const outputRaw = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "{}"
  const parsed = JSON.parse(outputRaw)
  const counts = parsePromptfooCounts(parsed)

  writeMarkdownReport({
    path: markdownPath,
    command: ["bun", "scripts/eval-customer-flow.ts", ...process.argv.slice(2)].join(" "),
    counts,
    results: collected,
    promptfooConfigPath: configPath,
    promptfooOutputPath: outputPath,
    rawPath
  })

  console.log(`Promptfoo summary: ${counts.passed} passed, ${counts.failed} failed, ${counts.errors} errors`)
  console.log(`promptfoo config: ${configPath}`)
  console.log(`promptfoo output: ${outputPath}`)
  console.log(`raw results: ${rawPath}`)
  console.log(`markdown report: ${markdownPath}`)
  for (const entry of collected) {
    console.log(
      [
        `- ${entry.caseId}`,
        `issue=${entry.issueUrl}`,
        `backend=${entry.dbRun?.backend ?? "missing"}`,
        `appKey=${entry.dbRun?.githubAppKey ?? "missing"}`,
        `status=${entry.dbRun?.status ?? "missing"}`,
        `pr=${entry.linkedPrUrl ?? "none"}`
      ].join(" ")
    )
  }

  if (!args.keepArtifacts) {
    for (const entry of collected) {
      try {
        gh(["issue", "close", String(entry.issueNumber), "--repo", args.repo])
      } catch {
        // ignore cleanup failures
      }
    }
  }

  if ((promptfooRun.status ?? 1) !== 0 || counts.failed > 0 || counts.errors > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
