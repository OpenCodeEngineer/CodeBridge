# CodeBridge Design

## Design Intent

This design treats GitHub Issues as the control plane for local Codex execution, with app-authored feedback and durable session state represented by labels/comments.

## Core Behavior

1. Bootstrap via issue assignment to an assignment trigger handle (`app bot` if assignable, or configured `assignmentAssignees`), or via bootstrap mention (`@CodexEngineer ...`) on:
   - issue comments
   - PR conversation comments
   - discussion comments
   creates or resumes a run.
2. The issue is marked managed (`agent:managed`).
3. After that, plain human comments on the same issue are interpreted as follow-up prompts.
4. Bridge executes locally via Codex CLI and writes status/answers back to the issue.

## Routing Rules

### Command Interpretation

- Issue not managed:
  - accept assignment-trigger bootstrap
  - accept app mention or configured explicit command prefix
- Issue managed:
  - treat any non-bot comment as a follow-up prompt
  - still allow explicit control verbs (`status`, `pause`, `resume`)

### Tenant Resolution

1. `tenant:<id>` in comment text
2. existing session/issue binding
3. tenant mapped by repo in config

If resolution fails, post a bot error comment with valid tenant ids.

## State Model

- Storage keeps run records and source-key dedupe.
- GitHub labels are source of truth for visible issue lifecycle:
  - `agent:managed`
  - `agent:in-progress`
  - `agent:idle`
  - `agent:completed`
- Optional mirror sink emits lifecycle events to an external agent dashboard API (best-effort, no delivery guarantee).

## Architecture Diagram (ASCII)

```text
                         +-----------------------------+
                         |        GitHub Issues        |
                         |  (comments + labels + PR)   |
                         +-------------+---------------+
                                       ^
                                       | app-authored comments/labels
                                       |
                      poll/webhook     |
 +-------------------+   events   +----+----------------------------+
 | Human (web/mobile)|----------->|         CodeBridge              |
 | comment authoring |            |  - parser/router                |
 +-------------------+            |  - tenant resolver              |
                                  |  - dedupe + run state           |
                                  |  - GitHub app auth client       |
                                  +-----+----------------------+-----+
                                        |                      |
                                        | enqueue/dequeue      | notify mirror
                                        v                      v
                                  +-----+----------------------+------+
                                  |     Local Codex Runner (CLI)      |
                                  |  - executes prompt in repo path    |
                                  |  - returns assistant response      |
                                  +------------------------------------+
                                                         |
                                                         | HTTP lifecycle events (optional)
                                                         v
                                           +-------------------------------+
                                           | External Agent Dashboard/API  |
                                           | (e.g., Vibe agents backend)   |
                                           +-------------------------------+
```

## End-to-End Flow Diagram (ASCII)

```text
[Human posts issue comment]
          |
          v
[CodeBridge reads new comment]
          |
          +--> issue assigned to assignment trigger handle?
          |        |
          |        +--> yes => bootstrap run from issue title/body
          |
          +--> issue is NOT managed?
          |        |
          |        +--> require app mention/prefix
          |        |        |
          |        |        +--> no prefix => ignore
          |        |
          |        +--> yes prefix => bootstrap run
          |
          +--> issue IS managed?
                   |
                   +--> non-bot plain comment => follow-up run

          |
          v
[Resolve tenant]
  priority: tenant:<id> > issue binding > repo default
          |
          v
[Create/Reuse run; dedupe by source key]
          |
          v
[Set labels: agent:managed + agent:in-progress]
          |
          v
[Execute Codex locally]
          |
          +--> progress/idle => update status comment + labels
          +--> emit optional mirror events (in-progress/idle/completed)
          |
          v
[Post assistant response comment]
          |
          v
[Set label: agent:completed]
```

## Minimal Implementation Plan

1. Parser: support both bootstrap mode and managed-issue conversational mode.
2. Lifecycle: ensure label transitions are idempotent.
3. Dedupe: keep source-key checks for polling/webhook/comment retries.
4. Error UX: post actionable issue comments for tenant/auth/config failures.
5. Tests: verify assignment bootstrap (or blocked precondition), issue mention, PR mention, discussion mention, managed plain comment, tenant override, and status transitions.
 - Discussion threads:
   - accept app mention bootstrap
   - require explicit mention/prefix for follow-up prompts
   - no issue-label lifecycle writes (discussions do not support issue labels)
