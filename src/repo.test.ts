import { describe, expect, it } from "vitest"
import { parseGitHubFullNameFromRemote } from "./repo.js"

describe("parseGitHubFullNameFromRemote", () => {
  it("parses https remotes for repositories with dots", () => {
    expect(parseGitHubFullNameFromRemote("origin https://github.com/acme/platform.repo.git (fetch)")).toBe("acme/platform.repo")
  })

  it("parses ssh remotes for repositories with dots", () => {
    expect(parseGitHubFullNameFromRemote("origin git@github.com:acme/platform.repo.git (push)")).toBe("acme/platform.repo")
  })
})
