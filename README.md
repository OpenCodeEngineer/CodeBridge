# Codex Bridge

Bridge Slack threads and GitHub issue comments to a local Codex CLI runner. Posts progress updates and can open PRs.

## Run (Local)

1. Copy `config/tenants.example.yaml` to `config/tenants.yaml` and set repo paths.
2. Start with SQLite + in‑memory queue:

```bash
export DATABASE_URL=sqlite://./data/codex-bridge.db
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
