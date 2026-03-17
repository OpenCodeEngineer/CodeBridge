import { resolveGitHubOctokit, type GitHubApiClient } from "./github-api.js"
import type { GitHubContext } from "./types.js"

const discussionIdCache = new Map<string, string>()

export function isDiscussionSourceKey(sourceKey?: string): boolean {
  if (!sourceKey) return false
  return sourceKey.startsWith("github-discussion:")
}

export async function postDiscussionCommentFromContext(
  client: GitHubApiClient,
  github: GitHubContext,
  body: string
): Promise<void> {
  const discussionNumber = github.issueNumber
  if (!discussionNumber) {
    throw new Error("Missing discussion number in GitHub context")
  }
  await postDiscussionCommentByNumber(client, {
    owner: github.owner,
    repo: github.repo,
    discussionNumber,
    body
  })
}

export async function postDiscussionCommentByNumber(
  client: GitHubApiClient,
  input: {
    owner: string
    repo: string
    discussionNumber: number
    body: string
  }
): Promise<void> {
  const octokit = resolveGitHubOctokit(client)
  const discussionId = await resolveDiscussionNodeId(octokit, {
    owner: input.owner,
    repo: input.repo,
    discussionNumber: input.discussionNumber
  })

  await octokit.graphql(
    `
      mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment { id }
        }
      }
    `,
    {
      discussionId,
      body: input.body
    }
  )
}

async function resolveDiscussionNodeId(
  octokit: ReturnType<typeof resolveGitHubOctokit>,
  input: {
    owner: string
    repo: string
    discussionNumber: number
  }
): Promise<string> {
  const cacheKey = `${input.owner}/${input.repo}#${input.discussionNumber}`
  const cached = discussionIdCache.get(cacheKey)
  if (cached) return cached

  const response = await octokit.graphql<{
    repository: {
      discussion: {
        id: string
      } | null
    } | null
  }>(
    `
      query DiscussionId($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            id
          }
        }
      }
    `,
    {
      owner: input.owner,
      repo: input.repo,
      number: input.discussionNumber
    }
  )

  const discussionId = response.repository?.discussion?.id
  if (!discussionId) {
    throw new Error(`Discussion #${input.discussionNumber} not found in ${input.owner}/${input.repo}`)
  }

  discussionIdCache.set(cacheKey, discussionId)
  return discussionId
}
