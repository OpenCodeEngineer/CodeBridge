# CodeBridge

Bridge Slack threads and GitHub issue comments to a local Codex CLI runner. Posts progress updates and can open PRs.

## Breaking Change (GitHub Command Routing)

GitHub command parsing is now handle-first.

- GitHub comments must start with a GitHub handle mention (for example `@codexengineer`).
- Legacy GitHub text prefixes like `codex:` and `/codex` are no longer accepted for GitHub comment routing.
- This is an immediate cutover (no deprecation window in this release).
- Slack command prefix behavior is unchanged.

Authoritative product docs:

- [Requirements](docs/requirements.md)
- [Design](docs/design.md)
- [GitHub Apps](docs/github.md)
- [GitHub Assignee Setup](docs/github-assignee-setup.md)
- [GitHub Surface Test Protocol](docs/test-protocol.md)

## GitHub Commands

GitHub issue commands are handle-based.
CodeBridge accepts only `@handle` mention prefixes for GitHub comments (no plain-text aliases like `codex:` for GitHub).

Migration note:
- If your older tenant config used GitHub `commandPrefixes` values like `codex:` or `/codex`, switch comment usage to app-handle mentions (for example `@codexengineer ...`).
- Slack command prefixes are unchanged; this change is GitHub-surface only.

Prefix sources:
- App slug handle from GitHub App identity (for example `@codexengineer`)
- Handles from `github.assignmentAssignees` (for assignment + mention fallback)

- `run <prompt>`: create a new run (default when no verb is provided)
- `reply <prompt>`: create a follow-up run for the same issue
- `status`: post latest run status for the issue
- `pause`: acknowledge pause intent (runtime pause control not implemented yet)
- `resume`: acknowledge resume intent (runtime resume control not implemented yet)
- `tenant:<tenant-id>`: explicitly target a configured tenant (useful when multiple tenants share an app or repo)

Examples:

- `@codexengineer run check wikipedia and answer in what year the first gpt model was released`
- `@codexengineer status`
- `@codexengineer tenant:local run investigate failing CI on this branch`

## GitHub Lifecycle Labels

Bridge maintains issue labels as lightweight session state:

- `agent:in-progress`
- `agent:idle`
- `agent:completed`
- `agent:managed`

If a run is created without an issue number (for example from non-GitHub entry points), bridge auto-creates an issue in the configured repository and associates the run with it.

## Optional Vibe Agents Mirror

If `integrations.vibeAgents` is configured, CodeBridge emits run lifecycle events to the configured HTTP endpoint:

- `session.created` when a run is created
- `session.status` with lifecycle mapping:
  - `running` -> `in-progress`
  - `failed` -> `idle`
  - `succeeded` / `no_changes` -> `completed`

This is best-effort and non-blocking. GitHub issue flow continues even if the mirror endpoint is unavailable.

## Codex CLI Session Sync (Notify Hook)

Bridge exposes `POST /codex/notify` to ingest Codex turn-complete notifications and mirror session state to GitHub issues.

Behavior:

- One Codex session (`thread-id`) maps to one GitHub issue.
- If prompt includes an issue reference (`#123`, `owner/repo#123`, or full GitHub issue/PR URL), bridge binds session to that issue.
- If prompt has no issue reference, bridge auto-creates an issue and binds the session.
- On each turn:
  - sets lifecycle label to `agent:in-progress`
  - posts user prompt as an issue comment
  - posts assistant response as an issue comment
  - marks issue `agent:completed` after response is posted

### Wire Codex `notify` to Bridge

Add this to Codex config:

```toml
notify = ["node", "/ABS/PATH/CodeBridge/scripts/codex-notify-bridge.mjs"]
```

Optional env vars for the script:

- `CODEBRIDGE_NOTIFY_URL` (default: `http://127.0.0.1:8788/codex/notify`)
- `CODEBRIDGE_NOTIFY_TIMEOUT_MS` (default: `2500`)
- `CODEBRIDGE_NOTIFY_TOKEN` (optional header value)
- Legacy aliases are still accepted: `CODEX_BRIDGE_NOTIFY_URL`, `CODEX_BRIDGE_NOTIFY_TIMEOUT_MS`, `CODEX_BRIDGE_NOTIFY_TOKEN`

## Run (Local)

1. Copy `config/tenants.example.yaml` to `config/tenants.yaml` and set repo paths.
2. Put GitHub App credentials in YAML (`secrets.githubAppId`, `secrets.githubPrivateKey`), preferably in `~/.config/codebridge/config.yaml`.
3. Set `CONFIG_PATH` to that file if you don't want to run from repo-local config.
4. Start with SQLite + in‑memory queue:

```bash
export DATABASE_URL=sqlite://./data/codebridge.db
export QUEUE_MODE=memory
pnpm install
pnpm dev
```

Health check: `http://localhost:8788/health`

## GitHub Integration

Create a GitHub App:
- Permissions: Issues (Read & Write), Pull requests (Read & Write), Contents (Read & Write)
- Subscribe to `issue_comment`

Assignment bootstrap details and limits (including non-assignable app bots) are documented in [GitHub Assignee Setup](docs/github-assignee-setup.md).

### Webhook mode
- Set Webhook URL to `http://HOST:8788/github/webhook`
- Set `GITHUB_WEBHOOK_SECRET`

### Polling mode (no public webhook)
- Disable webhook in the app
- Set `GITHUB_POLL_INTERVAL` (seconds, e.g. `30`)

Install the App on the target repo and copy the installation ID into `config/tenants.yaml`.

## Minimal Config (`config/tenants.yaml`)

```yaml
secrets:
  githubAppId: 123456
  githubPrivateKey: "BASE64_OR_PEM_PRIVATE_KEY"
  # Optional if vibeAgents.token is omitted:
  # vibeAgentsToken: "token"

integrations:
  vibeAgents:
    endpoint: "https://api.vibebrowser.app/api/agents/sessions"
    author: "dzianisv"
    project: "VibeWebAgent"
    enabled: true
    timeoutMs: 8000

tenants:
  - id: local
    name: Local
    github:
      installationId: 123456
      # Optional: assignment bootstrap handles (must be assignable users in repo)
      # assignmentAssignees:
      #   - "codex-operator"
      repoAllowlist:
        - "owner/repo"
    repos:
      - fullName: "owner/repo"
        path: "/abs/path/to/repo"
        baseBranch: "main"
        branchPrefix: "codex"
    defaultRepo: "owner/repo"
```

## Env Vars (GitHub)

- `GITHUB_APP_ID` (fallback if `secrets.githubAppId` is not set)
- `GITHUB_PRIVATE_KEY` (fallback if `secrets.githubPrivateKey` is not set)
- `GITHUB_WEBHOOK_SECRET` (webhook mode only; fallback if not set in `secrets.githubWebhookSecret`)
- `GITHUB_POLL_INTERVAL` (polling mode only)

## Optional Env Vars (Vibe Agents Mirror)

- `VIBE_AGENTS_ENDPOINT` (override `integrations.vibeAgents.endpoint`)
- `VIBE_AGENTS_TOKEN` (override token or `secrets.vibeAgentsToken`)
- `VIBE_AGENTS_AUTHOR` (author metadata override)
- `VIBE_AGENTS_PROJECT` (project metadata override)
- `VIBE_AGENTS_ENABLED` (`true`/`false`)
- `VIBE_AGENTS_TIMEOUT_MS` (HTTP timeout in milliseconds)

## Test

```bash
pnpm test:github-polling --repo owner/repo --timeout 300 --poll 5 --close
pnpm test:github-protocol \
  --issue-repo owner/repo \
  --pr-repo owner/repo \
  --discussion-repo owner/repo \
  --discussion-number 1
```

## Notes

- Repo paths must exist on the host and be clean before a run.
- Each run creates a new branch and opens a PR when changes exist.
