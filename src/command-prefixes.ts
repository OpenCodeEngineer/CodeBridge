import { App } from "@octokit/app"
import { formatPrivateKey } from "./github-auth.js"
import { logger } from "./logger.js"

const GITHUB_USERNAME_RE = /^[A-Za-z0-9-]+$/

export type GitHubAppIdentity = {
  slug?: string
  name?: string
  botLogin?: string
}

type GitHubAppEnv = {
  githubAppId?: number
  githubPrivateKey?: string
}

export async function resolveDefaultGithubCommandPrefixes(env: GitHubAppEnv): Promise<string[]> {
  const fallback: string[] = []
  const identity = await resolveGithubAppIdentity(env)
  if (!identity) return fallback
  return buildDefaultGithubCommandPrefixes(identity)
}

export async function resolveGithubAppIdentity(env: GitHubAppEnv): Promise<GitHubAppIdentity | null> {
  if (!env.githubAppId || !env.githubPrivateKey) return null

  try {
    const app = new App({
      appId: env.githubAppId,
      privateKey: formatPrivateKey(env.githubPrivateKey)
    })
    const response = await app.octokit.request("GET /app")
    if (!response.data) return null
    return {
      slug: response.data.slug,
      name: response.data.name,
      botLogin: toBotLogin(response.data.slug)
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to resolve GitHub App identity")
    return null
  }
}

export function mergeGithubCommandPrefixes(
  configured: string[] | undefined,
  defaults: string[]
): string[] {
  return [...new Set([...(configured ?? []), ...defaults])]
}

export function filterGithubMentionPrefixes(prefixes: string[] | undefined): string[] {
  if (!prefixes?.length) return []
  const values = new Set<string>()
  for (const prefix of prefixes) {
    const normalized = normalizeMentionPrefix(prefix)
    if (!normalized) continue
    values.add(normalized)
  }
  return [...values]
}

export function buildAssigneeMentionPrefixes(assignees: string[] | undefined): string[] {
  if (!assignees?.length) return []
  const values = new Set<string>()
  for (const assignee of assignees) {
    const normalized = normalizeMentionPrefix(`@${assignee}`)
    if (!normalized) continue
    values.add(normalized)
  }
  return [...values]
}

export function buildGithubCommandPrefixes(input: {
  configured?: string[]
  assignmentAssignees?: string[]
  defaultPrefixes?: string[]
}): string[] {
  const defaults = filterGithubMentionPrefixes(input.defaultPrefixes)
  if (defaults.length > 0) {
    // When the app slug can be resolved from GitHub, comment-trigger routing must
    // use that exact real handle only. Configured aliases and assignment handles
    // must not widen the accepted bootstrap surface.
    return defaults
  }
  return filterGithubMentionPrefixes(input.configured)
}

function buildDefaultGithubCommandPrefixes(identity?: GitHubAppIdentity): string[] {
  const values = new Set<string>()
  if (!identity) return [...values]

  // GitHub issue bootstrap must rely on real handles, not arbitrary text aliases.
  const mention = normalizeMentionPrefix(`@${identity.slug ?? ""}`)
  if (mention) values.add(mention)

  return [...values]
}

function normalizeMentionPrefix(value?: string): string | null {
  if (!value) return null
  const trimmed = value.trim().startsWith("@") ? value.trim() : `@${value.trim()}`
  if (!trimmed) return null
  const handle = trimmed.slice(1)
  if (!GITHUB_USERNAME_RE.test(handle)) return null
  return `@${handle}`
}

function toBotLogin(slug?: string): string | undefined {
  if (!slug) return undefined
  const trimmed = slug.trim().toLowerCase()
  if (!trimmed || !GITHUB_USERNAME_RE.test(trimmed)) return undefined
  return `${trimmed}[bot]`
}
