import { readFile } from "node:fs/promises"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import Database from "better-sqlite3"
import type { AgentBackend, RunEvent, RunRecord, RunStatus, SlackContext, GitHubContext } from "./types.js"
import { resolveAgentBackend } from "./agent-backend.js"

export type RunStore = {
  ensureSchema: () => Promise<void>
  createRun: (input: {
    id: string
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    backend?: AgentBackend
    agent?: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => Promise<RunRecord>
  getRun: (id: string) => Promise<RunRecord | null>
  getRunBySourceKey: (sourceKey: string) => Promise<RunRecord | null>
  getLatestRunForIssue: (input: {
    tenantId: string
    repoFullName: string
    issueNumber: number
  }) => Promise<RunRecord | null>
  getGithubPollState: (
    tenantId: string,
    repoFullName: string
  ) => Promise<{ lastCommentId: number | null; lastCommentCreatedAt: string | null } | null>
  updateGithubPollState: (input: {
    tenantId: string
    repoFullName: string
    lastCommentId: number | null
    lastCommentCreatedAt: string | null
  }) => Promise<void>
  updateRunStatus: (id: string, status: RunStatus) => Promise<void>
  updateSlackMessage: (id: string, messageTs: string) => Promise<void>
  updateGithubComment: (id: string, commentId: number) => Promise<void>
  updateRunBranch: (id: string, branchName: string) => Promise<void>
  updateRunPr: (id: string, prNumber: number, prUrl: string) => Promise<void>
  appendEvent: (event: RunEvent) => Promise<void>
}

export function createPostgresStore(databaseUrl: string): RunStore {
  const pool = new Pool({ connectionString: databaseUrl })

  const ensureSchema = async () => {
    const schemaPath = path.join(process.cwd(), "sql", "schema.sql")
    const sql = await readFile(schemaPath, "utf8")
    await pool.query(sql)
  }

  const createRun = async (input: {
    id: string
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    backend?: AgentBackend
    agent?: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => {
    const result = await pool.query(
      `INSERT INTO runs (
        id, tenant_id, repo_full_name, repo_path, source_key, status, prompt, backend, agent, model, branch_prefix,
        slack_channel, slack_thread_ts, slack_message_ts, slack_user_id,
        github_owner, github_repo, github_issue_number, github_comment_id, github_trigger_comment_id,
        github_installation_id, github_issue_title, github_issue_body
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      ON CONFLICT (source_key) DO UPDATE SET updated_at = now()
      RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.repoFullName,
        input.repoPath,
        input.sourceKey ?? null,
        "queued",
        input.prompt,
        resolveAgentBackend(input.backend),
        input.agent ?? null,
        input.model ?? null,
        input.branchPrefix ?? null,
        input.slack?.channel ?? null,
        input.slack?.threadTs ?? null,
        input.slack?.messageTs ?? null,
        input.slack?.userId ?? null,
        input.github?.owner ?? null,
        input.github?.repo ?? null,
        input.github?.issueNumber ?? null,
        input.github?.commentId ?? null,
        input.github?.triggerCommentId ?? null,
        input.github?.installationId ?? null,
        input.github?.issueTitle ?? null,
        input.github?.issueBody ?? null
      ]
    )
    return toRunRecord(result.rows[0])
  }

  const getRun = async (id: string) => {
    const result = await pool.query("SELECT * FROM runs WHERE id = $1", [id])
    if (result.rowCount === 0) return null
    return toRunRecord(result.rows[0])
  }

  const getRunBySourceKey = async (sourceKey: string) => {
    const result = await pool.query("SELECT * FROM runs WHERE source_key = $1", [sourceKey])
    if (result.rowCount === 0) return null
    return toRunRecord(result.rows[0])
  }

  const getLatestRunForIssue = async (input: {
    tenantId: string
    repoFullName: string
    issueNumber: number
  }) => {
    const result = await pool.query(
      `SELECT *
       FROM runs
       WHERE tenant_id = $1 AND repo_full_name = $2 AND github_issue_number = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.tenantId, input.repoFullName, input.issueNumber]
    )
    if (result.rowCount === 0) return null
    return toRunRecord(result.rows[0])
  }

  const getGithubPollState = async (tenantId: string, repoFullName: string) => {
    const result = await pool.query(
      "SELECT last_comment_id, last_comment_created_at FROM github_poll_state WHERE tenant_id = $1 AND repo_full_name = $2",
      [tenantId, repoFullName]
    )
    if (result.rowCount === 0) return null
    return {
      lastCommentId: result.rows[0].last_comment_id ?? null,
      lastCommentCreatedAt: result.rows[0].last_comment_created_at
        ? new Date(result.rows[0].last_comment_created_at).toISOString()
        : null
    }
  }

  const updateGithubPollState = async (input: {
    tenantId: string
    repoFullName: string
    lastCommentId: number | null
    lastCommentCreatedAt: string | null
  }) => {
    await pool.query(
      `INSERT INTO github_poll_state (tenant_id, repo_full_name, last_comment_id, last_comment_created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, repo_full_name)
       DO UPDATE SET last_comment_id = EXCLUDED.last_comment_id,
                     last_comment_created_at = EXCLUDED.last_comment_created_at,
                     updated_at = now()`,
      [input.tenantId, input.repoFullName, input.lastCommentId, input.lastCommentCreatedAt]
    )
  }

  const updateRunStatus = async (id: string, status: RunStatus) => {
    await pool.query("UPDATE runs SET status = $1, updated_at = now() WHERE id = $2", [status, id])
  }

  const updateSlackMessage = async (id: string, messageTs: string) => {
    await pool.query("UPDATE runs SET slack_message_ts = $1, updated_at = now() WHERE id = $2", [messageTs, id])
  }

  const updateGithubComment = async (id: string, commentId: number) => {
    await pool.query("UPDATE runs SET github_comment_id = $1, updated_at = now() WHERE id = $2", [commentId, id])
  }

  const updateRunBranch = async (id: string, branchName: string) => {
    await pool.query("UPDATE runs SET branch_name = $1, updated_at = now() WHERE id = $2", [branchName, id])
  }

  const updateRunPr = async (id: string, prNumber: number, prUrl: string) => {
    await pool.query("UPDATE runs SET pr_number = $1, pr_url = $2, updated_at = now() WHERE id = $3", [prNumber, prUrl, id])
  }

  const appendEvent = async (event: RunEvent) => {
    await pool.query(
      "INSERT INTO run_events (run_id, seq, event_type, payload) VALUES ($1,$2,$3,$4)",
      [event.runId, event.seq, event.type, event.payload]
    )
  }

  return {
    ensureSchema,
    createRun,
    getRun,
    getRunBySourceKey,
    getLatestRunForIssue,
    getGithubPollState,
    updateGithubPollState,
    updateRunStatus,
    updateSlackMessage,
    updateGithubComment,
    updateRunBranch,
    updateRunPr,
    appendEvent
  }
}

function toRunRecord(row: any): RunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repoFullName: row.repo_full_name,
    repoPath: row.repo_path,
    sourceKey: row.source_key ?? undefined,
    status: row.status,
    prompt: row.prompt,
    backend: resolveAgentBackend(row.backend ?? undefined),
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    branchPrefix: row.branch_prefix ?? undefined,
    slack: row.slack_channel && row.slack_thread_ts ? {
      channel: row.slack_channel,
      threadTs: row.slack_thread_ts,
      messageTs: row.slack_message_ts ?? undefined,
      userId: row.slack_user_id ?? undefined
    } : undefined,
    github: row.github_owner && row.github_repo ? {
      owner: row.github_owner,
      repo: row.github_repo,
      issueNumber: row.github_issue_number ?? undefined,
      commentId: row.github_comment_id ?? undefined,
      triggerCommentId: row.github_trigger_comment_id ?? undefined,
      installationId: row.github_installation_id ?? undefined,
      issueTitle: row.github_issue_title ?? undefined,
      issueBody: row.github_issue_body ?? undefined
    } : undefined,
    branchName: row.branch_name ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prUrl: row.pr_url ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

export function createSqliteStore(databaseUrl: string): RunStore {
  const filename = resolveSqlitePath(databaseUrl)
  if (filename !== ":memory:") {
    const dir = path.dirname(filename)
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true })
    }
  }
  const db = new Database(filename)

  const schemaPath = path.join(process.cwd(), "sql", "schema.sqlite.sql")
  const schemaSql = readFileSync(schemaPath, "utf8")
  db.exec(schemaSql)
  ensureSqliteRunSchemaMigrations(db)

  const ensureSchema = async () => {
    db.exec(schemaSql)
    ensureSqliteRunSchemaMigrations(db)
  }

  const insertRun = db.prepare(
    `INSERT INTO runs (
      id, tenant_id, repo_full_name, repo_path, source_key, status, prompt, backend, agent, model, branch_prefix,
      slack_channel, slack_thread_ts, slack_message_ts, slack_user_id,
      github_owner, github_repo, github_issue_number, github_comment_id, github_trigger_comment_id,
      github_installation_id, github_issue_title, github_issue_body
    ) VALUES (
      @id, @tenantId, @repoFullName, @repoPath, @sourceKey, @status, @prompt, @backend, @agent, @model, @branchPrefix,
      @slackChannel, @slackThreadTs, @slackMessageTs, @slackUserId,
      @githubOwner, @githubRepo, @githubIssueNumber, @githubCommentId, @githubTriggerCommentId,
      @githubInstallationId, @githubIssueTitle, @githubIssueBody
    )
    ON CONFLICT(source_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`
  )

  const getRunRow = db.prepare("SELECT * FROM runs WHERE id = ?")
  const getRunBySourceKeyRow = db.prepare("SELECT * FROM runs WHERE source_key = ?")
  const getLatestRunForIssueRow = db.prepare(
    `SELECT *
     FROM runs
     WHERE tenant_id = ? AND repo_full_name = ? AND github_issue_number = ?
     ORDER BY datetime(created_at) DESC
     LIMIT 1`
  )
  const updateRunStatusStmt = db.prepare("UPDATE runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateSlackMessageStmt = db.prepare("UPDATE runs SET slack_message_ts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateGithubCommentStmt = db.prepare("UPDATE runs SET github_comment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateRunBranchStmt = db.prepare("UPDATE runs SET branch_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateRunPrStmt = db.prepare("UPDATE runs SET pr_number = ?, pr_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const insertEventStmt = db.prepare("INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?,?,?,?)")

  const getPollStateStmt = db.prepare(
    "SELECT last_comment_id, last_comment_created_at FROM github_poll_state WHERE tenant_id = ? AND repo_full_name = ?"
  )
  const upsertPollStateStmt = db.prepare(
    `INSERT INTO github_poll_state (tenant_id, repo_full_name, last_comment_id, last_comment_created_at)
     VALUES (?,?,?,?)
     ON CONFLICT (tenant_id, repo_full_name)
     DO UPDATE SET last_comment_id = excluded.last_comment_id,
                   last_comment_created_at = excluded.last_comment_created_at,
                   updated_at = CURRENT_TIMESTAMP`
  )

  const createRun = async (input: {
    id: string
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    backend?: AgentBackend
    agent?: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => {
    insertRun.run({
      id: input.id,
      tenantId: input.tenantId,
      repoFullName: input.repoFullName,
      repoPath: input.repoPath,
      sourceKey: input.sourceKey ?? null,
      status: "queued",
      prompt: input.prompt,
      backend: resolveAgentBackend(input.backend),
      agent: input.agent ?? null,
      model: input.model ?? null,
      branchPrefix: input.branchPrefix ?? null,
      slackChannel: input.slack?.channel ?? null,
      slackThreadTs: input.slack?.threadTs ?? null,
      slackMessageTs: input.slack?.messageTs ?? null,
      slackUserId: input.slack?.userId ?? null,
      githubOwner: input.github?.owner ?? null,
      githubRepo: input.github?.repo ?? null,
      githubIssueNumber: input.github?.issueNumber ?? null,
      githubCommentId: input.github?.commentId ?? null,
      githubTriggerCommentId: input.github?.triggerCommentId ?? null,
      githubInstallationId: input.github?.installationId ?? null,
      githubIssueTitle: input.github?.issueTitle ?? null,
      githubIssueBody: input.github?.issueBody ?? null
    })
    const row = input.sourceKey ? getRunBySourceKeyRow.get(input.sourceKey) : getRunRow.get(input.id)
    return toRunRecordSqlite(row)
  }

  const getRun = async (id: string) => {
    const row = getRunRow.get(id)
    if (!row) return null
    return toRunRecordSqlite(row)
  }

  const getRunBySourceKey = async (sourceKey: string) => {
    const row = getRunBySourceKeyRow.get(sourceKey)
    if (!row) return null
    return toRunRecordSqlite(row)
  }

  const getLatestRunForIssue = async (input: {
    tenantId: string
    repoFullName: string
    issueNumber: number
  }) => {
    const row = getLatestRunForIssueRow.get(input.tenantId, input.repoFullName, input.issueNumber)
    if (!row) return null
    return toRunRecordSqlite(row)
  }

  const getGithubPollState = async (tenantId: string, repoFullName: string) => {
    const row = getPollStateStmt.get(tenantId, repoFullName) as
      | { last_comment_id: number | null; last_comment_created_at: string | null }
      | undefined
    if (!row) return null
    return {
      lastCommentId: row.last_comment_id ?? null,
      lastCommentCreatedAt: row.last_comment_created_at ?? null
    }
  }

  const updateGithubPollState = async (input: {
    tenantId: string
    repoFullName: string
    lastCommentId: number | null
    lastCommentCreatedAt: string | null
  }) => {
    upsertPollStateStmt.run(
      input.tenantId,
      input.repoFullName,
      input.lastCommentId ?? null,
      input.lastCommentCreatedAt ?? null
    )
  }

  const updateRunStatus = async (id: string, status: RunStatus) => {
    updateRunStatusStmt.run(status, id)
  }

  const updateSlackMessage = async (id: string, messageTs: string) => {
    updateSlackMessageStmt.run(messageTs, id)
  }

  const updateGithubComment = async (id: string, commentId: number) => {
    updateGithubCommentStmt.run(commentId, id)
  }

  const updateRunBranch = async (id: string, branchName: string) => {
    updateRunBranchStmt.run(branchName, id)
  }

  const updateRunPr = async (id: string, prNumber: number, prUrl: string) => {
    updateRunPrStmt.run(prNumber, prUrl, id)
  }

  const appendEvent = async (event: RunEvent) => {
    insertEventStmt.run(event.runId, event.seq, event.type, JSON.stringify(event.payload))
  }

  return {
    ensureSchema,
    createRun,
    getRun,
    getRunBySourceKey,
    getLatestRunForIssue,
    getGithubPollState,
    updateGithubPollState,
    updateRunStatus,
    updateSlackMessage,
    updateGithubComment,
    updateRunBranch,
    updateRunPr,
    appendEvent
  }
}

export function createStore(databaseUrl: string): RunStore {
  if (isSqliteUrl(databaseUrl)) {
    return createSqliteStore(databaseUrl)
  }
  return createPostgresStore(databaseUrl)
}

function isSqliteUrl(databaseUrl: string): boolean {
  if (!databaseUrl) return true
  const normalized = databaseUrl.toLowerCase()
  return normalized.startsWith("sqlite:") || normalized.endsWith(".db") || normalized === ":memory:"
}

function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl) return ":memory:"
  if (databaseUrl === ":memory:") return databaseUrl
  if (databaseUrl.startsWith("sqlite://")) {
    return databaseUrl.slice("sqlite://".length)
  }
  if (databaseUrl.startsWith("sqlite:")) {
    const pathPart = databaseUrl.slice("sqlite:".length)
    return pathPart || ":memory:"
  }
  return databaseUrl
}

function toRunRecordSqlite(row: any): RunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repoFullName: row.repo_full_name,
    repoPath: row.repo_path,
    sourceKey: row.source_key ?? undefined,
    status: row.status,
    prompt: row.prompt,
    backend: resolveAgentBackend(row.backend ?? undefined),
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    branchPrefix: row.branch_prefix ?? undefined,
    slack: row.slack_channel && row.slack_thread_ts ? {
      channel: row.slack_channel,
      threadTs: row.slack_thread_ts,
      messageTs: row.slack_message_ts ?? undefined,
      userId: row.slack_user_id ?? undefined
    } : undefined,
    github: row.github_owner && row.github_repo ? {
      owner: row.github_owner,
      repo: row.github_repo,
      issueNumber: row.github_issue_number ?? undefined,
      commentId: row.github_comment_id ?? undefined,
      triggerCommentId: row.github_trigger_comment_id ?? undefined,
      installationId: row.github_installation_id ?? undefined,
      issueTitle: row.github_issue_title ?? undefined,
      issueBody: row.github_issue_body ?? undefined
    } : undefined,
    branchName: row.branch_name ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prUrl: row.pr_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function ensureSqliteRunSchemaMigrations(db: Database.Database) {
  const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
  if (!columns.some(column => column.name === "source_key")) {
    db.exec("ALTER TABLE runs ADD COLUMN source_key TEXT")
  }
  if (!columns.some(column => column.name === "backend")) {
    db.exec("ALTER TABLE runs ADD COLUMN backend TEXT")
  }
  if (!columns.some(column => column.name === "agent")) {
    db.exec("ALTER TABLE runs ADD COLUMN agent TEXT")
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_source_key_idx ON runs(source_key)")
}
