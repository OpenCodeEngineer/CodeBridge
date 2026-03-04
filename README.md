# CodeBridge

Bridge Slack threads and GitHub issue comments to a local Codex CLI runner. Posts progress updates and can open PRs.

## GitHub Commands

Use one of the configured command prefixes (`codex:`, `/codex`, `@codex`) in issue comments:

- `run <prompt>`: create a new run (default when no verb is provided)
- `reply <prompt>`: create a follow-up run for the same issue
- `status`: post latest run status for the issue
- `pause`: acknowledge pause intent (runtime pause control not implemented yet)
- `resume`: acknowledge resume intent (runtime resume control not implemented yet)

## GitHub Lifecycle Labels

Bridge maintains issue labels as lightweight session state:

- `agent:in-progress`
- `agent:idle`
- `agent:completed`
- `agent:managed`

If a run is created without an issue number (for example from non-GitHub entry points), bridge auto-creates an issue in the configured repository and associates the run with it.

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
2. Start with SQLite + in‑memory queue:

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

### Webhook mode
- Set Webhook URL to `http://HOST:8788/github/webhook`
- Set `GITHUB_WEBHOOK_SECRET`

### Polling mode (no public webhook)
- Disable webhook in the app
- Set `GITHUB_POLL_INTERVAL` (seconds, e.g. `30`)

Install the App on the target repo and copy the installation ID into `config/tenants.yaml`.

## Minimal Config (`config/tenants.yaml`)

```yaml
tenants:
  - id: local
    name: Local
    github:
      installationId: 123456
      repoAllowlist:
        - "owner/repo"
      commandPrefixes:
        - "codex:"
    repos:
      - fullName: "owner/repo"
        path: "/abs/path/to/repo"
        baseBranch: "main"
        branchPrefix: "codex"
    defaultRepo: "owner/repo"
```

## Env Vars (GitHub)

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY` (PEM or base64)
- `GITHUB_WEBHOOK_SECRET` (webhook mode only)
- `GITHUB_POLL_INTERVAL` (polling mode only)

## Test

```bash
pnpm test:github-polling --repo owner/repo --timeout 300 --poll 5 --close
```

## Notes

- Repo paths must exist on the host and be clean before a run.
- Each run creates a new branch and opens a PR when changes exist.
