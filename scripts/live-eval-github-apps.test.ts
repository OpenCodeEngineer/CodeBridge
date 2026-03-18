import { describe, expect, it } from "vitest"
import {
  assertDistinctEvalGithubApps,
  resolveExpectedBotLogin,
  resolveExpectedHandle
} from "./live-eval-github-apps.js"

describe("assertDistinctEvalGithubApps", () => {
  it("accepts distinct app identities", () => {
    expect(() =>
      assertDistinctEvalGithubApps({
        codex: { key: "codex", appId: 1, slug: "codexengineer", botLogin: "codexengineer[bot]" },
        opencode: { key: "opencode", appId: 2, slug: "opencodeengineer", botLogin: "opencodeengineer[bot]" }
      })
    ).not.toThrow()
  })

  it("rejects shared app ids", () => {
    expect(() =>
      assertDistinctEvalGithubApps({
        codex: { key: "codex", appId: 1, slug: "codexengineer", botLogin: "codexengineer[bot]" },
        opencode: { key: "opencode", appId: 1, slug: "opencodeengineer", botLogin: "opencodeengineer[bot]" }
      })
    ).toThrow(/distinct GitHub Apps/)
  })

  it("rejects shared slugs", () => {
    expect(() =>
      assertDistinctEvalGithubApps({
        codex: { key: "codex", appId: 1, slug: "codexengineer", botLogin: "codexengineer[bot]" },
        opencode: { key: "opencode", appId: 2, slug: "codexengineer", botLogin: "opencodeengineer[bot]" }
      })
    ).toThrow(/distinct GitHub App slugs/)
  })

  it("rejects shared bot authors", () => {
    expect(() =>
      assertDistinctEvalGithubApps({
        codex: { key: "codex", appId: 1, slug: "codexengineer", botLogin: "shared[bot]" },
        opencode: { key: "opencode", appId: 2, slug: "opencodeengineer", botLogin: "shared[bot]" }
      })
    ).toThrow(/distinct GitHub App bot authors/)
  })
})

describe("resolveExpectedHandle", () => {
  it("uses the real resolved handle by default", () => {
    expect(resolveExpectedHandle("codex", undefined, "@codexengineer")).toBe("@codexengineer")
  })

  it("rejects alias handles that do not match the real app slug", () => {
    expect(() => resolveExpectedHandle("opencode", "@OpenCodeEvalApp", "@opencodeengineer")).toThrow(/handle mismatch/)
  })
})

describe("resolveExpectedBotLogin", () => {
  it("uses the real resolved bot login by default", () => {
    expect(resolveExpectedBotLogin("codex", undefined, "codexengineer[bot]")).toBe("codexengineer[bot]")
  })

  it("rejects mismatched bot logins", () => {
    expect(() => resolveExpectedBotLogin("opencode", "codexengineer[bot]", "opencodeengineer[bot]")).toThrow(/bot login mismatch/)
  })
})
