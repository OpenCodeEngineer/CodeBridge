import { describe, expect, it } from "vitest"
import { buildLiveEvalConfig } from "./write-live-eval-config.js"

describe("buildLiveEvalConfig", () => {
  const apps = {
    codex: {
      key: "codex" as const,
      appId: 1,
      installationId: 11,
      privateKey: "codex-key",
      slug: "codexengineer",
      handle: "@codexengineer",
      botLogin: "codexengineer[bot]"
    },
    opencode: {
      key: "opencode" as const,
      appId: 2,
      installationId: 22,
      privateKey: "opencode-key",
      slug: "opencodebridgeapp",
      handle: "@opencodebridgeapp",
      botLogin: "opencodebridgeapp[bot]"
    }
  }

  const args = {
    outputPath: "/tmp/out.yaml",
    repoFullName: "dzianisv/codebridge-test"
  }

  it("uses the portable default opencode model when no override is configured", () => {
    const config = buildLiveEvalConfig({
      args,
      apps,
      opencodeBaseUrl: "http://127.0.0.1:4096",
      models: {
        codexModel: "gpt-5.2-codex"
      }
    })

    expect(config.tenants[0]?.repos[0]?.githubApps?.opencode).toMatchObject({
      backend: "opencode",
      agent: "build",
      model: "opencode/minimax-m2.5-free",
      branchPrefix: "opencodeapp"
    })
    expect(config.tenants[0]?.repos[0]).not.toHaveProperty("path")
  })

  it("passes through an explicit supported opencode model override", () => {
    const config = buildLiveEvalConfig({
      args,
      apps,
      opencodeBaseUrl: "http://127.0.0.1:4096",
      models: {
        codexModel: "gpt-5.2-codex",
        opencodeModel: "github-copilot/gemini-3.1-pro-preview"
      }
    })

    expect(config.tenants[0]?.repos[0]?.githubApps?.opencode?.model).toBe("github-copilot/gemini-3.1-pro-preview")
  })
})
