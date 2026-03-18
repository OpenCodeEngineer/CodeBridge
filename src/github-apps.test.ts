import { describe, expect, it } from "vitest"
import type { AppConfig, RepoConfig, RunRecord, TenantConfig } from "./types.js"
import {
  buildGithubPollStateKey,
  findTenantByGithubInstallation,
  resolveRepoForGithubApp,
  runUsesGithubApp,
  selectGithubAppKeyForBackend
} from "./github-apps.js"

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    fullName: "org/repo",
    path: "/tmp/repo",
    backend: "codex",
    ...overrides
  }
}

function makeTenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    id: "tenant-a",
    name: "Tenant A",
    github: {
      apps: [
        { appKey: "codex", installationId: 1001 },
        { appKey: "opencode", installationId: 1002 }
      ]
    },
    repos: [makeRepo()],
    ...overrides
  }
}

function makeConfig(tenants: TenantConfig[]): AppConfig {
  return {
    tenants,
    secrets: {
      githubApps: {
        codex: { appId: 1, privateKey: "codex" },
        opencode: { appId: 2, privateKey: "opencode" }
      }
    }
  }
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    tenantId: "tenant-a",
    repoFullName: "org/repo",
    repoPath: "/tmp/repo",
    status: "queued",
    prompt: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  }
}

describe("findTenantByGithubInstallation", () => {
  it("matches tenants by app key and installation id", () => {
    const tenant = makeTenant()
    const config = makeConfig([tenant])

    expect(findTenantByGithubInstallation(config, 1001, "codex")?.id).toBe("tenant-a")
    expect(findTenantByGithubInstallation(config, 1001, "opencode")).toBeNull()
  })
})

describe("resolveRepoForGithubApp", () => {
  it("applies app-specific repo overrides", () => {
    const repo = makeRepo({
      githubApps: {
        opencode: {
          backend: "opencode",
          agent: "build",
          model: "openai/gpt-5"
        }
      }
    })

    const resolved = resolveRepoForGithubApp(repo, "opencode")
    expect(resolved.backend).toBe("opencode")
    expect(resolved.agent).toBe("build")
    expect(resolved.model).toBe("openai/gpt-5")
  })

  it("does not inherit backend-specific model or agent when the app override changes backend", () => {
    const repo = makeRepo({
      agent: "codex-review",
      model: "gpt-5.2-codex",
      githubApps: {
        opencode: {
          backend: "opencode"
        }
      }
    })

    const resolved = resolveRepoForGithubApp(repo, "opencode")
    expect(resolved.backend).toBe("opencode")
    expect(resolved.agent).toBeUndefined()
    expect(resolved.model).toBeUndefined()
  })
})

describe("selectGithubAppKeyForBackend", () => {
  it("prefers the app whose effective repo route matches the backend", () => {
    const tenant = makeTenant()
    const repo = makeRepo({
      githubApps: {
        opencode: { backend: "opencode" }
      }
    })

    expect(selectGithubAppKeyForBackend(tenant, repo, "opencode")).toBe("opencode")
    expect(selectGithubAppKeyForBackend(tenant, repo, "codex")).toBe("codex")
  })
})

describe("buildGithubPollStateKey", () => {
  it("namespaces poll state by app key and scope", () => {
    expect(buildGithubPollStateKey({
      repoFullName: "Org/Repo",
      appKey: "codex",
      scope: "comments"
    })).toBe("org/repo#app:codex")

    expect(buildGithubPollStateKey({
      repoFullName: "Org/Repo",
      appKey: "opencode",
      scope: "pr-review"
    })).toBe("org/repo#app:opencode#pr-review")
  })
})

describe("runUsesGithubApp", () => {
  it("treats missing appKey on old runs as the default app", () => {
    const legacyRun = makeRun({
      github: {
        owner: "org",
        repo: "repo",
        issueNumber: 1,
        installationId: 1001
      }
    })
    const opencodeRun = makeRun({
      github: {
        appKey: "opencode",
        owner: "org",
        repo: "repo",
        issueNumber: 1,
        installationId: 1002
      }
    })

    expect(runUsesGithubApp(legacyRun, "default")).toBe(true)
    expect(runUsesGithubApp(opencodeRun, "opencode")).toBe(true)
    expect(runUsesGithubApp(opencodeRun, "codex")).toBe(false)
  })
})
