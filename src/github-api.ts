import type { InstallationClient } from "./github-auth.js"

type CreateCommentParams = {
  owner: string
  repo: string
  issue_number: number
  body: string
}

export type GitHubOctokitClient = {
  issues: {
    createComment: (params: CreateCommentParams) => Promise<unknown>
  }
  graphql: <T = unknown>(query: string, parameters?: Record<string, unknown>) => Promise<T>
}

export type GitHubApiClient = InstallationClient | GitHubOctokitClient

export function resolveGitHubOctokit(client: GitHubApiClient): GitHubOctokitClient {
  return "octokit" in client ? client.octokit as GitHubOctokitClient : client
}
