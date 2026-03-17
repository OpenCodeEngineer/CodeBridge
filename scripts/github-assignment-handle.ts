import { loadConfig, loadEnv } from "../src/config.js"
import { findTenantRepoByFullName } from "../src/repo.js"

type ResolvedAssignmentHandle = {
  handle: string
  reason: string
  candidates: string[]
}

export async function resolvePreferredAssignmentHandle(input: {
  repo: string
  appHandle: string
  explicitAssignmentHandle?: string
  isAssignable: (handle: string) => Promise<boolean>
}): Promise<ResolvedAssignmentHandle> {
  const appHandle = normalizeHandle(input.appHandle)
  if (input.explicitAssignmentHandle) {
    return {
      handle: normalizeHandle(input.explicitAssignmentHandle),
      reason: "cli-override",
      candidates: [normalizeHandle(input.explicitAssignmentHandle)]
    }
  }

  const configuredHandles = await loadConfiguredAssignmentHandles(input.repo)
  const candidates = uniqueHandles([appHandle, ...configuredHandles])

  for (const handle of candidates) {
    if (await input.isAssignable(handle)) {
      return {
        handle,
        reason: handle === appHandle ? "app-handle-assignable" : "configured-assignee-assignable",
        candidates
      }
    }
  }

  return {
    handle: appHandle,
    reason: "no-assignable-configured-handle-found",
    candidates
  }
}

async function loadConfiguredAssignmentHandles(repoFullName: string): Promise<string[]> {
  try {
    const env = loadEnv()
    const config = await loadConfig(env.configPath)
    const match = findTenantRepoByFullName(config, repoFullName)
    return (match?.tenant.github?.assignmentAssignees ?? []).map(normalizeHandle)
  } catch {
    return []
  }
}

function normalizeHandle(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`
}

function uniqueHandles(values: string[]): string[] {
  const normalized = values
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizeHandle)
  return [...new Set(normalized.map(value => value.toLowerCase()))].map(lower => {
    return normalized.find(value => value.toLowerCase() === lower) ?? `@${lower.replace(/^@/, "")}`
  })
}
