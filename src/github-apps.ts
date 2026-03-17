import { createInstallationClient, formatPrivateKey, type InstallationClient } from "./github-auth.js"
import type { AgentBackend, AppConfig, GitHubAppBindingConfig, GitHubAppConfig, RepoConfig, RunRecord, TenantConfig } from "./types.js"

export const DEFAULT_GITHUB_APP_KEY = "default"

export type GitHubAppMap = Record<string, GitHubAppConfig>

export function normalizeGithubAppKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

export function getGithubAppConfig(githubApps: GitHubAppMap | undefined, appKey: string | undefined): GitHubAppConfig | null {
  const normalized = normalizeGithubAppKey(appKey) ?? DEFAULT_GITHUB_APP_KEY
  return githubApps?.[normalized] ?? null
}

export function listGithubApps(githubApps: GitHubAppMap | undefined): Array<{ key: string; config: GitHubAppConfig }> {
  return Object.entries(githubApps ?? {}).map(([key, config]) => ({ key, config }))
}

export function hasGithubAppCredentials(config: GitHubAppConfig | null | undefined): boolean {
  return Boolean(config?.appId && config?.privateKey)
}

export function canMountGithubWebhook(config: GitHubAppConfig | null | undefined): boolean {
  return Boolean(config?.appId && config?.privateKey && config?.webhookSecret)
}

export function listTenantGithubAppBindings(tenant: TenantConfig): GitHubAppBindingConfig[] {
  return tenant.github?.apps ?? []
}

export function getTenantGithubAppBinding(
  tenant: TenantConfig,
  appKey: string | undefined
): GitHubAppBindingConfig | null {
  const normalized = normalizeGithubAppKey(appKey) ?? DEFAULT_GITHUB_APP_KEY
  return listTenantGithubAppBindings(tenant).find(binding => binding.appKey === normalized) ?? null
}

export function tenantSupportsGithubApp(tenant: TenantConfig, appKey: string | undefined): boolean {
  return Boolean(getTenantGithubAppBinding(tenant, appKey))
}

export function findTenantByGithubInstallation(
  config: AppConfig,
  installationId: number | undefined,
  appKey?: string
): TenantConfig | null {
  if (!installationId) return null
  const normalizedAppKey = normalizeGithubAppKey(appKey)

  return config.tenants.find(tenant => {
    const bindings = listTenantGithubAppBindings(tenant)
    if (normalizedAppKey) {
      return bindings.some(binding => binding.appKey === normalizedAppKey && binding.installationId === installationId)
    }
    return bindings.some(binding => binding.installationId === installationId)
  }) ?? null
}

export function findTenantByRepoFullNameForGithubApp(
  config: AppConfig,
  fullName: string,
  appKey?: string
): TenantConfig | null {
  const normalizedAppKey = normalizeGithubAppKey(appKey)
  const repoFullName = fullName.toLowerCase()
  return config.tenants.find(tenant => {
    if (normalizedAppKey && !tenantSupportsGithubApp(tenant, normalizedAppKey)) {
      return false
    }
    return tenant.repos.some(repo => repo.fullName.toLowerCase() === repoFullName)
  }) ?? null
}

export function resolveRepoForGithubApp(repo: RepoConfig, appKey?: string): RepoConfig {
  const normalized = normalizeGithubAppKey(appKey)
  if (!normalized) return repo
  const override = repo.githubApps?.[normalized]
  if (!override) return repo

  return {
    ...repo,
    backend: override.backend ?? repo.backend,
    agent: override.agent ?? repo.agent,
    model: override.model ?? repo.model,
    baseBranch: override.baseBranch ?? repo.baseBranch,
    branchPrefix: override.branchPrefix ?? repo.branchPrefix
  }
}

export function selectDefaultGithubAppKeyForRepo(tenant: TenantConfig, repo: RepoConfig): string | null {
  const bindings = listTenantGithubAppBindings(tenant)
  if (bindings.length === 0) return null
  if (bindings.length === 1) return bindings[0].appKey

  const baseBackend = repo.backend ?? "codex"
  const matchingBackend = bindings.filter(binding => {
    const overrideBackend = repo.githubApps?.[binding.appKey]?.backend
    return !overrideBackend || overrideBackend === baseBackend
  })

  const preferred = matchingBackend.find(binding => binding.appKey === baseBackend)
  if (preferred) return preferred.appKey
  if (matchingBackend.length === 1) return matchingBackend[0].appKey
  if (matchingBackend.length > 0) return matchingBackend[0].appKey
  return bindings[0].appKey
}

export function selectGithubAppKeyForBackend(
  tenant: TenantConfig,
  repo: RepoConfig,
  backend: AgentBackend
): string | null {
  const bindings = listTenantGithubAppBindings(tenant)
  if (bindings.length === 0) return null

  const matching = bindings.filter(binding => {
    const overrideBackend = repo.githubApps?.[binding.appKey]?.backend
    const effectiveBackend = overrideBackend ?? repo.backend ?? "codex"
    return effectiveBackend === backend
  })

  const preferred = matching.find(binding => binding.appKey === backend)
  if (preferred) return preferred.appKey
  if (matching.length > 0) return matching[0].appKey
  return selectDefaultGithubAppKeyForRepo(tenant, repo)
}

export function buildGithubPollStateKey(input: {
  repoFullName: string
  appKey?: string
  scope?: "comments" | "discussion" | "pr-review"
}): string {
  const normalizedAppKey = normalizeGithubAppKey(input.appKey) ?? DEFAULT_GITHUB_APP_KEY
  const parts = [input.repoFullName.toLowerCase(), `app:${normalizedAppKey}`]
  if (input.scope && input.scope !== "comments") {
    parts.push(input.scope)
  }
  return parts.join("#")
}

export function runUsesGithubApp(run: Pick<RunRecord, "github"> | null | undefined, appKey: string): boolean {
  if (!run?.github) return false
  const latestAppKey = normalizeGithubAppKey(run.github.appKey) ?? DEFAULT_GITHUB_APP_KEY
  const expectedAppKey = normalizeGithubAppKey(appKey) ?? DEFAULT_GITHUB_APP_KEY
  return latestAppKey === expectedAppKey
}

export function createGitHubInstallationClientFactory(githubApps: GitHubAppMap, ttlMs = 50 * 60 * 1000) {
  const cache = new Map<string, { client: InstallationClient; expiresAt: number }>()

  return async (appKey: string, installationId: number): Promise<InstallationClient> => {
    const normalizedAppKey = normalizeGithubAppKey(appKey) ?? DEFAULT_GITHUB_APP_KEY
    const cacheKey = `${normalizedAppKey}:${installationId}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.client
    }

    const app = getGithubAppConfig(githubApps, normalizedAppKey)
    if (!app?.appId || !app.privateKey) {
      throw new Error(`GitHub app '${normalizedAppKey}' is missing appId/privateKey`)
    }

    const client = await createInstallationClient({
      appId: app.appId,
      privateKey: formatPrivateKey(app.privateKey),
      installationId
    })
    cache.set(cacheKey, { client, expiresAt: Date.now() + ttlMs })
    return client
  }
}
