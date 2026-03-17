import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runOpenCodePrompt } from "../src/opencode.js"

async function main() {
  const baseUrl = readArg("--base-url") ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096"
  const username = readArg("--username") ?? process.env.OPENCODE_USERNAME ?? process.env.OPENCODE_SERVER_USERNAME
  const password = readArg("--password") ?? process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD
  const agent = readArg("--agent")
  const model = readArg("--model")
  const timeoutMs = readNumberArg("--timeout-ms") ?? 300_000
  const pollIntervalMs = readNumberArg("--poll-interval-ms") ?? 1_000

  const repoPath = await mkdtemp(path.join(tmpdir(), "codebridge-opencode-"))
  const proofPath = path.join(repoPath, "opencode-proof.txt")

  try {
    execFileSync("git", ["init", "-q"], { cwd: repoPath })
    execFileSync("git", ["checkout", "-b", "main"], { cwd: repoPath })
    execFileSync("git", ["config", "user.name", "CodeBridge Test"], { cwd: repoPath })
    execFileSync("git", ["config", "user.email", "codebridge@example.com"], { cwd: repoPath })
    await writeFile(path.join(repoPath, "README.md"), "# OpenCode Integration Test\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: repoPath })
    execFileSync("git", ["commit", "-m", "init", "-q"], { cwd: repoPath })

    const result = await runOpenCodePrompt({
      integration: {
        baseUrl,
        username,
        password,
        timeoutMs,
        pollIntervalMs
      },
      directory: repoPath,
      title: "CodeBridge OpenCode integration test",
      prompt: [
        "Create a file named `opencode-proof.txt` in the repository root.",
        'The file must contain exactly: `CodeBridge OpenCode integration OK`.',
        "Do not modify any other files."
      ].join(" "),
      agent,
      model
    })

    const proof = (await readFile(proofPath, "utf8")).trim()
    if (proof !== "CodeBridge OpenCode integration OK") {
      throw new Error(`Unexpected proof content: ${JSON.stringify(proof)}`)
    }

    const gitStatus = execFileSync("git", ["status", "--short"], { cwd: repoPath, encoding: "utf8" }).trim()
    if (!gitStatus.includes("opencode-proof.txt")) {
      throw new Error(`Expected git status to include opencode-proof.txt, got: ${gitStatus || "<clean>"}`)
    }

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      repoPath,
      sessionId: result.sessionId,
      responseText: result.responseText,
      gitStatus
    }, null, 2))
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function readNumberArg(name: string): number | undefined {
  const value = readArg(name)
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
