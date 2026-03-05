import { execa } from "execa"
import { loadConfig, loadEnv } from "../src/config.js"
import { resolveDefaultGithubCommandPrefixes } from "../src/command-prefixes.js"
import { createInstallationClient, formatPrivateKey } from "../src/github-auth.js"

type Args = {
  issueRepo?: string
  prRepo?: string
  discussionRepo?: string
  discussionNumber?: number
  appHandle?: string
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

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
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
  const result = await execa("gh", args, { stdio: ["ignore", "pipe", "pipe"] })
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

const parseIssueOrPrNumber = (url: string): number => {
  const match = url.match(/\/(issues|pull)\/(\d+)/)
  if (!match) throw new Error(`Unable to parse issue/PR number from URL: ${url}`)
  return Number(match[2])
}

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
        const body = (comment.body ?? "").toLowerCase()
        if (input.requireCompletion && !(body.includes("codex run") && body.includes("complete"))) {
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

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const config = await loadConfig(env.configPath)
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

  const defaultDiscussionRepo = config.tenants
    .flatMap(tenant => tenant.repos)
    .find(repo => repo.fullName.toLowerCase().includes("vibeteam-eval-hello-world"))?.fullName
  const discussionRepo = args.discussionRepo ?? defaultDiscussionRepo

  const results: CaseResult[] = []

  // Case 1: issue assigned to @githubapphandle.
  const assignableBotCheck = await safeGh([
    "api",
    `repos/${issueRepo}/assignees/${encodeURIComponent(appBotLogin)}`,
    "-i"
  ])
  const assignableLoginCheck = await safeGh([
    "api",
    `repos/${issueRepo}/assignees/${encodeURIComponent(appLogin)}`,
    "-i"
  ])
  const assignableCandidate = assignableBotCheck.ok
    ? appBotLogin
    : assignableLoginCheck.ok
      ? appLogin
      : null

  if (!assignableCandidate) {
    results.push({
      name: "assignment-to-app-handle",
      status: "blocked",
      details: `GitHub does not allow assigning ${appBotLogin} or ${appLogin} on ${issueRepo}.`
    })
  } else {
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
      await gh([
        "issue",
        "edit",
        String(assignmentIssue),
        "--repo",
        issueRepo,
        "--add-assignee",
        assignableCandidate
      ])
      await waitForIssueBotComment({
        repo: issueRepo,
        issueNumber: assignmentIssue,
        botLogins: acceptedBotLogins,
        requireCompletion: true,
        timeoutSec: args.timeoutSec,
        pollSec: args.pollSec
      })
      results.push({
        name: "assignment-to-app-handle",
        status: "pass",
        details: `Assignment bootstrap worked via assignee ${assignableCandidate}.`,
        url: assignmentIssueUrl
      })
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
      requireCompletion: true,
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
        requireCompletion: true,
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
    const repoInfoRaw = await gh(["repo", "view", discussionRepo, "--json", "hasDiscussionsEnabled"])
    const repoInfo = JSON.parse(repoInfoRaw) as { hasDiscussionsEnabled: boolean }
    if (!repoInfo.hasDiscussionsEnabled) {
      results.push({
        name: "discussion-mention",
        status: "blocked",
        details: `Discussions are disabled on ${discussionRepo}.`
      })
    } else {
      const [owner, repoName] = discussionRepo.split("/")
      const discussionTenant = config.tenants.find(tenant =>
        tenant.repos.some(repo => repo.fullName.toLowerCase() === discussionRepo.toLowerCase())
      )
      const githubAppId = env.githubAppId ?? config.secrets?.githubAppId
      const githubPrivateKey = env.githubPrivateKey ?? config.secrets?.githubPrivateKey
      const installationId = discussionTenant?.github?.installationId
      let discussionPrereqOk = true
      if (!githubAppId || !githubPrivateKey || !installationId) {
        results.push({
          name: "discussion-mention",
          status: "blocked",
          details: `Missing GitHub App credentials or installation mapping for ${discussionRepo}.`
        })
        discussionPrereqOk = false
      }

      // Preflight integration access so missing Discussions permission is "blocked" (not timeout fail).
      if (discussionPrereqOk) {
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
          const blocked = message.includes("Resource not accessible by integration")
          results.push({
            name: "discussion-mention",
            status: blocked ? "blocked" : "fail",
            details: blocked
              ? "GitHub App lacks Discussions permission for this repository."
              : message
          })
          discussionPrereqOk = false
        }
      }

      let discussionId: string | undefined
      let discussionNumber: number | undefined
      let discussionUrl: string | undefined

      if (discussionPrereqOk) {
        try {
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
              throw new Error(`Discussion #${args.discussionNumber} was not found in ${discussionRepo}.`)
            }
            discussionId = discussion.id
            discussionNumber = discussion.number
            discussionUrl = discussion.url
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
              results.push({
                name: "discussion-mention",
                status: "blocked",
                details: `No existing discussions found in ${discussionRepo}. Provide --discussion-number or create one discussion first.`
              })
              discussionId = undefined
            } else {
              discussionId = discussion.id
              discussionNumber = discussion.number
              discussionUrl = discussion.url
            }
          }

          if (discussionId && discussionNumber) {
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
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const blocked = message.includes("Resource not accessible by integration")
          results.push({
            name: "discussion-mention",
            status: blocked ? "blocked" : "fail",
            details: blocked
              ? "GitHub App does not currently have Discussions permission (Resource not accessible by integration)."
              : message,
            url: discussionUrl
          })
        }
      }
    }
  }

  const summary = {
    appHandle,
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
