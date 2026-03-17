# CodeBridge - Project Context

Date: 2026-03-05

## Mission

Make CodeBridge's GitHub App integration work **end-to-end**: a human assigns or mentions `@CodexEngineer` on a GitHub issue, and `codexengineer[bot]` replies with quality results (creates files, opens PRs). Build an **evaluation framework using promptfoo** that tests Codex task execution quality by posting test tasks and scoring responses. Then create a polished **README.md with system design ASCII diagram** ready for public launch on HN/Reddit.

## What Is CodeBridge

CodeBridge is a bridge service that connects **GitHub issues/PRs/discussions** and **Slack threads** to a **local Codex CLI runner**. When a human mentions the bot or assigns it to an issue, CodeBridge runs Codex against the target repo and posts progress updates, answers, and pull requests back to the conversation thread.

## Architecture

- **API server** (Express, port 8788): receives GitHub webhooks or polls GitHub for new mentions
- **Worker** (BullMQ or in-memory queue): executes Codex SDK runs against local repo clones
- **Storage**: PostgreSQL (prod) or SQLite (dev) for runs, events, poll state
- **Queue**: Redis/BullMQ (prod) or in-memory (dev)

## GitHub Integration

Two modes for receiving events:
1. **Webhook mode** via Probot at `/github/webhook`
2. **Polling mode** with configurable interval (no public endpoint needed)

Supported triggers:
- `issue_comment.created` (mention-based)
- `discussion_comment.created` (mention-based)
- `issues.assigned` (assignment-based)

Issue lifecycle labels: `agent:managed`, `agent:in-progress`, `agent:idle`, `agent:completed`

### Key Details

- GitHub App: `CodexEngineer` (appId: `3005179`, slug: `codexengineer`, bot login: `codexengineer[bot]`)
- Installed on: `dzianisv` (installationId: `113944796`) and `VibeTechnologies` (installationId: `114074361`)
- Test repo: `dzianisv/codebridge-test`
- GitHub events received via **polling** at 15-second intervals (no webhook endpoint needed)
- Use `gh` CLI with `OpenCodeEngineer` account for GitHub operations on `OpenCodeEngineer/CodeBridge` repo
- Use `unset GITHUB_TOKEN` before `gh` commands (or `env: { GITHUB_TOKEN: undefined }`) — the env var is stale; keyring auth works

## Configuration

Config loaded from YAML (`config/tenants.yaml` or `~/.config/codebridge/config.yaml`):
- GitHub App credentials (appId, privateKey)
- Tenant definitions with repo mappings, Slack team IDs, and GitHub installation IDs

Server env (`.env` at project root):
- `PORT=8788`, `ROLE=all`, `DATABASE_URL=sqlite://./data/codex-bridge.db`
- `QUEUE_MODE=memory`, `GITHUB_POLL_INTERVAL=15`, `GITHUB_POLL_BACKFILL=false`
- `CONFIG_PATH` pointing to user config YAML
- `CODEX_PATH=/Users/engineer/.nvm/versions/node/v22.15.1/bin/codex`

## Discoveries

- **No CI pipeline** — no `.github/workflows/` directory. Build (`pnpm build`) and lint (`pnpm lint`) both pass cleanly.
- **No unit test suite** — only integration test scripts (`test:github-polling`, `test:github-protocol`, `test:vibe-agents`).
- **Git auth**: HTTPS to `OpenCodeEngineer/CodeBridge` requires `gh auth setup-git`. SSH key is for `dzianisv` only.
- **Polling first-run behavior**: When `GITHUB_POLL_BACKFILL=false` and no poll state exists, the first poll cycle seeds the high-water mark without processing comments. Only subsequent comments after seeding are processed (by design, `github-poll.ts` lines 127-135).
- **Codex SDK `ThreadOptions`** supports: `sandboxMode` ("read-only" | "workspace-write" | "danger-full-access"), `approvalPolicy` ("never" | "on-request" | "on-failure" | "untrusted"), `networkAccessEnabled`, `webSearchMode`. Default sandbox was `"read-only"` which prevented file creation.
- **Azure OpenAI works**: `AZURE_OPENAI_BASE_URL=https://vibebrowser-dev.openai.azure.com/openai/responses?api-version=2025-04-01-preview` with `gpt-4.1` model via Responses API is confirmed working.
- **Eval run #1** (issues #24-26, read-only sandbox): 0/30 — bot couldn't create files, sandbox was read-only, eval timing was wrong.
- **Eval run #2** (issues #27-29, workspace-write sandbox): 18/30 (60%) — files created successfully with PRs (#30, #31), but noisy output (gh CLI network errors, kilocode errors in sandbox) cost points. Research task scored 8/10. Duplicate comment bug confirmed fixed (1 comment per run now).
- **Codex sandbox noise**: Even with `workspace-write`, Codex internally tries to run `gh issue list` and `kilocode run` which fail due to sandbox network restrictions, producing noisy output.
- The `codebridge-test` repo only contains `README.md`.
- **promptfoo `ApiProvider` interface**: `cleanup` is a reserved method name; use a different field name (e.g. `closeIssues`).
- **`execa` is ESM-only**: cannot be imported via tsx in CJS mode for eval provider; use `node:child_process` `execFile` + `promisify` instead.

## Accomplished

- Removed all OpenClaw/CodeClaw references from the codebase
- Build passes (`pnpm build` — clean TypeScript compilation)
- Lint passes (`pnpm lint` — zero warnings)
- PR #2 created, reviewed, and merged to `main`: https://github.com/OpenCodeEngineer/CodeBridge/pull/2
- Fixed duplicate comment bug in `runner.ts` — removed the `no_changes` path that posted a separate `createComment` before calling `finalize()`. Now only `finalize()` updates the existing status comment.
- Fixed Codex sandbox mode — changed `startThread()` to pass `sandboxMode: "workspace-write"` and `approvalPolicy: "never"` so Codex can create/edit files autonomously.
- Committed and pushed runner.ts fixes (commit `dc03a50` on `main`)
- **promptfoo eval framework created**:
  - Custom provider at `eval/provider.ts` (creates GitHub issues, assigns to bot, polls for reply, fetches PR diffs)
  - Config at `promptfooconfig.yaml` with 3 test cases (Python file creation, TypeScript file creation, research task)
  - Uses Azure GPT-4.1 as `llm-rubric` judge
  - Trigger is issue **assignment** to `codexengineer`, NOT @mention in comments
  - `pnpm eval` / `pnpm eval:view` scripts added to package.json
  - Old custom eval script (`scripts/eval-codex-quality.ts`) deleted
- Eval run #2 confirmed bot creates PRs — issues #27 (python) and #28 (typescript) both got PRs (#30, #31) with correct file contents
- CodeBridge server running on port 8788, healthy

## Next Steps

1. **Run promptfoo eval end-to-end** — execute `pnpm eval` against live server to validate the new eval framework works and produces scored results
2. **Rewrite README.md for public launch** — system design ASCII diagram, configuration guide, polished for HN/Reddit audience
3. **CI/CD pipeline** — add `.github/workflows/` with build + lint checks

## Key Files

### Source (core)
- `src/runner.ts` — Codex SDK thread execution, sandbox config, status updates, finalization
- `src/index.ts` — main entry, bootstraps Express + worker + polling
- `src/github-poll.ts` — polling-based GitHub event ingestion (718 lines)
- `src/github-auth.ts` — GitHub App auth / Octokit client creation
- `src/command-prefixes.ts` — resolves `@codexengineer` mention prefix
- `src/commands.ts` — command parsing
- `src/run-service.ts` — creates run records, posts initial status, enqueues jobs
- `src/storage.ts` — SQLite/PostgreSQL storage backend
- `src/config.ts` — config loading, Zod schemas, dotenv
- `src/status.ts` — formatGitHubStatus, formatSlackStatus, formatFinalSummary
- `src/progress.ts` — ProgressTracker
- `src/github-issue-state.ts` — syncIssueLifecycleState (labels)
- `src/git.ts` — git operations
- `src/repo.ts` — ensureRepoPath

### Eval (promptfoo)
- `promptfooconfig.yaml` — promptfoo configuration with test cases and Azure GPT-4.1 judge
- `eval/provider.ts` — custom promptfoo provider (GitHub issue creation, assignment, polling, PR diff)

### Config & Env
- `~/.config/codebridge/config.yaml` — GitHub App credentials, tenant definitions (secrets)
- `.env` — local environment variables (PORT, DATABASE_URL, QUEUE_MODE, etc.)

### Docs
- `docs/requirements.md`
- `docs/design.md`
- `docs/github.md`
- `docs/github-assignee-setup.md`
- `docs/test-protocol.md`

### Data
- `data/codex-bridge.db` — SQLite database
- Server logs at `/tmp/codebridge.log`
