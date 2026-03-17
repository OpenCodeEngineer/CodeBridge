import { beforeEach, describe, expect, it, vi } from "vitest"

const gitMocks = vi.hoisted(() => ({
  isDirty: vi.fn(),
  fetchOrigin: vi.fn(),
  createBranch: vi.fn(),
  commitAll: vi.fn(),
  pushBranch: vi.fn(),
  getDefaultBranchFromOrigin: vi.fn()
}))

const opencodeMocks = vi.hoisted(() => ({
  runOpenCodePrompt: vi.fn()
}))

const githubAppsMocks = vi.hoisted(() => ({
  createGitHubInstallationClientFactory: vi.fn()
}))

const githubIssueStateMocks = vi.hoisted(() => ({
  syncIssueLifecycleState: vi.fn()
}))

vi.mock("./git.js", () => gitMocks)
vi.mock("./opencode.js", () => opencodeMocks)
vi.mock("./github-apps.js", () => githubAppsMocks)
vi.mock("./github-issue-state.js", () => githubIssueStateMocks)

describe("runner OpenCode PR detection", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("treats a backend-created PR as success even when the repo is clean", async () => {
    gitMocks.getDefaultBranchFromOrigin.mockResolvedValue("main")
    gitMocks.isDirty.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    opencodeMocks.runOpenCodePrompt.mockResolvedValue({
      sessionId: "ses_123",
      responseText: "Completed the task.\nPR: https://github.com/acme/widgets/pull/42"
    })

    const updateComment = vi.fn().mockResolvedValue(undefined)
    const getGitHubClient = vi.fn().mockResolvedValue({
      token: "ghs_test",
      octokit: {
        issues: {
          updateComment
        },
        pulls: {
          create: vi.fn()
        }
      }
    })
    githubAppsMocks.createGitHubInstallationClientFactory.mockReturnValue(getGitHubClient)

    const statuses: string[] = []
    const store = {
      getRun: vi.fn().mockResolvedValue(makeRun()),
      updateRunStatus: vi.fn().mockImplementation(async (_id: string, status: string) => {
        statuses.push(status)
      }),
      updateRunBranch: vi.fn().mockResolvedValue(undefined),
      updateRunPr: vi.fn().mockResolvedValue(undefined),
      appendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const { createRunner } = await import("./runner.js")
    const runner = createRunner({
      store: store as any,
      env: {
        codexTurnTimeoutMs: 60_000,
        opencodeBaseUrl: "http://127.0.0.1:4096",
        opencodeEnabled: true,
        githubApps: {
          opencode: {
            appId: 1,
            privateKey: "private-key",
            webhookSecret: "webhook-secret"
          }
        }
      }
    })

    await runner({ runId: "run_123" })

    expect(store.updateRunPr).toHaveBeenCalledWith("run_123", 42, "https://github.com/acme/widgets/pull/42")
    expect(statuses).toEqual(["running", "succeeded"])
    expect(githubIssueStateMocks.syncIssueLifecycleState).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.objectContaining({ issueNumber: 99 }),
      "in-progress"
    )
    expect(githubIssueStateMocks.syncIssueLifecycleState).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ issueNumber: 99 }),
      "completed"
    )
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "widgets",
      comment_id: 321,
      body: expect.stringContaining("PR: https://github.com/acme/widgets/pull/42")
    }))
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.not.stringContaining("No PR created")
    }))
  })
})

describe("extractPullRequestReference", () => {
  it("extracts a GitHub PR URL from markdown links and raw text", async () => {
    const { _testHelpers } = await import("./runner.js")

    expect(_testHelpers.extractPullRequestReference(
      "Opened [PR #7](https://github.com/acme/widgets/pull/7) for review."
    )).toEqual({
      url: "https://github.com/acme/widgets/pull/7",
      number: 7
    })

    expect(_testHelpers.extractPullRequestReference(
      "PR ready: https://github.com/acme/widgets/pull/8/"
    )).toEqual({
      url: "https://github.com/acme/widgets/pull/8",
      number: 8
    })
  })

  it("returns null when no GitHub PR URL is present", async () => {
    const { _testHelpers } = await import("./runner.js")
    expect(_testHelpers.extractPullRequestReference("Completed without a pull request.")).toBeNull()
  })
})

function makeRun() {
  return {
    id: "run_123",
    tenantId: "tenant_1",
    repoFullName: "acme/widgets",
    repoPath: "/tmp/acme-widgets",
    status: "queued" as const,
    prompt: "Implement the feature",
    backend: "opencode" as const,
    agent: "build",
    model: "openai/gpt-5",
    sourceKey: "github:issue:acme/widgets#99",
    github: {
      appKey: "opencode",
      owner: "acme",
      repo: "widgets",
      issueNumber: 99,
      commentId: 321,
      installationId: 1234,
      issueTitle: "Support multi-app routing",
      issueBody: "Implement multi-app routing."
    },
    createdAt: new Date("2026-03-17T07:00:00Z").toISOString(),
    updatedAt: new Date("2026-03-17T07:00:00Z").toISOString()
  }
}
