import path from "node:path"
import { access } from "node:fs/promises"
import { execa } from "execa"
import type { AppConfig, RepoConfig, TenantConfig } from "./types.js"

export type TenantRepoMatch = {
  tenant: TenantConfig
  repo: RepoConfig
}

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

export function findTenantRepoByFullName(config: AppConfig, fullName: string): TenantRepoMatch | null {
  const normalized = fullName.toLowerCase()
  for (const tenant of config.tenants) {
    for (const repo of tenant.repos) {
      if (repo.fullName.toLowerCase() === normalized) {
        return { tenant, repo }
      }
    }
  }
  return null
}

export function findTenantRepoByPath(config: AppConfig, cwd: string): TenantRepoMatch | null {
  const resolvedCwd = normalizeForCompare(path.resolve(cwd))
  let bestMatch: TenantRepoMatch | null = null
  let bestLen = -1

  for (const tenant of config.tenants) {
    for (const repo of tenant.repos) {
      const repoPath = normalizeForCompare(path.resolve(repo.path))
      if (!pathContains(repoPath, resolvedCwd)) continue
      if (repoPath.length <= bestLen) continue
      bestMatch = { tenant, repo }
      bestLen = repoPath.length
    }
  }

  return bestMatch
}

export async function findTenantRepoByGitRemote(config: AppConfig, cwd: string): Promise<TenantRepoMatch | null> {
  try {
    const { stdout } = await execa("git", ["-C", cwd, "remote", "-v"], {
      timeout: 5000
    })
    const remotes = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    for (const remote of remotes) {
      const fullName = parseGitHubFullNameFromRemote(remote)
      if (!fullName) continue
      const match = findTenantRepoByFullName(config, fullName)
      if (match) return match
    }
  } catch {
    return null
  }
  return null
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

function normalizeForCompare(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function pathContains(basePath: string, candidate: string): boolean {
  if (candidate === basePath) return true
  const suffix = process.platform === "win32" ? "\\" : "/"
  return candidate.startsWith(basePath.endsWith(suffix) ? basePath : `${basePath}${suffix}`)
}

export function parseGitHubFullNameFromRemote(remoteLine: string): string | null {
  const parts = remoteLine.split(/\s+/)
  if (parts.length < 2) return null
  const remoteUrl = parts[1]
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`
  return null
}
