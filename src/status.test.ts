import { describe, it, expect, beforeEach } from "vitest"
import type { RunRecord } from "./types.js"
import type { ProgressSnapshot } from "./progress.js"
import { formatSlackStatus, formatGitHubStatus, formatFinalSummary } from "./status.js"

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    tenantId: "t1",
    repoFullName: "org/repo",
    repoPath: "/tmp/repo",
    status: "running",
    prompt: "fix bug",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  }
}

function makeSnapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    lines: [],
    updatedAt: Date.now(),
    ...overrides
  }
}

describe("formatSlackStatus", () => {
  it("includes run id and repo", () => {
    const result = formatSlackStatus(makeRun(), makeSnapshot(), "running")
    expect(result).toContain("run-1")
    expect(result).toContain("org/repo")
  })

  it("includes status", () => {
    const result = formatSlackStatus(makeRun(), makeSnapshot(), "running")
    expect(result).toContain("Status: running")
  })

  it("includes branch when present", () => {
    const result = formatSlackStatus(makeRun({ branchName: "fix/bug" }), makeSnapshot(), "running")
    expect(result).toContain("Branch: fix/bug")
  })

  it("excludes branch when absent", () => {
    const result = formatSlackStatus(makeRun(), makeSnapshot(), "running")
    expect(result).not.toContain("Branch:")
  })

  it("includes progress lines", () => {
    const result = formatSlackStatus(makeRun(), makeSnapshot({ lines: ["step 1", "step 2"] }), "running")
    expect(result).toContain("- step 1")
    expect(result).toContain("- step 2")
  })

  it("includes truncated agent message", () => {
    const longMsg = "a".repeat(300)
    const result = formatSlackStatus(makeRun(), makeSnapshot({ lastAgentMessage: longMsg }), "running")
    expect(result).toContain("Latest:")
    expect(result.length).toBeLessThan(longMsg.length + 200) // truncation happened
  })
})

describe("formatGitHubStatus", () => {
  it("includes bold header with run id", () => {
    const result = formatGitHubStatus(makeRun(), makeSnapshot(), "running")
    expect(result).toContain("**Codex run run-1**")
  })

  it("includes code-formatted branch", () => {
    const result = formatGitHubStatus(makeRun({ branchName: "fix/issue" }), makeSnapshot(), "running")
    expect(result).toContain("Branch: `fix/issue`")
  })

  it("includes progress lines", () => {
    const result = formatGitHubStatus(makeRun(), makeSnapshot({ lines: ["done"] }), "done")
    expect(result).toContain("- done")
  })
})

describe("formatFinalSummary", () => {
  it("includes run id and complete status", () => {
    const result = formatFinalSummary(makeRun(), "All good")
    expect(result).toContain("run-1 complete")
  })

  it("includes PR URL when provided", () => {
    const result = formatFinalSummary(makeRun(), "Summary", "https://github.com/org/repo/pull/1")
    expect(result).toContain("PR: https://github.com/org/repo/pull/1")
  })

  it("shows 'No PR created' when no PR", () => {
    const result = formatFinalSummary(makeRun(), "Summary")
    expect(result).toContain("No PR created")
  })

  it("includes summary text", () => {
    const result = formatFinalSummary(makeRun(), "Everything worked fine")
    expect(result).toContain("Everything worked fine")
  })
})
