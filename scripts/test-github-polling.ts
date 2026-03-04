import { execa } from "execa"
import { loadConfig, loadEnv } from "../src/config.js"

type Args = {
  repo?: string
  issue?: number
  title: string
  body: string
  comment: string
  timeoutSec: number
  pollSec: number
  close: boolean
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    title: "CodeBridge Polling Test",
    body: "Test issue for CodeBridge polling mode.",
    comment: "codex: Please respond with the path to README.md (if present). Do not modify files.",
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
  const normalized = body.toLowerCase()
  return normalized.includes("complete") || normalized.includes("status: failed") || normalized.includes("status: succeeded")
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const config = await loadConfig(env.configPath)

  const defaultRepo = config.tenants[0]?.repos[0]?.fullName
  const repo = args.repo ?? process.env.CODEBRIDGE_TEST_REPO ?? process.env.CODEX_BRIDGE_TEST_REPO ?? defaultRepo
  if (!repo) throw new Error("No repo provided and config has no repos")

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
    args.comment
  ])

  const startTime = Date.now()
  const deadline = Date.now() + args.timeoutSec * 1000
  let commentId: number | null = null

  while (Date.now() < deadline) {
    const raw = await gh([
      "api",
      `repos/${repo}/issues/${resolvedIssue}/comments?per_page=100`
    ])
    const comments = JSON.parse(raw) as Array<{ id: number; body: string; created_at: string }>

    if (!commentId) {
      const recent = comments
        .filter(comment => new Date(comment.created_at).getTime() >= startTime - 1000)
        .find(comment => isCodexComment(comment.body))
      if (recent) commentId = recent.id
    }

    if (commentId) {
      const current = comments.find(comment => comment.id === commentId)
      if (current && isFinal(current.body)) {
        console.log(current.body)
        if (args.close) {
          await gh(["issue", "close", String(resolvedIssue), "--repo", repo])
        }
        return
      }
    }

    await sleep(args.pollSec * 1000)
  }

  throw new Error("Timed out waiting for Codex run result")
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
