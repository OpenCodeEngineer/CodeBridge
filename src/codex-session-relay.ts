import { execa } from "execa"
import { logger } from "./logger.js"
import type { GitHubContext } from "./types.js"

const relayDedupeKeys = new Set<string>()
const issueToSession = new Map<string, SessionBinding>()
const sessionToBinding = new Map<string, SessionBinding>()
const sessionRelayQueue = new Map<string, Promise<void>>()

const SESSION_MARKER_RE = /<!--\s*(?:codebridge-session|codex-bridge-session):([A-Za-z0-9._:-]+)\s*-->/i

export type SessionBinding = {
  sessionId: string
  repoFullName: string
  repoPath: string
  github: GitHubContext
  createdAt: string
  updatedAt: string
}

export function extractSessionIdFromText(text?: string | null): string | null {
  if (!text) return null
  const match = text.match(SESSION_MARKER_RE)
  if (!match?.[1]) return null
  return match[1]
}

export function registerSessionBinding(input: {
  sessionId: string
  repoFullName: string
  repoPath: string
  github: GitHubContext
}): SessionBinding {
  const now = new Date().toISOString()
  const previous = sessionToBinding.get(input.sessionId)
  const binding: SessionBinding = {
    sessionId: input.sessionId,
    repoFullName: input.repoFullName,
    repoPath: input.repoPath,
    github: input.github,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  }
  sessionToBinding.set(input.sessionId, binding)
  const issueKey = buildIssueKey(input.github.owner, input.github.repo, input.github.issueNumber)
  if (issueKey) issueToSession.set(issueKey, binding)
  return binding
}

export function findSessionBindingByIssue(input: {
  owner: string
  repo: string
  issueNumber?: number
}): SessionBinding | null {
  const key = buildIssueKey(input.owner, input.repo, input.issueNumber)
  if (!key) return null
  return issueToSession.get(key) ?? null
}

export async function resolveSessionIdFromIssue(input: {
  issueBody?: string
  fetchComments?: () => Promise<Array<{ body?: string | null }>>
}): Promise<string | null> {
  const fromBody = extractSessionIdFromText(input.issueBody)
  if (fromBody) return fromBody
  if (!input.fetchComments) return null
  const comments = await input.fetchComments()
  for (const comment of comments) {
    const fromComment = extractSessionIdFromText(comment.body)
    if (fromComment) return fromComment
  }
  return null
}

export function dispatchSessionRelay(input: {
  sessionId: string
  owner: string
  repo: string
  issueNumber: number
  commentId: number | string
  commentBody: string
  authorLogin?: string
  repoPath: string
  codexPath?: string
  codexTurnTimeoutMs?: number
  postIssueComment?: (body: string) => Promise<void>
}): { accepted: boolean; reason?: string } {
  const text = input.commentBody.trim()
  if (!text) return { accepted: false, reason: "empty-comment" }

  const dedupeKey = `${input.owner}/${input.repo}#${input.issueNumber}:${input.commentId}`
  if (relayDedupeKeys.has(dedupeKey)) {
    return { accepted: false, reason: "duplicate-comment" }
  }
  relayDedupeKeys.add(dedupeKey)

  const marker = `<!-- codebridge-relay:${input.sessionId}:${input.commentId} -->`
  const intro = [
    marker,
    `Relaying comment from @${input.authorLogin ?? "unknown"} to Codex session \`${input.sessionId}\`.`
  ].join("\n")

  const previous = sessionRelayQueue.get(input.sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (input.postIssueComment) {
        await input.postIssueComment(intro)
      }

      const prompt = buildRelayPrompt({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.issueNumber,
        authorLogin: input.authorLogin,
        commentBody: input.commentBody
      })

      const timeoutMs = Math.max(30_000, input.codexTurnTimeoutMs ?? 300_000)
      const executable = input.codexPath ?? "codex"
      const result = await execa(executable, ["exec", "resume", input.sessionId, "-"], {
        cwd: input.repoPath,
        input: prompt,
        reject: false,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024
      })

      const code = result.exitCode ?? 1
      const output = summarizeCodexOutput(result.stdout, result.stderr)
      if (input.postIssueComment) {
        if (code === 0) {
          await input.postIssueComment([
            marker,
            `Codex session \`${input.sessionId}\` processed the relayed comment.`,
            "",
            output ? `\`\`\`\n${output}\n\`\`\`` : "_No terminal output captured._"
          ].join("\n"))
        } else {
          await input.postIssueComment([
            marker,
            `Failed to relay to Codex session \`${input.sessionId}\` (exit ${code}).`,
            "",
            output ? `\`\`\`\n${output}\n\`\`\`` : "_No terminal output captured._"
          ].join("\n"))
        }
      }
    })
    .catch(error => {
      logger.error({
        err: error,
        sessionId: input.sessionId,
        issue: `${input.owner}/${input.repo}#${input.issueNumber}`,
        commentId: input.commentId
      }, "Codex session relay failed")
      if (input.postIssueComment) {
        void input.postIssueComment([
          marker,
          `Relay failed for Codex session \`${input.sessionId}\`: ${error instanceof Error ? error.message : String(error)}`
        ].join("\n"))
      }
    })
    .finally(() => {
      const current = sessionRelayQueue.get(input.sessionId)
      if (current === next) {
        sessionRelayQueue.delete(input.sessionId)
      }
    })

  sessionRelayQueue.set(input.sessionId, next)
  return { accepted: true }
}

function buildIssueKey(owner: string, repo: string, issueNumber?: number): string | null {
  if (!issueNumber) return null
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${issueNumber}`
}

function buildRelayPrompt(input: {
  owner: string
  repo: string
  issueNumber: number
  authorLogin?: string
  commentBody: string
}): string {
  return [
    `GitHub follow-up from @${input.authorLogin ?? "unknown"} on ${input.owner}/${input.repo}#${input.issueNumber}:`,
    "",
    input.commentBody.trim(),
    "",
    "Continue the existing session and answer this follow-up."
  ].join("\n")
}

function summarizeCodexOutput(stdout: string, stderr: string): string {
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n")
  if (!text) return ""
  if (text.length <= 1800) return text
  return `${text.slice(0, 1797)}...`
}
