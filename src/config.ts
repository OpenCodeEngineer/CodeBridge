import { config as loadDotenv } from "dotenv"
import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import yaml from "js-yaml"
import { z } from "zod"
import type { AppConfig } from "./types.js"

loadDotenv()

const repoSchema = z.object({
  fullName: z.string(),
  path: z.string(),
  model: z.string().optional(),
  baseBranch: z.string().optional(),
  branchPrefix: z.string().optional()
})

const slackSchema = z.object({
  teamId: z.string(),
  commandPrefixes: z.array(z.string()).min(1)
})

const githubSchema = z.object({
  installationId: z.number().optional(),
  repoAllowlist: z.array(z.string()).optional(),
  commandPrefixes: z.array(z.string()).optional()
})

const tenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  slack: slackSchema.optional(),
  github: githubSchema.optional(),
  repos: z.array(repoSchema),
  defaultRepo: z.string().optional()
})

const appSchema = z.object({
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
  codexNotifyToken?: string
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
    codexNotifyToken: process.env.CODEBRIDGE_NOTIFY_TOKEN ?? process.env.CODEX_BRIDGE_NOTIFY_TOKEN,
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
  return result.data
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
