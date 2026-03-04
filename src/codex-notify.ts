import type { RequestHandler } from "express"
import { createInstallationClient, formatPrivateKey, type InstallationClient } from "./github-auth.js"
import { syncIssueLifecycleState } from "./github-issue-state.js"
import type { AppConfig, GitHubContext } from "./types.js"
import { findTenantRepoByFullName, findTenantRepoByPath, type TenantRepoMatch } from "./repo.js"
import { parseIssueReference } from "./commands.js"
import { logger } from "./logger.js"

const MANAGED_LABEL = "agent:managed"
const IN_PROGRESS_LABEL = "agent:in-progress"
const CLIENT_TTL_MS = 50 * 60 * 1000

type SessionBinding = {
  repoFullName: string
  github: GitHubContext
  createdIssue: boolean
}

type NormalizedTurn = {
  sessionId: string
  turnId: string
  cwd: string
  inputMessages: string[]
  lastAssistantMessage?: string
}

export function createCodexNotifyHandler(params: {
  config: AppConfig
  githubAppId?: number
  githubPrivateKey?: string
  ingestToken?: string
}): RequestHandler {
  const { config, githubAppId, githubPrivateKey, ingestToken } = params
  const sessionBindings = new Map<string, SessionBinding>()
  const clientCache = new Map<number, { client: InstallationClient; expiresAt: number }>()

  const getClient = async (installationId: number): Promise<InstallationClient> => {
    const cached = clientCache.get(installationId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.client
    }
    if (!githubAppId || !githubPrivateKey) {
      throw new Error("GitHub app credentials are required for Codex notify integration")
    }

    const client = await createInstallationClient({
      appId: githubAppId,
      privateKey: formatPrivateKey(githubPrivateKey),
      installationId
    })
    clientCache.set(installationId, { client, expiresAt: Date.now() + CLIENT_TTL_MS })
    return client
  }

  return async (req, res) => {
    try {
      if (ingestToken) {
        const header = req.header("x-codebridge-token") ?? req.header("x-codex-bridge-token")
        if (header !== ingestToken) {
          res.status(401).json({ error: "Unauthorized" })
          return
        }
      } else if (!isLoopbackRequest(req.ip, req.socket.remoteAddress)) {
        res.status(403).json({ error: "Forbidden: codex notify endpoint is localhost-only when no token is configured" })
        return
      }

      const normalized = normalizeTurnPayload(req.body)
      if (!normalized) {
        res.status(400).json({ error: "Invalid payload. Expected Codex after-agent notify payload." })
        return
      }

      const repoMatch = findTenantRepoByPath(config, normalized.cwd)
      if (!repoMatch) {
        res.status(400).json({ error: `No configured repo matched cwd: ${normalized.cwd}` })
        return
      }

      const binding = await getOrCreateBinding({
        normalized,
        repoMatch,
        config,
        sessionBindings,
        getClient
      })

      const github = binding.github
      if (!github.issueNumber || !github.installationId) {
        throw new Error("Session binding is missing GitHub issue context")
      }
      const issueNumber = github.issueNumber

      const client = await getClient(github.installationId)
      await withConsistencyRetry(() => syncIssueLifecycleState(client, github, "in-progress"))

      const existingComments = await withConsistencyRetry(() => listIssueComments(client, github))
      const userMarker = turnMarker(normalized.sessionId, normalized.turnId, "user")
      if (!hasAnyMarker(existingComments, turnMarkerVariants(normalized.sessionId, normalized.turnId, "user"))) {
        await withConsistencyRetry(() =>
          client.octokit.issues.createComment({
            owner: github.owner,
            repo: github.repo,
            issue_number: issueNumber,
            body: buildUserPromptComment(userMarker, normalized.inputMessages)
          })
        )
      }

      const assistantMessage = normalized.lastAssistantMessage
      if (assistantMessage) {
        const assistantMarker = turnMarker(normalized.sessionId, normalized.turnId, "assistant")
        if (!hasAnyMarker(existingComments, turnMarkerVariants(normalized.sessionId, normalized.turnId, "assistant"))) {
          await withConsistencyRetry(() =>
            client.octokit.issues.createComment({
              owner: github.owner,
              repo: github.repo,
              issue_number: issueNumber,
              body: buildAssistantComment(assistantMarker, assistantMessage)
            })
          )
        }
        await withConsistencyRetry(() => syncIssueLifecycleState(client, github, "completed"))
      }

      res.json({
        ok: true,
        sessionId: normalized.sessionId,
        turnId: normalized.turnId,
        issueNumber,
        repoFullName: binding.repoFullName,
        createdIssue: binding.createdIssue
      })
    } catch (error) {
      logger.error({ err: error }, "Codex notify sync failed")
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}

async function getOrCreateBinding(input: {
  normalized: NormalizedTurn
  repoMatch: TenantRepoMatch
  config: AppConfig
  sessionBindings: Map<string, SessionBinding>
  getClient: (installationId: number) => Promise<InstallationClient>
}): Promise<SessionBinding> {
  const { normalized, repoMatch, config, sessionBindings, getClient } = input
  const existing = sessionBindings.get(normalized.sessionId)
  if (existing) return existing

  const [defaultOwner, defaultRepo] = repoMatch.repo.fullName.split("/")
  if (!defaultOwner || !defaultRepo) {
    throw new Error(`Invalid repo fullName in config: ${repoMatch.repo.fullName}`)
  }

  const promptText = normalized.inputMessages.join("\n\n")
  const explicitIssue = parseIssueReference(promptText, {
    owner: defaultOwner,
    repo: defaultRepo
  })

  const target = resolveTargetRepoMatch(config, repoMatch, explicitIssue)
  const installationId = target.tenant.github?.installationId
  if (!installationId) {
    throw new Error(`Tenant '${target.tenant.id}' has no github.installationId configured`)
  }

  const client = await getClient(installationId)

  let github: GitHubContext
  let createdIssue = false
  const explicitIssueNumber = explicitIssue?.issueNumber
  if (explicitIssue && explicitIssueNumber) {
    const issue = await withConsistencyRetry(() =>
      client.octokit.issues.get({
        owner: explicitIssue.owner,
        repo: explicitIssue.repo,
        issue_number: explicitIssueNumber
      })
    )

    github = {
      owner: explicitIssue.owner,
      repo: explicitIssue.repo,
      issueNumber: explicitIssueNumber,
      installationId,
      issueTitle: issue.data.title,
      issueBody: issue.data.body ?? undefined
    }
    await ensureSessionMarker(client, github, normalized.sessionId)
  } else {
    const recovered = await findIssueBySessionMarker(client, {
      owner: defaultOwner,
      repo: defaultRepo,
      sessionId: normalized.sessionId
    })
    if (recovered) {
      github = {
        owner: defaultOwner,
        repo: defaultRepo,
        issueNumber: recovered.number,
        installationId,
        issueTitle: recovered.title,
        issueBody: recovered.body ?? undefined
      }
    } else {
      const firstPrompt = normalized.inputMessages[0] ?? "Codex task"
      const created = await withConsistencyRetry(() =>
        client.octokit.issues.create({
          owner: defaultOwner,
          repo: defaultRepo,
          title: buildIssueTitle(firstPrompt),
          body: buildIssueBody(firstPrompt, normalized.sessionId),
          labels: [MANAGED_LABEL, IN_PROGRESS_LABEL]
        })
      )

      github = {
        owner: defaultOwner,
        repo: defaultRepo,
        issueNumber: created.data.number,
        installationId,
        issueTitle: created.data.title,
        issueBody: created.data.body ?? undefined
      }
      createdIssue = true
    }
  }

  const binding: SessionBinding = {
    repoFullName: `${github.owner}/${github.repo}`,
    github,
    createdIssue
  }
  sessionBindings.set(normalized.sessionId, binding)
  return binding
}

function resolveTargetRepoMatch(
  config: AppConfig,
  defaultMatch: TenantRepoMatch,
  issue: GitHubContext | null
): TenantRepoMatch {
  if (!issue) return defaultMatch

  const fullName = `${issue.owner}/${issue.repo}`
  const match = findTenantRepoByFullName(config, fullName)
  return match ?? defaultMatch
}

async function findIssueBySessionMarker(
  client: InstallationClient,
  input: { owner: string; repo: string; sessionId: string }
) {
  const markers = sessionMarkerVariants(input.sessionId)
  const open = await withConsistencyRetry(() =>
    client.octokit.issues.listForRepo({
      owner: input.owner,
      repo: input.repo,
      state: "open",
      labels: MANAGED_LABEL,
      per_page: 100,
      sort: "updated",
      direction: "desc"
    })
  )
  const hit = open.data.find(issue => markers.some(marker => (issue.body ?? "").includes(marker)))
  if (hit) return hit

  const all = await withConsistencyRetry(() =>
    client.octokit.issues.listForRepo({
      owner: input.owner,
      repo: input.repo,
      state: "all",
      labels: MANAGED_LABEL,
      per_page: 100,
      sort: "updated",
      direction: "desc"
    })
  )
  return all.data.find(issue => markers.some(marker => (issue.body ?? "").includes(marker)))
}

async function ensureSessionMarker(client: InstallationClient, github: GitHubContext, sessionId: string): Promise<void> {
  const issueNumber = github.issueNumber
  if (!issueNumber) return
  const marker = sessionMarker(sessionId)
  const markers = sessionMarkerVariants(sessionId)

  const issue = await withConsistencyRetry(() =>
    client.octokit.issues.get({
      owner: github.owner,
      repo: github.repo,
      issue_number: issueNumber
    })
  )
  if (markers.some(value => (issue.data.body ?? "").includes(value))) return

  const comments = await listIssueComments(client, github)
  if (hasAnyMarker(comments, markers)) return

  await withConsistencyRetry(() =>
    client.octokit.issues.createComment({
      owner: github.owner,
      repo: github.repo,
      issue_number: issueNumber,
      body: `${marker}\nLinked Codex session \`${sessionId}\` to this issue.`
    })
  )
}

async function listIssueComments(client: InstallationClient, github: GitHubContext) {
  if (!github.issueNumber) return []
  const response = await client.octokit.issues.listComments({
    owner: github.owner,
    repo: github.repo,
    issue_number: github.issueNumber,
    per_page: 100
  })
  return response.data
}

function hasMarker(comments: Array<{ body?: string | null }>, marker: string): boolean {
  return comments.some(comment => (comment.body ?? "").includes(marker))
}

function hasAnyMarker(comments: Array<{ body?: string | null }>, markers: string[]): boolean {
  return markers.some(marker => hasMarker(comments, marker))
}

function buildIssueTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map(line => line.trim())
    .find(Boolean) ?? "Codex task"
  return truncate(firstLine, 120)
}

function buildIssueBody(prompt: string, sessionId: string): string {
  return [
    "Created automatically by CodeBridge from Codex CLI.",
    "",
    sessionMarker(sessionId),
    "",
    "### First prompt",
    truncate(prompt, 6000)
  ].join("\n")
}

function buildUserPromptComment(marker: string, inputMessages: string[]): string {
  const content = inputMessages.map(text => truncate(text.trim(), 12000)).join("\n\n---\n\n")
  return [
    marker,
    "**User prompt**",
    "",
    content || "_empty_"
  ].join("\n")
}

function buildAssistantComment(marker: string, message: string): string {
  return [
    marker,
    "**Codex response**",
    "",
    truncate(message.trim(), 60000)
  ].join("\n")
}

function sessionMarker(sessionId: string): string {
  return `<!-- codebridge-session:${sessionId} -->`
}

function legacySessionMarker(sessionId: string): string {
  return `<!-- codex-bridge-session:${sessionId} -->`
}

function sessionMarkerVariants(sessionId: string): string[] {
  return [sessionMarker(sessionId), legacySessionMarker(sessionId)]
}

function turnMarker(sessionId: string, turnId: string, kind: "user" | "assistant"): string {
  return `<!-- codebridge-turn:${sessionId}:${turnId}:${kind} -->`
}

function legacyTurnMarker(sessionId: string, turnId: string, kind: "user" | "assistant"): string {
  return `<!-- codex-bridge-turn:${sessionId}:${turnId}:${kind} -->`
}

function turnMarkerVariants(sessionId: string, turnId: string, kind: "user" | "assistant"): string[] {
  return [turnMarker(sessionId, turnId, kind), legacyTurnMarker(sessionId, turnId, kind)]
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function normalizeTurnPayload(raw: unknown): NormalizedTurn | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const payload = (obj.payload && typeof obj.payload === "object" ? obj.payload : obj) as Record<string, unknown>

  if (payload.type === "agent-turn-complete") {
    const sessionId = readString(payload["thread-id"]) ?? readString(payload.thread_id)
    const turnId = readString(payload["turn-id"]) ?? readString(payload.turn_id)
    const cwd = readString(payload.cwd)
    const inputMessages = readStringArray(payload["input-messages"] ?? payload.input_messages)
    const lastAssistantMessage = readString(payload["last-assistant-message"] ?? payload.last_assistant_message)
    if (!sessionId || !turnId || !cwd) return null
    return {
      sessionId,
      turnId,
      cwd,
      inputMessages,
      lastAssistantMessage
    }
  }

  const hookEvent = payload.hook_event
  if (!hookEvent || typeof hookEvent !== "object") return null
  const hook = hookEvent as Record<string, unknown>
  if (hook.event_type !== "after_agent") return null

  const sessionId = readString(payload.session_id) ?? readString(hook.thread_id)
  const turnId = readString(hook.turn_id)
  const cwd = readString(payload.cwd)
  const inputMessages = readStringArray(hook.input_messages)
  const lastAssistantMessage = readString(hook.last_assistant_message)

  if (!sessionId || !turnId || !cwd) return null
  return {
    sessionId,
    turnId,
    cwd,
    inputMessages,
    lastAssistantMessage
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map(entry => entry.trim())
    .filter(Boolean)
}

function isLoopbackRequest(ip?: string, remoteAddress?: string | null): boolean {
  return isLoopbackAddress(ip) || isLoopbackAddress(remoteAddress ?? undefined)
}

function isLoopbackAddress(address?: string): boolean {
  if (!address) return false
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
}

async function withConsistencyRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTransientNodeResolutionError(error) || attempt === 3) {
        throw error
      }
      await sleep(250 * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function isTransientNodeResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Could not resolve to a node with the global id")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
