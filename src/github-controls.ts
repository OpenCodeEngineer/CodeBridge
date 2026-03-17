import type { RunStore } from "./storage.js"
import type { GitHubApiClient } from "./github-api.js"
import { resolveGitHubOctokit } from "./github-api.js"
import { postDiscussionCommentByNumber } from "./github-discussions.js"

export async function postIssueStatus(input: {
  tenantId: string
  repoFullName: string
  issueNumber: number
  owner: string
  repo: string
  client: GitHubApiClient
  store: RunStore
}) {
  const latest = await input.store.getLatestRunForIssue({
    tenantId: input.tenantId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber
  })

  const body = latest
    ? [
      `Agent status for issue #${input.issueNumber}`,
      `- Run: \`${latest.id}\``,
      `- Status: \`${latest.status}\``,
      `- Updated: ${latest.updatedAt}`,
      latest.prUrl ? `- PR: ${latest.prUrl}` : "- PR: none"
    ].join("\n")
    : `No agent run found for issue #${input.issueNumber}.`

  await resolveGitHubOctokit(input.client).issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    body
  })
}

export async function postControlAck(input: {
  commandType: "pause" | "resume"
  issueNumber: number
  owner: string
  repo: string
  client: GitHubApiClient
}) {
  const body = input.commandType === "pause"
    ? "Pause command acknowledged. Runtime pause is not implemented yet in this bridge."
    : "Resume command acknowledged. Runtime resume is not implemented yet in this bridge."

  await resolveGitHubOctokit(input.client).issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    body
  })
}

export async function postDiscussionUnsupportedControl(input: {
  owner: string
  repo: string
  discussionNumber: number
  client: GitHubApiClient
}) {
  await postDiscussionCommentByNumber(input.client, {
    owner: input.owner,
    repo: input.repo,
    discussionNumber: input.discussionNumber,
    body: "This command is currently supported on issues/PR threads only. Use `run` or `reply` in discussions."
  })
}
