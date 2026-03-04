import path from "node:path"
import { access } from "node:fs/promises"
import type { AppConfig, RepoConfig, TenantConfig } from "./types.js"

export function findTenantBySlackTeam(config: AppConfig, teamId: string): TenantConfig | null {
  return config.tenants.find(t => t.slack?.teamId === teamId) ?? null
}

export function findTenantByGithubInstallation(config: AppConfig, installationId: number | undefined): TenantConfig | null {
  if (!installationId) return null
  return config.tenants.find(t => t.github?.installationId === installationId) ?? null
}

export function findTenantByRepoFullName(config: AppConfig, fullName: string): TenantConfig | null {
  return config.tenants.find(t => t.repos.some(r => r.fullName.toLowerCase() === fullName.toLowerCase())) ?? null
}

export function resolveRepo(tenant: TenantConfig, repoHint?: string): RepoConfig | null {
  if (repoHint) {
    const match = tenant.repos.find(r => r.fullName.toLowerCase() === repoHint.toLowerCase())
    if (match) return match
  }
  if (tenant.defaultRepo) {
    const match = tenant.repos.find(r => r.fullName.toLowerCase() === tenant.defaultRepo?.toLowerCase())
    if (match) return match
  }
  return tenant.repos[0] ?? null
}

export async function ensureRepoPath(repo: RepoConfig): Promise<string> {
  const resolved = path.resolve(repo.path)
  await access(resolved)
  return resolved
}
