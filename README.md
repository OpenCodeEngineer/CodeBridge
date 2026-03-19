# CodeBridge

CodeBridge turns GitHub issues, PR conversation comments, PR review comments, and discussion comments into a control plane for local coding agents.

Assign or mention one of your GitHub App bots, and CodeBridge resolves the GitHub repo into a managed local workspace clone plus per-task worktree, runs the configured agent backend there, then posts progress, summaries, and PR links back to the same thread.

## Install

```bash
git clone https://github.com/dzianisv/CodeBridge.git && cd CodeBridge && pnpm install && cp config/tenants.example.yaml config/tenants.yaml
```

## Why CodeBridge

- Run local agent workflows from GitHub web/mobile instead of a terminal.
- Keep session state visible in GitHub using labels and comments.
- Support both webhook and polling ingestion modes.
- Route different GitHub Apps to different backends against the same repo.
- Ship a hard-gate eval and protocol matrix against real GitHub surfaces.

## System Design

```text
                                         GitHub
      +------------------------------------------------------------------------+
      | Issues / PR comments / Discussions / Assignments / Labels / PRs       |
      +-------------------------------------+----------------------------------+
                                            | events
                         webhook (/github/webhook/<appKey>) or polling (interval)
                                            v
+-------------------------------------------------------------------------------------------+
|                                         CodeBridge                                        |
|                                                                                           |
|  +--------------------+     +---------------------+     +-------------------------------+ |
|  | Ingestion          | --> | Router + Dedupe     | --> | Run Service                   | |
|  | - Probot webhook   |     | - parse command     |     | - create run record           | |
|  | - GitHub poller    |     | - resolve tenant    |     | - post initial status         | |
|  +--------------------+     +---------------------+     +---------------+---------------+ |
|                                                                          enqueue          |
|  +--------------------+     +---------------------+                     (BullMQ/memory)   |
|  | Storage            | <-- | Worker              | <------------------------------------+ |
|  | - SQLite/Postgres  |     | - selected backend  |                                       |
|  | - runs/events      |     | - Codex / OpenCode  |                                       |
|  | - poll high-water  |     | - repo branch/PR    |                                       |
|  |                    |     | - status updates    |                                       |
|  +--------------------+     +----------+----------+                                       |
|                                         |                                                  |
|                             app-authored comments + labels + PR links                     |
+-----------------------------------------+--------------------------------------------------+
                                          |
                                          v
                                  GitHub thread updates
```

## Core Behavior

1. A user assigns an issue to a native assignable actor or comments with the GitHub App handle on an issue, PR conversation, PR review comment, or discussion.
2. CodeBridge resolves tenant/repo, creates a run, and marks lifecycle labels on issue and PR conversation threads.
3. Worker executes the configured backend against a CodeBridge-managed task worktree.
4. Progress and final summary are posted by the GitHub App identity.
5. If code changed, CodeBridge opens a PR and links it back to the originating GitHub thread.

PR review comment note:
CodeBridge treats PR review comments as explicit-command surfaces. Status and final responses are posted on the PR conversation thread, not inline in the review thread.

## GitHub Lifecycle Labels

- `agent:managed`
- `agent:in-progress`
- `agent:idle`
- `agent:completed`

## Quickstart

### 1. Prerequisites

- Node.js 18+
- `pnpm`
- `gh` CLI authenticated for repositories you test against
- GitHub App credentials (App ID + private key)
- Optional for Redis mode: Redis instance

### 2. Install and configure

```bash
pnpm install
cp config/tenants.example.yaml config/tenants.yaml
```

Set:

- `secrets.githubApps`
- tenant `github.apps[].installationId`
- tenant repo mapping in `repos`

You can also place real config in `~/.config/codebridge/config.yaml` and set `CONFIG_PATH`.

### 3. Set environment

Typical local dev defaults:

```bash
export PORT=8788
export ROLE=all
export DATABASE_URL=./data/codebridge.db
export QUEUE_MODE=memory
export GITHUB_POLL_INTERVAL=15
export GITHUB_POLL_BACKFILL=false
# optional override; defaults to $HOME/workspace
# export CODEBRIDGE_WORKSPACE_ROOT=$HOME/workspace
# optional safety guard: fail stuck agent turns after 5 minutes
# export CODEX_TURN_TIMEOUT_MS=300000
# optional OpenCode backend
# export OPENCODE_BASE_URL=http://127.0.0.1:4096
# export OPENCODE_USERNAME=opencode
# export OPENCODE_PASSWORD=change-me
# optional if config file is outside repo
# export CONFIG_PATH=$HOME/.config/codebridge/config.yaml
```

### 4. Run

```bash
pnpm dev
```

Health check:

```bash
curl http://127.0.0.1:8788/health
```

## GitHub App Setup

### 1. Create one or more GitHub Apps

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** and fill in one app per backend route you want to expose. Typical setup:

- `@<codex-app-slug>` -> backend `codex`
- `@<opencode-app-slug>` -> backend `opencode`

For each app:

| Field | Value |
|-------|-------|
| App name | `CodeBridge` (or your preferred name) |
| Homepage URL | `https://github.com/dzianisv/CodeBridge` |
| Webhook URL | `https://<your-host>:8788/github/webhook/<appKey>` (or leave blank if polling-only) |
| Webhook secret | Generate one with `openssl rand -hex 32` |

#### Permissions

| Permission | Access |
|------------|--------|
| Issues | Read & Write |
| Pull requests | Read & Write |
| Contents | Read & Write |
| Discussions | Read & Write (if discussion triggers are needed) |

#### Subscribe to events

- `issues`
- `issue_comment`
- `pull_request_review_comment`
- `discussion_comment`

Click **Create GitHub App**. Note the **App ID** shown on the next page.

### 2. Generate a private key

On the App settings page, scroll to **Private keys → Generate a private key**. Save the downloaded `.pem` file.

### 3. Install each App on your repository

Go to each App's page → **Install App** → select your org/account → choose the repositories. After installing, note the **Installation ID** from the URL:

```
https://github.com/settings/installations/12345678
                                           ^^^^^^^^ this is the installation ID
```

### 4. Configure CodeBridge

Edit `config/tenants.yaml`:

```yaml
secrets:
  githubApps:
    codex:
      appId: 123456
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
      webhookSecret: "your-codex-webhook-secret"
      commandPrefixes:
        - "your-real-codex-app-slug"      # optional traceability value; keep it equal to the real GitHub App slug
    opencode:
      appId: 234567
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
      webhookSecret: "your-opencode-webhook-secret"
      commandPrefixes:
        - "your-real-opencode-app-slug"   # optional traceability value; keep it equal to the real GitHub App slug

tenants:
  - id: local
    name: My Workspace
    github:
      apps:
        - appKey: "codex"
          installationId: 12345678         # real Codex app installation id
        - appKey: "opencode"
          installationId: 23456789         # real OpenCode app installation id
    repos:
      - fullName: "your-org/your-repo"
        path: "/absolute/path/to/local/clone" # optional; only needed for non-GitHub entrypoints
        backend: "codex"                  # default backend when no app-specific override exists
        model: "gpt-5.2-codex"
        githubApps:
          opencode:
            backend: "opencode"
            agent: "build"
            model: "openai/gpt-5"
            branchPrefix: "opencode"
        baseBranch: "main"
        branchPrefix: "codex"
    defaultRepo: "your-org/your-repo"
```

The private key accepts PEM with escaped newlines or base64-encoded PEM.

Legacy single-app config still works and is normalized into a `default` app key automatically.

Alternatively, use environment variables instead of the config file for a single default app:

```bash
export GITHUB_APP_ID=123456
export GITHUB_PRIVATE_KEY="$(cat path/to/private-key.pem)"
export GITHUB_WEBHOOK_SECRET="your-webhook-secret"
```

### 5. Choose ingestion mode

**Polling (no public URL needed):**

```bash
export GITHUB_POLL_INTERVAL=15
export GITHUB_POLL_BACKFILL=false
```

**Webhook (requires public URL):**

Set each webhook URL on its corresponding GitHub App to `https://<your-host>/github/webhook/<appKey>`. The webhook secret is required for signature verification.

Both modes can run simultaneously.

## Repo Mapping

GitHub-originated runs are mapped from GitHub metadata, not from the shell's current working directory.

For webhook and polling events, CodeBridge resolves the target local checkout in this order:

1. GitHub App key + installation id -> tenant app binding
2. GitHub `owner/repo` full name -> repo entry inside that tenant
3. optional `tenant:<id>` hint in the comment, but only if that tenant is valid for the same installation and the same GitHub repo

The actual GitHub run path is derived from the GitHub repo identity plus the managed workspace root:

```yaml
tenants:
  - id: local
    github:
      apps:
        - appKey: codex
          installationId: 113944796
          repoAllowlist:
            - dzianisv/codebridge-test
    repos:
      - fullName: dzianisv/codebridge-test
        branchPrefix: codex
```

Important behavior:

- GitHub issue, PR, and discussion commands use an exact `repos[].fullName` match.
- `defaultRepo` is only a fallback for non-GitHub entrypoints such as Slack or `/codex/notify`.
- For GitHub-originated runs, CodeBridge prefers a base clone at `$CODEBRIDGE_WORKSPACE_ROOT/<repo-name>`.
- If that path is already occupied by another repo, CodeBridge falls back to `$CODEBRIDGE_WORKSPACE_ROOT/<owner>__<repo-name>`.
- Task worktrees are created under `$CODEBRIDGE_WORKSPACE_ROOT/.codebridge/worktrees/<owner>__<repo-name>/<run-id>`.
- `repos[].path` is optional and is only required for entrypoints that do not already carry GitHub repo identity.

## Backend Selection

Each configured repo can select its default execution backend. If `backend` is omitted, CodeBridge defaults to `codex`. A repo can also override backend/agent/model per GitHub App key.

```yaml
secrets:
  opencodePassword: "optional-shared-password"

integrations:
  opencode:
    baseUrl: "http://127.0.0.1:4096"
    username: "opencode"
    enabled: true
    timeoutMs: 300000
    pollIntervalMs: 2000

tenants:
  - id: local
    name: Local
    github:
      apps:
        - appKey: codex
          installationId: 111111
        - appKey: opencode
          installationId: 222222
    repos:
      - fullName: "owner/repo"
        backend: "codex"
        model: "gpt-5.2-codex"
        path: "/absolute/path/to/local/checkout"   # optional; only needed for non-GitHub entrypoints
        githubApps:
          opencode:
            backend: "opencode"
            agent: "build"
            model: "openai/gpt-5"
            branchPrefix: "opencode"
```

Important behavior:

- `backend` currently supports `codex` and `opencode`.
- `agent` is backend-specific metadata and is currently forwarded to OpenCode session creation.
- `githubApps.<appKey>` on a repo only overrides fields that differ from the repo default route.
- OpenCode model values must use `provider/model` format.
- `integrations.opencode.*` can come from config or `OPENCODE_*` environment variables.

## Multi-App Routing

- Each run persists `github.appKey`, so outbound comments, labels, and PRs are written by the same app that ingested the command.
- Managed issue/PR follow-ups are owned by the latest app-bound run on that thread.
- Explicitly mentioning a different app on the same managed thread starts a new run under that app instead of relaying into the old session.
- Detailed design notes live in [docs/github-multi-app-routing.md](/Users/engineer/workspace/CodeBridge/docs/github-multi-app-routing.md).

## Execution Model

For GitHub-originated runs, CodeBridge now owns clone/worktree lifecycle under the managed workspace root.
It does not run backends against a shared mutable checkout.

Backend behavior:

- `codex`: CodeBridge starts a local Codex SDK thread in the resolved task worktree.
- `opencode`: CodeBridge prepares the git state locally, then creates an OpenCode session over HTTP scoped to that same task worktree. For GitHub-originated runs, the preferred contract is that OpenCode does not use GitHub tooling or `git push`; it leaves local edits or local commits for CodeBridge to publish with the handling app identity. CodeBridge also sends `tools.github=false` on those prompt requests so the OpenCode server cannot use its configured GitHub MCP for that run. If OpenCode still leaves the checkout clean, CodeBridge does not assume `no_changes`: it first looks for a returned PR URL, then checks whether the prepared branch is ahead of the remote base branch, pushes that branch if needed, reuses an already-open PR for that head branch, or creates the PR itself.

Before starting a run, the worker:

1. ensures or refreshes the base clone under the managed workspace root,
2. creates a fresh per-task worktree from the remote default branch,
3. verifies the task worktree is clean,
4. fetches `origin`,
5. creates a fresh branch from the remote default branch,
6. runs the selected backend in that task worktree,
7. if the backend left uncommitted changes, CodeBridge commits and pushes them from that task worktree,
8. if the backend left a clean branch with commits, CodeBridge still pushes/reuses/creates the PR from that branch instead of reporting `no_changes`,
9. if the backend already completed the PR flow and returned a GitHub PR URL, CodeBridge records that PR as the successful outcome.

## Triggering Runs

### Assignment bootstrap

Assign the issue to a native assignable actor. Configure additional accepted handles with `github.assignmentAssignees`.
Those assignment handles apply to assignment bootstrap only; they do not widen accepted comment mention prefixes.

### Mention bootstrap

Comment in issue/PR/discussion:

```text
@codexengineer run investigate flaky CI and propose a fix
```

If you run multiple apps on the same repo, mention the app you want:

```text
@your-real-codex-app-slug run fix the failing test
@your-real-opencode-app-slug run refactor this integration using the opencode backend
```

The mention handle must be the exact real installed GitHub App slug.
Do not rely on arbitrary text aliases for GitHub comment bootstrap or explicit GitHub commands.
CodeBridge now refuses configured alias fallback for GitHub comment routing when app identity lookup is unavailable; it will ignore the command rather than guess.
GitHub currently renders GitHub App slug tokens as plain text in issue/PR/discussion comment HTML instead of `<a class="user-mention">` links, so the bridge treats the exact resolved `@<app-slug>` text as the command token and proves authorship with matching app-authored responses plus `performed_via_github_app`.
If clickable highlighted `@mentions` for GitHub Apps are a hard product requirement, treat that as a GitHub-platform limitation rather than a CodeBridge routing feature.

### Follow-up

On managed issues and PR conversation threads, plain non-bot comments are treated as follow-up prompts only for the app that owns the latest managed run on that thread.

PR review comments stay explicit:

- every review-thread follow-up must still mention the exact app slug handle
- responses are written back to the PR conversation thread

### Control verbs

On managed issues and PR conversation threads, explicit `status`, `pause`, and `resume` commands are accepted.

Discussion threads stay explicit:

- every follow-up must still mention the exact app slug handle
- `status`, `pause`, and `resume` return an unsupported-message comment instead of mutating issue state

## Evaluation

### Hard gate

Runs the required live customer-flow mission gate:

```bash
pnpm eval:customer-flow -- \
  --repo dzianisv/codebridge-test \
  --workspace-root /absolute/path/to/dedicated/codebridge-workspace \
  --database-url /absolute/path/to/codebridge-eval.db
```

This suite is only valid when Codex and OpenCode are backed by distinct installed GitHub Apps, each addressed by its real handle.
The live-eval config now defaults the OpenCode route to `opencode/minimax-m2.5-free`, which completed a real repo mutation on March 18, 2026 after the default GitHub Copilot route hit global rate limits. Override `CODEBRIDGE_EVAL_OPENCODE_MODEL` only if your local server has a better supported model.

It proves two user-facing GitHub flows end to end:

- `@<real-codex-app-slug>` routes to backend `codex` and answers the GPT-1 release question on the issue thread with no PR.
- `@<real-opencode-app-slug>` routes to backend `opencode`, creates a Bun + TypeScript hello-world app, runs it, opens a PR, and reports the PR back on the issue thread.

It verifies:

- GitHub-visible evidence: the trigger comment used the real handle, the evaluator captured the rendered `body_html` for that trigger, the expected bot replied on the issue thread, the reply `performed_via_github_app` matches the expected app slug, and the OpenCode PR author matches the expected app
- persistence evidence: `backend`, `github_app_key`, and final run status from the live bridge database
- workspace evidence: the persisted `repo_path` is inside the managed workspace root and uses the per-task worktree layout instead of the base clone path
- executable PR verification: `bun test` and `bun run src/main.ts` on the generated PR branch
- backend publication contract: the OpenCode eval task forbids GitHub writes and `git push` from inside the backend task, and CodeBridge sends `tools.github=false` on GitHub-originated OpenCode prompts so the bridge must publish the branch and PR itself
- branch-ahead recovery: OpenCode is allowed to commit and push before CodeBridge inspects git state, and the bridge must still recover the PR flow instead of misclassifying the run as `no_changes`
- identity proof: the evaluator resolves the real GitHub App slugs and bot logins from credentials and fails if the two app keys share one GitHub App identity

Full design and workflow details live in [docs/evaluation.md](/Users/engineer/workspace/CodeBridge/docs/evaluation.md).

### Legacy assignment gate

Informational native-Codex assignment run:

```bash
pnpm eval:codex-native
```

Strict `@codexengineer` assignment gate:

```bash
pnpm eval:strict-codexengineer
```

When strict assignment is blocked by GitHub assignability rules, collect evidence with:

```bash
pnpm test:github-assignment-evidence -- --repo dzianisv/codebridge-test --assignment-handle @codexengineer
```

### Surface protocol matrix

Runs the operational GitHub surface matrix for assignment, issue mention, PR conversation mention, PR review comment mention, and discussion mention:

```bash
bun scripts/runGithubMentionE2ETest.ts
```

If `--pr-repo` is omitted, the matrix now reuses `--issue-repo`.

Add `--assignment-handle @openai-code-agent` when you want the native Codex actor explicitly.

### Promptfoo provider

CodeBridge still ships a custom promptfoo provider (`eval/provider.ts`) for rubric-based live scoring:

```bash
pnpm eval
pnpm eval:serial
```

Open report UI:

```bash
pnpm eval:view
```

Main config:

- `promptfooconfig.yaml`

## Development Commands

```bash
pnpm build                      # compile TypeScript
pnpm lint                       # lint with ESLint
pnpm test                       # run unit tests (vitest)
pnpm test:watch                 # run tests in watch mode
pnpm eval                       # run generic Codex eval
pnpm eval:requirements          # run requirements-focused eval (R1-R6)
pnpm eval:requirements:serial   # same, one issue at a time
pnpm eval:view                  # open promptfoo results UI
```

Integration test scripts (require live infra):

```bash
pnpm test:opencode-integration
pnpm test:github-polling
pnpm test:github-protocol
pnpm test:vibe-agents
```

## Troubleshooting

- If assignment bootstrap does not trigger, verify app/user assignability for that repo. Mention bootstrap remains the fallback.
- If a GitHub mention is ignored, verify that repository appears in both tenant `repos` and `github.repoAllowlist`, and that `CODEBRIDGE_WORKSPACE_ROOT` is writable.
- If polling misses first historical comments, keep `GITHUB_POLL_BACKFILL=false` and post a new comment after poller startup.
- If no PR is created, inspect run summary comments for repo cleanliness, auth, or network errors.
- If discussion validation passes only through synthetic fallback, that usually means the app still lacks Discussions permission on the target repo. Use the running bridge's `DATABASE_URL` and webhook secret when executing the protocol runner.

## Documentation

- [Requirements](docs/requirements.md)
- [Design](docs/design.md)
- [Customer-Flow Evaluation](docs/evaluation.md)
- [OpenCode Backend Design](docs/opencode.md)
- [GitHub Surface Test Protocol](docs/test-protocol.md)
- [GitHub Assignee Setup](docs/github-assignee-setup.md)
