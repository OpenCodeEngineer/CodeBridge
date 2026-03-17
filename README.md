# CodeBridge

CodeBridge turns GitHub issues, PR conversation comments, PR review comments, and discussion comments into a control plane for a local coding agent.

Assign or mention your GitHub App bot, and CodeBridge runs the configured agent backend against the mapped local repo, then posts progress, summaries, and PR links back to the same thread.

## Install

```bash
git clone https://github.com/dzianisv/CodeBridge.git && cd CodeBridge && pnpm install && cp config/tenants.example.yaml config/tenants.yaml
```

## Why CodeBridge

- Run local agent workflows from GitHub web/mobile instead of a terminal.
- Keep session state visible in GitHub using labels and comments.
- Support both webhook and polling ingestion modes.
- Ship a hard-gate eval and protocol matrix against real GitHub surfaces.

## System Design

```text
                                         GitHub
      +------------------------------------------------------------------------+
      | Issues / PR comments / Discussions / Assignments / Labels / PRs       |
      +-------------------------------------+----------------------------------+
                                            | events
                         webhook (/github/webhook) or polling (interval)
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
3. Worker executes the configured backend against the configured local repo path.
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

- `secrets.githubAppId`
- `secrets.githubPrivateKey`
- tenant `github.installationId`
- tenant repo mapping in `repos`

You can also place real config in `~/.config/codebridge/config.yaml` and set `CONFIG_PATH`.

### 3. Set environment

Typical local dev defaults:

```bash
export PORT=8788
export ROLE=all
export DATABASE_URL=sqlite://./data/codebridge.db
export QUEUE_MODE=memory
export GITHUB_POLL_INTERVAL=15
export GITHUB_POLL_BACKFILL=false
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

### 1. Create the GitHub App

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** and fill in:

| Field | Value |
|-------|-------|
| App name | `CodeBridge` (or your preferred name) |
| Homepage URL | `https://github.com/dzianisv/CodeBridge` |
| Webhook URL | `https://<your-host>:8788/github/webhook` (or leave blank if polling-only) |
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

### 3. Install the App on your repository

Go to your App's page → **Install App** → select your org/account → choose the repositories. After installing, note the **Installation ID** from the URL:

```
https://github.com/settings/installations/12345678
                                           ^^^^^^^^ this is the installation ID
```

### 4. Configure CodeBridge

Edit `config/tenants.yaml`:

```yaml
secrets:
  githubAppId: 123456                      # your App ID
  githubPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
  githubWebhookSecret: "your-webhook-secret"  # required for webhook mode

tenants:
  - id: local
    name: My Workspace
    github:
      installationId: 12345678             # from step 3
      # assignmentAssignees:               # optional — enable assignment bootstrap
      #   - "your-bot-login"
    repos:
      - fullName: "your-org/your-repo"
        path: "/absolute/path/to/local/clone"
        backend: "codex"                  # optional; defaults to codex
        # backend: "opencode"
        # agent: "build"                  # backend-specific; currently used by OpenCode
        model: "gpt-5.2-codex"
        # model: "openai/gpt-5"           # OpenCode expects provider/model
        baseBranch: "main"
        branchPrefix: "codex"
    defaultRepo: "your-org/your-repo"
```

The private key accepts PEM with escaped newlines or base64-encoded PEM.

Alternatively, use environment variables instead of the config file:

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

Set the webhook URL on your GitHub App to `https://<your-host>/github/webhook`. The webhook secret is required for signature verification.

Both modes can run simultaneously.

## Repo Mapping

GitHub-originated runs are mapped from GitHub metadata, not from the shell's current working directory.

For webhook and polling events, CodeBridge resolves the target local checkout in this order:

1. GitHub App installation id -> tenant
2. GitHub `owner/repo` full name -> repo entry inside that tenant
3. optional `tenant:<id>` hint in the comment, but only if that tenant is valid for the same installation and the same GitHub repo

The actual local execution path comes from the matched tenant repo entry:

```yaml
tenants:
  - id: local
    github:
      installationId: 113944796
      repoAllowlist:
        - dzianisv/codebridge-test
    repos:
      - fullName: dzianisv/codebridge-test
        path: /absolute/path/to/local/checkout
        branchPrefix: codex
```

Important behavior:

- GitHub issue, PR, and discussion commands use an exact `repos[].fullName` match.
- `defaultRepo` is only a fallback for non-GitHub entrypoints such as Slack or `/codex/notify`.
- If `repo.path` does not exist locally, the run cannot start.
- Repo mapping is resolved before backend dispatch. A GitHub mention on `owner/repo-a` can only execute against the configured `repo.path` for `owner/repo-a`.

## Backend Selection

Each configured repo can select its execution backend. If `backend` is omitted, CodeBridge defaults to `codex`.

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
    repos:
      - fullName: "owner/repo"
        path: "/absolute/path/to/local/checkout"
        backend: "opencode"
        agent: "build"
        model: "openai/gpt-5"
        branchPrefix: "opencode"
```

Important behavior:

- `backend` currently supports `codex` and `opencode`.
- `agent` is backend-specific metadata and is currently forwarded to OpenCode session creation.
- OpenCode model values must use `provider/model` format.
- `integrations.opencode.*` can come from config or `OPENCODE_*` environment variables.

## Execution Model

CodeBridge currently executes against the configured local checkout path. It does not create an ephemeral clone or manage a dedicated `git worktree` per run.

Backend behavior:

- `codex`: CodeBridge starts a local Codex SDK thread in `repo.path`.
- `opencode`: CodeBridge still prepares the git branch locally, then creates an OpenCode session over HTTP and scopes that session to the same `repo.path`.

Before starting a run, the worker:

1. verifies the configured checkout is clean,
2. fetches `origin`,
3. creates a fresh branch from the remote default branch,
4. runs the selected backend in that checkout,
5. commits and pushes from that same checkout.

That keeps repo mapping deterministic, but it also means one configured checkout is one mutable execution target. If you need stronger isolation or parallelism for the same GitHub repo, provide separate local clones or worktrees as separate configured `repo.path` targets.

## Triggering Runs

### Assignment bootstrap

Assign the issue to a native assignable actor. Configure additional accepted handles with `github.assignmentAssignees`.

### Mention bootstrap

Comment in issue/PR/discussion:

```text
@codexengineer run investigate flaky CI and propose a fix
```

### Follow-up

On managed issues and PR conversation threads, plain non-bot comments are treated as follow-up prompts.

PR review comments stay explicit:

- every review-thread follow-up must still mention the app or use a configured prefix
- responses are written back to the PR conversation thread

### Control verbs

On managed issues and PR conversation threads, explicit `status`, `pause`, and `resume` commands are accepted.

Discussion threads stay explicit:

- every follow-up must still mention the app or use a configured prefix
- `status`, `pause`, and `resume` return an unsupported-message comment instead of mutating issue state

## Evaluation

### Hard gate

Runs the required live evaluation suite, including the direct assignment-without-mention case:

```bash
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```

Native-Codex assignment run:

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
- If a GitHub mention is ignored, verify that repository appears in both tenant `repos` and `github.repoAllowlist`, and that the configured `repo.path` exists locally.
- If polling misses first historical comments, keep `GITHUB_POLL_BACKFILL=false` and post a new comment after poller startup.
- If no PR is created, inspect run summary comments for repo cleanliness, auth, or network errors.
- If discussion validation passes only through synthetic fallback, that usually means the app still lacks Discussions permission on the target repo. Use the running bridge's `DATABASE_URL` and webhook secret when executing the protocol runner.

## Documentation

- [Requirements](docs/requirements.md)
- [Design](docs/design.md)
- [OpenCode Backend Design](docs/opencode.md)
- [GitHub Surface Test Protocol](docs/test-protocol.md)
- [GitHub Assignee Setup](docs/github-assignee-setup.md)
