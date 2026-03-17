# CodeBridge Design

## Design Intent

This design treats GitHub issue and PR conversation threads as the primary control plane for local agent execution, supports PR review comments as explicit command surfaces, and keeps discussion threads explicit as well. App-authored feedback and durable session state are represented by labels/comments where the surface supports them.

## Core Behavior

1. Bootstrap via issue assignment to an assignment trigger handle (native assignable actor, or configured `assignmentAssignees`), or via bootstrap mention (`@CodexEngineer ...`) on:
   - issue comments
   - PR conversation comments
   - PR review comments
   - discussion comments
   creates or resumes a run.
2. Issue and PR conversation threads are marked managed (`agent:managed`).
3. After that, plain human comments on the same managed issue or PR thread are interpreted as follow-up prompts.
4. PR review comments and discussion threads remain explicit-command surfaces; follow-up comments there still require mention/prefix.
5. Bridge executes the configured backend against the resolved local checkout and writes status/answers back to the originating GitHub thread.

## Routing Rules

### Command Interpretation

- Issue not managed:
  - accept assignment-trigger bootstrap
  - accept app mention or configured explicit command prefix
- Issue or PR thread managed:
  - treat any non-bot comment as a follow-up prompt
  - still allow explicit control verbs (`status`, `pause`, `resume`)
- PR review comment thread:
  - require explicit app mention or configured prefix on every command
  - accept `run`, `reply`, `status`, `pause`, and `resume`
  - post acknowledgements and final responses on the PR conversation thread
- Discussion thread:
  - require explicit app mention or configured prefix on every command
  - accept `run` and `reply`
  - answer `status`, `pause`, and `resume` with an unsupported-surface comment

### Tenant Resolution

1. `tenant:<id>` in comment text
2. existing session/issue binding
3. tenant mapped by repo in config

If resolution fails, post a bot error comment with valid tenant ids. Tenant resolution happens before session relay so explicit `tenant:<id>` hints are honored even on managed threads.

## GitHub Repo Resolution

For GitHub-originated events, CodeBridge does not inspect the process cwd or try to infer a repo from the machine state. The mapping is fully config-driven.

Resolution flow:

1. Read `installation.id` and `repository.full_name` from the GitHub webhook or polling payload.
2. Resolve the default tenant by exact `github.installationId` match.
3. If installation id is absent or no tenant matches, fall back to exact repo match on `repos[].fullName`.
4. If the command includes `tenant:<id>`, validate that the hinted tenant:
   - is GitHub-enabled,
   - is compatible with the same installation id when one is present,
   - contains the same `repository.full_name`,
   - and allows that repo through `github.repoAllowlist` when configured.
5. Resolve the repo within that tenant by exact `repos[].fullName` match.
6. Resolve the local checkout path from `repos[].path` and fail fast if the path is missing.

This means a mention on `owner/repo-a` will not be remapped to `owner/repo-b` through `defaultRepo`. `defaultRepo` is reserved for non-GitHub entrypoints that do not already carry a concrete GitHub repository identity.

Backend dispatch happens only after this repo resolution completes. The selected backend receives the resolved `repos[].path`; it does not infer a repository or worktree from the mention text, process cwd, or agent state.

## Agent Backend Selection

- `repos[].backend` selects the execution backend for that repo and defaults to `codex` when omitted.
- `repos[].agent` stores backend-specific agent metadata. It is currently forwarded to OpenCode sessions.
- Run records persist both `backend` and `agent` so status comments, commit messages, PR titles, and debugging reflect the chosen execution path.
- Current backend implementations:
  - `codex`: local Codex SDK thread started in the configured checkout
  - `opencode`: HTTP session created against the same configured checkout path

## Local Checkout Model

Current design decision: CodeBridge executes in the configured checkout path directly, regardless of backend.

- No automatic `git worktree add`
- No temporary clone per run
- No repo-path indirection beyond `repos[].path`
- No OpenCode-managed workspace/worktree creation in the current integration

Execution sequence:

1. Ensure `repo.path` exists.
2. Refuse to run if the checkout has uncommitted changes.
3. Fetch `origin`.
4. Create a new branch from the remote default branch.
5. Run the selected backend inside that checkout.
6. Commit, push, and open a PR from that same checkout.

Why this design exists:

- deterministic mapping from GitHub repo -> local path
- easier debugging because the worker operates in a known checkout
- simpler app-authored PR flow

Trade-off:

- concurrent runs against the same `repo.path` are not isolated from each other
- operators who need parallel isolated execution should provision separate local clones or dedicated worktrees and map them explicitly in config

## State Model

- Storage keeps run records and source-key dedupe.
- GitHub labels are source of truth for visible lifecycle on issues and PR conversation threads:
  - `agent:managed`
  - `agent:in-progress`
  - `agent:idle`
  - `agent:completed`
- Discussion threads do not receive lifecycle labels; status is represented only by comments.
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
                                  |     Local Agent Backend            |
                                  |  - Codex SDK or OpenCode REST     |
                                  |  - executes prompt in repo path   |
                                  |  - returns assistant response     |
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
[Human posts issue or PR comment]
          |
          v
[CodeBridge reads new comment]
          |
          +--> issue assigned to assignment trigger handle?
          |        |
          |        +--> yes => bootstrap run from issue title/body
          |
          +--> thread is NOT managed?
          |        |
          |        +--> require app mention/prefix
          |        |        |
          |        |        +--> no prefix => ignore
          |        |
          |        +--> yes prefix => bootstrap run
          |
          +--> thread IS managed?
                   |
                   +--> non-bot plain comment => follow-up reply

          |
          v
[Resolve tenant]
  priority: tenant:<id> > issue binding > repo default
          |
          v
[Create/Reuse run; dedupe by source key]
          |
          v
[Set labels: agent:managed + agent:in-progress when the surface supports labels]
          |
          v
[Execute selected backend against resolved repo path]
          |
          +--> progress/idle => update status comment + labels
          +--> emit optional mirror events (in-progress/idle/completed)
          |
          v
[Post assistant response comment on the originating thread]
          |
          v
[Set label: agent:completed]
```

## Minimal Implementation Plan

1. Parser: support both bootstrap mode and managed-issue conversational mode.
2. Lifecycle: ensure label transitions are idempotent.
3. Dedupe: keep source-key checks for polling/webhook/comment retries.
4. Error UX: post actionable issue comments for tenant/auth/config failures.
5. Tests: verify assignment bootstrap (or blocked precondition), issue mention, PR conversation mention, PR review comment mention, discussion mention, managed plain comment, tenant override, control verbs, and status transitions.
 - Discussion threads:
   - accept app mention bootstrap
   - require explicit mention/prefix for follow-up prompts
   - no issue-label lifecycle writes (discussions do not support issue labels)

## Recent Findings

Validated on March 17, 2026:

- The GitHub surface matrix should treat the PR case as part of the same test repo flow by default. `runGithubMentionE2ETest.ts` now reuses `--issue-repo` when `--pr-repo` is omitted.
- Live protocol validation passed on `dzianisv/codebridge-test` for assignment bootstrap, issue mention, PR conversation mention, and PR review comment mention.
- Discussion validation still needs a signed synthetic `discussion_comment` fallback on `VibeTechnologies/vibeteam-eval-hello-world` because the app lacks Discussions access there. Run creation is verified through persisted `sourceKey` evidence rather than an app-authored discussion status comment.
- PR review comment ingestion is now implemented in both webhook and polling paths. Review comments are explicit-command only and reuse the PR conversation thread for lifecycle/status feedback.
- Backend dispatch is now per repo config. `backend` defaults to `codex`; `opencode` uses the same installation/repo -> `repo.path` resolution before any HTTP call is made.
- OpenCode integration uses server health, session creation, async prompt submission, session-status polling, and message polling. If the terminal assistant message contains only tool output, CodeBridge requests a final text summary in the same session.
- Live OpenCode validation showed transient untracked artifacts such as `.reflection/`, `.tts/`, and `.tts-debug.log`. Dirty-check and commit staging now ignore those paths so PRs only include intended user changes.
