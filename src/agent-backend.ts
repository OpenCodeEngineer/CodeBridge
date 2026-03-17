import type { AgentBackend, RunRecord } from "./types.js"

export function resolveAgentBackend(value?: AgentBackend): AgentBackend {
  return value === "opencode" ? "opencode" : "codex"
}

export function getRunBackend(run: Pick<RunRecord, "backend">): AgentBackend {
  return resolveAgentBackend(run.backend)
}

export function formatBackendLabel(value?: AgentBackend): string {
  return resolveAgentBackend(value) === "opencode" ? "OpenCode" : "Codex"
}

export function getRunBackendLabel(run: Pick<RunRecord, "backend">): string {
  return formatBackendLabel(run.backend)
}
