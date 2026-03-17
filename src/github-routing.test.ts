import { describe, expect, it } from "vitest"
import { routeExplicitGitHubCommand, routeIssueCommentCommand } from "./github-routing.js"

describe("routeIssueCommentCommand", () => {
  it("parses explicit commands on unmanaged threads", () => {
    const command = routeIssueCommentCommand({
      body: "@codexengineer run Fix the bug",
      prefixes: ["@codexengineer"],
      issueManaged: false
    })

    expect(command).toMatchObject({
      type: "run",
      prompt: "Fix the bug",
      explicit: true
    })
  })

  it("treats plain comments on managed threads as replies", () => {
    const command = routeIssueCommentCommand({
      body: "Please update the implementation plan.",
      prefixes: ["@codexengineer"],
      issueManaged: true
    })

    expect(command).toMatchObject({
      type: "reply",
      prompt: "Please update the implementation plan.",
      explicit: false
    })
  })
})

describe("routeExplicitGitHubCommand", () => {
  it("requires an explicit prefix", () => {
    const command = routeExplicitGitHubCommand({
      body: "Please answer this review comment.",
      prefixes: ["@codexengineer"]
    })

    expect(command).toBeNull()
  })

  it("parses reply commands with an explicit prefix", () => {
    const command = routeExplicitGitHubCommand({
      body: "@codexengineer reply Reply on the PR thread",
      prefixes: ["@codexengineer"]
    })

    expect(command).toMatchObject({
      type: "reply",
      prompt: "Reply on the PR thread",
      explicit: true
    })
  })
})
