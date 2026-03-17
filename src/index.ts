import express from "express"
import { WebClient } from "@slack/web-api"
import { loadConfig, loadEnv } from "./config.js"
import { createStore } from "./storage.js"
import { createQueue, startWorker } from "./queue.js"
import { createRunService } from "./run-service.js"
import { createRunner } from "./runner.js"
import { startSlack } from "./slack.js"
import { createGitHubApp } from "./github.js"
import { resolveRepo, ensureRepoPath } from "./repo.js"
import { logger } from "./logger.js"
import { startGitHubPolling } from "./github-poll.js"
import { createCodexNotifyHandler } from "./codex-notify.js"
import type { AppConfig } from "./types.js"
import { createVibeAgentsSink } from "./vibe-agents.js"
import { getTenantGithubAppBinding, type GitHubAppMap, selectGithubAppKeyForBackend } from "./github-apps.js"

const main = async () => {
  const env = loadEnv()
  const config = await loadConfig(env.configPath)
  const secrets = resolveRuntimeSecrets(config, env)
  const integrations = resolveRuntimeIntegrations(config, env, secrets)
  const vibeAgentsSink = createVibeAgentsSink(integrations.vibeAgents)

  const store = createStore(env.databaseUrl)
  await store.ensureSchema()

  const { queue } = createQueue(env.redisUrl, env.queueMode)
  const slackClient = env.slackBotToken ? new WebClient(env.slackBotToken) : undefined

  const runService = createRunService({
    store,
    queue,
    slackClient,
    githubApps: secrets.githubApps,
    vibeAgents: vibeAgentsSink
  })

  if (env.role === "all" || env.role === "worker") {
    const runner = createRunner({
      store,
      slackClient,
      env: {
        codexPath: env.codexPath,
        codexApiKey: env.codexApiKey,
        codexTurnTimeoutMs: env.codexTurnTimeoutMs,
        opencodeBaseUrl: integrations.opencode?.baseUrl,
        opencodeUsername: integrations.opencode?.username,
        opencodePassword: integrations.opencode?.password,
        opencodeEnabled: integrations.opencode?.enabled ?? false,
        opencodeTimeoutMs: integrations.opencode?.timeoutMs,
        opencodePollIntervalMs: integrations.opencode?.pollIntervalMs,
        githubApps: secrets.githubApps
      },
      vibeAgents: vibeAgentsSink
    })
    startWorker(env.redisUrl, runner, env.queueMode)
    logger.info("Worker started")
  }

  if (env.role === "all" || env.role === "api") {
    const app = express()

    app.get("/health", (_req, res) => {
      res.json({ status: "ok" })
    })

    const github = createGitHubApp(config, store, {
      githubApps: secrets.githubApps,
      codexPath: env.codexPath,
      codexTurnTimeoutMs: env.codexTurnTimeoutMs
    }, async input => {
      const tenant = config.tenants.find(t => t.id === input.tenantId)
      if (!tenant) return
      const repo = resolveRepo(tenant, input.repoFullName, input.github.appKey)
      if (!repo) return
      const repoPath = await ensureRepoPath(repo)
      const prompt = input.commandType === "reply"
        ? [`Follow-up command from GitHub issue #${input.github.issueNumber}:`, input.prompt].join("\n\n")
        : input.prompt

      await runService.createRun({
        tenantId: tenant.id,
        repoFullName: repo.fullName,
        repoPath,
        sourceKey: input.sourceKey,
        prompt,
        backend: repo.backend,
        agent: repo.agent,
        model: repo.model,
        branchPrefix: repo.branchPrefix,
        github: input.github
      })
    })
    if (github) github.mount(app)

    // Keep webhook payload raw for signature verification by Probot middleware.
    app.use(express.json({ limit: "1mb" }))

    app.post("/codex/notify", createCodexNotifyHandler({
      config,
      githubApps: secrets.githubApps,
      ingestToken: secrets.codexNotifyToken
    }))

    await app.listen(env.port)
    logger.info({ port: env.port }, "API server started")

    await startSlack(config, env, async input => {
      const tenant = config.tenants.find(t => t.id === input.tenantId)
      if (!tenant) return
      const repo = resolveRepo(tenant, input.repoHint)
      if (!repo) return
      const repoPath = await ensureRepoPath(repo)
      const [owner, repoName] = repo.fullName.split("/")
      const backend = repo.backend ?? "codex"
      const appKey = selectGithubAppKeyForBackend(tenant, repo, backend)
      const githubBinding = appKey ? getTenantGithubAppBinding(tenant, appKey) : null
      const githubContext = githubBinding?.installationId ? {
        appKey: appKey ?? undefined,
        owner: input.issue?.owner ?? owner,
        repo: input.issue?.repo ?? repoName,
        issueNumber: input.issue?.issueNumber,
        installationId: githubBinding.installationId
      } : undefined

      await runService.createRun({
        tenantId: tenant.id,
        repoFullName: repo.fullName,
        repoPath,
        prompt: input.prompt,
        backend,
        agent: repo.agent,
        model: repo.model,
        branchPrefix: repo.branchPrefix,
        slack: input.slack,
        github: githubContext
      })
    })

    startGitHubPolling({
      config,
      store,
      runService,
      env: {
        githubApps: secrets.githubApps,
        githubPollIntervalSec: env.githubPollIntervalSec,
        githubPollBackfill: env.githubPollBackfill,
        codexPath: env.codexPath,
        codexTurnTimeoutMs: env.codexTurnTimeoutMs
      }
    })
  }
}

function resolveRuntimeSecrets(config: AppConfig, env: ReturnType<typeof loadEnv>) {
  const githubApps: GitHubAppMap = {
    ...(config.secrets?.githubApps ?? {})
  }

  const configuredDefault = githubApps.default ?? {}
  const resolvedDefault = {
    ...configuredDefault,
    appId: configuredDefault.appId ?? env.githubAppId,
    privateKey: configuredDefault.privateKey ?? env.githubPrivateKey,
    webhookSecret: configuredDefault.webhookSecret ?? env.githubWebhookSecret
  }
  if (resolvedDefault.appId || resolvedDefault.privateKey || resolvedDefault.webhookSecret || resolvedDefault.commandPrefixes) {
    githubApps.default = resolvedDefault
  }

  return {
    githubApps,
    codexNotifyToken: config.secrets?.codexNotifyToken ?? env.codexNotifyToken,
    vibeAgentsToken: config.secrets?.vibeAgentsToken ?? env.vibeAgentsToken,
    opencodePassword: config.secrets?.opencodePassword ?? env.opencodePassword
  }
}

function resolveRuntimeIntegrations(
  config: AppConfig,
  env: ReturnType<typeof loadEnv>,
  secrets: ReturnType<typeof resolveRuntimeSecrets>
) {
  const configuredVibe = config.integrations?.vibeAgents
  const configuredOpenCode = config.integrations?.opencode

  return {
    vibeAgents: !configuredVibe && !env.vibeAgentsEndpoint ? undefined : {
      endpoint: env.vibeAgentsEndpoint ?? configuredVibe?.endpoint ?? "",
      token: env.vibeAgentsToken ?? configuredVibe?.token ?? secrets.vibeAgentsToken,
      author: env.vibeAgentsAuthor ?? configuredVibe?.author,
      project: env.vibeAgentsProject ?? configuredVibe?.project,
      enabled: env.vibeAgentsEnabled ?? configuredVibe?.enabled ?? true,
      timeoutMs: env.vibeAgentsTimeoutMs ?? configuredVibe?.timeoutMs
    },
    opencode: !configuredOpenCode && !env.opencodeBaseUrl ? undefined : {
      baseUrl: env.opencodeBaseUrl ?? configuredOpenCode?.baseUrl ?? "",
      username: env.opencodeUsername ?? configuredOpenCode?.username,
      password: env.opencodePassword ?? configuredOpenCode?.password ?? secrets.opencodePassword,
      enabled: env.opencodeEnabled ?? configuredOpenCode?.enabled ?? true,
      timeoutMs: env.opencodeTimeoutMs ?? configuredOpenCode?.timeoutMs,
      pollIntervalMs: env.opencodePollIntervalMs ?? configuredOpenCode?.pollIntervalMs
    }
  }
}

main().catch(err => {
  logger.error(err)
  process.exit(1)
})
