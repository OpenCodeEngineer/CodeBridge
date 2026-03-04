import { Codex } from "@openai/codex-sdk"
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk"
import type { WebClient } from "@slack/web-api"
import type { RunStore } from "./storage.js"
import type { RunRecord } from "./types.js"
import { ProgressTracker } from "./progress.js"
import { Throttler } from "./throttle.js"
import { formatGitHubStatus, formatSlackStatus, formatFinalSummary } from "./status.js"
import { updateSlackStatus, postSlackStatus } from "./slack.js"
import { createInstallationClient, formatPrivateKey } from "./github-auth.js"
import { syncIssueLifecycleState } from "./github-issue-state.js"
import { isDirty, fetchOrigin, createBranch, commitAll, pushBranch, getDefaultBranchFromOrigin } from "./git.js"
import { logger } from "./logger.js"

export type RunnerEnv = {
  codexPath?: string
  codexApiKey?: string
  githubAppId?: number
  githubPrivateKey?: string
}

export function createRunner(params: {
  store: RunStore
  slackClient?: WebClient
  env: RunnerEnv
}) {
  const { store, slackClient, env } = params

  return async (job: { runId: string }) => {
    const run = await store.getRun(job.runId)
    if (!run) throw new Error(`Run not found: ${job.runId}`)

    await store.updateRunStatus(run.id, "running")

    const tracker = new ProgressTracker()
    const throttler = new Throttler(2000)

    const githubClient = await getGitHubClient(run, env)
    if (run.github && githubClient) {
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
      if (run.github && githubClient && run.github.commentId) {
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

    const handleEvent = async (event: ThreadEvent, seq: number) => {
      await store.appendEvent({
        runId: run.id,
        seq,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString()
      })

      if (event.type === "item.completed") {
        handleCompletedItem(tracker, event.item)
      } else if (event.type === "item.updated") {
        handleUpdatedItem(tracker, event.item)
      } else if (event.type === "turn.failed") {
        tracker.pushLine(`Turn failed: ${event.error.message}`)
      } else if (event.type === "turn.completed") {
        tracker.pushLine(`Turn completed. Output tokens ${event.usage.output_tokens}`)
      }

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
      const codex = new Codex({
        codexPathOverride: env.codexPath,
        apiKey: env.codexApiKey
      })
      const thread = codex.startThread({
        workingDirectory: run.repoPath,
        model: run.model
      })

      let seq = 0
      let finalResponse = ""
      const { events } = await thread.runStreamed(prompt)
      for await (const event of events) {
        seq += 1
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text
          tracker.setAgentMessage(event.item.text)
        }
        await handleEvent(event, seq)
      }

      const hasChanges = await isDirty(run.repoPath)
      if (!hasChanges) {
        await store.updateRunStatus(run.id, "no_changes")
        if (run.github && githubClient) {
          await syncIssueLifecycleState(githubClient, run.github, "completed")
        }
        const message = formatFinalSummary(run, finalResponse || "No changes detected", undefined)
        await finalize(run, "no_changes", message, updateStatus, githubClient, slackClient)
        return
      }

      await commitAll(run.repoPath, buildCommitMessage(run))

      if (!run.github || !githubClient) {
        await store.updateRunStatus(run.id, "failed")
        if (run.github && githubClient) {
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
        body: buildPrBody(run, finalResponse)
      })

      await store.updateRunPr(run.id, pr.data.number, pr.data.html_url)
      await store.updateRunStatus(run.id, "succeeded")
      await syncIssueLifecycleState(githubClient, run.github, "completed")
      const message = formatFinalSummary(run, finalResponse || "Completed", pr.data.html_url)
      await finalize(run, "succeeded", message, updateStatus, githubClient, slackClient)
    } catch (error) {
      await store.updateRunStatus(run.id, "failed")
      if (run.github && githubClient) {
        await syncIssueLifecycleState(githubClient, run.github, "idle")
      }
      tracker.pushLine(error instanceof Error ? error.message : String(error))
      await updateStatus("failed")
      throw error
    }
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
  const prefix = run.branchPrefix ?? (run.github?.issueNumber ? `codex/${run.github.issueNumber}` : "codex/task")
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

function buildCommitMessage(run: RunRecord): string {
  const base = run.github?.issueNumber ? `codex: issue ${run.github.issueNumber}` : "codex: update"
  return base
}

function buildRemoteUrl(run: RunRecord, token: string): string {
  return `https://x-access-token:${token}@github.com/${run.github?.owner}/${run.github?.repo}.git`
}

function buildPrTitle(run: RunRecord): string {
  if (run.github?.issueNumber && run.github.issueTitle) {
    return `Codex: ${run.github.issueTitle}`
  }
  return "Codex: changes"
}

function buildPrBody(run: RunRecord, summary: string): string {
  const issue = run.github?.issueNumber ? `Closes #${run.github.issueNumber}` : ""
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
  if (run.github && githubClient && run.github.commentId) {
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
