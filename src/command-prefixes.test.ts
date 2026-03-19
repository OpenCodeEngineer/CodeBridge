import { describe, it, expect } from "vitest"
import {
  buildGithubCommandPrefixes,
  mergeGithubCommandPrefixes,
  filterGithubMentionPrefixes,
  buildAssigneeMentionPrefixes
} from "./command-prefixes.js"

describe("mergeGithubCommandPrefixes", () => {
  it("returns defaults when configured is undefined", () => {
    const result = mergeGithubCommandPrefixes(undefined, ["@bot"])
    expect(result).toEqual(["@bot"])
  })

  it("merges configured and defaults, deduplicating", () => {
    const result = mergeGithubCommandPrefixes(["@bot", "@custom"], ["@bot", "@default"])
    expect(result).toContain("@bot")
    expect(result).toContain("@custom")
    expect(result).toContain("@default")
    // @bot should appear only once
    expect(result.filter(v => v === "@bot")).toHaveLength(1)
  })

  it("returns only defaults when configured is empty array", () => {
    const result = mergeGithubCommandPrefixes([], ["@a", "@b"])
    expect(result).toEqual(["@a", "@b"])
  })
})

describe("filterGithubMentionPrefixes", () => {
  it("returns empty array for undefined input", () => {
    expect(filterGithubMentionPrefixes(undefined)).toEqual([])
  })

  it("returns empty array for empty input", () => {
    expect(filterGithubMentionPrefixes([])).toEqual([])
  })

  it("normalizes prefixes with @ prefix", () => {
    const result = filterGithubMentionPrefixes(["@codex", "codebridge"])
    expect(result).toContain("@codex")
    expect(result).toContain("@codebridge")
  })

  it("deduplicates normalized prefixes", () => {
    const result = filterGithubMentionPrefixes(["@codex", "@codex"])
    expect(result).toHaveLength(1)
    expect(result[0]).toBe("@codex")
  })

  it("rejects invalid GitHub usernames", () => {
    const result = filterGithubMentionPrefixes(["@valid-name", "@invalid name", "@bad!char"])
    expect(result).toEqual(["@valid-name"])
  })

  it("handles whitespace trimming", () => {
    const result = filterGithubMentionPrefixes(["  @codex  "])
    expect(result).toEqual(["@codex"])
  })
})

describe("buildAssigneeMentionPrefixes", () => {
  it("returns empty array for undefined input", () => {
    expect(buildAssigneeMentionPrefixes(undefined)).toEqual([])
  })

  it("returns empty array for empty input", () => {
    expect(buildAssigneeMentionPrefixes([])).toEqual([])
  })

  it("prepends @ to assignee names", () => {
    const result = buildAssigneeMentionPrefixes(["codex", "bot"])
    expect(result).toContain("@codex")
    expect(result).toContain("@bot")
  })

  it("deduplicates assignee mentions", () => {
    const result = buildAssigneeMentionPrefixes(["codex", "codex"])
    expect(result).toHaveLength(1)
  })

  it("rejects invalid GitHub usernames", () => {
    const result = buildAssigneeMentionPrefixes(["valid-name", "invalid name"])
    expect(result).toEqual(["@valid-name"])
  })
})

describe("buildGithubCommandPrefixes", () => {
  it("uses only the resolved real app handle when defaults are available", () => {
    const result = buildGithubCommandPrefixes({
      configured: ["CodexApp", "@custom"],
      assignmentAssignees: ["openai-code-agent"],
      defaultPrefixes: ["@codexapp"]
    })

    expect(result).toEqual(["@codexapp"])
  })

  it("refuses configured alias fallbacks when the real app handle is unavailable", () => {
    const result = buildGithubCommandPrefixes({
      configured: ["CodexApp", "@custom"],
      assignmentAssignees: ["openai-code-agent"]
    })

    expect(result).toEqual([])
  })
})
