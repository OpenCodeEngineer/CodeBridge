#!/usr/bin/env bun
import { execa } from "execa"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadConfig, loadEnv } from "../src/config.js"
import { findTenantRepoByFullName } from "../src/repo.js"

type Args = {
  repo: string
  notifyUrl: string
  timeoutSec: number
  pollSec: number
  codexPath?: string
  keepIssue: boolean
}

type NotifyResponse = {
  ok: boolean
  sessionId: string
  turnId: string
  issueNumber: number
  repoFullName: string
  createdIssue: boolean
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    repo: "dzianisv/codebridge-test",
    notifyUrl: process.env.CODEBRIDGE_NOTIFY_URL ?? "http://127.0.0.1:8788/codex/notify",
    timeoutSec: 240,
    pollSec: 5,
    codexPath: process.env.CODEX_PATH,
    keepIssue: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--repo" && next) {
      args.repo = next
      i += 1
    } else if (arg === "--notify-url" && next) {
      args.notifyUrl = next
      i += 1
    } else if (arg === "--timeout" && next) {
      args.timeoutSec = Number(next)
      i += 1
    } else if (arg === "--poll" && next) {
      args.pollSec = Number(next)
      i += 1
    } else if (arg === "--codex-path" && next) {
      args.codexPath = next
      i += 1
    } else if (arg === "--keep") {
      args.keepIssue = true
    }
  }
  return args
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const gh = async (args: string[]): Promise<string> => {
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  const result = await execa("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    extendEnv: false
  })
  return result.stdout.trim()
}

const parseIssueCommentIdFromUrl = (url: string): number => {
  const match = url.match(/issuecomment-(\d+)/)
  if (!match) {
    throw new Error(`Unable to parse issue comment id from URL: ${url}`)
  }
  return Number(match[1])
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const env = loadEnv()
  const config = await loadConfig(env.configPath)

  const repoMatch = findTenantRepoByFullName(config, args.repo)
  if (!repoMatch) {
    throw new Error(`Repo ${args.repo} is not configured`)
  }

  const relayToken = `RELAY_REPLY_OK_${Date.now()}`
  const codexExecutable = args.codexPath ?? env.codexPath ?? "codex"

  const bootstrap = await execa(codexExecutable, ["exec", "--json", "Reply with exactly RELAY_BOOTSTRAP_OK"], {
    cwd: repoMatch.repo.path,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024
  })

  const events = bootstrap.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, any>)
  const threadId = events.find(event => event.type === "thread.started")?.thread_id as string | undefined
  if (!threadId) {
    throw new Error("Failed to capture thread_id from codex exec --json output")
  }

  const notifyPayload = {
    type: "agent-turn-complete",
    "thread-id": threadId,
    "turn-id": `turn-relay-${Date.now()}`,
    cwd: repoMatch.repo.path,
    "input-messages": ["Relay e2e bootstrap task."],
    "last-assistant-message": "RELAY_BOOTSTRAP_OK"
  }
  const notifyRes = await fetch(args.notifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(notifyPayload)
  })
  if (!notifyRes.ok) {
    throw new Error(`Notify endpoint failed: ${notifyRes.status} ${await notifyRes.text()}`)
  }
  const notifyJson = await notifyRes.json() as NotifyResponse
  if (!notifyJson.ok || !notifyJson.issueNumber) {
    throw new Error(`Unexpected notify response: ${JSON.stringify(notifyJson)}`)
  }

  const relayPrompt = `Please answer with exactly ${relayToken} and nothing else.`
  const commentUrl = await gh([
    "issue",
    "comment",
    String(notifyJson.issueNumber),
    "--repo",
    args.repo,
    "--body",
    relayPrompt
  ])
  const triggerCommentId = parseIssueCommentIdFromUrl(commentUrl)
  const marker = `<!-- codebridge-relay:${threadId}:${triggerCommentId} -->`

  const deadline = Date.now() + args.timeoutSec * 1000
  let finalRelayComment: string | null = null
  while (Date.now() < deadline) {
    const raw = await gh(["api", `repos/${args.repo}/issues/${notifyJson.issueNumber}/comments?per_page=100`])
    const comments = JSON.parse(raw) as Array<{ body?: string }>
    const hit = comments.find(comment =>
      (comment.body ?? "").includes(marker) &&
      (comment.body ?? "").includes("processed the relayed comment.")
    )
    if (hit?.body) {
      finalRelayComment = hit.body
      break
    }
    await sleep(args.pollSec * 1000)
  }

  if (!finalRelayComment) {
    throw new Error(`Timed out waiting for relay completion on issue #${notifyJson.issueNumber}`)
  }
  if (!finalRelayComment.includes(relayToken)) {
    throw new Error(`Relay completed but expected token '${relayToken}' was not found in bridge response`)
  }

  const summary = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    repo: args.repo,
    sessionId: threadId,
    issueNumber: notifyJson.issueNumber,
    triggerCommentId,
    marker,
    relayToken
  }
  const reportsDir = path.join(process.cwd(), "reports")
  mkdirSync(reportsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const reportPath = path.join(reportsDir, `codex-session-relay-${stamp}.json`)
  writeFileSync(reportPath, JSON.stringify(summary, null, 2))

  console.log(JSON.stringify({ ...summary, reportPath }, null, 2))

  if (!args.keepIssue) {
    try {
      await gh(["issue", "close", String(notifyJson.issueNumber), "--repo", args.repo])
    } catch {
      // best effort cleanup
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
