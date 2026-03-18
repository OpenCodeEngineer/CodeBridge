import { beforeEach, describe, expect, it, vi } from "vitest"

const codexSdkMocks = vi.hoisted(() => {
  const runStreamed = vi.fn()
  const startThread = vi.fn(() => ({ runStreamed }))
  const Codex = vi.fn(function MockCodex() {
    return { startThread }
  })
  return { Codex, startThread, runStreamed }
})

const gitMocks = vi.hoisted(() => ({
  countCommitsAhead: vi.fn(),
  currentBranch: vi.fn(),
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

vi.mock("@openai/codex-sdk", () => ({
  Codex: codexSdkMocks.Codex
}))
vi.mock("./git.js", () => gitMocks)
vi.mock("./opencode.js", () => opencodeMocks)
vi.mock("./github-apps.js", () => githubAppsMocks)
vi.mock("./github-issue-state.js", () => githubIssueStateMocks)

describe("runner OpenCode PR detection", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    gitMocks.countCommitsAhead.mockResolvedValue(0)
    gitMocks.currentBranch.mockResolvedValue("opencode/99-run_123")
    codexSdkMocks.runStreamed.mockReset()
    codexSdkMocks.startThread.mockReset()
    codexSdkMocks.startThread.mockImplementation(() => ({ runStreamed: codexSdkMocks.runStreamed }))
    codexSdkMocks.Codex.mockReset()
    codexSdkMocks.Codex.mockImplementation(function MockCodex() {
      return { startThread: codexSdkMocks.startThread }
    })
  })

  it("treats a backend-created PR as success even when the repo is clean", async () => {
    gitMocks.getDefaultBranchFromOrigin.mockResolvedValue("main")
    gitMocks.isDirty.mockResolvedValue(false)
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

    expect(opencodeMocks.runOpenCodePrompt).toHaveBeenCalledWith(expect.objectContaining({
      tools: {
        github: false
      }
    }))
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

  it("creates a PR when OpenCode committed changes and left a clean branch behind", async () => {
    gitMocks.getDefaultBranchFromOrigin.mockResolvedValue("main")
    gitMocks.isDirty.mockResolvedValue(false)
    gitMocks.countCommitsAhead.mockResolvedValue(1)
    opencodeMocks.runOpenCodePrompt.mockResolvedValue({
      sessionId: "ses_456",
      responseText: "Implemented the requested files, ran bun test, committed the changes, and pushed the branch."
    })

    const updateComment = vi.fn().mockResolvedValue(undefined)
    const list = vi.fn().mockResolvedValue({ data: [] })
    const create = vi.fn().mockResolvedValue({
      data: {
        number: 43,
        html_url: "https://github.com/acme/widgets/pull/43"
      }
    })
    const getGitHubClient = vi.fn().mockResolvedValue({
      token: "ghs_test",
      octokit: {
        issues: {
          updateComment
        },
        pulls: {
          list,
          create
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

    expect(gitMocks.pushBranch).toHaveBeenCalledWith(
      "/tmp/acme-widgets",
      "https://x-access-token:ghs_test@github.com/acme/widgets.git",
      "opencode/99-run_123"
    )
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "widgets",
      state: "open",
      head: "acme:opencode/99-run_123"
    }))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "widgets",
      head: "opencode/99-run_123",
      base: "main",
      body: expect.stringContaining("Closes #99")
    }))
    expect(store.updateRunPr).toHaveBeenCalledWith("run_123", 43, "https://github.com/acme/widgets/pull/43")
    expect(statuses).toEqual(["running", "succeeded"])
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("PR: https://github.com/acme/widgets/pull/43")
    }))
  })

  it("reuses an existing PR for a clean OpenCode branch with commits", async () => {
    gitMocks.getDefaultBranchFromOrigin.mockResolvedValue("main")
    gitMocks.isDirty.mockResolvedValue(false)
    gitMocks.countCommitsAhead.mockResolvedValue(1)
    opencodeMocks.runOpenCodePrompt.mockResolvedValue({
      sessionId: "ses_789",
      responseText: "Committed the task changes and pushed them for review."
    })

    const updateComment = vi.fn().mockResolvedValue(undefined)
    const list = vi.fn().mockResolvedValue({
      data: [
        {
          number: 77,
          html_url: "https://github.com/acme/widgets/pull/77"
        }
      ]
    })
    const create = vi.fn()
    const getGitHubClient = vi.fn().mockResolvedValue({
      token: "ghs_test",
      octokit: {
        issues: {
          updateComment
        },
        pulls: {
          list,
          create
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

    expect(gitMocks.pushBranch).toHaveBeenCalledWith(
      "/tmp/acme-widgets",
      "https://x-access-token:ghs_test@github.com/acme/widgets.git",
      "opencode/99-run_123"
    )
    expect(create).not.toHaveBeenCalled()
    expect(store.updateRunPr).toHaveBeenCalledWith("run_123", 77, "https://github.com/acme/widgets/pull/77")
    expect(statuses).toEqual(["running", "succeeded"])
  })

  it("publishes extracted GitHub-ready text instead of a comment-to-post wrapper", async () => {
    gitMocks.getDefaultBranchFromOrigin.mockResolvedValue("main")
    gitMocks.isDirty.mockResolvedValue(false)
    opencodeMocks.runOpenCodePrompt.mockResolvedValue({
      sessionId: "ses_999",
      responseText: [
        "**Status**",
        "- Could not post with gh from inside the task.",
        "",
        "**Comment to post on the issue**",
        "```text",
        "Answer: GPT-1 was released in June 2018.",
        "```"
      ].join("\n")
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

    expect(statuses).toEqual(["running", "no_changes"])
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("Answer: GPT-1 was released in June 2018.")
    }))
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.not.stringContaining("Comment to post")
    }))
  })
})

describe("runner Codex execution", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    gitMocks.countCommitsAhead.mockResolvedValue(0)
    gitMocks.currentBranch.mockResolvedValue("codex/99-run_123")
    gitMocks.getDefaultBranchFromOrigin.mockResolvedValue("main")
    gitMocks.isDirty.mockResolvedValue(false)
    codexSdkMocks.runStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Completed without file changes."
          }
        }
        yield {
          type: "turn.completed",
          usage: {
            output_tokens: 1
          }
        }
      })()
    })
    codexSdkMocks.startThread.mockImplementation(() => ({ runStreamed: codexSdkMocks.runStreamed }))
    codexSdkMocks.Codex.mockImplementation(function MockCodex() {
      return { startThread: codexSdkMocks.startThread }
    })
  })

  it("uses a supported reasoning effort for GPT-5 Codex models", async () => {
    const statuses: string[] = []
    const store = {
      getRun: vi.fn().mockResolvedValue(makeRun({
        backend: "codex",
        agent: undefined,
        model: "gpt-5.2-codex",
        github: undefined
      })),
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
        codexTurnTimeoutMs: 60_000
      }
    })

    await runner({ runId: "run_123" })

    expect(codexSdkMocks.startThread).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.2-codex",
      modelReasoningEffort: "low"
    }))
    expect(statuses).toEqual(["running", "no_changes"])
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

  it("tells GitHub-originated runs to leave PR creation to CodeBridge", async () => {
    const { _testHelpers } = await import("./runner.js")
    const contract = _testHelpers.buildGitHubResponseContract(makeRun())

    expect(contract).toContain("Do not use gh, GitHub MCP/integrations/tools, the GitHub website, or GitHub APIs/CLI")
    expect(contract).toContain("do not run git push to publish branches to GitHub")
    expect(contract).toContain("CodeBridge owns those GitHub writes, including branch publication, PR creation")
    expect(contract).toContain("CodeBridge will publish the branch and open the PR with the correct GitHub App identity")
  })

  it("disables the GitHub tool for GitHub-originated OpenCode runs", async () => {
    const { _testHelpers } = await import("./runner.js")
    expect(_testHelpers.resolveOpenCodeTools(makeRun())).toEqual({ github: false })
    expect(_testHelpers.resolveOpenCodeTools({
      ...makeRun(),
      github: undefined
    } as any)).toBeUndefined()
  })
})

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
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
    updatedAt: new Date("2026-03-17T07:00:00Z").toISOString(),
    ...overrides
  }
}
