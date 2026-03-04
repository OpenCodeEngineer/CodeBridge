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

const main = async () => {
  const env = loadEnv()
  const config = await loadConfig(env.configPath)

  const store = createStore(env.databaseUrl)
  await store.ensureSchema()

  const { queue } = createQueue(env.redisUrl, env.queueMode)
  const slackClient = env.slackBotToken ? new WebClient(env.slackBotToken) : undefined

  const runService = createRunService({
    store,
    queue,
    slackClient,
    githubAppId: env.githubAppId,
    githubPrivateKey: env.githubPrivateKey
  })

  if (env.role === "all" || env.role === "worker") {
    const runner = createRunner({
      store,
      slackClient,
      env: {
        codexPath: env.codexPath,
        codexApiKey: env.codexApiKey,
        githubAppId: env.githubAppId,
        githubPrivateKey: env.githubPrivateKey
      }
    })
    startWorker(env.redisUrl, runner, env.queueMode)
    logger.info("Worker started")
  }

  if (env.role === "all" || env.role === "api") {
    const app = express()
    app.use(express.json({ limit: "1mb" }))

    app.get("/health", (_req, res) => {
      res.json({ status: "ok" })
    })
    app.post("/codex/notify", createCodexNotifyHandler({
      config,
      githubAppId: env.githubAppId,
      githubPrivateKey: env.githubPrivateKey,
      ingestToken: env.codexNotifyToken
    }))

    const github = createGitHubApp(config, env, async input => {
      const tenant = config.tenants.find(t => t.id === input.tenantId)
      if (!tenant) return
      const repo = resolveRepo(tenant, input.repoFullName)
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
        model: repo.model,
        branchPrefix: repo.branchPrefix,
        github: input.github
      })
    })
    if (github) github.mount(app)

    await app.listen(env.port)
    logger.info({ port: env.port }, "API server started")

    await startSlack(config, env, async input => {
      const tenant = config.tenants.find(t => t.id === input.tenantId)
      if (!tenant) return
      const repo = resolveRepo(tenant, input.repoHint)
      if (!repo) return
      const repoPath = await ensureRepoPath(repo)
      const [owner, repoName] = repo.fullName.split("/")
      const githubContext = tenant.github?.installationId ? {
        owner: input.issue?.owner ?? owner,
        repo: input.issue?.repo ?? repoName,
        issueNumber: input.issue?.issueNumber,
        installationId: tenant.github.installationId
      } : undefined

      await runService.createRun({
        tenantId: tenant.id,
        repoFullName: repo.fullName,
        repoPath,
        prompt: input.prompt,
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
        githubAppId: env.githubAppId,
        githubPrivateKey: env.githubPrivateKey,
        githubPollIntervalSec: env.githubPollIntervalSec,
        githubPollBackfill: env.githubPollBackfill
      }
    })
  }
}

main().catch(err => {
  logger.error(err)
  process.exit(1)
})
