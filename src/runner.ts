import { Codex } from "@openai/codex-sdk"
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk"
import type { WebClient } from "@slack/web-api"
import { execa } from "execa"
import type { RunStore } from "./storage.js"
import type { RunRecord } from "./types.js"
import { getRunBackend, getRunBackendLabel } from "./agent-backend.js"
import type { OpenCodeActivity, OpenCodePart } from "./opencode.js"
import { runOpenCodePrompt } from "./opencode.js"
import { ProgressTracker } from "./progress.js"
import { Throttler } from "./throttle.js"
import { formatGitHubStatus, formatSlackStatus, formatFinalSummary } from "./status.js"
import { updateSlackStatus, postSlackStatus } from "./slack.js"
import { createInstallationClient, formatPrivateKey } from "./github-auth.js"
import { syncIssueLifecycleState } from "./github-issue-state.js"
import { isDiscussionSourceKey, postDiscussionCommentFromContext } from "./github-discussions.js"
import { isDirty, fetchOrigin, createBranch, commitAll, pushBranch, getDefaultBranchFromOrigin } from "./git.js"
import { logger } from "./logger.js"
import type { VibeAgentsSink } from "./vibe-agents.js"

const disabledMcpServersCache = new Map<string, Promise<Record<string, { enabled: boolean }>>>()

export type RunnerEnv = {
  codexPath?: string
  codexApiKey?: string
  codexTurnTimeoutMs: number
  opencodeBaseUrl?: string
  opencodeUsername?: string
  opencodePassword?: string
  opencodeEnabled?: boolean
  opencodeTimeoutMs?: number
  opencodePollIntervalMs?: number
  githubAppId?: number
  githubPrivateKey?: string
}

export function createRunner(params: {
  store: RunStore
  slackClient?: WebClient
  env: RunnerEnv
  vibeAgents?: VibeAgentsSink
}) {
  const { store, slackClient, env, vibeAgents } = params

  return async (job: { runId: string }) => {
    const run = await store.getRun(job.runId)
    if (!run) throw new Error(`Run not found: ${job.runId}`)
    const discussionTarget = isDiscussionSourceKey(run.sourceKey)
    const backend = getRunBackend(run)
    const runTurnTimeoutMs = Math.max(
      30_000,
      backend === "opencode"
        ? env.opencodeTimeoutMs ?? env.codexTurnTimeoutMs
        : env.codexTurnTimeoutMs
    )

    await store.updateRunStatus(run.id, "running")
    void vibeAgents?.sendRunStatus(run, "running")

    const tracker = new ProgressTracker()
    const throttler = new Throttler(2000)

    const githubClient = await getGitHubClient(run, env)
    if (run.github && githubClient && !discussionTarget) {
      await syncIssueLifecycleState(githubClient, run.github, "in-progress")
    }

    const updateStatus = async (state: string) => {
      const snapshot = tracker.snapshot()
      if (run.slack && slackClient && run.slack.messageTs) {
        try {
          const text = formatSlackStatus(run, snapshot, state)
          await updateSlackStatus(slackClient, run.slack, text, run.slack.messageTs)
        } catch (error) {
          logger.warn({ err: error, runId: run.id }, "Slack status update failed")
        }
      }
      if (run.github && githubClient && run.github.commentId && !discussionTarget) {
        try {
          const body = formatGitHubStatus(run, snapshot, state)
          await githubClient.octokit.issues.updateComment({
            owner: run.github.owner,
            repo: run.github.repo,
            comment_id: run.github.commentId,
            body
          })
        } catch (error) {
          logger.warn({ err: error, runId: run.id }, "GitHub status update failed")
        }
      }
    }

    let seq = 0
    const appendRunEvent = async (type: string, payload: Record<string, unknown>) => {
      seq += 1
      await store.appendEvent({
        runId: run.id,
        seq,
        type,
        payload,
        createdAt: new Date().toISOString()
      })

      if (throttler.shouldRun()) {
        await updateStatus("running")
      }
    }

    try {
      const baseBranch = await resolveBaseBranch(run)
      const branchName = buildBranchName(run, baseBranch)
      await store.updateRunBranch(run.id, branchName)

      await prepareRepo(run, baseBranch, branchName)
      await updateStatus("running")

      const prompt = buildPrompt(run)
      const finalResponse = await executeRunTurn({
        run,
        prompt,
        tracker,
        appendRunEvent,
        env
      })

      const hasChanges = await isDirty(run.repoPath)
      if (!hasChanges) {
        await store.updateRunStatus(run.id, "no_changes")
        void vibeAgents?.sendRunStatus(run, "no_changes", {
          summary: finalResponse.trim() || "No changes detected"
        })
        if (run.github && githubClient && !discussionTarget) {
          await syncIssueLifecycleState(githubClient, run.github, "completed")
        }
        // finalize() updates the existing status comment (or posts to discussion)
        // with the final summary — no separate comment needed.
        const message = formatFinalSummary(run, finalResponse || "No changes detected", undefined)
        await finalize(run, "no_changes", message, updateStatus, githubClient, slackClient)
        return
      }

      await commitAll(run.repoPath, buildCommitMessage(run))

      if (!run.github || !githubClient) {
        await store.updateRunStatus(run.id, "failed")
        void vibeAgents?.sendRunStatus(run, "failed", {
          summary: "Missing GitHub context for PR creation"
        })
        if (run.github && githubClient && !discussionTarget) {
          await syncIssueLifecycleState(githubClient, run.github, "idle")
        }
        const message = formatFinalSummary(run, "Missing GitHub context for PR creation", undefined)
        await finalize(run, "failed", message, updateStatus, githubClient, slackClient)
        return
      }

      const remoteUrl = buildRemoteUrl(run, githubClient.token)
      await pushBranch(run.repoPath, remoteUrl, branchName)

      const pr = await githubClient.octokit.pulls.create({
        owner: run.github.owner,
        repo: run.github.repo,
        title: buildPrTitle(run),
        head: branchName,
        base: baseBranch,
        body: buildPrBody(run, finalResponse, discussionTarget)
      })

      await store.updateRunPr(run.id, pr.data.number, pr.data.html_url)
      await store.updateRunStatus(run.id, "succeeded")
      void vibeAgents?.sendRunStatus(run, "succeeded", {
        summary: finalResponse || "Completed",
        prUrl: pr.data.html_url
      })
      if (!discussionTarget) {
        await syncIssueLifecycleState(githubClient, run.github, "completed")
      }
      const message = formatFinalSummary(run, finalResponse || "Completed", pr.data.html_url)
      await finalize(run, "succeeded", message, updateStatus, githubClient, slackClient)
    } catch (error) {
      const runError = error instanceof Error && error.name === "AbortError"
        ? new Error(`${getRunBackendLabel(run)} run timed out after ${Math.round(runTurnTimeoutMs / 1000)}s`)
        : error instanceof Error
          ? error
          : new Error(String(error))
      await store.updateRunStatus(run.id, "failed")
      void vibeAgents?.sendRunStatus(run, "failed", {
        summary: runError.message
      })
      if (run.github && githubClient && !discussionTarget) {
        await syncIssueLifecycleState(githubClient, run.github, "idle")
      }
      tracker.pushLine(runError.message)
      await updateStatus("failed")
      throw runError
    }
  }
}

async function executeRunTurn(params: {
  run: RunRecord
  prompt: string
  tracker: ProgressTracker
  appendRunEvent: (type: string, payload: Record<string, unknown>) => Promise<void>
  env: RunnerEnv
}) {
  if (getRunBackend(params.run) === "opencode") {
    return executeOpenCodeTurn(params)
  }
  return executeCodexTurn(params)
}

async function executeCodexTurn(params: {
  run: RunRecord
  prompt: string
  tracker: ProgressTracker
  appendRunEvent: (type: string, payload: Record<string, unknown>) => Promise<void>
  env: RunnerEnv
}) {
  const codexTurnTimeoutMs = Math.max(30_000, params.env.codexTurnTimeoutMs)
  const mcpOverrides = await resolveDisabledMcpServersConfig(params.env.codexPath)
  const codex = new Codex({
    codexPathOverride: params.env.codexPath,
    apiKey: params.env.codexApiKey,
    config: {
      features: {
        apps: false,
        apps_mcp_gateway: false,
        connectors: false
      },
      mcp_servers: mcpOverrides
    }
  })
  const thread = codex.startThread({
    workingDirectory: params.run.repoPath,
    model: params.run.model,
    sandboxMode: "workspace-write",
    approvalPolicy: "never"
  })

  const turnAbortController = new AbortController()
  const turnTimeout = setTimeout(() => {
    turnAbortController.abort(`Codex turn timed out after ${Math.round(codexTurnTimeoutMs / 1000)}s`)
  }, codexTurnTimeoutMs)

  let finalResponse = ""
  try {
    const { events } = await thread.runStreamed(params.prompt, {
      signal: turnAbortController.signal
    })
    for await (const event of events) {
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text
      }
      handleCodexEvent(params.tracker, event)
      await params.appendRunEvent(event.type, event as unknown as Record<string, unknown>)
    }
  } finally {
    clearTimeout(turnTimeout)
  }

  return finalResponse
}

async function executeOpenCodeTurn(params: {
  run: RunRecord
  prompt: string
  tracker: ProgressTracker
  appendRunEvent: (type: string, payload: Record<string, unknown>) => Promise<void>
  env: RunnerEnv
}) {
  const result = await runOpenCodePrompt({
    integration: {
      baseUrl: params.env.opencodeBaseUrl ?? "",
      username: params.env.opencodeUsername,
      password: params.env.opencodePassword,
      enabled: params.env.opencodeEnabled,
      timeoutMs: params.env.opencodeTimeoutMs,
      pollIntervalMs: params.env.opencodePollIntervalMs
    },
    directory: params.run.repoPath,
    title: buildOpenCodeSessionTitle(params.run),
    prompt: params.prompt,
    agent: params.run.agent,
    model: params.run.model,
    onActivity: async (activity) => {
      handleOpenCodeActivity(params.tracker, activity)
      await params.appendRunEvent(`opencode.${activity.type}`, activity as unknown as Record<string, unknown>)
    }
  })

  params.tracker.setAgentMessage(result.responseText)
  return result.responseText
}

function handleCodexEvent(tracker: ProgressTracker, event: ThreadEvent) {
  if (event.type === "item.completed") {
    handleCompletedItem(tracker, event.item)
  } else if (event.type === "item.updated") {
    handleUpdatedItem(tracker, event.item)
  } else if (event.type === "turn.failed") {
    tracker.pushLine(`Turn failed: ${event.error.message}`)
  } else if (event.type === "turn.completed") {
    tracker.pushLine(`Turn completed. Output tokens ${event.usage.output_tokens}`)
  }
}

function handleCompletedItem(tracker: ProgressTracker, item: ThreadItem) {
  if (item.type === "command_execution") {
    const exitText = item.exit_code !== undefined ? `exit ${item.exit_code}` : ""
    tracker.pushLine(`Command ${item.command} ${item.status} ${exitText}`.trim())
  } else if (item.type === "file_change") {
    for (const change of item.changes) {
      tracker.pushLine(`File ${change.kind} ${change.path}`)
    }
  } else if (item.type === "agent_message") {
    tracker.setAgentMessage(item.text)
  } else if (item.type === "reasoning") {
    tracker.pushLine("Reasoning updated")
  } else if (item.type === "mcp_tool_call") {
    tracker.pushLine(`MCP ${item.tool} ${item.status}`)
  } else if (item.type === "web_search") {
    tracker.pushLine(`Web search ${item.query}`)
  } else if (item.type === "error") {
    tracker.pushLine(`Error ${item.message}`)
  }
}

function handleOpenCodeActivity(tracker: ProgressTracker, activity: OpenCodeActivity) {
  if (activity.type === "health.checked") {
    tracker.pushLine(`OpenCode server ${activity.version} healthy`)
    return
  }
  if (activity.type === "session.created") {
    tracker.pushLine(`OpenCode session ${activity.session.id} created`)
    return
  }
  if (activity.type === "session.status") {
    if (activity.status.type === "busy") {
      tracker.pushLine("OpenCode session running")
    } else if (activity.status.type === "idle") {
      tracker.pushLine("OpenCode session idle")
    } else {
      tracker.pushLine(`OpenCode retry ${activity.status.attempt}: ${activity.status.message}`)
    }
    return
  }
  if (activity.type === "summary.requested") {
    tracker.pushLine("OpenCode requested a final text summary")
    return
  }
  if (activity.type === "summary.completed") {
    tracker.setAgentMessage(activity.text)
    return
  }
  handleOpenCodePart(tracker, activity.part)
  if (activity.part.type === "text" && activity.message.role === "assistant") {
    tracker.setAgentMessage(activity.part.text)
  }
}

function handleOpenCodePart(tracker: ProgressTracker, part: OpenCodePart) {
  if (part.type === "tool") {
    const title = part.state.title ? ` ${part.state.title}` : ""
    tracker.pushLine(`Tool ${part.tool} ${part.state.status}${title}`.trim())
  } else if (part.type === "step-start") {
    tracker.pushLine("Step started")
  } else if (part.type === "step-finish") {
    tracker.pushLine(`Step finished: ${part.reason}`)
  } else if (part.type === "reasoning") {
    tracker.pushLine("Reasoning updated")
  } else if (part.type === "patch") {
    tracker.pushLine(`Patch updated ${part.files.length} files`)
  } else if (part.type === "retry") {
    tracker.pushLine(`Retry ${part.attempt}: ${part.error.data?.message ?? "provider retry"}`)
  }
}

function handleUpdatedItem(tracker: ProgressTracker, item: ThreadItem) {
  if (item.type === "todo_list") {
    const done = item.items.filter(i => i.completed).length
    const total = item.items.length
    tracker.pushLine(`Todo ${done}/${total}`)
  }
}

async function resolveBaseBranch(run: RunRecord): Promise<string> {
  const fromOrigin = await getDefaultBranchFromOrigin(run.repoPath)
  return fromOrigin ?? "main"
}

function buildBranchName(run: RunRecord, base: string): string {
  const backendPrefix = getRunBackend(run) === "opencode" ? "opencode" : "codex"
  const prefix = run.branchPrefix ?? (run.github?.issueNumber ? `${backendPrefix}/${run.github.issueNumber}` : `${backendPrefix}/task`)
  const suffix = run.id.toLowerCase()
  return `${prefix}-${suffix}`
}

async function prepareRepo(run: RunRecord, baseBranch: string, branchName: string): Promise<void> {
  if (await isDirty(run.repoPath)) {
    throw new Error("Repository has uncommitted changes")
  }
  await fetchOrigin(run.repoPath)
  await createBranch(run.repoPath, branchName, `origin/${baseBranch}`)
}

function buildPrompt(run: RunRecord): string {
  const issueTitle = run.github?.issueTitle ? `Issue: ${run.github.issueTitle}` : ""
  const issueBody = run.github?.issueBody ? `\n${run.github.issueBody}` : ""
  return [issueTitle + issueBody, run.prompt].filter(Boolean).join("\n\n")
}

function buildOpenCodeSessionTitle(run: RunRecord): string {
  if (run.github?.issueNumber) {
    return `${run.repoFullName}#${run.github.issueNumber} ${run.id}`
  }
  return `${run.repoFullName} ${run.id}`
}

function buildCommitMessage(run: RunRecord): string {
  const backend = getRunBackend(run)
  const base = run.github?.issueNumber ? `${backend}: issue ${run.github.issueNumber}` : `${backend}: update`
  return base
}

function buildRemoteUrl(run: RunRecord, token: string): string {
  return `https://x-access-token:${token}@github.com/${run.github?.owner}/${run.github?.repo}.git`
}

function buildPrTitle(run: RunRecord): string {
  const backendLabel = getRunBackendLabel(run)
  if (run.github?.issueNumber && run.github.issueTitle) {
    return `${backendLabel}: ${run.github.issueTitle}`
  }
  return `${backendLabel}: changes`
}

function buildPrBody(run: RunRecord, summary: string, discussionTarget: boolean): string {
  const issue = run.github?.issueNumber && !discussionTarget ? `Closes #${run.github.issueNumber}` : ""
  return [issue, summary].filter(Boolean).join("\n\n")
}

async function finalize(
  run: RunRecord,
  state: string,
  message: string,
  updateStatus: (state: string) => Promise<void>,
  githubClient: any,
  slackClient?: WebClient
) {
  if (run.slack && run.slack.messageTs) {
    await updateStatus(state)
    if (slackClient) {
      try {
        await postSlackStatus(slackClient, run.slack, message)
      } catch (error) {
        logger.warn({ err: error, runId: run.id }, "Slack final post failed")
      }
    }
  }
  if (run.github && githubClient && isDiscussionSourceKey(run.sourceKey)) {
    try {
      await postDiscussionCommentFromContext(githubClient, run.github, message)
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "GitHub discussion final post failed")
    }
  } else if (run.github && githubClient && run.github.commentId) {
    try {
      await githubClient.octokit.issues.updateComment({
        owner: run.github.owner,
        repo: run.github.repo,
        comment_id: run.github.commentId,
        body: message
      })
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "GitHub final update failed")
    }
  }
}

async function getGitHubClient(run: RunRecord, env: RunnerEnv) {
  if (!run.github?.installationId || !env.githubAppId || !env.githubPrivateKey) return null
  return createInstallationClient({
    appId: env.githubAppId,
    privateKey: formatPrivateKey(env.githubPrivateKey),
    installationId: run.github.installationId
  })
}

async function resolveDisabledMcpServersConfig(codexPath?: string): Promise<Record<string, { enabled: boolean }>> {
  const key = codexPath ?? "codex"
  let cached = disabledMcpServersCache.get(key)
  if (!cached) {
    cached = discoverMcpServerOverrides(codexPath)
    disabledMcpServersCache.set(key, cached)
  }
  return cached
}

async function discoverMcpServerOverrides(codexPath?: string): Promise<Record<string, { enabled: boolean }>> {
  const executable = codexPath ?? "codex"
  try {
    const { stdout } = await execa(executable, ["mcp", "list"], {
      timeout: 5000
    })
    const names = parseMcpServerNames(stdout)
    return Object.fromEntries(names.map(name => [name, { enabled: false }]))
  } catch (error) {
    logger.warn({ err: error, executable }, "Failed to discover MCP servers; skipping MCP overrides")
    return {}
  }
}

function parseMcpServerNames(output: string): string[] {
  const names = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.toLowerCase().startsWith("name")) continue

    const columns = line.split(/\s{2,}|\t+/).filter(Boolean)
    if (columns.length < 2) continue

    const name = columns[0]?.trim()
    if (!name) continue
    names.add(name)
  }
  return [...names]
}
