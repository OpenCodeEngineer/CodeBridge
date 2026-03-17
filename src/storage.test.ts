import { describe, it, expect } from "vitest"

// We test the pure logic parts of storage.ts that don't require a database connection.
// The storage module exports isSqliteUrl and resolveSqlitePath as private functions,
// but createStore uses them. We test via createStore's routing behavior and also
// test the SQLite store with an in-memory database.

describe("createStore routing", () => {
  it("creates SQLite store for sqlite:// URLs", async () => {
    const { createStore } = await import("./storage.js")
    // sqlite in-memory store should work without external deps
    const store = createStore(":memory:")
    expect(store).toBeDefined()
    expect(store.createRun).toBeTypeOf("function")
    expect(store.getRun).toBeTypeOf("function")
  })

  it("creates SQLite store for .db paths", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const os = await import("node:os")
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-store-"))
    const dbPath = path.join(tmpDir, "test.db")

    const { createStore } = await import("./storage.js")
    const store = createStore(dbPath)
    expect(store).toBeDefined()

    // Clean up
    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe("SQLite store CRUD", () => {
  it("creates and retrieves a run", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    const run = await store.createRun({
      id: "test-run-1",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "fix the bug"
    })

    expect(run.id).toBe("test-run-1")
    expect(run.status).toBe("queued")
    expect(run.prompt).toBe("fix the bug")

    const fetched = await store.getRun("test-run-1")
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe("test-run-1")
  })

  it("returns null for non-existent run", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")
    const result = await store.getRun("does-not-exist")
    expect(result).toBeNull()
  })

  it("updates run status", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-status",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "test"
    })

    await store.updateRunStatus("run-status", "running")
    const run = await store.getRun("run-status")
    expect(run!.status).toBe("running")

    await store.updateRunStatus("run-status", "succeeded")
    const run2 = await store.getRun("run-status")
    expect(run2!.status).toBe("succeeded")
  })

  it("updates branch name", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-branch",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "test"
    })

    await store.updateRunBranch("run-branch", "fix/my-branch")
    const run = await store.getRun("run-branch")
    expect(run!.branchName).toBe("fix/my-branch")
  })

  it("updates PR info", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-pr",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "test"
    })

    await store.updateRunPr("run-pr", 42, "https://github.com/org/repo/pull/42")
    const run = await store.getRun("run-pr")
    expect(run!.prNumber).toBe(42)
    expect(run!.prUrl).toBe("https://github.com/org/repo/pull/42")
  })

  it("stores and retrieves GitHub context", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-gh",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "test",
      github: {
        owner: "org",
        repo: "repo",
        issueNumber: 10,
        installationId: 12345
      }
    })

    const run = await store.getRun("run-gh")
    expect(run!.github).toBeDefined()
    expect(run!.github!.owner).toBe("org")
    expect(run!.github!.repo).toBe("repo")
    expect(run!.github!.issueNumber).toBe(10)
    expect(run!.github!.installationId).toBe(12345)
  })

  it("stores and retrieves Slack context", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-slack",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "test",
      slack: {
        channel: "C123",
        threadTs: "123.456",
        userId: "U789"
      }
    })

    const run = await store.getRun("run-slack")
    expect(run!.slack).toBeDefined()
    expect(run!.slack!.channel).toBe("C123")
    expect(run!.slack!.threadTs).toBe("123.456")
    expect(run!.slack!.userId).toBe("U789")
  })

  it("source_key deduplication works", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-a",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      sourceKey: "unique-key",
      prompt: "first"
    })

    // Upserting with same source_key should not create a new row
    await store.createRun({
      id: "run-b",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      sourceKey: "unique-key",
      prompt: "second"
    })

    const byKey = await store.getRunBySourceKey("unique-key")
    expect(byKey).not.toBeNull()
    // Should return original run (ON CONFLICT DO UPDATE only touches updated_at)
    expect(byKey!.id).toBe("run-a")
    expect(byKey!.prompt).toBe("first")
  })

  it("getLatestRunForIssue returns most recent run", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "old-run",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "old",
      github: { owner: "org", repo: "repo", issueNumber: 5 }
    })

    // SQLite CURRENT_TIMESTAMP has 1-second precision, need >1s delay
    await new Promise(r => setTimeout(r, 1100))

    await store.createRun({
      id: "new-run",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "new",
      github: { owner: "org", repo: "repo", issueNumber: 5 }
    })

    const latest = await store.getLatestRunForIssue({
      tenantId: "t1",
      repoFullName: "org/repo",
      issueNumber: 5
    })
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe("new-run")
  })

  it("github poll state CRUD", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    // Initially null
    const initial = await store.getGithubPollState("t1", "org/repo")
    expect(initial).toBeNull()

    // Insert
    await store.updateGithubPollState({
      tenantId: "t1",
      repoFullName: "org/repo",
      lastCommentId: 100,
      lastCommentCreatedAt: "2026-01-01T00:00:00Z"
    })

    const state = await store.getGithubPollState("t1", "org/repo")
    expect(state).not.toBeNull()
    expect(state!.lastCommentId).toBe(100)
    expect(state!.lastCommentCreatedAt).toBe("2026-01-01T00:00:00Z")

    // Update
    await store.updateGithubPollState({
      tenantId: "t1",
      repoFullName: "org/repo",
      lastCommentId: 200,
      lastCommentCreatedAt: "2026-02-01T00:00:00Z"
    })

    const updated = await store.getGithubPollState("t1", "org/repo")
    expect(updated!.lastCommentId).toBe(200)
  })

  it("appends events", async () => {
    const { createSqliteStore } = await import("./storage.js")
    const store = createSqliteStore(":memory:")

    await store.createRun({
      id: "run-ev",
      tenantId: "t1",
      repoFullName: "org/repo",
      repoPath: "/tmp/repo",
      prompt: "test"
    })

    // Should not throw
    await store.appendEvent({
      runId: "run-ev",
      seq: 1,
      type: "progress",
      payload: { message: "hello" },
      createdAt: new Date().toISOString()
    })
  })
})
