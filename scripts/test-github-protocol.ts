import { createHmac, randomUUID } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { execa } from "execa"
import { loadConfig, loadEnv } from "../src/config.js"
import { resolveDefaultGithubCommandPrefixes } from "../src/command-prefixes.js"
import { createInstallationClient, formatPrivateKey } from "../src/github-auth.js"
import { resolvePreferredAssignmentHandle } from "./github-assignment-handle.js"

type Args = {
  issueRepo?: string
  prRepo?: string
  discussionRepo?: string
  discussionNumber?: number
  appHandle?: string
  assignmentHandle?: string
  databaseUrl?: string
  hookTarget: string
  webhookSecret: string
  timeoutSec: number
  pollSec: number
  keepArtifacts: boolean
}

type CaseResult = {
  name: string
  status: "pass" | "fail" | "blocked"
  details: string
  url?: string
}

type AssignableActor = {
  login: string
  id: string
  type: "User" | "Bot"
}

type IssueAssignee = {
  login: string
  nodeId: string
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    hookTarget: process.env.EVAL_HOOK_TARGET?.trim() || "http://127.0.0.1:8788/github/webhook",
    webhookSecret: process.env.EVAL_WEBHOOK_SECRET?.trim() || process.env.GITHUB_WEBHOOK_SECRET?.trim() || "",
    timeoutSec: 240,
    pollSec: 5,
    keepArtifacts: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--issue-repo" && next) {
      args.issueRepo = next
      i += 1
    } else if (arg === "--pr-repo" && next) {
      args.prRepo = next
      i += 1
    } else if (arg === "--discussion-repo" && next) {
      args.discussionRepo = next
      i += 1
    } else if (arg === "--discussion-number" && next) {
      const value = Number(next)
      if (Number.isFinite(value) && value > 0) {
        args.discussionNumber = value
      }
      i += 1
    } else if (arg === "--app-handle" && next) {
      args.appHandle = next.startsWith("@") ? next : `@${next}`
      i += 1
    } else if (arg === "--assignment-handle" && next) {
      args.assignmentHandle = next.startsWith("@") ? next : `@${next}`
      i += 1
    } else if (arg === "--database-url" && next) {
      args.databaseUrl = next
      i += 1
    } else if (arg === "--hook-target" && next) {
      args.hookTarget = next
      i += 1
    } else if (arg === "--webhook-secret" && next) {
      args.webhookSecret = next
      i += 1
    } else if (arg === "--timeout" && next) {
      args.timeoutSec = Number(next)
      i += 1
    } else if (arg === "--poll" && next) {
      args.pollSec = Number(next)
      i += 1
    } else if (arg === "--keep") {
      args.keepArtifacts = true
    }
  }

  return args
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const gh = async (args: string[]) => {
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  const result = await execa("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    extendEnv: false
  })
  return result.stdout.trim()
}

const safeGh = async (args: string[]) => {
  try {
    const stdout = await gh(args)
    return { ok: true as const, stdout }
  } catch (error: any) {
    return {
      ok: false as const,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      exitCode: error?.exitCode
    }
  }
}

const buildAssignmentCandidates = (handle: string): string[] => {
  const raw = handle.trim().replace(/^@/, "")
  if (!raw) return []
  const lower = raw.toLowerCase()
  const variants = raw.match(/\[bot\]$/i)
    ? [raw, raw.replace(/\[bot\]$/i, ""), lower, lower.replace(/\[bot\]$/i, "")]
    : [raw, `${raw}[bot]`, lower, `${lower}[bot]`]
  return [...new Set(variants.filter(Boolean))]
}

const parseRepo = (repoFullName: string) => {
  const [owner, repo] = repoFullName.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name: ${repoFullName}`)
  }
  return { owner, repo }
}

const listAssignableActors = async (repoFullName: string): Promise<AssignableActor[]> => {
  const { owner, repo } = parseRepo(repoFullName)
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{__typename ... on User {login id} ... on Bot {login id}}}}}",
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`
  ])
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        suggestedActors?: {
          nodes?: Array<{
            __typename?: string
            login?: string
            id?: string
          }>
        }
      } | null
    }
  }
  const nodes = parsed.data?.repository?.suggestedActors?.nodes ?? []
  return nodes
    .map(node => {
      const login = (node.login ?? "").trim()
      const id = (node.id ?? "").trim()
      const type = node.__typename === "Bot" ? "Bot" : node.__typename === "User" ? "User" : null
      if (!login || !id || !type) return null
      return { login, id, type }
    })
    .filter((value): value is AssignableActor => value !== null)
}

const resolveUserNodeId = async (login: string): Promise<string | null> => {
  const response = await safeGh(["api", `users/${encodeURIComponent(login)}`])
  if (!response.ok || !response.stdout) return null
  try {
    const parsed = JSON.parse(response.stdout) as { node_id?: string }
    const nodeId = parsed.node_id?.trim()
    return nodeId || null
  } catch {
    return null
  }
}

const resolveAssignmentActor = async (repoFullName: string, assignmentHandle: string) => {
  const actors = await listAssignableActors(repoFullName)
  const actorsByLogin = new Map(actors.map(actor => [actor.login.toLowerCase(), actor]))
  const actorsById = new Map(actors.map(actor => [actor.id, actor]))
  const candidates = buildAssignmentCandidates(assignmentHandle)

  for (const candidate of candidates) {
    const direct = actorsByLogin.get(candidate.toLowerCase())
    if (direct) {
      return {
        actor: direct,
        reason: `matched assignable actor login "${direct.login}"`,
        candidates,
        actors
      }
    }
  }

  for (const candidate of candidates) {
    const nodeId = await resolveUserNodeId(candidate)
    if (!nodeId) continue
    const byId = actorsById.get(nodeId)
    if (byId) {
      return {
        actor: byId,
        reason: `candidate "${candidate}" resolved to assignable actor id ${nodeId}`,
        candidates,
        actors
      }
    }
  }

  return {
    actor: null as null,
    reason: "no assignable actor matched assignment handle",
    candidates,
    actors
  }
}

const readIssueAssignmentState = async (repoFullName: string, issueNumber: number) => {
  const raw = await gh(["api", `repos/${repoFullName}/issues/${issueNumber}`])
  const parsed = JSON.parse(raw) as {
    node_id?: string
    assignees?: Array<{ login?: string; node_id?: string }>
  }
  const issueNodeId = (parsed.node_id ?? "").trim()
  const assignees: IssueAssignee[] = (parsed.assignees ?? [])
    .map(entry => ({
      login: (entry.login ?? "").trim(),
      nodeId: (entry.node_id ?? "").trim()
    }))
    .filter(entry => entry.login && entry.nodeId)
  return { issueNodeId, assignees }
}

const assignIssueToActor = async (input: {
  issueNodeId: string
  actorId: string
}) => {
  const result = await safeGh([
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: copilot_api",
    "-f",
    "query=mutation($assignable:ID!,$actor:ID!){addAssigneesToAssignable(input:{assignableId:$assignable,assigneeIds:[$actor]}){assignable{... on Issue {number assignees(first:20){nodes{login id}}}}}}",
    "-f",
    `assignable=${input.issueNodeId}`,
    "-f",
    `actor=${input.actorId}`
  ])
  if (!result.ok) {
    const detail = result.stderr || result.stdout || "unknown gh graphql error"
    throw new Error(`Native assignment mutation failed: ${detail}`)
  }
}

const parseIssueOrPrNumber = (url: string): number => {
  const match = url.match(/\/(issues|pull)\/(\d+)/)
  if (!match) throw new Error(`Unable to parse issue/PR number from URL: ${url}`)
  return Number(match[2])
}

const isCodexRunComment = (body: string) => body.toLowerCase().includes("codex run")

const isTerminalBotComment = (body: string) => {
  const firstLine = body.split("\n")[0]?.trim().toLowerCase() ?? ""
  if (/^codex run\s+\S+\s+complete$/.test(firstLine)) return true
  const statusMatch = body.match(/^\s*status:\s*([a-z-]+)/im)
  if (!statusMatch) return false
  const status = statusMatch[1].toLowerCase()
  return status === "completed" || status === "failed" || status === "succeeded"
}

// This protocol validates bootstrap surfaces (assignment/mentions). It intentionally
// treats an acknowledged "Codex run" comment as success; promptfoo eval covers end-to-end completion quality.
const waitForIssueBotComment = async (input: {
  repo: string
  issueNumber: number
  botLogins: string[]
  expectedSubstring?: string
  requireCompletion?: boolean
  timeoutSec: number
  pollSec: number
}) => {
  const deadline = Date.now() + input.timeoutSec * 1000
  const expected = input.expectedSubstring?.toLowerCase()
  const botLogins = new Set(input.botLogins.map(login => login.toLowerCase()))

  while (Date.now() < deadline) {
    const raw = await gh([
      "api",
      `repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`
    ])
    const comments = JSON.parse(raw) as Array<{
      id: number
      body: string
      user?: { login?: string }
      created_at: string
    }>
    const match = comments
      .filter(comment => botLogins.has((comment.user?.login ?? "").toLowerCase()))
      .find(comment => {
        const rawBody = comment.body ?? ""
        const body = rawBody.toLowerCase()
        if (!isCodexRunComment(rawBody)) {
          return false
        }
        if (input.requireCompletion && !isTerminalBotComment(rawBody)) {
          return false
        }
        if (expected && !body.includes(expected)) return false
        return true
      })
    if (match) return match
    await sleep(input.pollSec * 1000)
  }

  const expectation = expected ?? (input.requireCompletion ? "a completion comment" : "a bot comment")
  throw new Error(`Timed out waiting for ${expectation}`)
}

const waitForDiscussionBotComment = async (input: {
  repo: string
  discussionNumber: number
  botLogins: string[]
  expectedSubstring: string
  timeoutSec: number
  pollSec: number
}) => {
  const [owner, repoName] = input.repo.split("/")
  const deadline = Date.now() + input.timeoutSec * 1000
  const expected = input.expectedSubstring.toLowerCase()
  const botLogins = new Set(input.botLogins.map(login => login.toLowerCase()))

  while (Date.now() < deadline) {
    const raw = await gh([
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){comments(first:100){nodes{body author{login}}}}}}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repoName}`,
      "-F",
      `number=${input.discussionNumber}`
    ])
    const parsed = JSON.parse(raw) as {
      data?: {
        repository?: {
          discussion?: {
            comments?: {
              nodes?: Array<{ body: string; author?: { login?: string | null } | null }>
            }
          } | null
        } | null
      }
    }
    const comments = parsed.data?.repository?.discussion?.comments?.nodes ?? []
    const match = comments.find(comment =>
      botLogins.has((comment.author?.login ?? "").toLowerCase()) &&
      (comment.body ?? "").toLowerCase().includes(expected)
    )
    if (match) return match
    await sleep(input.pollSec * 1000)
  }

  throw new Error(`Timed out waiting for discussion bot comment containing "${input.expectedSubstring}"`)
}

const resolveRepoInstallationId = (repoFullName: string, config: Awaited<ReturnType<typeof loadConfig>>): number | undefined => {
  const target = repoFullName.toLowerCase()
  for (const tenant of config.tenants) {
    const installationId = tenant.github?.installationId
    if (!installationId) continue
    const inRepos = tenant.repos.some(repo => repo.fullName.toLowerCase() === target)
    const inAllowlist = (tenant.github?.repoAllowlist ?? []).some(repo => repo.toLowerCase() === target)
    if (inRepos || inAllowlist) return installationId
  }
  return undefined
}

const emitSyntheticWebhook = async (input: {
  event: "issues" | "discussion_comment"
  payload: Record<string, unknown>
  hookTarget: string
  webhookSecret: string
}) => {
  if (!input.webhookSecret) {
    return { ok: false as const, error: "Missing webhook secret for synthetic webhook event" }
  }
  const body = JSON.stringify(input.payload)
  const signature = `sha256=${createHmac("sha256", input.webhookSecret).update(body).digest("hex")}`
  const response = await fetch(input.hookTarget, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": input.event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature
    },
    body
  })
  if (!response.ok) {
    return { ok: false as const, error: `Synthetic webhook HTTP ${response.status}: ${await response.text()}` }
  }
  return { ok: true as const }
}

const emitSyntheticDiscussionCommentWebhook = async (input: {
  repo: string
  discussionNumber: number
  commentId: number
  commentNodeId: string
  appHandle: string
  hookTarget: string
  webhookSecret: string
  installationId?: number
}) => {
  const [owner, repoName] = input.repo.split("/")
  const payload: Record<string, unknown> = {
    action: "created",
    repository: {
      full_name: input.repo,
      name: repoName,
      owner: { login: owner }
    },
    discussion: {
      number: input.discussionNumber,
      title: `Synthetic discussion protocol test ${Date.now()}`,
      body: "Synthetic discussion payload for protocol fallback."
    },
    comment: {
      id: input.commentId,
      node_id: input.commentNodeId,
      body: `${input.appHandle} run Reply with exactly: discussion-ok`,
      user: {
        login: "protocol-eval-user",
        type: "User"
      }
    },
    sender: {
      login: "protocol-eval-user",
      type: "User"
    }
  }
  if (input.installationId) {
    payload.installation = { id: input.installationId }
  }
  return emitSyntheticWebhook({
    event: "discussion_comment",
    payload,
    hookTarget: input.hookTarget,
    webhookSecret: input.webhookSecret
  })
}

const resolveSqlitePath = (databaseUrl: string): string | null => {
  if (!databaseUrl.startsWith("sqlite://")) return null
  const raw = databaseUrl.replace(/^sqlite:\/\//, "")
  if (!raw) return null
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
}

const resolveCandidateSqlitePaths = (databaseUrl: string): string[] => {
  const candidates = new Set<string>()
  const fromInput = resolveSqlitePath(databaseUrl)
  if (fromInput) candidates.add(fromInput)

  const fromProcessEnv = process.env.DATABASE_URL ? resolveSqlitePath(process.env.DATABASE_URL) : null
  if (fromProcessEnv) candidates.add(fromProcessEnv)

  try {
    const tmpMatches = readdirSync("/tmp")
      .filter(name => /^codebridge-eval-\d+\.db$/.test(name))
      .map(name => {
        const fullPath = path.join("/tmp", name)
        const mtimeMs = statSync(fullPath).mtimeMs
        return { fullPath, mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const match of tmpMatches) {
      candidates.add(match.fullPath)
    }
  } catch {
    // ignore filesystem probing errors
  }

  return [...candidates]
}

const waitForRunBySourceKey = async (input: {
  databaseUrl: string
  sourceKey: string
  timeoutSec: number
  pollSec: number
}) => {
  const sqlitePaths = resolveCandidateSqlitePaths(input.databaseUrl)
  if (sqlitePaths.length === 0) {
    throw new Error(`Synthetic fallback requires sqlite DATABASE_URL, got: ${input.databaseUrl}`)
  }

  const deadline = Date.now() + input.timeoutSec * 1000
  const sql = "SELECT id, status, source_key FROM runs ORDER BY created_at DESC LIMIT 500;"

  while (Date.now() < deadline) {
    for (const sqlitePath of sqlitePaths) {
      const result = await execa("sqlite3", ["-separator", "\t", sqlitePath, sql], {
        stdio: ["ignore", "pipe", "pipe"]
      })
      const rows = result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      for (const row of rows) {
        const [id, status, sourceKey] = row.split("\t")
        if (sourceKey === input.sourceKey && id) {
          return { id, status: status ?? "unknown", databasePath: sqlitePath }
        }
      }
    }
    await sleep(input.pollSec * 1000)
  }

  throw new Error(`Timed out waiting for run with sourceKey ${input.sourceKey}`)
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const config = await loadConfig(env.configPath)
  const databaseUrl = args.databaseUrl ?? env.databaseUrl
  const now = Date.now()

  const appPrefixes = await resolveDefaultGithubCommandPrefixes({
    githubAppId: env.githubAppId ?? config.secrets?.githubAppId,
    githubPrivateKey: env.githubPrivateKey ?? config.secrets?.githubPrivateKey
  })
  const appHandle = args.appHandle ?? appPrefixes[0] ?? "@codexengineer"
  const appLogin = appHandle.replace(/^@/, "").toLowerCase()
  const appBotLogin = appLogin.endsWith("[bot]") ? appLogin : `${appLogin}[bot]`
  const acceptedBotLogins = [...new Set([appLogin, appBotLogin])]

  const defaultIssueRepo = config.tenants
    .flatMap(tenant => tenant.repos)
    .find(repo => repo.fullName.toLowerCase().includes("codebridge-test"))?.fullName
  const issueRepo = args.issueRepo ?? defaultIssueRepo ?? config.tenants[0]?.repos[0]?.fullName
  if (!issueRepo) throw new Error("Unable to resolve issue repo")
  const prRepo = args.prRepo ?? issueRepo
  const preferredAssignment = await resolvePreferredAssignmentHandle({
    repo: issueRepo,
    appHandle,
    explicitAssignmentHandle: args.assignmentHandle,
    isAssignable: async (handle) => (await resolveAssignmentActor(issueRepo, handle)).actor !== null
  })
  const assignmentHandle = preferredAssignment.handle

  const defaultDiscussionRepo = config.tenants
    .flatMap(tenant => tenant.repos)
    .find(repo => repo.fullName.toLowerCase().includes("vibeteam-eval-hello-world"))?.fullName
  const discussionRepo = args.discussionRepo ?? defaultDiscussionRepo

  const results: CaseResult[] = []

  // Case 1: issue assigned to @githubapphandle.
  const assignmentIssueUrl = await gh([
    "issue",
    "create",
    "--repo",
    issueRepo,
    "--title",
    `Protocol assignment test ${now}`,
    "--body",
    "Reply with exactly: assignment-ok"
  ])
  const assignmentIssue = parseIssueOrPrNumber(assignmentIssueUrl)
  try {
    const assignmentProbe = await resolveAssignmentActor(issueRepo, assignmentHandle)
    if (!assignmentProbe.actor) {
      const assignable = assignmentProbe.actors.length > 0
        ? assignmentProbe.actors.map(actor => `${actor.login}(${actor.type})`).join(", ")
        : "(none)"
      results.push({
        name: "assignment-to-app-handle",
        status: "blocked",
        details: [
          `Native assignment unavailable for ${assignmentHandle}.`,
          `candidates=${assignmentProbe.candidates.join(", ") || "(none)"}`,
          `assignableActors=${assignable}`,
          "No synthetic fallback used."
        ].join(" "),
        url: assignmentIssueUrl
      })
    } else {
      const before = await readIssueAssignmentState(issueRepo, assignmentIssue)
      if (!before.issueNodeId) {
        throw new Error(`Issue ${assignmentIssue} missing node_id; cannot run native assignment mutation`)
      }

      await assignIssueToActor({
        issueNodeId: before.issueNodeId,
        actorId: assignmentProbe.actor.id
      })

      const after = await readIssueAssignmentState(issueRepo, assignmentIssue)
      const assigned = after.assignees.some(entry => entry.nodeId === assignmentProbe.actor?.id)
      if (!assigned) {
        const found = after.assignees.map(entry => `${entry.login}(${entry.nodeId})`).join(", ") || "(none)"
        results.push({
          name: "assignment-to-app-handle",
          status: "blocked",
          details: [
            `Native assignment mutation executed but ${assignmentProbe.actor.login} was not assigned.`,
            `matchedBy=${assignmentProbe.reason}.`,
            `assigneesAfter=${found}.`,
            "No synthetic fallback used."
          ].join(" "),
          url: assignmentIssueUrl
        })
      } else {
        await waitForIssueBotComment({
          repo: issueRepo,
          issueNumber: assignmentIssue,
          botLogins: acceptedBotLogins,
          requireCompletion: false,
          timeoutSec: args.timeoutSec,
          pollSec: args.pollSec
        })
        const assignedLogins = after.assignees.map(entry => entry.login).join(", ")
        results.push({
          name: "assignment-to-app-handle",
          status: "pass",
          details: `Assignment bootstrap worked via native actor ${assignmentProbe.actor.login} (id=${assignmentProbe.actor.id}; assignees=${assignedLogins}).`,
          url: assignmentIssueUrl
        })
      }
    }
  } catch (error) {
    results.push({
      name: "assignment-to-app-handle",
      status: "fail",
      details: error instanceof Error ? error.message : String(error),
      url: assignmentIssueUrl
    })
  } finally {
    if (!args.keepArtifacts) {
      await safeGh([
        "issue",
        "close",
        String(assignmentIssue),
        "--repo",
        issueRepo
      ])
    }
  }

  // Case 2: @githubapphandle mention on GitHub issue.
  const issueUrl = await gh([
    "issue",
    "create",
    "--repo",
    issueRepo,
    "--title",
    `Protocol issue mention test ${now}`,
    "--body",
    "Issue mention protocol test"
  ])
  const issueNumber = parseIssueOrPrNumber(issueUrl)
  try {
    await gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      issueRepo,
      "--body",
      `${appHandle} run Reply with exactly: issue-ok`
    ])
    await waitForIssueBotComment({
      repo: issueRepo,
      issueNumber,
      botLogins: acceptedBotLogins,
      requireCompletion: false,
      timeoutSec: args.timeoutSec,
      pollSec: args.pollSec
    })
    results.push({
      name: "issue-mention",
      status: "pass",
      details: `Issue mention command accepted with ${appHandle}.`,
      url: issueUrl
    })
  } catch (error) {
    results.push({
      name: "issue-mention",
      status: "fail",
      details: error instanceof Error ? error.message : String(error),
      url: issueUrl
    })
  } finally {
    if (!args.keepArtifacts) {
      await safeGh([
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        issueRepo
      ])
    }
  }

  // Case 3: @githubapphandle mention on GitHub PR conversation.
  const openPrsRaw = await gh([
    "pr",
    "list",
    "--repo",
    prRepo,
    "--state",
    "open",
    "--limit",
    "20",
    "--json",
    "number,url"
  ])
  const openPrs = JSON.parse(openPrsRaw) as Array<{ number: number; url: string }>
  const targetPr = openPrs[0]
  if (!targetPr) {
    results.push({
      name: "pr-mention",
      status: "blocked",
      details: `No open PRs available in ${prRepo} for PR conversation mention test.`
    })
  } else {
    try {
      await gh([
        "pr",
        "comment",
        String(targetPr.number),
        "--repo",
        prRepo,
        "--body",
        `${appHandle} run Reply in one short sentence.`
      ])

      await waitForIssueBotComment({
        repo: prRepo,
        issueNumber: targetPr.number,
        botLogins: acceptedBotLogins,
        requireCompletion: false,
        timeoutSec: args.timeoutSec,
        pollSec: args.pollSec
      })

      results.push({
        name: "pr-mention",
        status: "pass",
        details: `PR conversation mention command accepted with ${appHandle}.`,
        url: targetPr.url
      })
    } catch (error) {
      results.push({
        name: "pr-mention",
        status: "fail",
        details: error instanceof Error ? error.message : String(error),
        url: targetPr.url
      })
    }
  }

  // Case 4: @githubapphandle mention on GitHub discussion conversation.
  if (!discussionRepo) {
    results.push({
      name: "discussion-mention",
      status: "blocked",
      details: "No discussion repo configured."
    })
  } else {
    const [owner, repoName] = discussionRepo.split("/")
    const discussionTenant = config.tenants.find(tenant =>
      tenant.repos.some(repo => repo.fullName.toLowerCase() === discussionRepo.toLowerCase())
    )
    const githubAppId = env.githubAppId ?? config.secrets?.githubAppId
    const githubPrivateKey = env.githubPrivateKey ?? config.secrets?.githubPrivateKey
    const installationId = discussionTenant?.github?.installationId
    let discussionUrl: string | undefined
    let discussionBlockedReason: string | undefined
    let discussionPassed = false

    try {
      const repoInfoRaw = await gh(["repo", "view", discussionRepo, "--json", "hasDiscussionsEnabled"])
      const repoInfo = JSON.parse(repoInfoRaw) as { hasDiscussionsEnabled: boolean }
      if (!repoInfo.hasDiscussionsEnabled) {
        discussionBlockedReason = `Discussions are disabled on ${discussionRepo}.`
      }

      if (!discussionBlockedReason && (!githubAppId || !githubPrivateKey || !installationId)) {
        discussionBlockedReason = `Missing GitHub App credentials or installation mapping for ${discussionRepo}.`
      }

      // Preflight integration access so permission failures can transparently fall back to synthetic webhook.
      if (!discussionBlockedReason) {
        try {
          const client = await createInstallationClient({
            appId: githubAppId!,
            privateKey: formatPrivateKey(githubPrivateKey!),
            installationId: installationId!
          })
          await client.octokit.graphql(
            `
              query DiscussionPermissionProbe($owner: String!, $repo: String!) {
                repository(owner: $owner, name: $repo) {
                  discussions(first: 1) {
                    nodes { number }
                  }
                }
              }
            `,
            {
              owner,
              repo: repoName
            }
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes("Resource not accessible by integration")) {
            discussionBlockedReason = "GitHub App lacks Discussions permission for this repository."
          } else {
            throw error
          }
        }
      }

      if (!discussionBlockedReason) {
        let discussionId: string | undefined
        let discussionNumber: number | undefined

        if (args.discussionNumber) {
          const selectedRaw = await gh([
            "api",
            "graphql",
            "-f",
            `query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){id number url}}}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${repoName}`,
            "-F",
            `number=${args.discussionNumber}`
          ])
          const selected = JSON.parse(selectedRaw) as {
            data?: {
              repository?: {
                discussion?: {
                  id: string
                  number: number
                  url: string
                } | null
              } | null
            } | null
          }
          const discussion = selected.data?.repository?.discussion
          if (!discussion) {
            discussionBlockedReason = `Discussion #${args.discussionNumber} was not found in ${discussionRepo}.`
          } else {
            discussionId = discussion.id
            discussionNumber = discussion.number
            discussionUrl = discussion.url
          }
        } else {
          const latestRaw = await gh([
            "api",
            "graphql",
            "-f",
            `query=query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){discussions(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number url}}}}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${repoName}`
          ])
          const latest = JSON.parse(latestRaw) as {
            data?: {
              repository?: {
                discussions?: {
                  nodes?: Array<{
                    id: string
                    number: number
                    url: string
                  }>
                }
              }
            }
          }
          const discussion = latest.data?.repository?.discussions?.nodes?.[0]
          if (!discussion) {
            discussionBlockedReason = `No existing discussions found in ${discussionRepo}.`
          } else {
            discussionId = discussion.id
            discussionNumber = discussion.number
            discussionUrl = discussion.url
          }
        }

        if (!discussionBlockedReason && discussionId && discussionNumber) {
          await gh([
            "api",
            "graphql",
            "-f",
            `query=mutation($discussionId:ID!,$body:String!){addDiscussionComment(input:{discussionId:$discussionId,body:$body}){comment{id}}}`,
            "-f",
            `discussionId=${discussionId}`,
            "-f",
            `body=${appHandle} run Reply with exactly: discussion-ok`
          ])

          await waitForDiscussionBotComment({
            repo: discussionRepo,
            discussionNumber,
            botLogins: acceptedBotLogins,
            expectedSubstring: "discussion-ok",
            timeoutSec: args.timeoutSec,
            pollSec: args.pollSec
          })

          results.push({
            name: "discussion-mention",
            status: "pass",
            details: `Discussion mention command accepted with ${appHandle}.`,
            url: discussionUrl
          })
          discussionPassed = true
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        name: "discussion-mention",
        status: "fail",
        details: message,
        url: discussionUrl
      })
      discussionPassed = true
    }

    if (!discussionPassed) {
      const discussionInstallationId = resolveRepoInstallationId(discussionRepo, config)
      if (!discussionInstallationId) {
        results.push({
          name: "discussion-mention",
          status: "blocked",
          details: `Discussion fallback unavailable: installation mapping not found for ${discussionRepo}.`
        })
      } else if (!args.webhookSecret) {
        results.push({
          name: "discussion-mention",
          status: "blocked",
          details: `${discussionBlockedReason ?? "Discussion precondition failed"} Synthetic fallback requires webhook secret.`
        })
      } else {
        const syntheticDiscussionNumber = args.discussionNumber ?? (900000 + Math.floor(Math.random() * 100000))
        const syntheticCommentId = Date.now() * 1000 + Math.floor(Math.random() * 1000)
        const syntheticNodeId = `DC_SYNTHETIC_${randomUUID()}`
        const sourceKey = [
          "github-discussion",
          discussionInstallationId,
          discussionRepo.toLowerCase(),
          syntheticDiscussionNumber,
          syntheticNodeId,
          "run"
        ].join(":")

        const synthetic = await emitSyntheticDiscussionCommentWebhook({
          repo: discussionRepo,
          discussionNumber: syntheticDiscussionNumber,
          commentId: syntheticCommentId,
          commentNodeId: syntheticNodeId,
          appHandle,
          hookTarget: args.hookTarget,
          webhookSecret: args.webhookSecret,
          installationId: discussionInstallationId
        })

        if (!synthetic.ok) {
          results.push({
            name: "discussion-mention",
            status: "blocked",
            details: `${discussionBlockedReason ?? "Discussion precondition failed"} Synthetic fallback failed: ${synthetic.error ?? "unknown error"}`
          })
        } else {
          try {
            const run = await waitForRunBySourceKey({
              databaseUrl,
              sourceKey,
              timeoutSec: args.timeoutSec,
              pollSec: args.pollSec
            })
            results.push({
              name: "discussion-mention",
              status: "pass",
              details: `Discussion mention accepted via synthetic discussion_comment webhook fallback. sourceKey=${sourceKey} runId=${run.id} status=${run.status} db=${run.databasePath}`
            })
          } catch (error) {
            results.push({
              name: "discussion-mention",
              status: "fail",
              details: error instanceof Error ? error.message : String(error)
            })
          }
        }
      }
    }
  }

  const summary = {
    appHandle,
    assignmentHandle,
    appLogin,
    discussionNumber: args.discussionNumber,
    issueRepo,
    prRepo,
    discussionRepo,
    results
  }
  console.log(JSON.stringify(summary, null, 2))

  const failed = results.filter(result => result.status === "fail")
  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
