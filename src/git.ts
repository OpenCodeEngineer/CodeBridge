import { execa } from "execa"

export async function git(args: string[], cwd: string): Promise<string> {
  const result = await execa("git", args, { cwd })
  return result.stdout.trim()
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(["status", "--porcelain"], cwd)
  return status.length > 0
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  return branch
}

export async function fetchOrigin(cwd: string): Promise<void> {
  await git(["fetch", "origin"], cwd)
}

export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  await git(["checkout", branch], cwd)
}

export async function createBranch(cwd: string, branch: string, base: string): Promise<void> {
  await git(["checkout", "-B", branch, base], cwd)
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], cwd)
  await git(["commit", "-m", message], cwd)
}

export async function pushBranch(cwd: string, remoteUrl: string, branch: string): Promise<void> {
  await git(["push", remoteUrl, `HEAD:${branch}`], cwd)
}

export async function getDefaultBranchFromOrigin(cwd: string): Promise<string | null> {
  try {
    const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)
    const parts = ref.split("/")
    return parts[parts.length - 1] ?? null
  } catch {
    return null
  }
}
