import { logger } from "./logger.js"
import type { OpenCodeIntegrationConfig } from "./types.js"

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_READ_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_WRITE_REQUEST_TIMEOUT_MS = 60_000

export type OpenCodeSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }

export type OpenCodePart =
  | {
      id: string
      type: "text"
      text: string
    }
  | {
      id: string
      type: "reasoning"
      text: string
    }
  | {
      id: string
      type: "tool"
      tool: string
      state: {
        status: "pending" | "running" | "completed" | "error"
        title?: string
        error?: string
      }
    }
  | {
      id: string
      type: "step-start"
    }
  | {
      id: string
      type: "step-finish"
      reason: string
    }
  | {
      id: string
      type: "patch"
      files: string[]
    }
  | {
      id: string
      type: "retry"
      attempt: number
      error: {
        data?: {
          message?: string
        }
      }
    }

export type OpenCodeMessageInfo = {
  id: string
  role: "user" | "assistant"
  time: {
    created: number
    completed?: number
  }
  providerID?: string
  modelID?: string
  finish?: string
  error?: {
    name: string
    data?: {
      message?: string
      [key: string]: unknown
    }
  }
}

export type OpenCodeMessage = {
  info: OpenCodeMessageInfo
  parts: OpenCodePart[]
}

type OpenCodeSession = {
  id: string
  title: string
  directory: string
}

export type OpenCodeActivity =
  | {
      type: "health.checked"
      version: string
    }
  | {
      type: "session.created"
      session: OpenCodeSession
    }
  | {
      type: "session.status"
      status: OpenCodeSessionStatus
    }
  | {
      type: "message.part"
      message: OpenCodeMessageInfo
      part: OpenCodePart
    }
  | {
      type: "summary.requested"
    }
  | {
      type: "summary.completed"
      text: string
    }

export type RunOpenCodePromptInput = {
  integration: OpenCodeIntegrationConfig
  directory: string
  title: string
  prompt: string
  agent?: string
  model?: string
  onActivity?: (activity: OpenCodeActivity) => Promise<void> | void
}

export type RunOpenCodePromptResult = {
  sessionId: string
  responseText: string
}

export function parseOpenCodeModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const value = model.trim()
  if (!value) return undefined
  const slashIndex = value.indexOf("/")
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    throw new Error(`Invalid OpenCode model "${model}". Expected provider/model format.`)
  }
  return {
    providerID: value.slice(0, slashIndex),
    modelID: value.slice(slashIndex + 1)
  }
}

export function extractOpenCodeResponseText(parts: OpenCodePart[]): string | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text
    }
  }
  return null
}

export async function runOpenCodePrompt(input: RunOpenCodePromptInput): Promise<RunOpenCodePromptResult> {
  if (input.integration.enabled === false) {
    throw new Error("OpenCode backend is disabled")
  }
  if (!input.integration.baseUrl) {
    throw new Error("OpenCode backend requires integrations.opencode.baseUrl")
  }

  const client = createOpenCodeClient(input.integration, input.directory)
  const seenPartIds = new Set<string>()
  const timeoutMs = Math.max(30_000, input.integration.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const pollIntervalMs = Math.max(250, input.integration.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const deadline = Date.now() + timeoutMs

  const health = await client.requestJson<{ healthy: boolean; version: string }>("GET", "/global/health")
  if (!health.healthy) {
    throw new Error("OpenCode server health check failed")
  }
  await input.onActivity?.({ type: "health.checked", version: health.version })

  const session = await client.requestJson<OpenCodeSession>("POST", "/session", {
    title: input.title
  })
  await input.onActivity?.({ type: "session.created", session })

  await client.request("POST", `/session/${encodeURIComponent(session.id)}/prompt_async`, {
    agent: input.agent,
    model: parseOpenCodeModel(input.model),
    parts: [
      {
        type: "text",
        text: input.prompt
      }
    ]
  })

  let lastStatusKey = ""
  let lastAssistant: OpenCodeMessage | null = null

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`OpenCode prompt timed out after ${Math.round(timeoutMs / 1000)}s`)
    }

    const messages = await client.requestJson<OpenCodeMessage[]>("GET", `/session/${encodeURIComponent(session.id)}/message`)
    await emitNewParts(messages, seenPartIds, input.onActivity)
    lastAssistant = findLastAssistantMessage(messages)

    try {
      const statuses = await client.requestJson<Record<string, OpenCodeSessionStatus>>("GET", "/session/status")
      const status = statuses[session.id] ?? { type: "idle" }
      const statusKey = formatStatusKey(status)
      if (statusKey !== lastStatusKey) {
        lastStatusKey = statusKey
        await input.onActivity?.({ type: "session.status", status })
      }

      if ((status.type === "idle" || !statuses[session.id]) && isAssistantTerminal(lastAssistant)) {
        break
      }

      const retryDelayMs = status.type === "retry"
        ? Math.max(250, Math.min(pollIntervalMs, status.next - Date.now()))
        : pollIntervalMs
      await sleep(Math.max(250, retryDelayMs))
      continue
    } catch (error) {
      if (isAssistantTerminal(lastAssistant)) {
        logger.warn({ err: error, sessionId: session.id }, "OpenCode status polling failed after terminal response")
        break
      }
      throw error
    }
  }

  if (!lastAssistant) {
    throw new Error("OpenCode completed without an assistant response")
  }
  if (lastAssistant.info.error) {
    throw toOpenCodeError(lastAssistant.info.error)
  }

  let responseText = extractOpenCodeResponseText(lastAssistant.parts)
  if (!responseText) {
    const summaryModel = resolveSummaryModel(lastAssistant, input.model)
    if (!summaryModel) {
      throw new Error("OpenCode completed without a text response and no model was available for summary fallback")
    }
    await input.onActivity?.({ type: "summary.requested" })
    const summary = await client.requestJson<OpenCodeMessage>("POST", `/session/${encodeURIComponent(session.id)}/message`, {
      agent: input.agent,
      model: summaryModel,
      tools: { "*": false },
      parts: [
        {
          type: "text",
          text: "Summarize the actions you completed for the user in 1-2 sentences."
        }
      ]
    })
    if (summary.info.error) {
      throw toOpenCodeError(summary.info.error)
    }
    responseText = extractOpenCodeResponseText(summary.parts)
    if (!responseText) {
      throw new Error("OpenCode completed without a text response")
    }
    await input.onActivity?.({ type: "summary.completed", text: responseText })
  }

  return {
    sessionId: session.id,
    responseText
  }
}

function findLastAssistantMessage(messages: OpenCodeMessage[]): OpenCodeMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info.role === "assistant") {
      return messages[index] ?? null
    }
  }
  return null
}

function isAssistantTerminal(message: OpenCodeMessage | null): boolean {
  if (!message) return false
  return Boolean(message.info.time.completed || message.info.error)
}

function formatStatusKey(status: OpenCodeSessionStatus): string {
  return status.type === "retry"
    ? `${status.type}:${status.attempt}:${status.message}`
    : status.type
}

async function emitNewParts(
  messages: OpenCodeMessage[],
  seenPartIds: Set<string>,
  onActivity?: (activity: OpenCodeActivity) => Promise<void> | void
) {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part?.id || seenPartIds.has(part.id)) continue
      seenPartIds.add(part.id)
      await onActivity?.({
        type: "message.part",
        message: message.info,
        part
      })
    }
  }
}

function resolveSummaryModel(message: OpenCodeMessage, configuredModel?: string) {
  if (message.info.providerID && message.info.modelID) {
    return {
      providerID: message.info.providerID,
      modelID: message.info.modelID
    }
  }
  return parseOpenCodeModel(configuredModel)
}

function toOpenCodeError(error: NonNullable<OpenCodeMessageInfo["error"]>): Error {
  const message = error.data?.message?.trim()
  if (message) {
    return new Error(`${error.name}: ${message}`)
  }
  return new Error(error.name)
}

function createOpenCodeClient(integration: OpenCodeIntegrationConfig, directory: string) {
  const baseUrl = integration.baseUrl.replace(/\/+$/, "")

  return {
    request: async (method: string, pathname: string, body?: unknown) => {
      const response = await requestOpenCode(baseUrl, directory, integration, method, pathname, body)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenCode ${method} ${pathname} failed (${response.status}): ${text || response.statusText}`)
      }
    },
    requestJson: async <T>(method: string, pathname: string, body?: unknown) => {
      const response = await requestOpenCode(baseUrl, directory, integration, method, pathname, body)
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`OpenCode ${method} ${pathname} failed (${response.status}): ${text || response.statusText}`)
      }
      if (!text) {
        return undefined as T
      }
      return JSON.parse(text) as T
    }
  }
}

async function requestOpenCode(
  baseUrl: string,
  directory: string,
  integration: OpenCodeIntegrationConfig,
  method: string,
  pathname: string,
  body?: unknown
): Promise<Response> {
  const controller = new AbortController()
  const timeoutMs = resolveRequestTimeoutMs(method, pathname, integration)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-opencode-directory": encodeURIComponent(directory)
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
    }
    if (integration.password) {
      const username = integration.username ?? "opencode"
      headers.Authorization = `Basic ${Buffer.from(`${username}:${integration.password}`, "utf8").toString("base64")}`
    }

    const url = new URL(pathname, `${baseUrl}/`)
    if (!pathname.startsWith("/global/")) {
      url.searchParams.set("directory", directory)
    }

    return await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
  } catch (error) {
    logger.warn({ err: error, method, pathname, baseUrl }, "OpenCode request failed")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function resolveRequestTimeoutMs(
  method: string,
  pathname: string,
  integration: OpenCodeIntegrationConfig
): number {
  const configuredTimeoutMs = Math.max(5_000, integration.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const cap = isLongOpenCodeRequest(method, pathname)
    ? configuredTimeoutMs
    : method === "GET"
      ? DEFAULT_READ_REQUEST_TIMEOUT_MS
      : DEFAULT_WRITE_REQUEST_TIMEOUT_MS
  return Math.max(5_000, Math.min(configuredTimeoutMs, cap))
}

function isLongOpenCodeRequest(method: string, pathname: string): boolean {
  return (method === "POST" && pathname === "/session")
    || (method === "GET" && /^\/session\/[^/]+\/message$/.test(pathname))
}
