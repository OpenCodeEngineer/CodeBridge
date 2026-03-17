import { describe, expect, it, vi } from "vitest"
import type { GitHubOctokitClient } from "./github-api.js"
import { postControlAck, postDiscussionUnsupportedControl, postIssueStatus } from "./github-controls.js"

describe("github controls", () => {
  it("posts issue status with a raw octokit client", async () => {
    const createComment = vi.fn(async () => ({}))
    const client = {
      issues: {
        createComment
      },
      graphql: vi.fn()
    }
    const store = {
      getLatestRunForIssue: vi.fn(async () => ({
        id: "run-123",
        status: "running",
        updatedAt: "2026-03-17T08:00:00.000Z",
        prUrl: "https://github.com/acme/repo/pull/1"
      }))
    }

    await postIssueStatus({
      tenantId: "local",
      repoFullName: "acme/repo",
      issueNumber: 42,
      owner: "acme",
      repo: "repo",
      client,
      store: store as any
    })

    expect(createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      issue_number: 42,
      body: [
        "Agent status for issue #42",
        "- Run: `run-123`",
        "- Status: `running`",
        "- Updated: 2026-03-17T08:00:00.000Z",
        "- PR: https://github.com/acme/repo/pull/1"
      ].join("\n")
    })
  })

  it("posts pause acknowledgements with a raw octokit client", async () => {
    const createComment = vi.fn(async () => ({}))
    const client = {
      issues: {
        createComment
      },
      graphql: vi.fn()
    }

    await postControlAck({
      commandType: "pause",
      issueNumber: 7,
      owner: "acme",
      repo: "repo",
      client
    })

    expect(createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      issue_number: 7,
      body: "Pause command acknowledged. Runtime pause is not implemented yet in this bridge."
    })
  })

  it("posts unsupported discussion control comments with a raw octokit client", async () => {
    const graphqlImpl: GitHubOctokitClient["graphql"] = async <T>(query: string, variables?: Record<string, unknown>) => {
      if (query.includes("query DiscussionId")) {
        return {
          repository: {
            discussion: {
              id: "D_kwDOExample"
            }
          }
        } as T
      }

      expect(variables).toEqual({
        discussionId: "D_kwDOExample",
        body: "This command is currently supported on issues/PR threads only. Use `run` or `reply` in discussions."
      })
      return {
        addDiscussionComment: {
          comment: {
            id: "DC_kwDOExample"
          }
        }
      } as T
    }
    const graphql = vi.fn(graphqlImpl)
    const client: GitHubOctokitClient = {
      issues: {
        createComment: vi.fn(async () => ({}))
      },
      graphql: graphql as GitHubOctokitClient["graphql"]
    }

    await postDiscussionUnsupportedControl({
      owner: "acme",
      repo: "repo",
      discussionNumber: 9,
      client
    })

    expect(graphql).toHaveBeenCalledTimes(2)
  })
})
