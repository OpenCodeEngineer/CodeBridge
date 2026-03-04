import type { InstallationClient } from "./github-auth.js"
import type { GitHubContext } from "./types.js"
import { logger } from "./logger.js"

const MANAGED_LABEL = "agent:managed"
const STATUS_LABELS = ["agent:in-progress", "agent:idle", "agent:completed"] as const

export type IssueLifecycleState = "in-progress" | "idle" | "completed"

export async function syncIssueLifecycleState(
  client: InstallationClient,
  github: GitHubContext,
  state: IssueLifecycleState
): Promise<void> {
  if (!github.issueNumber) return

  try {
    const issue = await client.octokit.issues.get({
      owner: github.owner,
      repo: github.repo,
      issue_number: github.issueNumber
    })

    const current = issue.data.labels
      .map(label => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label))

    const target = `agent:${state}`
    const merged = new Set(current.filter(label => !STATUS_LABELS.includes(label as typeof STATUS_LABELS[number])))
    merged.add(MANAGED_LABEL)
    merged.add(target)

    await client.octokit.issues.setLabels({
      owner: github.owner,
      repo: github.repo,
      issue_number: github.issueNumber,
      labels: Array.from(merged)
    })
  } catch (error) {
    logger.warn(
      { err: error, owner: github.owner, repo: github.repo, issueNumber: github.issueNumber },
      "GitHub lifecycle label sync failed"
    )
  }
}
