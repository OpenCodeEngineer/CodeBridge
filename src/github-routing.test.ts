import { describe, expect, it } from "vitest"
import {
  routeDiscussionCommentCommand,
  routeIssueCommentCommand,
  shouldRelayManagedIssueCommand
} from "./github-routing.js"

describe("routeIssueCommentCommand", () => {
  const prefixes = ["@codexengineer"]

  it("ignores unmanaged plain comments", () => {
    expect(routeIssueCommentCommand({
      body: "please investigate this",
      prefixes,
      issueManaged: false
    })).toBeNull()
  })

  it("keeps explicit control verbs on managed issues", () => {
    const command = routeIssueCommentCommand({
      body: "@codexengineer status",
      prefixes,
      issueManaged: true
    })

    expect(command).toEqual({
      type: "status",
      prompt: "",
      explicit: true,
      issue: undefined,
      repoHint: undefined,
      tenantHint: undefined
    })
    expect(shouldRelayManagedIssueCommand({ issueManaged: true, command: command! })).toBe(false)
  })

  it("converts managed plain follow-ups into replies", () => {
    const command = routeIssueCommentCommand({
      body: "please also add a regression test",
      prefixes,
      issueManaged: true
    })

    expect(command).toEqual({
      type: "reply",
      prompt: "please also add a regression test",
      explicit: false,
      issue: undefined,
      repoHint: undefined,
      tenantHint: undefined
    })
    expect(shouldRelayManagedIssueCommand({ issueManaged: true, command: command! })).toBe(true)
  })

  it("preserves explicit run commands on managed issues", () => {
    const command = routeIssueCommentCommand({
      body: "@codexengineer run restart from scratch",
      prefixes,
      issueManaged: true
    })

    expect(command?.type).toBe("run")
    expect(command?.prompt).toBe("restart from scratch")
    expect(command?.explicit).toBe(true)
    expect(shouldRelayManagedIssueCommand({ issueManaged: true, command: command! })).toBe(false)
  })

  it("preserves tenant hints on managed follow-ups", () => {
    const command = routeIssueCommentCommand({
      body: "tenant:acme please continue",
      prefixes,
      issueManaged: true
    })

    expect(command?.type).toBe("reply")
    expect(command?.tenantHint).toBe("acme")
    expect(command?.prompt).toBe("please continue")
  })
})

describe("routeDiscussionCommentCommand", () => {
  const prefixes = ["@codexengineer"]

  it("requires an explicit prefix", () => {
    expect(routeDiscussionCommentCommand({
      body: "reply with status",
      prefixes
    })).toBeNull()
  })

  it("parses explicit discussion control commands for caller-side rejection", () => {
    const command = routeDiscussionCommentCommand({
      body: "@codexengineer pause",
      prefixes
    })

    expect(command?.type).toBe("pause")
    expect(command?.explicit).toBe(true)
  })
})
