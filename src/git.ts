import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { execa } from "execa"

const TRANSIENT_UNTRACKED_PATHS = [
  ".reflection/",
  ".tts/",
  ".tts-debug.log"
]

export async function git(args: string[], cwd: string): Promise<string> {
  const result = await execa("git", args, { cwd })
  return result.stdout.trim()
}

export async function isDirty(cwd: string): Promise<boolean> {
  const entries = await getStatusEntries(cwd)
  return entries.some(entry => !shouldIgnoreStatusEntry(entry))
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  return branch
}

export async function countCommitsAhead(cwd: string, baseRef: string): Promise<number> {
  const output = await git(["rev-list", "--count", `${baseRef}..HEAD`], cwd)
  const parsed = Number.parseInt(output, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to parse commit distance for ${baseRef}: ${JSON.stringify(output)}`)
  }
  return parsed
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
  await stripUnexpectedNestedGitRepositories(cwd)
  const ignoredPaths = await getIgnoredTransientUntrackedPaths(cwd)
  await git(["add", "-A"], cwd)
  if (ignoredPaths.length > 0) {
    await git(["reset", "--", ...ignoredPaths], cwd)
  }
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

async function getIgnoredTransientUntrackedPaths(cwd: string): Promise<string[]> {
  const entries = await getStatusEntries(cwd)
  return entries
    .filter(shouldIgnoreStatusEntry)
    .map(entry => entry.path)
}

async function stripUnexpectedNestedGitRepositories(cwd: string): Promise<void> {
  const trackedGitlinks = await getTrackedGitlinks(cwd)
  const nestedGitEntries = await findNestedGitEntries(cwd)
  for (const entry of nestedGitEntries) {
    if (trackedGitlinks.has(entry.repoRootRel)) continue
    await rm(path.join(cwd, entry.gitEntryRel), { recursive: true, force: true })
  }
}

async function getStatusEntries(cwd: string): Promise<Array<{ code: string; path: string }>> {
  const status = await git(["status", "--porcelain", "--untracked-files=all"], cwd)
  return status
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => ({
      code: line.slice(0, 2),
      path: line.slice(3)
    }))
}

async function getTrackedGitlinks(cwd: string): Promise<Set<string>> {
  const output = await git(["ls-files", "--stage"], cwd)
  const gitlinks = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("160000 ")) continue
    const parts = line.split("\t")
    const filePath = parts[1]?.trim()
    if (filePath) gitlinks.add(filePath)
  }
  return gitlinks
}

async function findNestedGitEntries(cwd: string): Promise<Array<{ gitEntryRel: string; repoRootRel: string }>> {
  const results: Array<{ gitEntryRel: string; repoRootRel: string }> = []

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name)
      const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name

      if (entry.name === ".git") {
        if (relDir) {
          results.push({
            gitEntryRel: relPath,
            repoRootRel: relDir
          })
        }
        continue
      }

      if (entry.isDirectory()) {
        await walk(absPath, relDir ? path.posix.join(relDir, entry.name) : entry.name)
      }
    }
  }

  await walk(cwd, "")
  return results
}

function shouldIgnoreStatusEntry(entry: { code: string; path: string }): boolean {
  if (entry.code !== "??") return false
  return TRANSIENT_UNTRACKED_PATHS.some(pattern => {
    if (pattern.endsWith("/")) {
      return entry.path.startsWith(pattern)
    }
    return entry.path === pattern
  })
}
