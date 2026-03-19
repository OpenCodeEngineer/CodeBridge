import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ensureGitHubRunWorkspace, resolveManagedSessionRepoPath } from "./workspace.js"

describe("ensureGitHubRunWorkspace", () => {
  const tempPaths: string[] = []

  afterEach(async () => {
    await Promise.all(tempPaths.map(target => rm(target, { recursive: true, force: true })))
    tempPaths.length = 0
  })

  it("clones a base repo under the workspace root and creates isolated worktrees per run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codebridge-workspace-"))
    tempPaths.push(root)

    const remote = path.join(root, "github.com", "acme", "widgets.git")
    await seedRemoteRepository(remote, "v1\n")

    const first = await ensureGitHubRunWorkspace({
      repoFullName: "acme/widgets",
      runId: "run-a",
      workspaceRoot: path.join(root, "workspace"),
      remoteUrl: remote,
      fetchUrl: remote,
      defaultBranch: "main"
    })

    expect(first.baseRepoPath).toBe(path.join(root, "workspace", "widgets"))
    expect(first.worktreePath).toBe(path.join(root, "workspace", ".codebridge", "worktrees", "acme__widgets", "run-a"))
    await expect(readFile(path.join(first.worktreePath, "README.md"), "utf8")).resolves.toBe("v1\n")

    await pushRemoteUpdate(remote, "v2\n")

    const second = await ensureGitHubRunWorkspace({
      repoFullName: "acme/widgets",
      runId: "run-b",
      workspaceRoot: path.join(root, "workspace"),
      remoteUrl: remote,
      fetchUrl: remote,
      defaultBranch: "main"
    })

    expect(second.baseRepoPath).toBe(first.baseRepoPath)
    expect(second.worktreePath).not.toBe(first.worktreePath)
    await expect(readFile(path.join(second.worktreePath, "README.md"), "utf8")).resolves.toBe("v2\n")
  })

  it("falls back to an owner-scoped base clone path when the repo name path is already occupied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codebridge-workspace-"))
    tempPaths.push(root)

    const workspaceRoot = path.join(root, "workspace")
    await mkdir(path.join(workspaceRoot, "widgets"), { recursive: true })
    await writeFile(path.join(workspaceRoot, "widgets", "README.md"), "occupied\n", "utf8")

    const remote = path.join(root, "github.com", "acme", "widgets.git")
    await seedRemoteRepository(remote, "v1\n")

    const prepared = await ensureGitHubRunWorkspace({
      repoFullName: "acme/widgets",
      runId: "run-collision",
      workspaceRoot,
      remoteUrl: remote,
      fetchUrl: remote,
      defaultBranch: "main"
    })

    expect(prepared.baseRepoPath).toBe(path.join(workspaceRoot, "acme__widgets"))
    await expect(readFile(path.join(prepared.worktreePath, "README.md"), "utf8")).resolves.toBe("v1\n")
  })
})

describe("resolveManagedSessionRepoPath", () => {
  it("falls back to the latest persisted run path when no in-memory session binding exists", async () => {
    const resolved = await resolveManagedSessionRepoPath({
      store: {
        getLatestRunForIssue: async () => ({
          id: "run-1",
          tenantId: "tenant",
          repoFullName: "acme/widgets",
          repoPath: "/tmp/worktree",
          status: "running",
          prompt: "test",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z"
        })
      } as any,
      tenantId: "tenant",
      repo: {
        fullName: "acme/widgets"
      },
      owner: "acme",
      repoName: "widgets",
      issueNumber: 42
    })

    expect(resolved).toBe("/tmp/worktree")
  })
})

async function seedRemoteRepository(remotePath: string, readme: string): Promise<void> {
  await mkdir(path.dirname(remotePath), { recursive: true })
  execFileSync("git", ["init", "--bare", "-q", remotePath])

  const working = await mkdtemp(path.join(tmpdir(), "codebridge-remote-seed-"))
  try {
    execFileSync("git", ["clone", remotePath, working], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "checkout", "-b", "main"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "config", "user.name", "CodeBridge Test"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "config", "user.email", "codebridge@example.com"], { stdio: "ignore" })
    await writeFile(path.join(working, "README.md"), readme, "utf8")
    execFileSync("git", ["-C", working, "add", "README.md"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "commit", "-m", "seed", "-q"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "push", "origin", "main"], { stdio: "ignore" })
    execFileSync("git", ["-C", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "ignore" })
  } finally {
    await rm(working, { recursive: true, force: true })
  }
}

async function pushRemoteUpdate(remotePath: string, readme: string): Promise<void> {
  const working = await mkdtemp(path.join(tmpdir(), "codebridge-remote-update-"))
  try {
    execFileSync("git", ["clone", remotePath, working], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "checkout", "main"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "config", "user.name", "CodeBridge Test"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "config", "user.email", "codebridge@example.com"], { stdio: "ignore" })
    await writeFile(path.join(working, "README.md"), readme, "utf8")
    execFileSync("git", ["-C", working, "add", "README.md"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "commit", "-m", "update", "-q"], { stdio: "ignore" })
    execFileSync("git", ["-C", working, "push", "origin", "main"], { stdio: "ignore" })
  } finally {
    await rm(working, { recursive: true, force: true })
  }
}
