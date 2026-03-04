import { Probot, createNodeMiddleware } from "probot"
import type { Express } from "express"
import { extractCommand, type CommandType } from "./commands.js"
import { findTenantByGithubInstallation, findTenantByRepoFullName, resolveRepo } from "./repo.js"
import type { AppConfig, GitHubContext } from "./types.js"
import { logger } from "./logger.js"
import { formatPrivateKey } from "./github-auth.js"

export type GitHubCommandHandler = (input: {
  tenantId: string
  commandType: CommandType
  prompt: string
  repoFullName: string
  sourceKey: string
  github: GitHubContext
}) => Promise<void>

export function createGitHubApp(
  config: AppConfig,
  env: {
    githubAppId?: number
    githubPrivateKey?: string
    githubWebhookSecret?: string
  },
  onCommand: GitHubCommandHandler
) {
  if (!env.githubAppId || !env.githubPrivateKey || !env.githubWebhookSecret) {
    return null
  }

  const probot = new Probot({
    appId: env.githubAppId,
    privateKey: formatPrivateKey(env.githubPrivateKey),
    secret: env.githubWebhookSecret
  })

  const appFn = (app: Probot) => {
    app.on("issue_comment.created", async context => {
      const installationId = context.payload.installation?.id
      const repoFullName = context.payload.repository.full_name
      const tenant = findTenantByGithubInstallation(config, installationId) ?? findTenantByRepoFullName(config, repoFullName)
      if (!tenant?.github) return

      if (tenant.github.repoAllowlist && !tenant.github.repoAllowlist.includes(repoFullName)) return

      const prefixes = tenant.github.commandPrefixes ?? ["codex:", "/codex", "@codex"]
      const body = context.payload.comment.body ?? ""
      const command = extractCommand(body, prefixes)
      if (!command) return
      if (command.type !== "run" && command.type !== "reply") return

      const repo = resolveRepo(tenant, repoFullName)
      if (!repo) return

      const issue = context.payload.issue
      const sourceKey = [
        "github",
        installationId ?? "none",
        repoFullName.toLowerCase(),
        issue.number,
        context.payload.comment.id,
        command.type
      ].join(":")
      const github: GitHubContext = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issueNumber: issue.number,
        triggerCommentId: context.payload.comment.id,
        installationId,
        issueTitle: issue.title,
        issueBody: issue.body ?? undefined
      }

      await onCommand({
        tenantId: tenant.id,
        commandType: command.type,
        prompt: command.prompt,
        repoFullName: repo.fullName,
        sourceKey,
        github
      })
    })
  }

  probot.load(appFn)
  const middleware = createNodeMiddleware(appFn, {
    probot,
    webhooksPath: "/github/webhook"
  })

  const mount = (app: Express) => {
    app.use(middleware)
    logger.info("GitHub webhook mounted at /github/webhook")
  }

  return { probot, mount }
}
