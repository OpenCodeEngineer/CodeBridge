# OpenCode Backend Design

## Goal

Make CodeBridge backend-pluggable so a repo can run either:

- local Codex execution, or
- an OpenCode server over HTTP.

Codex remains the default when `repos[].backend` is omitted.

## Design Decision

CodeBridge keeps ownership of GitHub routing, tenant/repo resolution, status posting, and local branch preparation.

OpenCode is used as the execution backend over HTTP.

CodeBridge still prefers to own commit/push/PR creation when the checkout is dirty after the backend finishes. However, live validation showed two clean-checkout success modes that must not be downgraded to `no_changes`:

- OpenCode can finish the git/PR flow itself and return a GitHub PR URL.
- OpenCode can commit and even push the prepared branch itself, while leaving the checkout clean and omitting the PR URL.

The runner now treats a returned PR URL as authoritative success, and it also checks whether the prepared branch is ahead of the remote base branch before deciding the run had no changes.

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
7. if the checkout is dirty, commit, push, and open a PR from the same local checkout
8. if the checkout is already clean but the prepared branch is ahead of `origin/<base>`, push that branch, reuse an existing open PR for it if one already exists, otherwise create the PR
9. if the checkout is already clean and the assistant response contains a GitHub PR URL, persist that PR URL and mirror it back to the originating GitHub thread as the successful outcome

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
- model availability is still server-specific, but the live-eval path now defaults to `opencode/minimax-m2.5-free` because that provider/model completed a real repo mutation against `opencode serve` on March 18, 2026

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
- OpenCode can also create and open a PR itself before CodeBridge checks git status. CodeBridge still understands that fallback path for compatibility, but the preferred contract is that GitHub-originated runs leave PR creation to CodeBridge so the PR author remains the handling GitHub App identity.
- For GitHub-originated runs, the preferred contract is now stricter: the backend should avoid GitHub MCP/API/website writes and should not `git push`. It should leave local edits or local commits for CodeBridge to publish with the correct GitHub App identity.
- CodeBridge now enforces that contract at the transport layer for OpenCode by sending `tools.github=false` on GitHub-originated prompt requests. That blocks the server's configured GitHub MCP for those runs without changing the user's global OpenCode config.
- A March 18, 2026 live eval failure on `dzianisv/codebridge-test#536` showed another edge case: OpenCode committed and pushed branch `opencodeapp-guzqj7ve` without returning a PR URL, leaving the checkout clean while the branch was still ahead of `main` by one commit. The runner now checks branch-ahead state and recovers the PR flow instead of misclassifying that run as `no_changes`.
- Live runs produced transient untracked artifacts such as `.reflection/`, `.tts/`, and `.tts-debug.log`. CodeBridge now ignores those during dirty checks and unstages them before commit so PRs only include requested changes.
- Status polling can lag slightly behind the terminal assistant output. The adapter now tolerates status polling failures after a terminal assistant message has already been observed.
- A March 18, 2026 live-eval verification run showed that hardcoding `azure/gpt-4.1` in the temporary eval config was not portable across local OpenCode servers, and the default GitHub Copilot route could also stall behind global rate limits. The eval config now defaults the OpenCode route to `opencode/minimax-m2.5-free`, which completed a real repo mutation on the same day, and `CODEBRIDGE_EVAL_OPENCODE_MODEL` remains available as an explicit override.
- A March 18, 2026 hard-gate rerun also showed that asking the backend itself to open the PR can leak GitHub authorship to a local human credential. GitHub-originated prompts now instruct the backend to avoid GitHub writes and `git push`, leave the repo locally ready, and let CodeBridge publish the branch and final PR with the handling GitHub App installation token. CodeBridge also sends `tools.github=false` on those OpenCode prompt requests so the server cannot silently fall back to its local GitHub MCP.
- Another March 18, 2026 probe showed a specific adapter failure mode on the GitHub Copilot default route: OpenCode could leave an empty assistant placeholder and disappear from `/session/status` after a model-side failure. The adapter now fails fast on that empty-placeholder stall instead of burning the full turn timeout.
- Customer-flow rerun evidence after the backend-created-PR fix:
  - issue: `dzianisv/codebridge-test#524`
  - run id: `ZkkIiFQf`
  - final status comment: `PR: https://github.com/dzianisv/codebridge-test/pull/525`
  - resulting PR: `dzianisv/codebridge-test#525`
- Rejected distinct-app proof attempt:
  - issue: `dzianisv/codebridge-test#543`
  - run id: `g_uIe3gt`
  - resulting PR: `dzianisv/codebridge-test#544`
  - this remained route/backend proof only because the final GitHub author was still `codexengineer[bot]`
- Passing distinct-app hard-gate proof:
  - issue: `dzianisv/codebridge-test#560`
  - run id: `pguKDmKk`
  - final status comment includes the PR URL plus command results for `bun test` and `bun run src/main.ts`
  - resulting PR: `dzianisv/codebridge-test#561`
  - final issue-thread bot author: `opencodebridgeapp[bot]`
  - PR author: `app/opencodebridgeapp`
  - persisted result: `status=succeeded`, `backend=opencode`, `github_app_key=opencode`, `pr_url=https://github.com/dzianisv/codebridge-test/pull/561`

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
