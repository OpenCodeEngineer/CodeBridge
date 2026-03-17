import { Probot, createNodeMiddleware } from "probot"
import type { Express } from "express"
import type { CommandType } from "./commands.js"
import { resolveRepo } from "./repo.js"
import type { AppConfig, GitHubContext, TenantConfig } from "./types.js"
import type { RunStore } from "./storage.js"
import { logger } from "./logger.js"
import { formatPrivateKey } from "./github-auth.js"
import {
  buildGithubCommandPrefixes,
  resolveDefaultGithubCommandPrefixes,
  resolveGithubAppIdentity
} from "./command-prefixes.js"
import { dispatchSessionRelay, resolveSessionIdFromIssue } from "./codex-session-relay.js"
import {
  routeDiscussionCommentCommand,
  routeExplicitGitHubCommand,
  routeIssueCommentCommand,
  shouldRelayManagedIssueCommand
} from "./github-routing.js"
import { postControlAck, postDiscussionUnsupportedControl, postIssueStatus } from "./github-controls.js"
import {
  canMountGithubWebhook,
  findTenantByGithubInstallation,
  findTenantByRepoFullNameForGithubApp,
  getTenantGithubAppBinding,
  listGithubApps,
  runUsesGithubApp,
  type GitHubAppMap
} from "./github-apps.js"

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
  store: RunStore,
  env: {
    githubApps?: GitHubAppMap
    codexPath?: string
    codexTurnTimeoutMs: number
  },
  onCommand: GitHubCommandHandler
) {
  const mountedApps = listGithubApps(env.githubApps).filter(({ config: appConfig }) => canMountGithubWebhook(appConfig))
  if (mountedApps.length === 0) {
    return null
  }

  const webhooks = mountedApps.map(({ key: appKey, config: appConfig }) => {
    const probot = new Probot({
      appId: appConfig.appId!,
      privateKey: formatPrivateKey(appConfig.privateKey!),
      secret: appConfig.webhookSecret!
    })
    const defaultPrefixesPromise = resolveDefaultGithubCommandPrefixes({
      githubAppId: appConfig.appId,
      githubPrivateKey: appConfig.privateKey
    })
    const appIdentityPromise = resolveGithubAppIdentity({
      githubAppId: appConfig.appId,
      githubPrivateKey: appConfig.privateKey
    })

    const appFn = (app: Probot) => {
      app.on("issue_comment.created", async context => {
        const installationId = context.payload.installation?.id
        const repoFullName = context.payload.repository.full_name
        const defaultTenant = resolveDefaultTenantForGithubApp({
          config,
          appKey,
          installationId,
          repoFullName
        })
        if (!defaultTenant) return

        const githubBinding = getTenantGithubAppBinding(defaultTenant, appKey)
        if (!githubBinding) return

        const authorLogin = context.payload.comment.user?.login
        if (context.payload.comment.user?.type === "Bot" || authorLogin?.toLowerCase().endsWith("[bot]")) return
        if (githubBinding.repoAllowlist && !githubBinding.repoAllowlist.includes(repoFullName)) return

        const issueManaged = hasManagedLabel(context.payload.issue.labels)
        const defaultPrefixes = await defaultPrefixesPromise
        const prefixes = buildGithubCommandPrefixes({
          configured: [...(appConfig.commandPrefixes ?? []), ...(githubBinding.commandPrefixes ?? [])],
          assignmentAssignees: githubBinding.assignmentAssignees,
          defaultPrefixes
        })
        const body = context.payload.comment.body ?? ""
        const command = routeIssueCommentCommand({
          body,
          prefixes,
          issueManaged
        })
        if (!command) return

        const tenantResult = resolveTargetTenant({
          config,
          defaultTenant,
          tenantHint: command.tenantHint,
          installationId,
          repoFullName,
          appKey
        })
        if (!tenantResult.success) {
          await context.octokit.issues.createComment({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            issue_number: context.payload.issue.number,
            body: buildTenantErrorComment(tenantResult.error, tenantResult.validTenantIds)
          })
          return
        }

        const tenant = tenantResult.tenant
        const repo = resolveRepo(tenant, repoFullName, appKey)
        if (!repo) return

        const managedIssueOwnedByApp = issueManaged
          ? await isManagedIssueOwnedByApp({
            store,
            tenantId: tenant.id,
            repoFullName: repo.fullName,
            issueNumber: context.payload.issue.number,
            appKey
          })
          : false
        if (issueManaged && !command.explicit && !managedIssueOwnedByApp) return

        if (command.type === "status") {
          await postIssueStatus({
            tenantId: tenant.id,
            repoFullName: repo.fullName,
            issueNumber: context.payload.issue.number,
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            client: context.octokit as any,
            store
          })
          return
        }

        if (command.type === "pause" || command.type === "resume") {
          await postControlAck({
            commandType: command.type,
            issueNumber: context.payload.issue.number,
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            client: context.octokit as any
          })
          return
        }

        if (managedIssueOwnedByApp) {
          const sessionId = await resolveIssueSessionId(context)
          if (sessionId && shouldRelayManagedIssueCommand({ issueManaged, command })) {
            const relay = dispatchSessionRelay({
              sessionId,
              owner: context.payload.repository.owner.login,
              repo: context.payload.repository.name,
              issueNumber: context.payload.issue.number,
              commentId: context.payload.comment.id,
              commentBody: context.payload.comment.body ?? "",
              authorLogin,
              repoPath: repo.path,
              codexPath: env.codexPath,
              codexTurnTimeoutMs: env.codexTurnTimeoutMs,
              postIssueComment: async (replyBody) => {
                await context.octokit.issues.createComment({
                  owner: context.payload.repository.owner.login,
                  repo: context.payload.repository.name,
                  issue_number: context.payload.issue.number,
                  body: replyBody
                })
              }
            })
            if (relay.accepted) return
          }
        }

        const issue = context.payload.issue
        const sourceKey = [
          "github",
          appKey,
          installationId ?? "none",
          repoFullName.toLowerCase(),
          issue.number,
          context.payload.comment.id,
          command.type
        ].join(":")
        const github: GitHubContext = {
          appKey,
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

      app.on("pull_request_review_comment.created", async context => {
        const installationId = context.payload.installation?.id
        const repoFullName = context.payload.repository.full_name
        const defaultTenant = resolveDefaultTenantForGithubApp({
          config,
          appKey,
          installationId,
          repoFullName
        })
        if (!defaultTenant) return

        const githubBinding = getTenantGithubAppBinding(defaultTenant, appKey)
        if (!githubBinding) return

        const authorLogin = context.payload.comment.user?.login
        if (context.payload.comment.user?.type === "Bot" || authorLogin?.toLowerCase().endsWith("[bot]")) return
        if (githubBinding.repoAllowlist && !githubBinding.repoAllowlist.includes(repoFullName)) return

        const defaultPrefixes = await defaultPrefixesPromise
        const prefixes = buildGithubCommandPrefixes({
          configured: [...(appConfig.commandPrefixes ?? []), ...(githubBinding.commandPrefixes ?? [])],
          assignmentAssignees: githubBinding.assignmentAssignees,
          defaultPrefixes
        })
        const body = context.payload.comment.body ?? ""
        const command = routeExplicitGitHubCommand({
          body,
          prefixes
        })
        if (!command) return

        const owner = context.payload.repository.owner.login
        const repoName = context.payload.repository.name
        const issueNumber = context.payload.pull_request.number

        const tenantResult = resolveTargetTenant({
          config,
          defaultTenant,
          tenantHint: command.tenantHint,
          installationId,
          repoFullName,
          appKey
        })
        if (!tenantResult.success) {
          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: issueNumber,
            body: buildTenantErrorComment(tenantResult.error, tenantResult.validTenantIds)
          })
          return
        }

        const tenant = tenantResult.tenant
        const repo = resolveRepo(tenant, repoFullName, appKey)
        if (!repo) return

        const issue = await context.octokit.issues.get({
          owner,
          repo: repoName,
          issue_number: issueNumber
        })
        const issueManaged = hasManagedLabel(issue.data.labels)
        const managedIssueOwnedByApp = issueManaged
          ? await isManagedIssueOwnedByApp({
            store,
            tenantId: tenant.id,
            repoFullName: repo.fullName,
            issueNumber,
            appKey
          })
          : false

        if (command.type === "status") {
          await postIssueStatus({
            tenantId: tenant.id,
            repoFullName: repo.fullName,
            issueNumber,
            owner,
            repo: repoName,
            client: context.octokit as any,
            store
          })
          return
        }

        if (command.type === "pause" || command.type === "resume") {
          await postControlAck({
            commandType: command.type,
            issueNumber,
            owner,
            repo: repoName,
            client: context.octokit as any
          })
          return
        }

        if (managedIssueOwnedByApp && command.type === "reply") {
          const sessionId = await resolveSessionIdFromIssue({
            issueBody: issue.data.body ?? undefined,
            fetchComments: async () => {
              const comments = await context.octokit.issues.listComments({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                per_page: 100
              })
              return comments.data
            }
          })

          if (sessionId) {
            const relay = dispatchSessionRelay({
              sessionId,
              owner,
              repo: repoName,
              issueNumber,
              commentId: context.payload.comment.id,
              commentBody: context.payload.comment.body ?? "",
              authorLogin,
              repoPath: repo.path,
              codexPath: env.codexPath,
              codexTurnTimeoutMs: env.codexTurnTimeoutMs,
              postIssueComment: async (commentBody) => {
                await context.octokit.issues.createComment({
                  owner,
                  repo: repoName,
                  issue_number: issueNumber,
                  body: commentBody
                })
              }
            })
            if (relay.accepted) return
          }
        }

        const sourceKey = [
          "github-review",
          appKey,
          installationId ?? "none",
          repoFullName.toLowerCase(),
          issueNumber,
          context.payload.comment.id,
          command.type
        ].join(":")
        const github: GitHubContext = {
          appKey,
          owner,
          repo: repoName,
          issueNumber,
          triggerCommentId: context.payload.comment.id,
          installationId,
          issueTitle: issue.data.title,
          issueBody: issue.data.body ?? undefined
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
        const defaultTenant = resolveDefaultTenantForGithubApp({
          config,
          appKey,
          installationId,
          repoFullName
        })
        if (!defaultTenant) return

        const githubBinding = getTenantGithubAppBinding(defaultTenant, appKey)
        if (!githubBinding) return

        const authorLogin = context.payload.comment.user?.login
        if (context.payload.comment.user?.type === "Bot" || authorLogin?.toLowerCase().endsWith("[bot]")) return
        if (githubBinding.repoAllowlist && !githubBinding.repoAllowlist.includes(repoFullName)) return

        const defaultPrefixes = await defaultPrefixesPromise
        const prefixes = buildGithubCommandPrefixes({
          configured: [...(appConfig.commandPrefixes ?? []), ...(githubBinding.commandPrefixes ?? [])],
          assignmentAssignees: githubBinding.assignmentAssignees,
          defaultPrefixes
        })
        const body = context.payload.comment.body ?? ""
        const command = routeDiscussionCommentCommand({
          body,
          prefixes
        })
        if (!command) return

        const tenantResult = resolveTargetTenant({
          config,
          defaultTenant,
          tenantHint: command.tenantHint,
          installationId,
          repoFullName,
          appKey
        })
        if (!tenantResult.success) {
          logger.warn(
            { error: tenantResult.error, validTenantIds: tenantResult.validTenantIds, appKey },
            "Cannot post error comment to discussion (GraphQL required) - tenant resolution failed"
          )
          return
        }

        const tenant = tenantResult.tenant
        const repo = resolveRepo(tenant, repoFullName, appKey)
        if (!repo) return

        if (command.type === "pause" || command.type === "resume" || command.type === "status") {
          await postDiscussionUnsupportedControl({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            discussionNumber: context.payload.discussion.number,
            client: context.octokit as any
          })
          return
        }

        const discussion = context.payload.discussion
        const sourceKey = [
          "github-discussion",
          appKey,
          installationId ?? "none",
          repoFullName.toLowerCase(),
          discussion.number,
          context.payload.comment.node_id ?? context.payload.comment.id,
          command.type
        ].join(":")
        const github: GitHubContext = {
          appKey,
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
        const tenant = resolveDefaultTenantForGithubApp({
          config,
          appKey,
          installationId,
          repoFullName
        })
        if (!tenant) return

        const githubBinding = getTenantGithubAppBinding(tenant, appKey)
        if (!githubBinding) return
        if (githubBinding.repoAllowlist && !githubBinding.repoAllowlist.includes(repoFullName)) return

        const appIdentity = await appIdentityPromise
        const assignee = context.payload.assignee?.login?.toLowerCase()
        const allowedAssignees = resolveAssignmentAssignees(githubBinding.assignmentAssignees, appIdentity?.botLogin)
        if (!assignee || allowedAssignees.size === 0 || !allowedAssignees.has(assignee)) return
        if (hasManagedLabel(context.payload.issue.labels)) return

        const repo = resolveRepo(tenant, repoFullName, appKey)
        if (!repo) return

        const issue = context.payload.issue
        const sourceKey = [
          "github-assigned",
          appKey,
          installationId ?? "none",
          repoFullName.toLowerCase(),
          issue.number
        ].join(":")
        const github: GitHubContext = {
          appKey,
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
    return {
      key: appKey,
      probot,
      middleware: createNodeMiddleware(appFn, {
        probot,
        webhooksPath: `/github/webhook/${appKey}`
      })
    }
  })

  const mount = (app: Express) => {
    for (const webhook of webhooks) {
      app.use(webhook.middleware)
      logger.info({ appKey: webhook.key, path: `/github/webhook/${webhook.key}` }, "GitHub webhook mounted")
    }
  }

  return { probotApps: webhooks.map(webhook => webhook.probot), mount }
}

async function resolveIssueSessionId(context: any): Promise<string | null> {
  const owner = context.payload.repository.owner.login
  const repo = context.payload.repository.name
  const issueNumber = context.payload.issue.number
  const issueBody = context.payload.issue.body ?? undefined

  return resolveSessionIdFromIssue({
    issueBody,
    fetchComments: async () => {
      const comments = await context.octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100
      })
      return comments.data
    }
  })
}

type TenantResolutionResult =
  | { success: true; tenant: TenantConfig }
  | { success: false; error: string; validTenantIds: string[] }

function resolveDefaultTenantForGithubApp(input: {
  config: AppConfig
  appKey: string
  installationId?: number
  repoFullName: string
}): TenantConfig | null {
  return findTenantByGithubInstallation(input.config, input.installationId, input.appKey)
    ?? findTenantByRepoFullNameForGithubApp(input.config, input.repoFullName, input.appKey)
}

function resolveTargetTenant(input: {
  config: AppConfig
  defaultTenant: TenantConfig
  tenantHint?: string
  installationId?: number
  repoFullName: string
  appKey: string
}): TenantResolutionResult {
  if (!input.tenantHint) return { success: true, tenant: input.defaultTenant }

  const githubTenants = input.config.tenants.filter(t => getTenantGithubAppBinding(t, input.appKey))
  const validTenantIds = githubTenants.map(t => t.id)

  const target = input.config.tenants.find(t => t.id.toLowerCase() === input.tenantHint?.toLowerCase())
  const targetBinding = target ? getTenantGithubAppBinding(target, input.appKey) : null
  if (!target || !targetBinding) {
    logger.warn({ tenantHint: input.tenantHint, appKey: input.appKey }, "Ignoring command: tenant hint did not match any GitHub-enabled tenant")
    return {
      success: false,
      error: `Tenant \`${input.tenantHint}\` not found or not configured for GitHub App \`${input.appKey}\`.`,
      validTenantIds
    }
  }

  if (input.installationId && targetBinding.installationId && targetBinding.installationId !== input.installationId) {
    logger.warn({
      tenantHint: input.tenantHint,
      appKey: input.appKey,
      installationId: input.installationId,
      tenantInstallationId: targetBinding.installationId
    }, "Ignoring command: tenant hint installation mismatch")
    return {
      success: false,
      error: `Tenant \`${input.tenantHint}\` is not available for GitHub App \`${input.appKey}\` on this installation.`,
      validTenantIds
    }
  }

  const repoMatch = target.repos.some(repo => repo.fullName.toLowerCase() === input.repoFullName.toLowerCase())
  if (!repoMatch) {
    logger.warn({
      tenantHint: input.tenantHint,
      repoFullName: input.repoFullName
    }, "Ignoring command: tenant hint repo mismatch")
    return {
      success: false,
      error: `Tenant \`${input.tenantHint}\` is not configured for repository \`${input.repoFullName}\`.`,
      validTenantIds
    }
  }

  if (targetBinding.repoAllowlist && !targetBinding.repoAllowlist.some(repo => repo.toLowerCase() === input.repoFullName.toLowerCase())) {
    logger.warn({
      tenantHint: input.tenantHint,
      appKey: input.appKey,
      repoFullName: input.repoFullName
    }, "Ignoring command: tenant hint blocked by repo allowlist")
    return {
      success: false,
      error: `Tenant \`${input.tenantHint}\` cannot be used with repository \`${input.repoFullName}\` (blocked by allowlist).`,
      validTenantIds
    }
  }

  return { success: true, tenant: target }
}

async function isManagedIssueOwnedByApp(input: {
  store: RunStore
  tenantId: string
  repoFullName: string
  issueNumber: number
  appKey: string
}): Promise<boolean> {
  const latest = await input.store.getLatestRunForIssue({
    tenantId: input.tenantId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber
  })
  return runUsesGithubApp(latest, input.appKey)
}

function buildTenantErrorComment(error: string, validTenantIds: string[]): string {
  const tenantList = validTenantIds.length > 0
    ? validTenantIds.map(id => `- \`@${id}\``).join("\n")
    : "_(No GitHub-enabled tenants configured)_"

  return `❌ **Tenant Resolution Failed**

${error}

**Valid tenant IDs for this repository:**
${tenantList}

To specify a tenant, use: \`@tenant-id your command here\``
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
  const addAssignee = (raw: string | undefined) => {
    const normalized = normalizeAssigneeLogin(raw)
    if (!normalized) return
    for (const candidate of expandAssigneeAliases(normalized)) {
      values.add(candidate)
    }
  }

  addAssignee(botLogin)
  for (const value of configured ?? []) {
    addAssignee(value)
  }
  return values
}

function normalizeAssigneeLogin(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^@/, "")
}

function expandAssigneeAliases(login: string): string[] {
  const values = new Set<string>()
  if (!login) return []
  values.add(login)

  if (login.endsWith("[bot]")) {
    values.add(login.replace(/\[bot\]$/i, ""))
  }

  const aliasMap = new Map<string, string[]>([
    ["openai-code-agent", ["codex"]],
    ["codex", ["openai-code-agent"]],
    ["copilot-swe-agent", ["copilot"]],
    ["copilot", ["copilot-swe-agent"]]
  ])
  for (const alias of aliasMap.get(login) ?? []) {
    values.add(alias)
  }

  return [...values]
}
