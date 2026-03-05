import os from "node:os"
import { logger } from "./logger.js"
import type { RunRecord, RunStatus, VibeAgentsIntegrationConfig } from "./types.js"

type VibeLifecycleState = "queued" | "in-progress" | "idle" | "completed"
type VibeEventType = "session.created" | "session.status"

type VibeAgentsDispatchPayload = {
  source: "codebridge"
  eventType: VibeEventType
  timestamp: string
  lifecycle: VibeLifecycleState
  runStatus: RunStatus
  summary?: string
  prUrl?: string
  author?: string
  project?: string
  run: {
    id: string
    tenantId: string
    repoFullName: string
    prompt: string
    branchName?: string
    prNumber?: number
    prUrl?: string
    createdAt: string
    updatedAt: string
    github?: {
      owner: string
      repo: string
      issueNumber?: number
      commentId?: number
      triggerCommentId?: number
      installationId?: number
    }
  }
  host: {
    hostname: string
    pid: number
  }
}

export type VibeAgentsSink = {
  sendRunCreated: (run: RunRecord) => Promise<void>
  sendRunStatus: (run: RunRecord, status: RunStatus, detail?: { summary?: string; prUrl?: string }) => Promise<void>
}

const noopSink: VibeAgentsSink = {
  sendRunCreated: async () => {},
  sendRunStatus: async () => {}
}

export function createVibeAgentsSink(config?: VibeAgentsIntegrationConfig): VibeAgentsSink {
  if (!config?.endpoint || config.enabled === false) {
    return noopSink
  }

  const endpoint = config.endpoint
  const token = config.token
  const timeoutMs = config.timeoutMs ?? 8000

  const dispatch = async (payload: VibeAgentsDispatchPayload) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!response.ok) {
        const body = await response.text()
        logger.warn({
          endpoint,
          status: response.status,
          response: truncate(body, 600),
          runId: payload.run.id,
          eventType: payload.eventType
        }, "Vibe agents dispatch failed")
      }
    } catch (error) {
      logger.warn({ err: error, endpoint, runId: payload.run.id, eventType: payload.eventType }, "Vibe agents dispatch error")
    } finally {
      clearTimeout(timeout)
    }
  }

  const sendRunCreated = async (run: RunRecord) => {
    await dispatch(buildPayload({
      run,
      runStatus: run.status,
      eventType: "session.created",
      author: config.author,
      project: config.project
    }))
  }

  const sendRunStatus = async (run: RunRecord, status: RunStatus, detail?: { summary?: string; prUrl?: string }) => {
    await dispatch(buildPayload({
      run,
      runStatus: status,
      eventType: "session.status",
      author: config.author,
      project: config.project,
      summary: detail?.summary,
      prUrl: detail?.prUrl
    }))
  }

  return { sendRunCreated, sendRunStatus }
}

function buildPayload(input: {
  run: RunRecord
  runStatus: RunStatus
  eventType: VibeEventType
  author?: string
  project?: string
  summary?: string
  prUrl?: string
}): VibeAgentsDispatchPayload {
  const { run, runStatus } = input

  return {
    source: "codebridge",
    eventType: input.eventType,
    timestamp: new Date().toISOString(),
    lifecycle: toLifecycleState(runStatus),
    runStatus,
    summary: input.summary,
    prUrl: input.prUrl,
    author: input.author,
    project: input.project,
    run: {
      id: run.id,
      tenantId: run.tenantId,
      repoFullName: run.repoFullName,
      prompt: run.prompt,
      branchName: run.branchName,
      prNumber: run.prNumber,
      prUrl: run.prUrl,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      github: run.github ? {
        owner: run.github.owner,
        repo: run.github.repo,
        issueNumber: run.github.issueNumber,
        commentId: run.github.commentId,
        triggerCommentId: run.github.triggerCommentId,
        installationId: run.github.installationId
      } : undefined
    },
    host: {
      hostname: os.hostname(),
      pid: process.pid
    }
  }
}

function toLifecycleState(status: RunStatus): VibeLifecycleState {
  if (status === "running") return "in-progress"
  if (status === "succeeded" || status === "no_changes") return "completed"
  if (status === "failed") return "idle"
  return "queued"
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 3) + "..."
}
