import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// We test the pure helper functions exported from config.ts.
// loadEnv and loadConfig are integration-heavy (env vars, file system) so we
// test them by manipulating process.env and providing fixture YAML.

describe("parseBoolean (via loadEnv)", () => {
  const original = { ...process.env }

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    Object.assign(process.env, original)
  })

  it("parses GITHUB_POLL_BACKFILL 'true' as boolean true", async () => {
    process.env.GITHUB_POLL_BACKFILL = "true"
    // Dynamic import to pick up env at module-load time
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.githubPollBackfill).toBe(true)
  })

  it("parses GITHUB_POLL_BACKFILL 'false' as boolean false", async () => {
    process.env.GITHUB_POLL_BACKFILL = "false"
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.githubPollBackfill).toBe(false)
  })
})

describe("loadEnv defaults", () => {
  const original = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    Object.assign(process.env, original)
  })

  it("returns default port 8788 when PORT not set", async () => {
    delete process.env.PORT
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.port).toBe(8788)
  })

  it("returns custom port when PORT is set", async () => {
    process.env.PORT = "9999"
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.port).toBe(9999)
  })

  it("defaults role to 'all'", async () => {
    delete process.env.ROLE
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.role).toBe("all")
  })

  it("defaults databaseUrl to a plain SQLite path", async () => {
    delete process.env.DATABASE_URL
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.databaseUrl).toBe("./data/codebridge.db")
  })

  it("defaults queueMode to memory when no REDIS_URL", async () => {
    delete process.env.REDIS_URL
    delete process.env.QUEUE_MODE
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.queueMode).toBe("memory")
  })

  it("defaults codexTurnTimeoutMs to 300000", async () => {
    delete process.env.CODEX_TURN_TIMEOUT_MS
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.codexTurnTimeoutMs).toBe(300000)
  })

  it("clamps invalid codexTurnTimeoutMs to 300000", async () => {
    process.env.CODEX_TURN_TIMEOUT_MS = "-1"
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.codexTurnTimeoutMs).toBe(300000)
  })

  it("reads OpenCode env overrides", async () => {
    process.env.OPENCODE_BASE_URL = "http://127.0.0.1:4096"
    process.env.OPENCODE_USERNAME = "opencode"
    process.env.OPENCODE_PASSWORD = "secret"
    process.env.OPENCODE_TIMEOUT_MS = "45000"
    process.env.OPENCODE_POLL_INTERVAL_MS = "750"
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.opencodeBaseUrl).toBe("http://127.0.0.1:4096")
    expect(env.opencodeUsername).toBe("opencode")
    expect(env.opencodePassword).toBe("secret")
    expect(env.opencodeTimeoutMs).toBe(45000)
    expect(env.opencodePollIntervalMs).toBe(750)
  })
})

describe("loadConfig", () => {
  it("throws on invalid YAML config", async () => {
    const { loadConfig } = await import("./config.js")
    // Write a temp invalid config
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "cb-test-"))
    const configPath = path.join(tmpDir, "bad.yaml")
    await fs.writeFile(configPath, "not_valid: {}")
    await expect(loadConfig(configPath)).rejects.toThrow("Invalid config")
    await fs.rm(tmpDir, { recursive: true })
  })

  it("parses a valid minimal config", async () => {
    const { loadConfig } = await import("./config.js")
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "cb-test-"))
    const configPath = path.join(tmpDir, "good.yaml")
    const yaml = `
tenants:
  - id: test-tenant
    name: Test
    repos:
      - fullName: org/repo
`
    await fs.writeFile(configPath, yaml)
    const config = await loadConfig(configPath)
    expect(config.tenants).toHaveLength(1)
    expect(config.tenants[0].id).toBe("test-tenant")
    expect(config.tenants[0].repos[0].fullName).toBe("org/repo")
    expect(config.tenants[0].repos[0].path).toBeUndefined()
    await fs.rm(tmpDir, { recursive: true })
  })

  it("parses repo backend selection and OpenCode integration config", async () => {
    const { loadConfig } = await import("./config.js")
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "cb-test-"))
    const configPath = path.join(tmpDir, "opencode.yaml")
    const yaml = `
integrations:
  opencode:
    baseUrl: http://127.0.0.1:4096
    username: opencode
    timeoutMs: 45000
    pollIntervalMs: 500

tenants:
  - id: test-tenant
    name: Test
    repos:
      - fullName: org/repo
        path: /tmp/repo
        backend: opencode
        agent: build
        model: openai/gpt-5
`
    await fs.writeFile(configPath, yaml)
    const config = await loadConfig(configPath)
    expect(config.integrations?.opencode?.baseUrl).toBe("http://127.0.0.1:4096")
    expect(config.tenants[0].repos[0].backend).toBe("opencode")
    expect(config.tenants[0].repos[0].agent).toBe("build")
    expect(config.tenants[0].repos[0].model).toBe("openai/gpt-5")
    await fs.rm(tmpDir, { recursive: true })
  })

  it("normalizes multi-app GitHub config and repo app overrides", async () => {
    const { loadConfig } = await import("./config.js")
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "cb-test-"))
    const configPath = path.join(tmpDir, "multi-app.yaml")
    const yaml = `
secrets:
  githubApps:
    Codex:
      appId: 101
      privateKey: codex-key
      webhookSecret: codex-webhook
      commandPrefixes:
        - CodexApp
    opencode:
      appId: 202
      privateKey: opencode-key
      webhookSecret: opencode-webhook

tenants:
  - id: test-tenant
    name: Test
    github:
      apps:
        - appKey: Codex
          installationId: 3001
          assignmentAssignees:
            - CodexApp
        - appKey: OpenCode
          installationId: 3002
          commandPrefixes:
            - OpenCodeApp
    repos:
      - fullName: org/repo
        path: /tmp/repo
        backend: codex
        githubApps:
          OpenCode:
            backend: opencode
            agent: build
            model: openai/gpt-5
`
    await fs.writeFile(configPath, yaml)
    const config = await loadConfig(configPath)
    expect(config.secrets?.githubApps?.codex?.appId).toBe(101)
    expect(config.secrets?.githubApps?.opencode?.appId).toBe(202)
    expect(config.tenants[0].github?.apps.map(app => app.appKey)).toEqual(["codex", "opencode"])
    expect(config.tenants[0].repos[0].githubApps?.opencode?.backend).toBe("opencode")
    expect(config.tenants[0].repos[0].githubApps?.opencode?.agent).toBe("build")
    await fs.rm(tmpDir, { recursive: true })
  })

  it("normalizes legacy single-app GitHub config into the default app key", async () => {
    const { loadConfig } = await import("./config.js")
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "cb-test-"))
    const configPath = path.join(tmpDir, "legacy-github.yaml")
    const yaml = `
secrets:
  githubAppId: 123
  githubPrivateKey: legacy-key
  githubWebhookSecret: legacy-webhook

tenants:
  - id: test-tenant
    name: Test
    github:
      installationId: 456
      assignmentAssignees:
        - CodexApp
    repos:
      - fullName: org/repo
        path: /tmp/repo
`
    await fs.writeFile(configPath, yaml)
    const config = await loadConfig(configPath)
    expect(config.secrets?.githubApps?.default?.appId).toBe(123)
    expect(config.tenants[0].github?.apps).toEqual([{
      appKey: "default",
      installationId: 456,
      repoAllowlist: undefined,
      commandPrefixes: undefined,
      assignmentAssignees: ["CodexApp"]
    }])
    await fs.rm(tmpDir, { recursive: true })
  })
})
