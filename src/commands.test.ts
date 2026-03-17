import { describe, it, expect } from "vitest"
import {
  extractCommand,
  extractCommandFromManagedIssue,
  parseIssueUrl,
  parsePrUrl,
  parseIssueOrPr,
  parseIssueReference,
  extractRepoHint
} from "./commands.js"

describe("extractCommand", () => {
  const prefixes = ["@codex", "@codebridge"]

  it("returns null for empty text", () => {
    expect(extractCommand("", prefixes)).toBeNull()
    expect(extractCommand("  ", prefixes)).toBeNull()
  })

  it("returns null when no prefix matches", () => {
    expect(extractCommand("hello world", prefixes)).toBeNull()
  })

  it("extracts a run command from a mention prefix", () => {
    const result = extractCommand("@codex fix the bug", prefixes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("run")
    expect(result!.prompt).toBe("fix the bug")
  })

  it("is case-insensitive on prefix matching", () => {
    const result = extractCommand("@CODEX build the feature", prefixes)
    expect(result).not.toBeNull()
    expect(result!.prompt).toBe("build the feature")
  })

  it("matches the longest prefix", () => {
    const result = extractCommand("@codebridge run deploy", ["@code", "@codebridge"])
    expect(result).not.toBeNull()
    expect(result!.type).toBe("run")
    expect(result!.prompt).toBe("deploy")
  })

  it("strips punctuation after prefix", () => {
    const result = extractCommand("@codex, do the thing", prefixes)
    expect(result).not.toBeNull()
    expect(result!.prompt).toBe("do the thing")
  })

  it("strips colon after prefix", () => {
    const result = extractCommand("@codex: do the thing", prefixes)
    expect(result).not.toBeNull()
    expect(result!.prompt).toBe("do the thing")
  })

  it("strips dash after prefix", () => {
    const result = extractCommand("@codex - do the thing", prefixes)
    expect(result).not.toBeNull()
    expect(result!.prompt).toBe("do the thing")
  })

  it("extracts explicit run command", () => {
    const result = extractCommand("@codex run deploy the app", prefixes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("run")
    expect(result!.prompt).toBe("deploy the app")
  })

  it("extracts pause command", () => {
    const result = extractCommand("@codex pause", prefixes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("pause")
  })

  it("extracts resume command", () => {
    const result = extractCommand("@codex resume", prefixes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("resume")
  })

  it("extracts status command", () => {
    const result = extractCommand("@codex status", prefixes)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("status")
  })

  it("returns null for run with no prompt", () => {
    const result = extractCommand("@codex run", prefixes)
    expect(result).toBeNull()
  })

  it("returns null for reply with no prompt", () => {
    const result = extractCommand("@codex reply", prefixes)
    expect(result).toBeNull()
  })

  it("handles botUserId mention", () => {
    const result = extractCommand("<@U12345> fix the bug", [], "U12345")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("run")
    expect(result!.prompt).toBe("fix the bug")
  })

  it("extracts tenant hint", () => {
    const result = extractCommand("@codex tenant:myorg fix the bug", prefixes)
    expect(result).not.toBeNull()
    expect(result!.tenantHint).toBe("myorg")
    expect(result!.prompt).toBe("fix the bug")
  })

  it("extracts repo hint from text", () => {
    const result = extractCommand("@codex fix org/repo issue", prefixes)
    expect(result).not.toBeNull()
    expect(result!.repoHint).toBe("org/repo")
  })
})

describe("extractCommandFromManagedIssue", () => {
  it("returns null for empty text", () => {
    expect(extractCommandFromManagedIssue("")).toBeNull()
    expect(extractCommandFromManagedIssue("  ")).toBeNull()
  })

  it("parses plain text as a run command", () => {
    const result = extractCommandFromManagedIssue("fix the login page")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("run")
    expect(result!.prompt).toBe("fix the login page")
  })

  it("extracts tenant hint", () => {
    const result = extractCommandFromManagedIssue("tenant:acme fix the bug")
    expect(result).not.toBeNull()
    expect(result!.tenantHint).toBe("acme")
  })
})

describe("parseIssueUrl", () => {
  it("returns null for non-issue URLs", () => {
    expect(parseIssueUrl("https://example.com")).toBeNull()
    expect(parseIssueUrl("not a url")).toBeNull()
  })

  it("parses a GitHub issue URL", () => {
    const result = parseIssueUrl("https://github.com/owner/repo/issues/42")
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      issueNumber: 42
    })
  })

  it("is case-insensitive", () => {
    const result = parseIssueUrl("https://GITHUB.COM/Owner/Repo/Issues/99")
    expect(result).not.toBeNull()
    expect(result!.issueNumber).toBe(99)
  })
})

describe("parsePrUrl", () => {
  it("returns null for non-PR URLs", () => {
    expect(parsePrUrl("https://example.com")).toBeNull()
  })

  it("parses a GitHub PR URL", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/7")
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      issueNumber: 7
    })
  })
})

describe("parseIssueOrPr", () => {
  it("parses issue URL", () => {
    const result = parseIssueOrPr("check https://github.com/o/r/issues/1 please")
    expect(result).not.toBeNull()
    expect(result!.issueNumber).toBe(1)
  })

  it("parses PR URL", () => {
    const result = parseIssueOrPr("review https://github.com/o/r/pull/5")
    expect(result).not.toBeNull()
    expect(result!.issueNumber).toBe(5)
  })

  it("returns null for plain text", () => {
    expect(parseIssueOrPr("just some text")).toBeNull()
  })
})

describe("parseIssueReference", () => {
  it("parses full issue URL", () => {
    const result = parseIssueReference("https://github.com/a/b/issues/3")
    expect(result).not.toBeNull()
    expect(result!.owner).toBe("a")
    expect(result!.repo).toBe("b")
    expect(result!.issueNumber).toBe(3)
  })

  it("parses scoped reference owner/repo#123", () => {
    const result = parseIssueReference("fix owner/repo#42")
    expect(result).not.toBeNull()
    expect(result!.owner).toBe("owner")
    expect(result!.repo).toBe("repo")
    expect(result!.issueNumber).toBe(42)
  })

  it("parses local #123 with defaults", () => {
    const result = parseIssueReference("fix #99", { owner: "myorg", repo: "myrepo" })
    expect(result).not.toBeNull()
    expect(result!.owner).toBe("myorg")
    expect(result!.repo).toBe("myrepo")
    expect(result!.issueNumber).toBe(99)
  })

  it("returns null for local #123 without defaults", () => {
    const result = parseIssueReference("fix #99")
    expect(result).toBeNull()
  })
})

describe("extractRepoHint", () => {
  it("extracts owner/repo pattern", () => {
    expect(extractRepoHint("fix org/repo issue")).toBe("org/repo")
  })

  it("returns null when no pattern", () => {
    expect(extractRepoHint("just text")).toBeNull()
  })
})
