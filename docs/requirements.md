# CodeBridge Requirements

## Problem Statement

Local coding agents are hard to coordinate from terminal-only interfaces. The requirement is to use GitHub Issues as a native control plane so a human can operate Codex sessions from GitHub web/mobile without switching to local terminals.

## Primary Goal

Make GitHub Issues behave like a chat surface with Codex:

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
  - discussion comments
  - Example: `@CodexEngineer investigate flaky CI in this repo`
- The bootstrap action must be treated as a run request without requiring CLI access.
- If repository/org policy does not allow assigning the App bot as assignee, mention-based bootstrap is the required fallback.

### R2. Conversational Mode After Bootstrap

- Once an issue is marked as agent-managed, plain human comments on that issue are treated as follow-up prompts.
- Follow-up comments must not require command prefixes (`codex:`, `/codex`, etc.).
- Mentioning the app remains allowed but optional after bootstrap.

### R3. Tenant Targeting

- A tenant can be targeted explicitly in comment text:
  - `tenant:<tenant-id>` (example: `tenant:local`)
- Tenant selection precedence:
  1. explicit tenant hint in comment
  2. existing issue/session binding
  3. repo-to-tenant default mapping
- If no valid tenant can be resolved, bridge must post an actionable error comment.

### R4. Issue Association

- If the prompt references an issue (`#123`, `owner/repo#123`, or GitHub URL), that issue is used.
- If no issue is referenced and the run starts from non-issue entrypoints, bridge auto-creates an issue and binds the session.

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
  - user prompt comment (if not already mirrored for the turn)
  - assistant response comment
- Bridge must avoid duplicate comments for the same turn.

### R7. Identity

- Replies on GitHub must be authored by the GitHub App bot identity (not a personal user token identity).

### R9. Test Protocol Coverage

- Bridge must provide a repeatable protocol that tests:
  - assignment-to-app-handle bootstrap
  - mention bootstrap in issue comment
  - mention bootstrap in PR conversation comment
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

- A user can open GitHub Issue UI and interact with Codex as if chatting with a user.
- First interaction uses assignment-to-app or app mention; later messages on the managed issue can be plain text.
- `tenant:<id>` reliably routes commands to the desired tenant.
- Issue labels reflect run state transitions.
- Assistant responses are posted by the app bot account.
