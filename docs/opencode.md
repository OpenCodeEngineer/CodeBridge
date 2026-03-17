# OpenCode Backend Design

## Goal

Make CodeBridge backend-pluggable so a repo can run either:

- local Codex execution, or
- an OpenCode server over HTTP.

Codex remains the default when `repos[].backend` is omitted.

## Design Decision

CodeBridge keeps ownership of GitHub routing, local repo selection, branch creation, commits, pushes, and PR creation.

OpenCode is used only as the agent execution backend.

That means a GitHub issue assignment or mention is mapped like this:

1. GitHub installation id -> tenant
2. GitHub `owner/repo` -> `repos[].fullName`
3. configured local checkout -> `repos[].path`
4. selected backend -> `repos[].backend`

The backend never chooses the repo. It receives the already-resolved local checkout path.

## Why This Shape

- GitHub-originated events already carry exact repo identity, so repo resolution should stay in CodeBridge.
- CodeBridge already owns the git lifecycle around each run.
- OpenCode exposes a documented HTTP API, so integration is simpler and more observable than shelling out.
- Keeping repo mapping in one place avoids ambiguity when the same server can see multiple local repos.

## Runtime Flow

For a repo configured with `backend: opencode`, the runner does this:

1. resolve the local checkout from tenant config
2. verify the checkout is clean
3. fetch `origin`
4. create a fresh branch from the remote default branch
5. call the OpenCode server using the resolved checkout path
6. wait for the assistant to finish
7. commit, push, and open a PR from the same local checkout

The current integration does not ask OpenCode to create or manage worktrees. CodeBridge continues to use the configured checkout path directly.

## OpenCode API Usage

Current adapter flow in `src/opencode.ts`:

- `GET /global/health`
  - verify the server is reachable before starting a run
- `POST /session`
  - create a session with a human-readable title
- `POST /session/:id/prompt_async`
  - submit the prompt, optional backend `agent`, and optional `model`
- `GET /session/status`
  - poll session state until the session is idle or terminal
- `GET /session/:id/message`
  - read assistant output and stream progress into CodeBridge status updates
- `POST /session/:id/message`
  - fallback summary request when the terminal assistant response contains only tool output

Directory scoping:

- every non-global OpenCode request is scoped to the resolved checkout path
- the current adapter sends both the documented `directory` query parameter and the compatibility header `x-opencode-directory`
- OpenCode runs against that directory instead of trying to infer project state from the caller environment

Authentication:

- optional HTTP basic auth using `integrations.opencode.username`
- password can come from `integrations.opencode.password` or `secrets.opencodePassword`

## Config Model

Repo-level selection:

```yaml
tenants:
  - id: local
    repos:
      - fullName: "owner/repo"
        path: "/absolute/path/to/local/checkout"
        backend: "opencode"
        agent: "build"
        model: "openai/gpt-5"
        branchPrefix: "opencode"
```

Global OpenCode integration:

```yaml
secrets:
  opencodePassword: "optional-password"

integrations:
  opencode:
    baseUrl: "http://127.0.0.1:4096"
    username: "opencode"
    enabled: true
    timeoutMs: 300000
    pollIntervalMs: 2000
```

Environment overrides:

- `OPENCODE_BASE_URL`
- `OPENCODE_USERNAME`
- `OPENCODE_PASSWORD`
- `OPENCODE_ENABLED`
- `OPENCODE_TIMEOUT_MS`
- `OPENCODE_POLL_INTERVAL_MS`

Important constraints:

- `backend` currently supports `codex` and `opencode`
- `backend` defaults to `codex`
- `agent` is backend-specific metadata and is currently used by OpenCode
- OpenCode `model` values must use `provider/model` format

## Persistence And UX

Run records now persist:

- `backend`
- `agent`

That metadata feeds:

- status headers such as `OpenCode run ...`
- branch prefixes when `branchPrefix` is not explicitly configured
- commit messages such as `opencode: issue 123`
- PR titles such as `OpenCode: <issue title>`

## Findings From Live Validation

Validated on March 17, 2026:

- The OpenCode server was healthy and reachable over HTTP.
- The adapter successfully created a session, delegated a repo mutation, and collected the assistant response.
- OpenCode can complete a task with tool-only terminal output. CodeBridge now issues a summary follow-up in the same session when that happens so GitHub still gets a human-readable final message.
- Live runs produced transient untracked artifacts such as `.reflection/`, `.tts/`, and `.tts-debug.log`. CodeBridge now ignores those during dirty checks and unstages them before commit so PRs only include requested changes.
- Status polling can lag slightly behind the terminal assistant output. The adapter now tolerates status polling failures after a terminal assistant message has already been observed.

## Tradeoffs

Benefits:

- simpler transport than shelling out to another CLI
- backend choice becomes per-repo config
- easier observability because requests and responses are structured

Tradeoffs:

- CodeBridge still uses one mutable checkout per configured `repo.path`
- concurrent runs on the same checkout are still not isolated
- the current integration intentionally does not use OpenCode worktree/workspace APIs

## Future Work

- optional isolated execution using separate configured clones or worktrees per repo
- optional OpenCode worktree API usage once CodeBridge has a clear ownership model for worktree lifecycle
- richer mapping of OpenCode parts into GitHub progress comments
