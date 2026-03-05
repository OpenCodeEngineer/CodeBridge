import type { GitHubContext } from "./types.js"

export type CommandType = "run" | "reply" | "pause" | "resume" | "status"

export type ParsedCommand = {
  type: CommandType
  prompt: string
  repoHint?: string
  tenantHint?: string
  issue?: GitHubContext
}

export function extractCommand(text: string, prefixes: string[], botUserId?: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const mentionPrefix = botUserId ? `<@${botUserId}>` : null
  let remaining = trimmed

  if (mentionPrefix && remaining.startsWith(mentionPrefix)) {
    remaining = remaining.slice(mentionPrefix.length).trim()
  } else {
    const prefix = findBestPrefixMatch(remaining, prefixes)
    if (!prefix) return null
    remaining = remaining.slice(prefix.length).trim()
  }

  // Allow human-friendly punctuation after a prefix/mention:
  // "@CodexEngineer, do X" / "codex: - do X"
  remaining = remaining.replace(/^[,:\-]\s*/, "")

  if (!remaining) return null

  const tenantHint = extractTenantHint(remaining)
  if (tenantHint) {
    remaining = stripTenantHint(remaining, tenantHint)
  }

  const parsed = parseCommandType(remaining)
  if (!parsed) return null

  const issue = parseIssueOrPr(remaining)
  const repoHint = extractRepoHint(remaining)

  return {
    type: parsed.type,
    prompt: parsed.prompt,
    repoHint: repoHint ?? undefined,
    tenantHint: tenantHint ?? undefined,
    issue: issue ?? undefined
  }
}

export function extractCommandFromManagedIssue(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  let remaining = trimmed
  const tenantHint = extractTenantHint(remaining)
  if (tenantHint) {
    remaining = stripTenantHint(remaining, tenantHint)
  }

  const parsed = parseCommandType(remaining)
  if (!parsed) return null

  const issue = parseIssueOrPr(remaining)
  const repoHint = extractRepoHint(remaining)

  return {
    type: parsed.type,
    prompt: parsed.prompt,
    repoHint: repoHint ?? undefined,
    tenantHint: tenantHint ?? undefined,
    issue: issue ?? undefined
  }
}

function parseCommandType(text: string): { type: CommandType; prompt: string } | null {
  const actionMatch = text.match(/^(run|reply|pause|resume|status)\b[:\s-]*/i)
  if (!actionMatch) {
    return { type: "run", prompt: text.trim() }
  }

  const type = actionMatch[1].toLowerCase() as CommandType
  const prompt = text.slice(actionMatch[0].length).trim()
  if ((type === "run" || type === "reply") && !prompt) return null
  return { type, prompt }
}

export function parseIssueOrPr(text: string): GitHubContext | null {
  const issue = parseIssueUrl(text)
  if (issue) return issue
  const pr = parsePrUrl(text)
  if (pr) return pr
  return null
}

export function parseIssueReference(
  text: string,
  defaults?: { owner: string; repo: string }
): GitHubContext | null {
  const direct = parseIssueOrPr(text)
  if (direct) return direct

  const scoped = parseScopedIssueRef(text)
  if (scoped) return scoped

  const local = parseLocalIssueRef(text)
  if (local && defaults) {
    return {
      owner: defaults.owner,
      repo: defaults.repo,
      issueNumber: local
    }
  }

  return null
}

export function extractRepoHint(text: string): string | null {
  const match = text.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/)
  if (!match) return null
  return `${match[1]}/${match[2]}`
}

export function parseIssueUrl(text: string): GitHubContext | null {
  const match = text.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/i)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10)
  }
}

export function parsePrUrl(text: string): GitHubContext | null {
  const match = text.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/i)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10)
  }
}

function parseScopedIssueRef(text: string): GitHubContext | null {
  const match = text.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)\b/)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10)
  }
}

function parseLocalIssueRef(text: string): number | null {
  const match = text.match(/(?<![A-Za-z0-9_])#(\d+)\b/)
  if (!match) return null
  return parseInt(match[1], 10)
}

function findBestPrefixMatch(text: string, prefixes: string[]): string | null {
  const lower = text.toLowerCase()
  let best: string | null = null
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix.toLowerCase())) continue
    if (!best || prefix.length > best.length) {
      best = prefix
    }
  }
  return best
}

function extractTenantHint(text: string): string | null {
  const match = text.match(/(?:^|\s)(?:tenant|t)\s*[:=]\s*([A-Za-z0-9_.-]+)\b/i)
  if (!match) return null
  return match[1]
}

function stripTenantHint(text: string, tenantHint: string): string {
  const pattern = new RegExp(`(?:^|\\s)(?:tenant|t)\\s*[:=]\\s*${escapeRegExp(tenantHint)}\\b`, "i")
  return text.replace(pattern, " ").replace(/\s+/g, " ").trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
