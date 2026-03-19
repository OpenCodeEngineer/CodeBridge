import os from "node:os"
import path from "node:path"
import { access, mkdir, readdir, rm, stat } from "node:fs/promises"
import { execa } from "execa"
import type { RunStore } from "./storage.js"
import type { GitHubContext, RepoConfig } from "./types.js"
import { findSessionBindingByIssue } from "./codex-session-relay.js"
import { createGitHubInstallationClientFactory, type GitHubAppMap } from "./github-apps.js"
import { logger } from "./logger.js"
import { ensureRepoPath, parseGitHubFullNameFromRemote } from "./repo.js"

const WORKTREE_ROOT_SEGMENTS = [".codebridge", "worktrees"]

export type WorkspaceManager = {
  prepareRunRepoPath: (input: {
    repo: RepoConfig
    github?: GitHubContext
    runId: string
  }) => Promise<string>
}

export function createWorkspaceManager(params: {
  githubApps?: GitHubAppMap
  workspaceRoot?: string
}): WorkspaceManager {
  const getGitHubClient = params.githubApps
    ? createGitHubInstallationClientFactory(params.githubApps)
    : null

  const prepareRunRepoPath = async (input: {
    repo: RepoConfig
    github?: GitHubContext
    runId: string
  }) => {
    if (!input.github?.owner || !input.github.repo) {
      return await ensureRepoPath(input.repo)
    }

    const repoFullName = `${input.github.owner}/${input.github.repo}`
    const plainRemoteUrl = buildGitHubRemoteUrl(repoFullName)
    let fetchUrl = plainRemoteUrl

    if (input.github.installationId && getGitHubClient) {
      try {
        const client = await getGitHubClient(input.github.appKey ?? "default", input.github.installationId)
        fetchUrl = buildAuthenticatedGitHubRemoteUrl(repoFullName, client.token)
      } catch (error) {
        logger.warn({
          err: error,
          repoFullName,
          appKey: input.github.appKey ?? "default"
        }, "Falling back to unauthenticated GitHub clone/fetch")
      }
    }

    const prepared = await ensureGitHubRunWorkspace({
      repoFullName,
      runId: input.runId,
      workspaceRoot: params.workspaceRoot,
      remoteUrl: plainRemoteUrl,
      fetchUrl,
      defaultBranch: input.repo.baseBranch
    })
    return prepared.worktreePath
  }

  return { prepareRunRepoPath }
}

export async function resolveManagedSessionRepoPath(input: {
  store: RunStore
  tenantId: string
  repo: RepoConfig
  owner: string
  repoName: string
  issueNumber: number
}): Promise<string> {
  const binding = findSessionBindingByIssue({
    owner: input.owner,
    repo: input.repoName,
    issueNumber: input.issueNumber
  })
  if (binding?.repoPath) {
    return binding.repoPath
  }

  const latest = await input.store.getLatestRunForIssue({
    tenantId: input.tenantId,
    repoFullName: input.repo.fullName,
    issueNumber: input.issueNumber
  })
  if (latest?.repoPath) {
    return latest.repoPath
  }

  return await ensureRepoPath(input.repo)
}

export async function ensureGitHubRunWorkspace(input: {
  repoFullName: string
  runId: string
  workspaceRoot?: string
  remoteUrl?: string
  fetchUrl?: string
  defaultBranch?: string
}): Promise<{
  workspaceRoot: string
  baseRepoPath: string
  worktreePath: string
  defaultBranch: string
}> {
  const workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot)
  const repoRef = parseRepoFullName(input.repoFullName)
  const remoteUrl = input.remoteUrl ?? buildGitHubRemoteUrl(input.repoFullName)
  const fetchUrl = input.fetchUrl ?? remoteUrl
  const defaultBranch = input.defaultBranch ?? await resolveRemoteDefaultBranch(fetchUrl) ?? "main"

  await mkdir(workspaceRoot, { recursive: true })
  const baseRepoPath = await resolveBaseRepoPath({
    workspaceRoot,
    repoFullName: input.repoFullName
  })

  if (!await pathExists(baseRepoPath)) {
    await initializeBaseClone({
      baseRepoPath,
      remoteUrl
    })
  } else if (!await repoMatchesFullName(baseRepoPath, input.repoFullName)) {
    throw new Error(`Existing workspace repo path does not match ${input.repoFullName}: ${baseRepoPath}`)
  }

  await fetchIntoBaseClone({
    baseRepoPath,
    fetchUrl,
    defaultBranch
  })
  await ensureBaseBranchCheckout(baseRepoPath, defaultBranch)

  const worktreePath = buildWorktreePath({
    workspaceRoot,
    repoFullName: input.repoFullName,
    runId: input.runId
  })
  await recreateWorktree({
    baseRepoPath,
    worktreePath,
    defaultBranch
  })

  return {
    workspaceRoot,
    baseRepoPath,
    worktreePath,
    defaultBranch
  }
}

export function resolveWorkspaceRoot(override?: string): string {
  return path.resolve(override ?? process.env.CODEBRIDGE_WORKSPACE_ROOT ?? path.join(os.homedir(), "workspace"))
}

export function buildGitHubRemoteUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`
}

export function buildAuthenticatedGitHubRemoteUrl(repoFullName: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`
}

export function buildWorktreePath(input: {
  workspaceRoot: string
  repoFullName: string
  runId: string
}): string {
  return path.join(
    input.workspaceRoot,
    ...WORKTREE_ROOT_SEGMENTS,
    sanitizeRepoFullName(input.repoFullName),
    sanitizePathSegment(input.runId)
  )
}

async function resolveBaseRepoPath(input: {
  workspaceRoot: string
  repoFullName: string
}): Promise<string> {
  const repoRef = parseRepoFullName(input.repoFullName)
  const existing = await findExistingBaseRepoPath({
    workspaceRoot: input.workspaceRoot,
    repoFullName: input.repoFullName
  })
  if (existing) {
    return existing
  }

  const preferred = path.join(input.workspaceRoot, repoRef.repoName)
  if (!await pathExists(preferred)) {
    return preferred
  }

  const fallback = path.join(input.workspaceRoot, sanitizeRepoFullName(input.repoFullName))
  if (!await pathExists(fallback)) {
    return fallback
  }
  if (await repoMatchesFullName(fallback, input.repoFullName)) {
    return fallback
  }

  throw new Error([
    `Unable to allocate a workspace clone path for ${input.repoFullName}.`,
    `Tried ${preferred} and ${fallback}, but both are already occupied by other repositories.`
  ].join(" "))
}

async function findExistingBaseRepoPath(input: {
  workspaceRoot: string
  repoFullName: string
}): Promise<string | null> {
  const repoRef = parseRepoFullName(input.repoFullName)
  const candidates = new Set<string>([
    path.join(input.workspaceRoot, repoRef.repoName),
    path.join(input.workspaceRoot, repoRef.owner, repoRef.repoName),
    path.join(input.workspaceRoot, sanitizeRepoFullName(input.repoFullName))
  ])

  try {
    const entries = await readdir(input.workspaceRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === repoRef.repoName) {
        candidates.add(path.join(input.workspaceRoot, entry.name))
      }
      const nested = path.join(input.workspaceRoot, entry.name, repoRef.repoName)
      if (await pathExists(nested)) {
        candidates.add(nested)
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  for (const candidate of candidates) {
    if (!await pathExists(candidate)) continue
    if (await repoMatchesFullName(candidate, input.repoFullName)) {
      return candidate
    }
  }

  return null
}

async function initializeBaseClone(input: {
  baseRepoPath: string
  remoteUrl: string
}): Promise<void> {
  await mkdir(path.dirname(input.baseRepoPath), { recursive: true })
  await execa("git", ["init", "-q", input.baseRepoPath])
  await execa("git", ["-C", input.baseRepoPath, "remote", "add", "origin", input.remoteUrl])
}

async function fetchIntoBaseClone(input: {
  baseRepoPath: string
  fetchUrl: string
  defaultBranch: string
}): Promise<void> {
  const remoteName = `codebridge-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await execa("git", ["-C", input.baseRepoPath, "remote", "add", remoteName, input.fetchUrl])
    await execa("git", [
      "-C",
      input.baseRepoPath,
      "fetch",
      "--prune",
      remoteName,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*"
    ])
    await execa("git", [
      "-C",
      input.baseRepoPath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${input.defaultBranch}`
    ])
  } finally {
    await execa("git", ["-C", input.baseRepoPath, "remote", "remove", remoteName], {
      reject: false
    })
  }
}

async function ensureBaseBranchCheckout(baseRepoPath: string, defaultBranch: string): Promise<void> {
  await execa("git", [
    "-C",
    baseRepoPath,
    "checkout",
    "-q",
    "-B",
    defaultBranch,
    `origin/${defaultBranch}`
  ])
}

async function recreateWorktree(input: {
  baseRepoPath: string
  worktreePath: string
  defaultBranch: string
}): Promise<void> {
  await execa("git", ["-C", input.baseRepoPath, "worktree", "prune"], {
    reject: false
  })
  await rm(input.worktreePath, { recursive: true, force: true })
  await mkdir(path.dirname(input.worktreePath), { recursive: true })
  await execa("git", [
    "-C",
    input.baseRepoPath,
    "worktree",
    "add",
    "--detach",
    input.worktreePath,
    `refs/remotes/origin/${input.defaultBranch}`
  ])
}

async function resolveRemoteDefaultBranch(fetchUrl: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["ls-remote", "--symref", fetchUrl, "HEAD"])
    const match = stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

async function repoMatchesFullName(repoPath: string, repoFullName: string): Promise<boolean> {
  if (!await isGitRepository(repoPath)) {
    return false
  }

  try {
    const { stdout } = await execa("git", ["-C", repoPath, "remote", "-v"])
    const remotes = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    return remotes.some(line => parseGitHubFullNameFromRemote(line)?.toLowerCase() === repoFullName.toLowerCase())
  } catch {
    return false
  }
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  const result = await execa("git", ["-C", repoPath, "rev-parse", "--git-dir"], {
    reject: false
  })
  return (result.exitCode ?? 1) === 0
}

function parseRepoFullName(fullName: string): { owner: string; repoName: string } {
  const [owner, repoName] = fullName.split("/")
  if (!owner || !repoName) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`)
  }
  return { owner, repoName }
}

function sanitizeRepoFullName(fullName: string): string {
  const repoRef = parseRepoFullName(fullName)
  return `${sanitizePathSegment(repoRef.owner)}__${sanitizePathSegment(repoRef.repoName)}`
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-")
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}
