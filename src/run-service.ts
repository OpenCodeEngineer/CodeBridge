import { nanoid } from "nanoid"
import type { RunStore } from "./storage.js"
import type { SlackContext, GitHubContext, RunRecord } from "./types.js"
import type { WebClient } from "@slack/web-api"
import { postSlackStatus } from "./slack.js"
import { createInstallationClient, formatPrivateKey } from "./github-auth.js"
import { formatGitHubStatus, formatSlackStatus } from "./status.js"
import { syncIssueLifecycleState } from "./github-issue-state.js"
import { ProgressTracker } from "./progress.js"
import type { RunQueue } from "./queue.js"
import { logger } from "./logger.js"

export type RunService = {
  createRun: (input: {
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => Promise<RunRecord>
}

export function createRunService(params: {
  store: RunStore
  queue: RunQueue
  slackClient?: WebClient
  githubAppId?: number
  githubPrivateKey?: string
}) : RunService {
  const { store, queue, slackClient, githubAppId, githubPrivateKey } = params

  const createRun = async (input: {
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => {
    const id = nanoid(8)
    let github = input.github ? { ...input.github } : undefined
    let githubClient: Awaited<ReturnType<typeof createInstallationClient>> | null = null

    if (github && githubAppId && githubPrivateKey && github.installationId) {
      try {
        githubClient = await createInstallationClient({
          appId: githubAppId,
          privateKey: formatPrivateKey(githubPrivateKey),
          installationId: github.installationId
        })
      } catch (error) {
        logger.warn({ err: error, tenantId: input.tenantId }, "GitHub client bootstrap failed")
      }
    }

    if (github && !github.issueNumber && githubClient) {
      try {
        const created = await githubClient.octokit.issues.create({
          owner: github.owner,
          repo: github.repo,
          title: buildIssueTitle(input.prompt),
          body: buildIssueBody(input.prompt),
          labels: ["agent:managed", "agent:in-progress"]
        })
        github = {
          ...github,
          issueNumber: created.data.number,
          issueTitle: created.data.title,
          issueBody: created.data.body ?? undefined
        }
      } catch (error) {
        logger.warn({ err: error, tenantId: input.tenantId }, "GitHub issue auto-create failed")
      }
    }

    const run = await store.createRun({
      id,
      tenantId: input.tenantId,
      repoFullName: input.repoFullName,
      repoPath: input.repoPath,
      sourceKey: input.sourceKey,
      prompt: input.prompt,
      model: input.model,
      branchPrefix: input.branchPrefix,
      slack: input.slack,
      github
    })
    const isNewRun = run.id === id
    if (!isNewRun) return run

    if (run.slack && slackClient) {
      const tracker = new ProgressTracker()
      const message = formatSlackStatus(run, tracker.snapshot(), "queued")
      const messageTs = await postSlackStatus(slackClient, run.slack, message)
      if (messageTs) {
        await store.updateSlackMessage(run.id, messageTs)
      }
    }

    if (run.github && run.github.issueNumber && githubClient) {
      try {
        const tracker = new ProgressTracker()
        const body = formatGitHubStatus(run, tracker.snapshot(), "queued")
        const response = await githubClient.octokit.issues.createComment({
          owner: run.github.owner,
          repo: run.github.repo,
          issue_number: run.github.issueNumber,
          body
        })
        await store.updateGithubComment(run.id, response.data.id)
        await syncIssueLifecycleState(githubClient, run.github, "in-progress")
      } catch (error) {
        logger.warn({ err: error, runId: run.id }, "GitHub status comment failed")
      }
    }

    await queue.add("run", { runId: run.id })
    return run
  }

  return { createRun }
}

function buildIssueTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map(line => line.trim())
    .find(Boolean) ?? "Codex task"
  return truncate(firstLine, 120)
}

function buildIssueBody(prompt: string): string {
  return [
    "Created automatically by codex-bridge.",
    "",
    "### Requested task",
    prompt
  ].join("\n")
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 3) + "..."
}
