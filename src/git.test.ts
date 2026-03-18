import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { commitAll, git, isDirty } from "./git.js"

describe("git helpers", () => {
  const repos: string[] = []

  afterEach(async () => {
    await Promise.all(repos.map(repo => rm(repo, { recursive: true, force: true })))
    repos.length = 0
  })

  it("ignores transient untracked agent artifacts when checking dirtiness", async () => {
    const repo = await createRepo()
    repos.push(repo)

    await mkdir(path.join(repo, ".reflection"), { recursive: true })
    await mkdir(path.join(repo, ".tts"), { recursive: true })
    await writeFile(path.join(repo, ".reflection", "notes.md"), "scratch\n", "utf8")
    await writeFile(path.join(repo, ".tts", "audio.json"), "{}\n", "utf8")
    await writeFile(path.join(repo, ".tts-debug.log"), "debug\n", "utf8")

    await expect(isDirty(repo)).resolves.toBe(false)

    await writeFile(path.join(repo, "README.md"), "changed\n", "utf8")
    await expect(isDirty(repo)).resolves.toBe(true)
  })

  it("does not stage transient untracked agent artifacts in commits", async () => {
    const repo = await createRepo()
    repos.push(repo)

    await mkdir(path.join(repo, ".reflection"), { recursive: true })
    await writeFile(path.join(repo, ".reflection", "notes.md"), "scratch\n", "utf8")
    await writeFile(path.join(repo, ".tts-debug.log"), "debug\n", "utf8")
    await writeFile(path.join(repo, "README.md"), "changed\n", "utf8")

    await commitAll(repo, "test commit")

    const files = await git(["show", "--name-only", "--format=", "HEAD"], repo)
    expect(files).toContain("README.md")
    expect(files).not.toContain(".reflection/notes.md")
    expect(files).not.toContain(".tts-debug.log")
  })

  it("flattens accidental nested git repositories before committing", async () => {
    const repo = await createRepo()
    repos.push(repo)

    const nestedRepo = path.join(repo, "customer-flow", "issue-1")
    await mkdir(path.join(nestedRepo, "src"), { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: nestedRepo })
    await writeFile(path.join(nestedRepo, "package.json"), "{\"type\":\"module\"}\n", "utf8")
    await writeFile(path.join(nestedRepo, "src", "main.ts"), "console.log('Hello, world!')\n", "utf8")

    await commitAll(repo, "flatten nested repo")

    const files = (await git(["show", "--name-only", "--format=", "HEAD"], repo)).split(/\r?\n/).filter(Boolean)
    expect(files).toContain("customer-flow/issue-1/package.json")
    expect(files).toContain("customer-flow/issue-1/src/main.ts")
    expect(files).not.toContain("customer-flow/issue-1")

    const nestedGitPath = path.join(nestedRepo, ".git")
    await expect(import("node:fs/promises").then(fs => fs.access(nestedGitPath))).rejects.toThrow()
  })
})

async function createRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "codebridge-git-"))
  execFileSync("git", ["init", "-q"], { cwd: repo })
  execFileSync("git", ["checkout", "-b", "main"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "CodeBridge Test"], { cwd: repo })
  execFileSync("git", ["config", "user.email", "codebridge@example.com"], { cwd: repo })
  await writeFile(path.join(repo, "README.md"), "initial\n", "utf8")
  execFileSync("git", ["add", "README.md"], { cwd: repo })
  execFileSync("git", ["commit", "-m", "init", "-q"], { cwd: repo })
  return repo
}
