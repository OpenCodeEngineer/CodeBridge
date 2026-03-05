import { Probot, createNodeMiddleware } from "probot"
import type { Express } from "express"
import { extractCommand, extractCommandFromManagedIssue, type CommandType } from "./commands.js"
import { findTenantByGithubInstallation, findTenantByRepoFullName, resolveRepo } from "./repo.js"
import type { AppConfig, GitHubContext, TenantConfig } from "./types.js"
import { logger } from "./logger.js"
import { formatPrivateKey } from "./github-auth.js"
import {
  buildAssigneeMentionPrefixes,
  mergeGithubCommandPrefixes,
  resolveDefaultGithubCommandPrefixes,
  resolveGithubAppIdentity
} from "./command-prefixes.js"

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
  const defaultPrefixesPromise = resolveDefaultGithubCommandPrefixes({
    githubAppId: env.githubAppId,
    githubPrivateKey: env.githubPrivateKey
  })
  const appIdentityPromise = resolveGithubAppIdentity({
    githubAppId: env.githubAppId,
    githubPrivateKey: env.githubPrivateKey
  })

  const appFn = (app: Probot) => {
    app.on("issue_comment.created", async context => {
      const installationId = context.payload.installation?.id
      const repoFullName = context.payload.repository.full_name
      const defaultTenant = findTenantByGithubInstallation(config, installationId) ?? findTenantByRepoFullName(config, repoFullName)
      if (!defaultTenant?.github) return

      if (defaultTenant.github.repoAllowlist && !defaultTenant.github.repoAllowlist.includes(repoFullName)) return

      const defaultPrefixes = await defaultPrefixesPromise
      const assigneePrefixes = buildAssigneeMentionPrefixes(defaultTenant.github.assignmentAssignees)
      const prefixes = mergeGithubCommandPrefixes(
        assigneePrefixes,
        defaultPrefixes
      )
      const body = context.payload.comment.body ?? ""
      const issueManaged = hasManagedLabel(context.payload.issue.labels)
      const command = extractCommand(body, prefixes) ?? (issueManaged ? extractCommandFromManagedIssue(body) : null)
      if (!command) return
      if (command.type !== "run" && command.type !== "reply") return

      const tenant = resolveTargetTenant({
        config,
        defaultTenant,
        tenantHint: command.tenantHint,
        installationId,
        repoFullName
      })
      if (!tenant) return

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

    app.on("discussion_comment.created", async context => {
      const installationId = context.payload.installation?.id
      const repoFullName = context.payload.repository.full_name
      const defaultTenant = findTenantByGithubInstallation(config, installationId) ?? findTenantByRepoFullName(config, repoFullName)
      if (!defaultTenant?.github) return

      if (defaultTenant.github.repoAllowlist && !defaultTenant.github.repoAllowlist.includes(repoFullName)) return

      const defaultPrefixes = await defaultPrefixesPromise
      const assigneePrefixes = buildAssigneeMentionPrefixes(defaultTenant.github.assignmentAssignees)
      const prefixes = mergeGithubCommandPrefixes(
        assigneePrefixes,
        defaultPrefixes
      )
      const body = context.payload.comment.body ?? ""
      const command = extractCommand(body, prefixes)
      if (!command) return
      if (command.type !== "run" && command.type !== "reply") return

      const tenant = resolveTargetTenant({
        config,
        defaultTenant,
        tenantHint: command.tenantHint,
        installationId,
        repoFullName
      })
      if (!tenant) return

      const repo = resolveRepo(tenant, repoFullName)
      if (!repo) return

      const discussion = context.payload.discussion
      const sourceKey = [
        "github-discussion",
        installationId ?? "none",
        repoFullName.toLowerCase(),
        discussion.number,
        context.payload.comment.node_id ?? context.payload.comment.id,
        command.type
      ].join(":")
      const github: GitHubContext = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issueNumber: discussion.number,
        installationId,
        issueTitle: discussion.title,
        issueBody: discussion.body ?? undefined
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

    app.on("issues.assigned", async context => {
      const installationId = context.payload.installation?.id
      const repoFullName = context.payload.repository.full_name
      const tenant = findTenantByGithubInstallation(config, installationId) ?? findTenantByRepoFullName(config, repoFullName)
      if (!tenant?.github) return
      if (tenant.github.repoAllowlist && !tenant.github.repoAllowlist.includes(repoFullName)) return

      const appIdentity = await appIdentityPromise
      const assignee = context.payload.assignee?.login?.toLowerCase()
      const allowedAssignees = resolveAssignmentAssignees(tenant.github.assignmentAssignees, appIdentity?.botLogin)
      if (!assignee || allowedAssignees.size === 0 || !allowedAssignees.has(assignee)) return
      if (hasManagedLabel(context.payload.issue.labels)) return

      const repo = resolveRepo(tenant, repoFullName)
      if (!repo) return

      const issue = context.payload.issue
      const sourceKey = [
        "github-assigned",
        installationId ?? "none",
        repoFullName.toLowerCase(),
        issue.number
      ].join(":")
      const github: GitHubContext = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issueNumber: issue.number,
        installationId,
        issueTitle: issue.title,
        issueBody: issue.body ?? undefined
      }

      await onCommand({
        tenantId: tenant.id,
        commandType: "run",
        prompt: buildIssueBootstrapPrompt(issue.number, issue.title, issue.body ?? undefined),
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

function resolveTargetTenant(input: {
  config: AppConfig
  defaultTenant: TenantConfig
  tenantHint?: string
  installationId?: number
  repoFullName: string
}): TenantConfig | null {
  if (!input.tenantHint) return input.defaultTenant

  const target = input.config.tenants.find(t => t.id.toLowerCase() === input.tenantHint?.toLowerCase())
  if (!target?.github) {
    logger.warn({ tenantHint: input.tenantHint }, "Ignoring command: tenant hint did not match any GitHub-enabled tenant")
    return null
  }

  if (input.installationId && target.github.installationId && target.github.installationId !== input.installationId) {
    logger.warn({
      tenantHint: input.tenantHint,
      installationId: input.installationId,
      tenantInstallationId: target.github.installationId
    }, "Ignoring command: tenant hint installation mismatch")
    return null
  }

  const repoMatch = target.repos.some(repo => repo.fullName.toLowerCase() === input.repoFullName.toLowerCase())
  if (!repoMatch) {
    logger.warn({
      tenantHint: input.tenantHint,
      repoFullName: input.repoFullName
    }, "Ignoring command: tenant hint repo mismatch")
    return null
  }

  if (target.github.repoAllowlist && !target.github.repoAllowlist.some(repo => repo.toLowerCase() === input.repoFullName.toLowerCase())) {
    logger.warn({
      tenantHint: input.tenantHint,
      repoFullName: input.repoFullName
    }, "Ignoring command: tenant hint blocked by repo allowlist")
    return null
  }

  return target
}

function hasManagedLabel(labels?: Array<{ name?: string } | string>): boolean {
  if (!labels || labels.length === 0) return false
  return labels.some(label => {
    const name = typeof label === "string" ? label : label.name
    return name?.toLowerCase() === "agent:managed"
  })
}

function buildIssueBootstrapPrompt(issueNumber: number, title: string, body?: string): string {
  const bodyText = body?.trim() ? body.trim() : "(No description provided)"
  return [
    `Work on GitHub issue #${issueNumber}: ${title}`,
    "",
    "Issue description:",
    bodyText
  ].join("\n")
}

function resolveAssignmentAssignees(configured: string[] | undefined, botLogin?: string): Set<string> {
  const values = new Set<string>()
  if (botLogin) values.add(botLogin.trim().toLowerCase())
  for (const value of configured ?? []) {
    const normalized = value.trim().toLowerCase()
    if (!normalized) continue
    values.add(normalized)
  }
  return values
}
