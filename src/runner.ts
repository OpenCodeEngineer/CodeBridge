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
import { syncIssueLifecycleState } from "./github-issue-state.js"
import { isDiscussionSourceKey, postDiscussionCommentFromContext } from "./github-discussions.js"
import {
  countCommitsAhead,
  currentBranch,
  isDirty,
  fetchOrigin,
  createBranch,
  commitAll,
  pushBranch,
  getDefaultBranchFromOrigin
} from "./git.js"
import { logger } from "./logger.js"
import type { VibeAgentsSink } from "./vibe-agents.js"
import { createGitHubInstallationClientFactory, type GitHubAppMap } from "./github-apps.js"

const disabledMcpServersCache = new Map<string, Promise<Record<string, { enabled: boolean }>>>()
const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)\/?/i
const DEFAULT_GPT5_CODEX_REASONING_EFFORT = "low"

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
  githubApps?: GitHubAppMap
}

export function createRunner(params: {
  store: RunStore
  slackClient?: WebClient
  env: RunnerEnv
  vibeAgents?: VibeAgentsSink
}) {
  const { store, slackClient, env, vibeAgents } = params
  const getGitHubClient = env.githubApps ? createGitHubInstallationClientFactory(env.githubApps) : null

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

    const githubClient = run.github?.installationId && getGitHubClient
      ? await getGitHubClient(run.github.appKey ?? "default", run.github.installationId)
      : null
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
      const rawFinalResponse = await executeRunTurn({
        run,
        prompt,
        tracker,
        appendRunEvent,
        env
      })
      const finalResponse = normalizeFinalResponseForDelivery(run, rawFinalResponse)

      const backendCreatedPr = extractPullRequestReference(finalResponse)
      const hasChanges = await isDirty(run.repoPath)
      const commitsAhead = await countCommitsAhead(run.repoPath, `origin/${baseBranch}`)
      if (!hasChanges) {
        if (backendCreatedPr) {
          await completeWithPr({
            run,
            pr: backendCreatedPr,
            finalResponse,
            updateStatus,
            githubClient,
            slackClient,
            discussionTarget,
            store,
            vibeAgents
          })
          return
        }

        if (commitsAhead > 0) {
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

          const headBranch = await resolveHeadBranch(run.repoPath, branchName)
          if (headBranch !== branchName) {
            await store.updateRunBranch(run.id, headBranch)
          }

          const remoteUrl = buildRemoteUrl(run, githubClient.token)
          await pushBranch(run.repoPath, remoteUrl, headBranch)

          const existingPr = await findExistingPullRequestForBranch(githubClient, run, headBranch)
          if (existingPr) {
            await completeWithPr({
              run,
              pr: existingPr,
              finalResponse,
              updateStatus,
              githubClient,
              slackClient,
              discussionTarget,
              store,
              vibeAgents
            })
            return
          }

          const pr = await githubClient.octokit.pulls.create({
            owner: run.github.owner,
            repo: run.github.repo,
            title: buildPrTitle(run),
            head: headBranch,
            base: baseBranch,
            body: buildPrBody(run, finalResponse, discussionTarget)
          })
          await completeWithPr({
            run,
            pr: { number: pr.data.number, url: pr.data.html_url },
            finalResponse,
            updateStatus,
            githubClient,
            slackClient,
            discussionTarget,
            store,
            vibeAgents
          })
          return
        }

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

      await completeWithPr({
        run,
        pr: { number: pr.data.number, url: pr.data.html_url },
        finalResponse,
        updateStatus,
        githubClient,
        slackClient,
        discussionTarget,
        store,
        vibeAgents
      })
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
    modelReasoningEffort: resolveCodexModelReasoningEffort(params.run.model),
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
    tools: resolveOpenCodeTools(params.run),
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
  return [issueTitle + issueBody, run.prompt, buildGitHubResponseContract(run)].filter(Boolean).join("\n\n")
}

function buildGitHubResponseContract(run: RunRecord): string {
  if (!run.github) return ""
  return [
    "Final response contract:",
    "- Do not use gh, GitHub MCP/integrations/tools, the GitHub website, or GitHub APIs/CLI to create, update, or comment on GitHub issues or pull requests from inside the task.",
    "- Do not open or update a pull request yourself, and do not run git push to publish branches to GitHub from inside the task.",
    "- CodeBridge owns those GitHub writes, including branch publication, PR creation, PR linking, and publishing your final assistant response to the originating thread.",
    "- Write the final answer so it can be posted to GitHub unchanged.",
    "- For knowledge questions, answer the question directly instead of saying 'comment to post' or describing what you would have posted.",
    "- If code changes are ready for review, leave the local repository in that ready state and describe the result. Local file edits and local commits are fine. CodeBridge will publish the branch and open the PR with the correct GitHub App identity.",
    "- If you ran important commands or tests, include a 'Command results' section with the command and whether it passed.",
    "- If a PR exists, include the full GitHub PR URL in the final response.",
    "- Do not mention an inability to comment on GitHub unless the user explicitly asked you to use GitHub tooling from inside the task."
  ].join("\n")
}

function buildOpenCodeSessionTitle(run: RunRecord): string {
  if (run.github?.issueNumber) {
    return `${run.repoFullName}#${run.github.issueNumber} ${run.id}`
  }
  return `${run.repoFullName} ${run.id}`
}

function resolveOpenCodeTools(run: RunRecord): Record<string, boolean> | undefined {
  if (!run.github) return undefined
  return {
    github: false
  }
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

function normalizeFinalResponseForDelivery(run: RunRecord, finalResponse: string): string {
  const trimmed = finalResponse.trim()
  if (!run.github || !trimmed) return trimmed

  const commentBlockMatch = trimmed.match(/comment to post(?: on the issue)?\s*[:\-]?\s*```(?:text)?\n([\s\S]*?)```/i)
  if (commentBlockMatch?.[1]?.trim()) {
    return commentBlockMatch[1].trim()
  }

  return trimmed
}

async function resolveHeadBranch(repoPath: string, fallbackBranch: string): Promise<string> {
  try {
    const branch = await currentBranch(repoPath)
    return branch && branch !== "HEAD" ? branch : fallbackBranch
  } catch {
    return fallbackBranch
  }
}

async function findExistingPullRequestForBranch(
  githubClient: any,
  run: RunRecord,
  headBranch: string
): Promise<{ number: number; url: string } | null> {
  if (!run.github) return null
  const existing = await githubClient.octokit.pulls.list({
    owner: run.github.owner,
    repo: run.github.repo,
    state: "open",
    head: `${run.github.owner}:${headBranch}`,
    per_page: 1
  })
  const pr = existing.data[0]
  if (!pr) return null
  return {
    number: pr.number,
    url: pr.html_url
  }
}

async function completeWithPr(params: {
  run: RunRecord
  pr: { number: number; url: string }
  finalResponse: string
  updateStatus: (state: string) => Promise<void>
  githubClient: any
  slackClient?: WebClient
  discussionTarget: boolean
  store: RunStore
  vibeAgents?: VibeAgentsSink
}) {
  const summary = params.finalResponse.trim() || "Completed"
  await params.store.updateRunPr(params.run.id, params.pr.number, params.pr.url)
  await params.store.updateRunStatus(params.run.id, "succeeded")
  void params.vibeAgents?.sendRunStatus(params.run, "succeeded", {
    summary,
    prUrl: params.pr.url
  })
  if (params.run.github && params.githubClient && !params.discussionTarget) {
    await syncIssueLifecycleState(params.githubClient, params.run.github, "completed")
  }
  const message = formatFinalSummary(params.run, summary, params.pr.url)
  await finalize(params.run, "succeeded", message, params.updateStatus, params.githubClient, params.slackClient)
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

function resolveCodexModelReasoningEffort(model: string | undefined): "low" | undefined {
  const normalized = model?.trim().toLowerCase()
  if (!normalized) return undefined
  return normalized.startsWith("gpt-5") ? DEFAULT_GPT5_CODEX_REASONING_EFFORT : undefined
}

function extractPullRequestReference(text: string): { url: string; number: number } | null {
  const match = text.match(GITHUB_PULL_REQUEST_URL_PATTERN)
  if (!match) return null

  const prNumber = Number.parseInt(match[1] ?? "", 10)
  if (!Number.isFinite(prNumber)) return null

  return {
    url: match[0].replace(/\/$/, ""),
    number: prNumber
  }
}

export const _testHelpers = {
  extractPullRequestReference,
  resolveCodexModelReasoningEffort,
  buildGitHubResponseContract,
  resolveOpenCodeTools
}
