import { config as loadDotenv } from "dotenv"
import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import yaml from "js-yaml"
import { z } from "zod"
import type {
  AppConfig,
  GitHubAppBindingConfig,
  GitHubAppConfig,
  GitHubConfig,
  RepoGitHubAppConfig
} from "./types.js"

loadDotenv()

const repoGithubAppSchema = z.object({
  backend: z.enum(["codex", "opencode"]).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  baseBranch: z.string().optional(),
  branchPrefix: z.string().optional()
})

const repoSchema = z.object({
  fullName: z.string(),
  path: z.string(),
  backend: z.enum(["codex", "opencode"]).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  baseBranch: z.string().optional(),
  branchPrefix: z.string().optional(),
  githubApps: z.record(repoGithubAppSchema).optional()
})

const slackSchema = z.object({
  teamId: z.string(),
  commandPrefixes: z.array(z.string()).min(1)
})

const githubAppBindingSchema = z.object({
  appKey: z.string(),
  installationId: z.number().optional(),
  repoAllowlist: z.array(z.string()).optional(),
  commandPrefixes: z.array(z.string()).optional(),
  assignmentAssignees: z.array(z.string()).optional()
})

const githubSchema = z.object({
  installationId: z.number().optional(),
  repoAllowlist: z.array(z.string()).optional(),
  commandPrefixes: z.array(z.string()).optional(),
  assignmentAssignees: z.array(z.string()).optional(),
  apps: z.array(githubAppBindingSchema).optional()
})

const tenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  slack: slackSchema.optional(),
  github: githubSchema.optional(),
  repos: z.array(repoSchema),
  defaultRepo: z.string().optional()
})

const githubAppSchema = z.object({
  appId: z.number().optional(),
  privateKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  commandPrefixes: z.array(z.string()).optional()
})

const secretsSchema = z.object({
  githubApps: z.record(githubAppSchema).optional(),
  githubAppId: z.number().optional(),
  githubPrivateKey: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
  codexNotifyToken: z.string().optional(),
  vibeAgentsToken: z.string().optional(),
  opencodePassword: z.string().optional()
})

const vibeAgentsSchema = z.object({
  endpoint: z.string().url(),
  token: z.string().optional(),
  author: z.string().optional(),
  project: z.string().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
})

const opencodeSchema = z.object({
  baseUrl: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  pollIntervalMs: z.number().int().positive().optional()
})

const integrationsSchema = z.object({
  vibeAgents: vibeAgentsSchema.optional(),
  opencode: opencodeSchema.optional()
})

const appSchema = z.object({
  secrets: secretsSchema.optional(),
  integrations: integrationsSchema.optional(),
  tenants: z.array(tenantSchema)
})

export type EnvConfig = {
  port: number
  role: "all" | "api" | "worker"
  databaseUrl: string
  redisUrl?: string
  queueMode: "redis" | "memory"
  slackBotToken?: string
  slackAppToken?: string
  slackSigningSecret?: string
  githubAppId?: number
  githubPrivateKey?: string
  githubWebhookSecret?: string
  githubPollIntervalSec: number
  githubPollBackfill: boolean
  codexPath?: string
  codexApiKey?: string
  codexTurnTimeoutMs: number
  codexNotifyToken?: string
  vibeAgentsEndpoint?: string
  vibeAgentsToken?: string
  vibeAgentsAuthor?: string
  vibeAgentsProject?: string
  vibeAgentsEnabled?: boolean
  vibeAgentsTimeoutMs?: number
  opencodeBaseUrl?: string
  opencodeUsername?: string
  opencodePassword?: string
  opencodeEnabled?: boolean
  opencodeTimeoutMs?: number
  opencodePollIntervalMs?: number
  configPath: string
}

export function loadEnv(): EnvConfig {
  const role = (process.env.ROLE ?? "all") as EnvConfig["role"]
  const port = parseInt(process.env.PORT ?? "8788", 10)
  const databaseUrl = process.env.DATABASE_URL ?? "sqlite://./data/codebridge.db"
  const redisUrl = process.env.REDIS_URL
  const queueMode = parseQueueMode(process.env.QUEUE_MODE, redisUrl)
  const configPath = process.env.CONFIG_PATH ?? resolveDefaultConfigPath()
  const githubAppId = process.env.GITHUB_APP_ID ? parseInt(process.env.GITHUB_APP_ID, 10) : undefined
  const githubPollIntervalSec = parseInt(process.env.GITHUB_POLL_INTERVAL ?? "0", 10)
  const githubPollBackfill = parseBoolean(process.env.GITHUB_POLL_BACKFILL ?? "false")
  const codexTurnTimeoutMs = parseInt(process.env.CODEX_TURN_TIMEOUT_MS ?? "300000", 10)
  const vibeAgentsTimeoutMsRaw = process.env.VIBE_AGENTS_TIMEOUT_MS
  const vibeAgentsTimeoutMsParsed = vibeAgentsTimeoutMsRaw ? parseInt(vibeAgentsTimeoutMsRaw, 10) : undefined
  const opencodeTimeoutMsRaw = process.env.OPENCODE_TIMEOUT_MS
  const opencodeTimeoutMsParsed = opencodeTimeoutMsRaw ? parseInt(opencodeTimeoutMsRaw, 10) : undefined
  const opencodePollIntervalMsRaw = process.env.OPENCODE_POLL_INTERVAL_MS
  const opencodePollIntervalMsParsed = opencodePollIntervalMsRaw ? parseInt(opencodePollIntervalMsRaw, 10) : undefined

  return {
    port,
    role,
    databaseUrl,
    redisUrl,
    queueMode,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    githubAppId,
    githubPrivateKey: process.env.GITHUB_PRIVATE_KEY,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubPollIntervalSec,
    githubPollBackfill,
    codexPath: process.env.CODEX_PATH,
    codexApiKey: process.env.CODEX_API_KEY,
    codexTurnTimeoutMs: Number.isFinite(codexTurnTimeoutMs) && codexTurnTimeoutMs > 0 ? codexTurnTimeoutMs : 300000,
    codexNotifyToken: process.env.CODEBRIDGE_NOTIFY_TOKEN ?? process.env.CODEX_BRIDGE_NOTIFY_TOKEN,
    vibeAgentsEndpoint: process.env.VIBE_AGENTS_ENDPOINT,
    vibeAgentsToken: process.env.VIBE_AGENTS_TOKEN,
    vibeAgentsAuthor: process.env.VIBE_AGENTS_AUTHOR,
    vibeAgentsProject: process.env.VIBE_AGENTS_PROJECT,
    vibeAgentsEnabled: process.env.VIBE_AGENTS_ENABLED ? parseBoolean(process.env.VIBE_AGENTS_ENABLED) : undefined,
    vibeAgentsTimeoutMs: Number.isFinite(vibeAgentsTimeoutMsParsed) ? vibeAgentsTimeoutMsParsed : undefined,
    opencodeBaseUrl: process.env.OPENCODE_BASE_URL,
    opencodeUsername: process.env.OPENCODE_USERNAME ?? process.env.OPENCODE_SERVER_USERNAME,
    opencodePassword: process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD,
    opencodeEnabled: process.env.OPENCODE_ENABLED ? parseBoolean(process.env.OPENCODE_ENABLED) : undefined,
    opencodeTimeoutMs: Number.isFinite(opencodeTimeoutMsParsed) ? opencodeTimeoutMsParsed : undefined,
    opencodePollIntervalMs: Number.isFinite(opencodePollIntervalMsParsed) ? opencodePollIntervalMsParsed : undefined,
    configPath
  }
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = await readFile(configPath, "utf8")
  const parsed = yaml.load(raw)
  const result = appSchema.safeParse(parsed)
  if (!result.success) {
    const message = result.error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("; ")
    throw new Error(`Invalid config: ${message}`)
  }
  return normalizeConfig(result.data)
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function parseQueueMode(value: string | undefined, redisUrl?: string): "redis" | "memory" {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "memory") return "memory"
  if (normalized === "redis") return "redis"
  if (!redisUrl || redisUrl === "memory") return "memory"
  return "redis"
}

function resolveDefaultConfigPath(): string {
  const home = os.homedir()
  const candidates = [
    path.join(process.cwd(), "config", "tenants.yaml"),
    path.join(process.cwd(), "config", "tenants.yml"),
    path.join(home, ".config", "codebridge", "config.yaml"),
    path.join(home, ".config", "codebridge", "config.yml"),
    path.join(home, ".config", "codex-bridge", "config.yaml"),
    path.join(home, ".config", "codex-bridge", "config.yml")
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return path.join(process.cwd(), "config", "tenants.yaml")
}

function normalizeConfig(input: z.infer<typeof appSchema>): AppConfig {
  const secrets = normalizeSecretsConfig(input.secrets)

  return {
    secrets,
    integrations: input.integrations,
    tenants: input.tenants.map(tenant => ({
      ...tenant,
      github: normalizeTenantGitHubConfig(tenant.github),
      repos: tenant.repos.map(repo => ({
        ...repo,
        githubApps: normalizeRepoGitHubApps(repo.githubApps)
      }))
    }))
  }
}

function normalizeSecretsConfig(
  secrets: z.infer<typeof secretsSchema> | undefined
): AppConfig["secrets"] {
  if (!secrets) return undefined

  const githubApps = new Map<string, GitHubAppConfig>()
  for (const [rawKey, value] of Object.entries(secrets.githubApps ?? {})) {
    const key = normalizeGithubAppKey(rawKey)
    if (!key) continue
    githubApps.set(key, value)
  }

  const legacyDefault: GitHubAppConfig = {
    appId: secrets.githubAppId,
    privateKey: secrets.githubPrivateKey,
    webhookSecret: secrets.githubWebhookSecret
  }
  if (hasGitHubAppConfig(legacyDefault) && !githubApps.has("default")) {
    githubApps.set("default", legacyDefault)
  }

  const normalized: NonNullable<AppConfig["secrets"]> = {
    codexNotifyToken: secrets.codexNotifyToken,
    vibeAgentsToken: secrets.vibeAgentsToken,
    opencodePassword: secrets.opencodePassword
  }

  if (githubApps.size > 0) {
    normalized.githubApps = Object.fromEntries(githubApps.entries())
  }

  return hasAnySecretValue(normalized) ? normalized : undefined
}

function normalizeTenantGitHubConfig(
  github: z.infer<typeof githubSchema> | undefined
): GitHubConfig | undefined {
  if (!github) return undefined

  const apps = new Map<string, GitHubAppBindingConfig>()
  for (const binding of github.apps ?? []) {
    const appKey = normalizeGithubAppKey(binding.appKey)
    if (!appKey) continue
    apps.set(appKey, {
      appKey,
      installationId: binding.installationId,
      repoAllowlist: binding.repoAllowlist,
      commandPrefixes: binding.commandPrefixes,
      assignmentAssignees: binding.assignmentAssignees
    })
  }

  const legacyDefault: GitHubAppBindingConfig = {
    appKey: "default",
    installationId: github.installationId,
    repoAllowlist: github.repoAllowlist,
    commandPrefixes: github.commandPrefixes,
    assignmentAssignees: github.assignmentAssignees
  }
  if (hasGitHubAppBinding(legacyDefault) && !apps.has("default")) {
    apps.set("default", legacyDefault)
  }

  if (apps.size === 0) return undefined
  return { apps: Array.from(apps.values()) }
}

function normalizeRepoGitHubApps(
  githubApps: Record<string, z.infer<typeof repoGithubAppSchema>> | undefined
): Record<string, RepoGitHubAppConfig> | undefined {
  if (!githubApps) return undefined
  const normalizedEntries = Object.entries(githubApps)
    .map(([rawKey, value]) => {
      const key = normalizeGithubAppKey(rawKey)
      if (!key) return null
      return [key, value] as const
    })
    .filter((entry): entry is readonly [string, RepoGitHubAppConfig] => Boolean(entry))

  if (normalizedEntries.length === 0) return undefined
  return Object.fromEntries(normalizedEntries)
}

function normalizeGithubAppKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

function hasGitHubAppConfig(value: GitHubAppConfig | undefined): boolean {
  if (!value) return false
  return Boolean(
    value.appId ||
    value.privateKey ||
    value.webhookSecret ||
    (value.commandPrefixes && value.commandPrefixes.length > 0)
  )
}

function hasGitHubAppBinding(value: GitHubAppBindingConfig | undefined): boolean {
  if (!value) return false
  return Boolean(
    value.installationId ||
    (value.repoAllowlist && value.repoAllowlist.length > 0) ||
    (value.commandPrefixes && value.commandPrefixes.length > 0) ||
    (value.assignmentAssignees && value.assignmentAssignees.length > 0)
  )
}

function hasAnySecretValue(value: NonNullable<AppConfig["secrets"]>): boolean {
  return Boolean(
    value.githubApps ||
    value.codexNotifyToken ||
    value.vibeAgentsToken ||
    value.opencodePassword
  )
}
