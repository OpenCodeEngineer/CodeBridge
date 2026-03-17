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

  it("defaults databaseUrl to sqlite", async () => {
    delete process.env.DATABASE_URL
    const { loadEnv } = await import("./config.js")
    const env = loadEnv()
    expect(env.databaseUrl).toBe("sqlite://./data/codebridge.db")
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
        path: /tmp/repo
`
    await fs.writeFile(configPath, yaml)
    const config = await loadConfig(configPath)
    expect(config.tenants).toHaveLength(1)
    expect(config.tenants[0].id).toBe("test-tenant")
    expect(config.tenants[0].repos[0].fullName).toBe("org/repo")
    await fs.rm(tmpDir, { recursive: true })
  })
})
