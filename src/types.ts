export type SlackConfig = {
  teamId: string
  commandPrefixes: string[]
}

export type AgentBackend = "codex" | "opencode"

export type GitHubAppConfig = {
  appId?: number
  privateKey?: string
  webhookSecret?: string
  commandPrefixes?: string[]
}

export type GitHubAppBindingConfig = {
  appKey: string
  installationId?: number
  repoAllowlist?: string[]
  commandPrefixes?: string[]
  assignmentAssignees?: string[]
}

export type GitHubConfig = {
  apps: GitHubAppBindingConfig[]
}

export type VibeAgentsIntegrationConfig = {
  endpoint: string
  token?: string
  author?: string
  project?: string
  enabled?: boolean
  timeoutMs?: number
}

export type OpenCodeIntegrationConfig = {
  baseUrl: string
  username?: string
  password?: string
  enabled?: boolean
  timeoutMs?: number
  pollIntervalMs?: number
}

export type IntegrationsConfig = {
  vibeAgents?: VibeAgentsIntegrationConfig
  opencode?: OpenCodeIntegrationConfig
}

export type RepoGitHubAppConfig = {
  backend?: AgentBackend
  agent?: string
  model?: string
  baseBranch?: string
  branchPrefix?: string
}

export type RepoConfig = {
  fullName: string
  path?: string
  backend?: AgentBackend
  agent?: string
  model?: string
  baseBranch?: string
  branchPrefix?: string
  githubApps?: Record<string, RepoGitHubAppConfig>
}

export type TenantConfig = {
  id: string
  name: string
  slack?: SlackConfig
  github?: GitHubConfig
  repos: RepoConfig[]
  defaultRepo?: string
}

export type SecretsConfig = {
  githubApps?: Record<string, GitHubAppConfig>
  codexNotifyToken?: string
  vibeAgentsToken?: string
  opencodePassword?: string
}

export type AppConfig = {
  secrets?: SecretsConfig
  integrations?: IntegrationsConfig
  tenants: TenantConfig[]
}

export type SlackContext = {
  channel: string
  threadTs: string
  messageTs?: string
  userId?: string
}

export type GitHubContext = {
  appKey?: string
  owner: string
  repo: string
  issueNumber?: number
  commentId?: number
  triggerCommentId?: number
  installationId?: number
  issueTitle?: string
  issueBody?: string
}

export type RunStatus = "queued" | "running" | "failed" | "succeeded" | "no_changes"

export type RunRecord = {
  id: string
  tenantId: string
  repoFullName: string
  repoPath: string
  sourceKey?: string
  status: RunStatus
  prompt: string
  backend?: AgentBackend
  agent?: string
  model?: string
  branchPrefix?: string
  slack?: SlackContext
  github?: GitHubContext
  branchName?: string
  prNumber?: number
  prUrl?: string
  createdAt: string
  updatedAt: string
}

export type RunEvent = {
  runId: string
  seq: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}
