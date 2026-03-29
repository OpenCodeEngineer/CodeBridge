import type { AppConfig, RepoConfig, TenantConfig } from "./types.js"
import type { RunStore } from "./storage.js"
import type { RunService } from "./run-service.js"
import type { InstallationClient } from "./github-auth.js"
import type { CommandType } from "./commands.js"
import {
  buildGithubCommandPrefixes,
  resolveDefaultGithubCommandPrefixes,
  resolveGithubAppIdentity
} from "./command-prefixes.js"
import { routeDiscussionCommentCommand, routeExplicitGitHubCommand, routeIssueCommentCommand } from "./github-routing.js"
import {
  formatTenantErrorComment,
  postControlAck,
  postDiscussionTenantError,
  postDiscussionUnsupportedControl,
  postIssueStatus,
  postReviewPromptMirrorIfMissing
} from "./github-controls.js"
import { resolveRepo } from "./repo.js"
import { logger } from "./logger.js"
import { dispatchSessionRelay, resolveSessionIdFromIssue } from "./codex-session-relay.js"
import {
  buildGithubPollStateKey,
  createGitHubInstallationClientFactory,
  getTenantGithubAppBinding,
  hasGithubAppCredentials,
  listGithubApps,
  runUsesGithubApp,
  type GitHubAppMap
} from "./github-apps.js"
import { createWorkspaceManager, resolveManagedSessionRepoPath, type WorkspaceManager } from "./workspace.js"

export type GitHubPollEnv = {
  githubApps?: GitHubAppMap
  githubPollIntervalSec: number
  githubPollBackfill: boolean
  codexPath?: string
  codexTurnTimeoutMs: number
}

type GitHubClient = InstallationClient

export function startGitHubPolling(params: {
  config: AppConfig
  store: RunStore
  runService: RunService
  env: GitHubPollEnv
}) {
  const { config, store, runService, env } = params
  const configuredApps = listGithubApps(env.githubApps).filter(({ config: appConfig }) => hasGithubAppCredentials(appConfig))
  if (configuredApps.length === 0) {
    logger.warn("GitHub polling disabled: no GitHub apps with credentials are configured")
    return
  }
  if (!Number.isFinite(env.githubPollIntervalSec) || env.githubPollIntervalSec <= 0) {
    return
  }

  const intervalMs = Math.max(10000, env.githubPollIntervalSec * 1000)
  const repoPollTimeoutMs = 30_000
  const clientTimeoutMs = 15_000
  const workspaceManager = createWorkspaceManager({
    githubApps: env.githubApps
  })
  logger.info({
    intervalSec: env.githubPollIntervalSec,
    appKeys: configuredApps.map(app => app.key)
  }, "GitHub polling enabled")
  let running = false
  const getClient = createGitHubInstallationClientFactory(env.githubApps ?? {})
  const appRuntimes = configuredApps.map(({ key, config: appConfig }) => ({
    appKey: key,
    configuredPrefixes: appConfig.commandPrefixes,
    defaultPrefixesPromise: resolveDefaultGithubCommandPrefixes({
      githubAppId: appConfig.appId,
      githubPrivateKey: appConfig.privateKey
    }),
    appIdentityPromise: resolveGithubAppIdentity({
      githubAppId: appConfig.appId,
      githubPrivateKey: appConfig.privateKey
    })
  }))

  const tick = async () => {
    if (running) return
    running = true
    try {
      logger.debug({ appCount: appRuntimes.length, tenantCount: config.tenants.length }, "GitHub poll tick started")
      for (const appRuntime of appRuntimes) {
        for (const tenant of config.tenants) {
          const githubBinding = getTenantGithubAppBinding(tenant, appRuntime.appKey)
          const installationId = githubBinding?.installationId
          if (!installationId) {
            logger.debug({ tenantId: tenant.id, appKey: appRuntime.appKey }, "Skipping tenant: no installationId")
            continue
          }

          const client = await withTimeout(
            getClient(appRuntime.appKey, installationId),
            clientTimeoutMs,
            `GitHub installation client bootstrap timed out for app ${appRuntime.appKey} installation ${installationId}`
          ).catch(error => {
            logger.warn({
              err: error,
              tenantId: tenant.id,
              appKey: appRuntime.appKey,
              installationId
            }, "Skipping tenant app binding: GitHub client unavailable")
            return null
          })
          if (!client) continue

          logger.debug({ tenantId: tenant.id, appKey: appRuntime.appKey, installationId, repoCount: tenant.repos.length }, "Polling tenant repos")
          for (const tenantRepo of tenant.repos) {
            const repo = resolveRepo(tenant, tenantRepo.fullName, appRuntime.appKey)
            if (!repo) continue

            try {
              await withTimeout(
                pollRepo(tenant, repo, githubBinding, appRuntime, client),
                repoPollTimeoutMs,
                `GitHub polling timed out for ${repo.fullName} (${appRuntime.appKey})`
              )
            } catch (error) {
              logger.warn({
                err: error,
                tenantId: tenant.id,
                repoFullName: repo.fullName,
                appKey: appRuntime.appKey
              }, "Skipping repo after polling timeout/failure")
            }
          }
        }
      }
    } catch (error) {
      logger.error(error, "GitHub polling failed")
    } finally {
      running = false
    }
  }

  const pollRepo = async (
    tenant: TenantConfig,
    repo: RepoConfig,
    githubBinding: NonNullable<TenantConfig["github"]>["apps"][number],
    appRuntime: {
      appKey: string
      configuredPrefixes?: string[]
      defaultPrefixesPromise: Promise<string[]>
      appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
    },
    client: GitHubClient
  ) => {
    const repoFullName = repo.fullName
    const allowlist = githubBinding.repoAllowlist
    if (allowlist && !allowlist.some(r => r.toLowerCase() === repoFullName.toLowerCase())) return

    const [owner, repoName] = repoFullName.split("/")
    if (!owner || !repoName) return

    await pollAssignedIssues({
      appKey: appRuntime.appKey,
      githubBinding,
      tenant,
      repo,
      owner,
      repoName,
      client,
      store,
      runService,
      appIdentityPromise: appRuntime.appIdentityPromise,
      workspaceManager
    })

    await pollDiscussionComments({
      config,
      appKey: appRuntime.appKey,
      configuredPrefixes: appRuntime.configuredPrefixes,
      githubBinding,
      tenant,
      repo,
      owner,
      repoName,
      client,
      store,
      runService,
      defaultPrefixesPromise: appRuntime.defaultPrefixesPromise,
      appIdentityPromise: appRuntime.appIdentityPromise,
      githubPollBackfill: env.githubPollBackfill,
      workspaceManager
    })

    await pollPullRequestReviewComments({
      appKey: appRuntime.appKey,
      configuredPrefixes: appRuntime.configuredPrefixes,
      githubBinding,
      config,
      tenant,
      repo,
      owner,
      repoName,
      client,
      store,
      runService,
      defaultPrefixesPromise: appRuntime.defaultPrefixesPromise,
      appIdentityPromise: appRuntime.appIdentityPromise,
      githubPollBackfill: env.githubPollBackfill,
      env,
      workspaceManager
    })

    const pollStateKey = buildGithubPollStateKey({
      repoFullName,
      appKey: appRuntime.appKey,
      scope: "comments"
    })
    const state = await store.getGithubPollState(tenant.id, pollStateKey)
    const response = await client.octokit.issues.listCommentsForRepo({
      owner,
      repo: repoName,
      per_page: 100,
      sort: "created",
      direction: "desc"
    })

    const comments = response.data
    const newest = comments[0]
    const newestId = newest?.id ?? null
    const newestCreatedAt = newest?.created_at ?? null

    if (!state && !env.githubPollBackfill) {
      await store.updateGithubPollState({
        tenantId: tenant.id,
        repoFullName: pollStateKey,
        lastCommentId: newestId,
        lastCommentCreatedAt: newestCreatedAt
      })
      return
    }

    const lastId = state?.lastCommentId ?? 0
    const pending = comments
      .filter(comment => typeof comment.id === "number" && comment.id > lastId)
      .sort((a, b) => a.id - b.id)
    const defaultPrefixes = pending.length > 0
      ? await resolveDefaultPrefixesWithTimeout(appRuntime.defaultPrefixesPromise)
      : []
    const issueMetaByNumber = new Map<number, { title: string; body?: string; managed: boolean }>()
    const issueSessionByNumber = new Map<number, string | null>()
    const getIssueMeta = async (issueNumber: number) => {
      const cached = issueMetaByNumber.get(issueNumber)
      if (cached) return cached

      const issue = await client.octokit.issues.get({
        owner,
        repo: repoName,
        issue_number: issueNumber
      })
      const meta = {
        title: issue.data.title,
        body: issue.data.body ?? undefined,
        managed: hasManagedLabel(issue.data.labels)
      }
      issueMetaByNumber.set(issueNumber, meta)
      return meta
    }

    const getIssueSessionId = async (issueNumber: number, issueBody?: string) => {
      const cached = issueSessionByNumber.get(issueNumber)
      if (cached !== undefined) return cached

      const resolved = await resolveSessionIdFromIssue({
        issueBody,
        fetchComments: async () => {
          const comments = await client.octokit.issues.listComments({
            owner,
            repo: repoName,
            issue_number: issueNumber,
            per_page: 100
          })
          return comments.data
        }
      })
      issueSessionByNumber.set(issueNumber, resolved)
      return resolved
    }

    for (const comment of pending) {
      try {
        if (!comment.body) continue
        if (comment.user?.type === "Bot" || comment.user?.login?.endsWith("[bot]")) continue

        const issueNumber = parseIssueNumber(comment.issue_url)
        if (!issueNumber) continue

        const issueMeta = await getIssueMeta(issueNumber)
        const prefixes = buildGithubCommandPrefixes({
          configured: [...(appRuntime.configuredPrefixes ?? []), ...(githubBinding.commandPrefixes ?? [])],
          assignmentAssignees: githubBinding.assignmentAssignees,
          defaultPrefixes
        })
        const command = routeIssueCommentCommand({
          body: comment.body,
          prefixes,
          issueManaged: issueMeta.managed
        })
        logger.debug({
          commentId: comment.id,
          issueNumber,
          managed: issueMeta.managed,
          commandType: command?.type ?? null,
          commandExplicit: command?.explicit ?? null,
          repoFullName
        }, "Processing issue comment")
        if (!command) continue

        const managedIssueOwnedByApp = issueMeta.managed
          ? await isManagedIssueOwnedByApp({
            store,
            tenantId: tenant.id,
            repoFullName: repo.fullName,
            issueNumber,
            appKey: appRuntime.appKey
          })
          : false
        logger.debug({
          commentId: comment.id,
          issueNumber,
          managed: issueMeta.managed,
          ownedByApp: managedIssueOwnedByApp,
          commandType: command.type,
          explicit: command.explicit
        }, "Managed issue ownership check")
        if (issueMeta.managed && !command.explicit && !managedIssueOwnedByApp) continue

        if (command.tenantHint) {
          const hintLower = command.tenantHint.toLowerCase()
          const tenantMatches = hintLower === tenant.id.toLowerCase()

          if (!tenantMatches) {
            const allGithubTenants = config.tenants.filter(t => getTenantGithubAppBinding(t, appRuntime.appKey))
            const validTenantIds = allGithubTenants.map(t => t.id)
            const isValidHint = allGithubTenants.some(t => t.id.toLowerCase() === hintLower)

            if (!isValidHint) {
              await client.octokit.issues.createComment({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                body: formatTenantErrorComment(
                  `Tenant \`${command.tenantHint}\` not found or not configured for GitHub App \`${appRuntime.appKey}\`.`,
                  validTenantIds
                )
              })
            }
            continue
          }
        }

        if (command.type === "status") {
          await postIssueStatus({
            tenantId: tenant.id,
            repoFullName,
            issueNumber,
            owner,
            repo: repoName,
            client,
            store
          })
          continue
        }

        if (command.type === "pause" || command.type === "resume") {
          await postControlAck({
            commandType: command.type,
            issueNumber,
            owner,
            repo: repoName,
            client
          })
          continue
        }

        if (managedIssueOwnedByApp && command.type === "reply") {
          const sessionId = await getIssueSessionId(issueNumber, issueMeta.body)
          logger.info({
            commentId: comment.id,
            issueNumber,
            sessionId,
            repoFullName
          }, "Session relay candidate")
          if (sessionId) {
            const relay = dispatchSessionRelay({
              sessionId,
              owner,
              repo: repoName,
              issueNumber,
              commentId: comment.id,
              commentBody: comment.body,
              authorLogin: comment.user?.login ?? undefined,
              repoPath: await resolveManagedSessionRepoPath({
                store,
                tenantId: tenant.id,
                repo,
                owner,
                repoName,
                issueNumber
              }),
              codexPath: env.codexPath,
              codexTurnTimeoutMs: env.codexTurnTimeoutMs,
              postIssueComment: async (body) => {
                await client.octokit.issues.createComment({
                  owner,
                  repo: repoName,
                  issue_number: issueNumber,
                  body
                })
              }
            })
            if (relay.accepted) continue
          }
        }

        const sourceKey = buildSourceKey({
          appKey: appRuntime.appKey,
          installationId: githubBinding.installationId,
          repoFullName,
          issueNumber,
          commentId: comment.id,
          commandType: command.type
        })
        const existing = await store.getRunBySourceKey(sourceKey)
        if (existing) continue

        const issue = issueMeta
        const prompt = command.type === "reply"
          ? buildReplyPrompt(issueNumber, command.prompt)
          : command.prompt

        await runService.createRun({
          tenantId: tenant.id,
          repoFullName: repo.fullName,
          prepareRepoPath: runId => workspaceManager.prepareRunRepoPath({
            repo,
            github: {
              appKey: appRuntime.appKey,
              owner,
              repo: repoName,
              issueNumber,
              installationId: githubBinding.installationId,
              issueTitle: issue.title,
              issueBody: issue.body,
              triggerCommentId: comment.id
            },
            runId
          }),
          sourceKey,
          prompt,
          backend: repo.backend,
          agent: repo.agent,
          model: repo.model,
          branchPrefix: repo.branchPrefix,
          github: {
            appKey: appRuntime.appKey,
            owner,
            repo: repoName,
            issueNumber,
            installationId: githubBinding.installationId,
            issueTitle: issue.title,
            issueBody: issue.body,
            triggerCommentId: comment.id
          }
        })
      } catch (error) {
        logger.error({ err: error, tenantId: tenant.id, repo: repoFullName, commentId: comment.id }, "GitHub polling comment failed")
      }
    }

    await store.updateGithubPollState({
      tenantId: tenant.id,
      repoFullName: pollStateKey,
      lastCommentId: newestId ?? (state?.lastCommentId ?? null),
      lastCommentCreatedAt: newestCreatedAt ?? null
    })
  }

  const timer = setInterval(() => {
    tick().catch(error => logger.error(error, "GitHub polling tick failed"))
  }, intervalMs)

  tick().catch(error => logger.error(error, "GitHub polling tick failed"))

  return () => clearInterval(timer)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function pollAssignedIssues(input: {
  appKey: string
  githubBinding: NonNullable<TenantConfig["github"]>["apps"][number]
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  store: RunStore
  runService: RunService
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
  workspaceManager: WorkspaceManager
}): Promise<void> {
  const appIdentity = await resolveAppIdentityWithTimeout(input.appIdentityPromise)
  const assignees = resolveAssignmentAssignees(input.githubBinding.assignmentAssignees, appIdentity?.botLogin)
  if (assignees.length === 0) return

  const assigneeSet = new Set(assignees.map(value => value.toLowerCase()))
  const issuesByNumber = new Map<number, {
    number: number
    title: string
    body: string | null
    pull_request?: unknown
    labels: Array<{ name?: string } | string>
  }>()

  let response: Awaited<ReturnType<typeof input.client.octokit.issues.listForRepo>>
  try {
    response = await input.client.octokit.issues.listForRepo({
      owner: input.owner,
      repo: input.repoName,
      state: "open",
      per_page: 100,
      sort: "updated",
      direction: "desc"
    })
  } catch (error) {
    logger.warn({
      err: error,
      tenantId: input.tenant.id,
      repoFullName: input.repo.fullName
    }, "GitHub assignment polling list failed")
    return
  }

  for (const issue of response.data) {
    const issueAssignees = (issue.assignees ?? [])
      .map(entry => entry?.login?.toLowerCase())
      .filter((value): value is string => Boolean(value))
    if (!issueAssignees.some(login => assigneeSet.has(login))) continue
    if (!issue.number || issuesByNumber.has(issue.number)) continue
    issuesByNumber.set(issue.number, {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      pull_request: issue.pull_request,
      labels: issue.labels as Array<{ name?: string } | string>
    })
  }

  for (const issue of issuesByNumber.values()) {
    if (issue.pull_request) continue
    if (hasManagedLabel(issue.labels)) continue
    if (!issue.number) continue

    const sourceKey = [
      "github-assigned",
      input.appKey,
      input.githubBinding.installationId ?? "none",
      input.repo.fullName.toLowerCase(),
      issue.number
    ].join(":")

    const existing = await input.store.getRunBySourceKey(sourceKey)
    if (existing) continue

    await input.runService.createRun({
      tenantId: input.tenant.id,
      repoFullName: input.repo.fullName,
      prepareRepoPath: runId => input.workspaceManager.prepareRunRepoPath({
        repo: input.repo,
        github: {
          appKey: input.appKey,
          owner: input.owner,
          repo: input.repoName,
          issueNumber: issue.number,
          installationId: input.githubBinding.installationId,
          issueTitle: issue.title,
          issueBody: issue.body ?? undefined
        },
        runId
      }),
      sourceKey,
      prompt: buildIssueBootstrapPrompt(issue.number, issue.title, issue.body ?? undefined),
      backend: input.repo.backend,
      agent: input.repo.agent,
      model: input.repo.model,
      branchPrefix: input.repo.branchPrefix,
      github: {
        appKey: input.appKey,
        owner: input.owner,
        repo: input.repoName,
        issueNumber: issue.number,
        installationId: input.githubBinding.installationId,
        issueTitle: issue.title,
        issueBody: issue.body ?? undefined
      }
    })
  }
}

async function pollDiscussionComments(input: {
  config: AppConfig
  appKey: string
  configuredPrefixes?: string[]
  githubBinding: NonNullable<TenantConfig["github"]>["apps"][number]
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  store: RunStore
  runService: RunService
  defaultPrefixesPromise: Promise<string[]>
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
  githubPollBackfill: boolean
  workspaceManager: WorkspaceManager
}): Promise<void> {
  const discussionPollKey = buildGithubPollStateKey({
    repoFullName: input.repo.fullName,
    appKey: input.appKey,
    scope: "discussion"
  })
  const state = await input.store.getGithubPollState(input.tenant.id, discussionPollKey)
  const appIdentity = await resolveAppIdentityWithTimeout(input.appIdentityPromise)

  let graphData: {
    repository?: {
      discussions?: {
        nodes?: Array<{
          number: number
          title: string
          body: string | null
          comments?: {
            nodes?: Array<{
              id: string
              body: string
              createdAt: string
              author?: { login?: string | null } | null
            }>
          }
        }>
      }
    }
  } | null = null

  try {
    graphData = await input.client.octokit.graphql(
      `
        query PollDiscussions($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            discussions(first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes {
                number
                title
                body
                comments(first: 50) {
                  nodes {
                    id
                    body
                    createdAt
                    author {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        owner: input.owner,
        repo: input.repoName
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Resource not accessible by integration")) {
      return
    }
    logger.warn({
      err: error,
      tenantId: input.tenant.id,
      repoFullName: input.repo.fullName
    }, "GitHub discussion polling failed")
    return
  }

  const discussions = graphData?.repository?.discussions?.nodes ?? []
  const flattened = discussions.flatMap(discussion =>
    (discussion.comments?.nodes ?? []).map(comment => ({
      discussionNumber: discussion.number,
      discussionTitle: discussion.title,
      discussionBody: discussion.body ?? undefined,
      commentId: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      authorLogin: comment.author?.login ?? undefined
    }))
  )

  const newestCreatedAt = flattened
    .map(item => item.createdAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? null

  if (!state && !input.githubPollBackfill) {
    await input.store.updateGithubPollState({
      tenantId: input.tenant.id,
      repoFullName: discussionPollKey,
      lastCommentId: null,
      lastCommentCreatedAt: newestCreatedAt
    })
    return
  }

  const lastCreatedAt = state?.lastCommentCreatedAt ?? null
  const pending = flattened
    .filter(item => !lastCreatedAt || item.createdAt > lastCreatedAt)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.commentId.localeCompare(b.commentId)
      return a.createdAt.localeCompare(b.createdAt)
    })

  const defaultPrefixes = pending.length > 0
    ? await resolveDefaultPrefixesWithTimeout(input.defaultPrefixesPromise)
    : []

  for (const comment of pending) {
    try {
      if (!comment.body?.trim()) continue
      if (!comment.authorLogin) continue
      const authorLower = comment.authorLogin.toLowerCase()
      if (
        authorLower.endsWith("[bot]") ||
        (appIdentity?.slug && authorLower === appIdentity.slug.toLowerCase()) ||
        (appIdentity?.botLogin && authorLower === appIdentity.botLogin.toLowerCase())
      ) {
        continue
      }

      const prefixes = buildGithubCommandPrefixes({
        configured: [...(input.configuredPrefixes ?? []), ...(input.githubBinding.commandPrefixes ?? [])],
        assignmentAssignees: input.githubBinding.assignmentAssignees,
        defaultPrefixes
      })
      const command = routeDiscussionCommentCommand({
        body: comment.body,
        prefixes
      })
      if (!command) continue
      if (command.tenantHint) {
        const hintLower = command.tenantHint.toLowerCase()
        const tenantMatches = hintLower === input.tenant.id.toLowerCase()
        if (!tenantMatches) {
          const allGithubTenants = input.config.tenants.filter(tenant => getTenantGithubAppBinding(tenant, input.appKey))
          const validTenantIds = allGithubTenants.map(tenant => tenant.id)
          const isValidHint = allGithubTenants.some(tenant => tenant.id.toLowerCase() === hintLower)

          if (!isValidHint && input.tenant.id.toLowerCase() === (allGithubTenants[0]?.id.toLowerCase() ?? "")) {
            await postDiscussionTenantError({
              owner: input.owner,
              repo: input.repoName,
              discussionNumber: comment.discussionNumber,
              client: input.client,
              error: `Tenant \`${command.tenantHint}\` not found or not configured for GitHub App \`${input.appKey}\`.`,
              validTenantIds,
              sourceCommentId: comment.commentId
            })
          }
          continue
        }
      }

      if (command.type === "pause" || command.type === "resume" || command.type === "status") {
        await postDiscussionUnsupportedControl({
          owner: input.owner,
          repo: input.repoName,
          discussionNumber: comment.discussionNumber,
          client: input.client,
          sourceCommentId: comment.commentId
        })
        continue
      }

      const sourceKey = [
        "github-discussion",
        input.appKey,
        input.githubBinding.installationId ?? "none",
        input.repo.fullName.toLowerCase(),
        comment.discussionNumber,
        comment.commentId,
        command.type
      ].join(":")

      const existing = await input.store.getRunBySourceKey(sourceKey)
      if (existing) continue

      const prompt = command.type === "reply"
        ? buildDiscussionReplyPrompt(comment.discussionNumber, command.prompt)
        : command.prompt

      await input.runService.createRun({
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        prepareRepoPath: runId => input.workspaceManager.prepareRunRepoPath({
          repo: input.repo,
          github: {
            appKey: input.appKey,
            owner: input.owner,
            repo: input.repoName,
            issueNumber: comment.discussionNumber,
            installationId: input.githubBinding.installationId,
            issueTitle: comment.discussionTitle,
            issueBody: comment.discussionBody
          },
          runId
        }),
        sourceKey,
        prompt,
        backend: input.repo.backend,
        agent: input.repo.agent,
        model: input.repo.model,
        branchPrefix: input.repo.branchPrefix,
        github: {
          appKey: input.appKey,
          owner: input.owner,
          repo: input.repoName,
          issueNumber: comment.discussionNumber,
          installationId: input.githubBinding.installationId,
          issueTitle: comment.discussionTitle,
          issueBody: comment.discussionBody
        }
      })
    } catch (error) {
      logger.error({
        err: error,
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        discussionNumber: comment.discussionNumber,
        commentId: comment.commentId
      }, "GitHub discussion comment polling failed")
    }
  }

  await input.store.updateGithubPollState({
    tenantId: input.tenant.id,
    repoFullName: discussionPollKey,
    lastCommentId: null,
    lastCommentCreatedAt: newestCreatedAt ?? (state?.lastCommentCreatedAt ?? null)
  })
}

async function pollPullRequestReviewComments(input: {
  appKey: string
  configuredPrefixes?: string[]
  githubBinding: NonNullable<TenantConfig["github"]>["apps"][number]
  config: AppConfig
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  store: RunStore
  runService: RunService
  defaultPrefixesPromise: Promise<string[]>
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
  githubPollBackfill: boolean
  env: GitHubPollEnv
  workspaceManager: WorkspaceManager
}): Promise<void> {
  const reviewPollKey = buildGithubPollStateKey({
    repoFullName: input.repo.fullName,
    appKey: input.appKey,
    scope: "pr-review"
  })
  const state = await input.store.getGithubPollState(input.tenant.id, reviewPollKey)
  const appIdentity = await resolveAppIdentityWithTimeout(input.appIdentityPromise)

  type ReviewComment = {
    id: number
    body?: string | null
    created_at?: string | null
    pull_request_url?: string | null
    user?: {
      login?: string | null
      type?: string | null
    } | null
  }

  let response: { data: ReviewComment[] }
  try {
    response = await input.client.octokit.request("GET /repos/{owner}/{repo}/pulls/comments", {
      owner: input.owner,
      repo: input.repoName,
      per_page: 100,
      sort: "created",
      direction: "desc"
    }) as { data: ReviewComment[] }
  } catch (error) {
    logger.warn({
      err: error,
      tenantId: input.tenant.id,
      repoFullName: input.repo.fullName
    }, "GitHub PR review comment polling failed")
    return
  }

  const comments = response.data
  const newest = comments[0]
  const newestId = newest?.id ?? null
  const newestCreatedAt = newest?.created_at ?? null

  if (!state && !input.githubPollBackfill) {
    await input.store.updateGithubPollState({
      tenantId: input.tenant.id,
      repoFullName: reviewPollKey,
      lastCommentId: newestId,
      lastCommentCreatedAt: newestCreatedAt
    })
    return
  }

  const lastId = state?.lastCommentId ?? 0
  const pending = comments
    .filter(comment => typeof comment.id === "number" && comment.id > lastId)
    .sort((a, b) => a.id - b.id)
  const defaultPrefixes = pending.length > 0
    ? await resolveDefaultPrefixesWithTimeout(input.defaultPrefixesPromise)
    : []
  const issueMetaByNumber = new Map<number, { title: string; body?: string; managed: boolean }>()
  const issueSessionByNumber = new Map<number, string | null>()

  const getIssueMeta = async (issueNumber: number) => {
    const cached = issueMetaByNumber.get(issueNumber)
    if (cached) return cached

    const issue = await input.client.octokit.issues.get({
      owner: input.owner,
      repo: input.repoName,
      issue_number: issueNumber
    })
    const meta = {
      title: issue.data.title,
      body: issue.data.body ?? undefined,
      managed: hasManagedLabel(issue.data.labels)
    }
    issueMetaByNumber.set(issueNumber, meta)
    return meta
  }

  const getIssueSessionId = async (issueNumber: number, issueBody?: string) => {
    const cached = issueSessionByNumber.get(issueNumber)
    if (cached !== undefined) return cached

    const resolved = await resolveSessionIdFromIssue({
      issueBody,
      fetchComments: async () => {
        const comments = await input.client.octokit.issues.listComments({
          owner: input.owner,
          repo: input.repoName,
          issue_number: issueNumber,
          per_page: 100
        })
        return comments.data
      }
    })
    issueSessionByNumber.set(issueNumber, resolved)
    return resolved
  }

  for (const comment of pending) {
    try {
      const body = comment.body?.trim()
      if (!body) continue

      const authorLogin = comment.user?.login ?? undefined
      const authorLower = authorLogin?.toLowerCase()
      if (
        comment.user?.type === "Bot" ||
        authorLower?.endsWith("[bot]") ||
        (appIdentity?.slug && authorLower === appIdentity.slug.toLowerCase()) ||
        (appIdentity?.botLogin && authorLower === appIdentity.botLogin.toLowerCase())
      ) {
        continue
      }

      const issueNumber = parsePullRequestNumber(comment.pull_request_url)
      if (!issueNumber) continue

      const issueMeta = await getIssueMeta(issueNumber)
      const prefixes = buildGithubCommandPrefixes({
        configured: [...(input.configuredPrefixes ?? []), ...(input.githubBinding.commandPrefixes ?? [])],
        assignmentAssignees: input.githubBinding.assignmentAssignees,
        defaultPrefixes
      })
      const command = routeExplicitGitHubCommand({
        body,
        prefixes
      })
      if (!command) continue

      await postReviewPromptMirrorIfMissing({
        owner: input.owner,
        repo: input.repoName,
        issueNumber,
        triggerCommentId: comment.id,
        originalCommentBody: body,
        authorLogin,
        client: input.client
      })

      const managedIssueOwnedByApp = issueMeta.managed
        ? await isManagedIssueOwnedByApp({
          store: input.store,
          tenantId: input.tenant.id,
          repoFullName: input.repo.fullName,
          issueNumber,
          appKey: input.appKey
        })
        : false

      if (command.tenantHint) {
        const hintLower = command.tenantHint.toLowerCase()
        const tenantMatches = hintLower === input.tenant.id.toLowerCase()

        if (!tenantMatches) {
          const allGithubTenants = input.config.tenants.filter(tenant => getTenantGithubAppBinding(tenant, input.appKey))
          const validTenantIds = allGithubTenants.map(tenant => tenant.id)
          const isValidHint = allGithubTenants.some(tenant => tenant.id.toLowerCase() === hintLower)

          if (!isValidHint) {
            await input.client.octokit.issues.createComment({
              owner: input.owner,
              repo: input.repoName,
              issue_number: issueNumber,
              body: formatTenantErrorComment(
                `Tenant \`${command.tenantHint}\` not found or not configured for GitHub App \`${input.appKey}\`.`,
                validTenantIds
              )
            })
          }
          continue
        }
      }

      if (command.type === "status") {
        await postIssueStatus({
          tenantId: input.tenant.id,
          repoFullName: input.repo.fullName,
          issueNumber,
          owner: input.owner,
          repo: input.repoName,
          client: input.client,
          store: input.store
        })
        continue
      }

      if (command.type === "pause" || command.type === "resume") {
        await postControlAck({
          commandType: command.type,
          issueNumber,
          owner: input.owner,
          repo: input.repoName,
          client: input.client
        })
        continue
      }

      if (managedIssueOwnedByApp && command.type === "reply") {
        const sessionId = await getIssueSessionId(issueNumber, issueMeta.body)
        if (sessionId) {
          const relay = dispatchSessionRelay({
            sessionId,
            owner: input.owner,
            repo: input.repoName,
            issueNumber,
            commentId: comment.id,
            commentBody: body,
            authorLogin,
            repoPath: await resolveManagedSessionRepoPath({
              store: input.store,
              tenantId: input.tenant.id,
              repo: input.repo,
              owner: input.owner,
              repoName: input.repoName,
              issueNumber
            }),
            codexPath: input.env.codexPath,
            codexTurnTimeoutMs: input.env.codexTurnTimeoutMs,
            postIssueComment: async (commentBody) => {
              await input.client.octokit.issues.createComment({
                owner: input.owner,
                repo: input.repoName,
                issue_number: issueNumber,
                body: commentBody
              })
            }
          })
          if (relay.accepted) continue
        }
      }

      const sourceKey = buildPullRequestReviewSourceKey({
        appKey: input.appKey,
        installationId: input.githubBinding.installationId,
        repoFullName: input.repo.fullName,
        issueNumber,
        commentId: comment.id,
        commandType: command.type
      })
      const existing = await input.store.getRunBySourceKey(sourceKey)
      if (existing) continue

      const prompt = command.type === "reply"
        ? buildReplyPrompt(issueNumber, command.prompt)
        : command.prompt

      await input.runService.createRun({
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        prepareRepoPath: runId => input.workspaceManager.prepareRunRepoPath({
          repo: input.repo,
          github: {
            appKey: input.appKey,
            owner: input.owner,
            repo: input.repoName,
            issueNumber,
            installationId: input.githubBinding.installationId,
            issueTitle: issueMeta.title,
            issueBody: issueMeta.body,
            triggerCommentId: comment.id
          },
          runId
        }),
        sourceKey,
        prompt,
        backend: input.repo.backend,
        agent: input.repo.agent,
        model: input.repo.model,
        branchPrefix: input.repo.branchPrefix,
        github: {
          appKey: input.appKey,
          owner: input.owner,
          repo: input.repoName,
          issueNumber,
          installationId: input.githubBinding.installationId,
          issueTitle: issueMeta.title,
          issueBody: issueMeta.body,
          triggerCommentId: comment.id
        }
      })
    } catch (error) {
      logger.error({
        err: error,
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        commentId: comment.id
      }, "GitHub PR review comment polling failed")
    }
  }

  await input.store.updateGithubPollState({
    tenantId: input.tenant.id,
    repoFullName: reviewPollKey,
    lastCommentId: newestId ?? (state?.lastCommentId ?? null),
    lastCommentCreatedAt: newestCreatedAt ?? (state?.lastCommentCreatedAt ?? null)
  })
}

function resolveAssignmentAssignees(configured: string[] | undefined, botLogin?: string): string[] {
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
  return [...values]
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

async function resolveDefaultPrefixesWithTimeout(
  promise: Promise<string[]>,
  timeoutMs = 5000
): Promise<string[]> {
  const timeout = new Promise<string[]>((resolve) => {
    setTimeout(() => resolve([]), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn({ err: error }, "Falling back: unable to resolve GitHub App mention prefixes")
    return []
  }
}

async function resolveAppIdentityWithTimeout(
  promise: Promise<{ slug?: string; botLogin?: string } | null>,
  timeoutMs = 5000
): Promise<{ slug?: string; botLogin?: string } | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn({ err: error }, "Falling back: unable to resolve GitHub App identity")
    return null
  }
}

function parseIssueNumber(issueUrl?: string | null): number | null {
  if (!issueUrl) return null
  const match = issueUrl.match(/\/issues\/(\d+)/)
  if (!match) return null
  return parseInt(match[1], 10)
}

function parsePullRequestNumber(pullRequestUrl?: string | null): number | null {
  if (!pullRequestUrl) return null
  const match = pullRequestUrl.match(/\/pulls\/(\d+)/)
  if (!match) return null
  return parseInt(match[1], 10)
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

function buildReplyPrompt(issueNumber: number, prompt: string): string {
  return [
    `Follow-up command from GitHub issue #${issueNumber}:`,
    prompt
  ].join("\n\n")
}

function buildDiscussionReplyPrompt(discussionNumber: number, prompt: string): string {
  return [
    `Follow-up command from GitHub discussion #${discussionNumber}:`,
    prompt
  ].join("\n\n")
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

function buildSourceKey(input: {
  appKey: string
  installationId?: number
  repoFullName: string
  issueNumber: number
  commentId: number
  commandType: CommandType
}): string {
  return [
    "github",
    input.appKey,
    input.installationId ?? "none",
    input.repoFullName.toLowerCase(),
    input.issueNumber,
    input.commentId,
    input.commandType
  ].join(":")
}

function buildPullRequestReviewSourceKey(input: {
  appKey: string
  installationId?: number
  repoFullName: string
  issueNumber: number
  commentId: number
  commandType: CommandType
}): string {
  return [
    "github-review",
    input.appKey,
    input.installationId ?? "none",
    input.repoFullName.toLowerCase(),
    input.issueNumber,
    input.commentId,
    input.commandType
  ].join(":")
}

function hasManagedLabel(labels?: Array<{ name?: string } | string>): boolean {
  if (!labels || labels.length === 0) return false
  return labels.some(label => {
    const name = typeof label === "string" ? label : label.name
    return name?.toLowerCase() === "agent:managed"
  })
}
