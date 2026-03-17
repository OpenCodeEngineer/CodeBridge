# CodeBridge Requirements

## Problem Statement

Local coding agents are hard to coordinate from terminal-only interfaces. The requirement is to use GitHub Issues as a native control plane so a human can operate CodeBridge-managed agent sessions from GitHub web/mobile without switching to local terminals.

## Primary Goal

Make GitHub issue and PR conversation threads behave like a chat surface with the configured coding agent backend, while keeping PR review comments and discussions explicit:

- bootstrap once using a native app mention
- continue conversation using plain human comments
- keep issue labels/comments as the single visible session state

## User-Facing Requirements

### R1. Native Bootstrap on GitHub

- A human can start an agent run by assigning the issue to an assignment trigger handle:
  - GitHub App bot account (if assignable in that repo), or
  - one of `github.assignmentAssignees` configured for the tenant.
- A human can also start a run by mentioning the GitHub App in:
  - issue comments
  - PR conversation comments
  - PR review comments
  - discussion comments
  - Example: `@CodexEngineer investigate flaky CI in this repo`
- The bootstrap action must be treated as a run request without requiring CLI access.
- If repository/org policy does not allow assigning the App bot as assignee, mention-based bootstrap is the required fallback.

### R2. Conversational Mode After Bootstrap

- Once an issue or PR conversation thread is marked as agent-managed, plain human comments on that managed thread are treated as follow-up prompts.
- Follow-up comments must not require command prefixes (`codex:`, `/codex`, etc.).
- Mentioning the app remains allowed but optional after bootstrap.
- PR review comments remain explicit-command only: each follow-up must still mention the app or use a configured prefix, and responses are written back to the PR conversation thread.
- Discussion follow-up remains explicit-command only: each follow-up must still mention the app or use a configured prefix.
- Explicit `status`, `pause`, and `resume` commands must work on managed issue and PR conversation threads without being misrouted as normal follow-up text.
- Explicit `status`, `pause`, and `resume` commands must also work from PR review comments when explicitly prefixed.
- On discussions, `status`, `pause`, and `resume` must return an unsupported-surface message rather than silently doing nothing.

### R3. Tenant Targeting

- A tenant can be targeted explicitly in comment text:
  - `tenant:<tenant-id>` (example: `tenant:local`)
- Tenant selection precedence:
  1. explicit tenant hint in comment
  2. existing issue/session binding
  3. repo-to-tenant default mapping
- If no valid tenant can be resolved, bridge must post an actionable error comment.
- For GitHub-originated commands, repo selection inside the chosen tenant must use exact `repository.full_name` matching against `repos[].fullName`.
- `defaultRepo` must not remap one GitHub repository event onto a different configured repository.
- The configured local `repos[].path` must exist before a run is enqueued; otherwise the bridge must fail fast with actionable diagnostics.
- Repo backend selection is per configured repo:
  - `repos[].backend` chooses the execution backend and defaults to `codex`
  - `repos[].agent` stores backend-specific agent selection
  - backend integrations receive the resolved `repos[].path`; they do not infer a repo or worktree from the GitHub mention, process cwd, or agent state

### R4. Issue Association

- If the prompt references an issue (`#123`, `owner/repo#123`, or GitHub URL), that issue is used when the entrypoint supports issue association.
- If no issue is referenced and the run starts from non-GitHub entrypoints (for example Slack or `/codex/notify`), bridge auto-creates an issue and binds the session.
- GitHub-originated issue, PR, and discussion commands stay bound to their source thread; they do not auto-create a secondary issue today.

### R5. Status Lifecycle on Issue

- Bridge maintains labels:
  - `agent:managed`
  - `agent:in-progress`
  - `agent:idle`
  - `agent:completed`
- Status transitions:
  - new/active work => `agent:in-progress`
  - waiting/no active execution => `agent:idle`
  - run turn finished successfully => `agent:completed`

### R6. Comment Mirroring

- For each processed user turn, bridge must post:
  - user prompt comment (if not already present on that surface for the turn)
  - assistant response comment
- Bridge must avoid duplicate comments for the same turn.

### R7. Identity

- Replies on GitHub must be authored by the GitHub App bot identity (not a personal user token identity).

### R9. Test Protocol Coverage

- Bridge must provide a repeatable protocol that tests:
  - assignment-to-app-handle bootstrap
  - mention bootstrap in issue comment
  - mention bootstrap in PR conversation comment
  - mention bootstrap in PR review comment
  - mention bootstrap in discussion comment
- If a case cannot run due GitHub platform prerequisites (for example app assignability or missing app Discussion permissions), result must be reported as `blocked` with actionable reason.

### R8. Optional External Agent Dashboard Mirror

- Bridge can optionally emit run lifecycle events to an external dashboard endpoint (for example Vibe agents backend).
- Event emission must be non-blocking:
  - failures in mirror delivery must not break GitHub issue orchestration.
- Minimum mirrored lifecycle states:
  - session created
  - in-progress
  - idle (failure/waiting)
  - completed

## Non-Goals (Current Scope)

- No Slack/Jira/Trello orchestration in this phase.
- No webhook dependency for localhost-only operation (polling path must remain supported).
- No advanced pause/resume execution control beyond simple acknowledgment.

## Acceptance Criteria

- A user can open GitHub Issue UI and interact with the configured coding agent backend as if chatting with a user.
- First interaction uses assignment-to-app or app mention; later messages on the managed issue or PR conversation thread can be plain text.
- Discussion follow-up remains explicit mention/prefix based.
- `tenant:<id>` reliably routes commands to the desired tenant.
- Backend selection is deterministic per configured repo and still uses the exact configured local checkout path.
- Issue labels reflect run state transitions.
- Assistant responses are posted by the app bot account.
