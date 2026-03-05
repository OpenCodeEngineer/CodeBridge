import { execa } from "execa"
import { loadConfig, loadEnv } from "../src/config.js"
import { resolveDefaultGithubCommandPrefixes } from "../src/command-prefixes.js"

type Args = {
  repo?: string
  issue?: number
  title: string
  body: string
  comment?: string
  timeoutSec: number
  pollSec: number
  close: boolean
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    title: "CodeBridge Polling Test",
    body: "Test issue for CodeBridge polling mode.",
    timeoutSec: 240,
    pollSec: 5,
    close: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--repo" && next) {
      args.repo = next
      i += 1
    } else if (arg === "--issue" && next) {
      args.issue = Number(next)
      i += 1
    } else if (arg === "--title" && next) {
      args.title = next
      i += 1
    } else if (arg === "--body" && next) {
      args.body = next
      i += 1
    } else if (arg === "--comment" && next) {
      args.comment = next
      i += 1
    } else if (arg === "--timeout" && next) {
      args.timeoutSec = Number(next)
      i += 1
    } else if (arg === "--poll" && next) {
      args.pollSec = Number(next)
      i += 1
    } else if (arg === "--close") {
      args.close = true
    }
  }

  return args
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const gh = async (args: string[]) => {
  const result = await execa("gh", args, { stdio: ["ignore", "pipe", "pipe"] })
  return result.stdout.trim()
}

const extractIssueNumber = (url: string): number => {
  const match = url.match(/\/issues\/(\d+)/)
  if (!match) throw new Error(`Unable to parse issue number from ${url}`)
  return Number(match[1])
}

const isCodexComment = (body: string) => body.includes("Codex run")

const isFinal = (body: string) => {
  const firstLine = body.split("\n")[0]?.trim().toLowerCase() ?? ""
  if (/^codex run\s+\S+\s+complete$/.test(firstLine)) return true

  const statusMatch = body.match(/^\s*status:\s*([a-z-]+)/im)
  if (!statusMatch) return false
  const status = statusMatch[1].toLowerCase()
  return status === "completed" || status === "failed" || status === "succeeded"
}

const resolveDefaultComment = async (args: Args, env: ReturnType<typeof loadEnv>, config: Awaited<ReturnType<typeof loadConfig>>) => {
  if (args.comment) return args.comment

  const appPrefixes = await resolveDefaultGithubCommandPrefixes({
    githubAppId: env.githubAppId ?? config.secrets?.githubAppId,
    githubPrivateKey: env.githubPrivateKey ?? config.secrets?.githubPrivateKey
  })
  const handle = appPrefixes[0] ?? (() => {
    const fallbackAssignee = config.tenants
      .flatMap(tenant => tenant.github?.assignmentAssignees ?? [])
      .find(Boolean)
    return fallbackAssignee ? `@${fallbackAssignee}` : null
  })()

  if (!handle) {
    throw new Error("Unable to resolve a GitHub mention handle. Configure GitHub App credentials or pass --comment explicitly.")
  }

  return `${handle} run Please respond with the path to README.md (if present). Do not modify files.`
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const config = await loadConfig(env.configPath)

  const defaultRepo = config.tenants[0]?.repos[0]?.fullName
  const repo = args.repo ?? process.env.CODEBRIDGE_TEST_REPO ?? process.env.CODEX_BRIDGE_TEST_REPO ?? defaultRepo
  if (!repo) throw new Error("No repo provided and config has no repos")
  const comment = await resolveDefaultComment(args, env, config)

  const issueNumber = args.issue ?? (() => {
    const url = gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      args.title,
      "--body",
      args.body
    ])
    return url.then(extractIssueNumber)
  })()

  const resolvedIssue = await issueNumber

  await gh([
    "issue",
    "comment",
    String(resolvedIssue),
    "--repo",
    repo,
    "--body",
    comment
  ])

  const startTime = Date.now()
  const deadline = Date.now() + args.timeoutSec * 1000

  while (Date.now() < deadline) {
    const raw = await gh([
      "api",
      `repos/${repo}/issues/${resolvedIssue}/comments?per_page=100`
    ])
    const comments = JSON.parse(raw) as Array<{ id: number; body: string; created_at: string }>
    const recentCodex = comments
      .filter(comment => new Date(comment.created_at).getTime() >= startTime - 1000)
      .filter(comment => isCodexComment(comment.body))
      .sort((a, b) => a.id - b.id)
    const latest = recentCodex[recentCodex.length - 1]
    if (latest && isFinal(latest.body)) {
      console.log(latest.body)
      if (args.close) {
        await gh(["issue", "close", String(resolvedIssue), "--repo", repo])
      }
      return
    }

    await sleep(args.pollSec * 1000)
  }

  throw new Error("Timed out waiting for Codex run result")
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
