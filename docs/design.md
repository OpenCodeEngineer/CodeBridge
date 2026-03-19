# CodeBridge Design

## Design Intent

This design treats GitHub issue and PR conversation threads as the primary control plane for local agent execution, supports PR review comments as explicit command surfaces, and keeps discussion threads explicit as well. App-authored feedback and durable session state are represented by labels/comments where the surface supports them.

## Product Source Of Truth

For GitHub-originated runs, the intended product flow is:

1. User creates an issue or comment on GitHub.
2. User explicitly addresses the installed GitHub App by its real handle.
3. CodeBridge resolves the GitHub repository identity from the event payload.
4. CodeBridge ensures a base clone exists under `$HOME/workspace`.
   - if the repo is missing locally, clone it
   - if the repo already exists, fetch/update it
5. CodeBridge creates an isolated per-task git worktree.
6. CodeBridge delegates that isolated worktree path to the selected backend.
7. Backend works only inside that worktree.
8. CodeBridge publishes the result back to the originating GitHub thread using the same GitHub App identity that handled the run.
9. For implementation tasks, the default expectation is usually a PR, but the issue instructions still decide whether a PR is required for that run.

That model is now implemented for GitHub-originated runs.
Non-GitHub entrypoints can still use `repos[].path` directly when no GitHub repo identity is present.

## Core Behavior

1. Bootstrap via issue assignment to an assignment trigger handle (native assignable actor, or configured `assignmentAssignees`), or via bootstrap mention to one of the configured GitHub Apps (`@<real-codex-app-slug> ...`, `@<real-opencode-app-slug> ...`) on:
   - issue comments
   - PR conversation comments
   - PR review comments
   - discussion comments
   creates or resumes a run.
2. Issue and PR conversation threads are marked managed (`agent:managed`).
3. After that, plain human comments on the same managed issue or PR thread are interpreted as follow-up prompts only for the app that owns the latest run on that thread.
4. PR review comments and discussion threads remain explicit-command surfaces; follow-up comments there still require the exact app slug handle.
5. Bridge executes the configured backend against the resolved local task worktree and writes status/answers back to the originating GitHub thread.

For GitHub comment routing, "real handle" means the exact `@<app-slug>` token resolved from the GitHub App identity (`GET /app`), not an arbitrary configured alias. GitHub currently renders GitHub App slug tokens as plain text in issue/PR/discussion comment HTML instead of `<a class="user-mention">` links, so validity is defined by exact slug match plus matching app-authored response and `performed_via_github_app` evidence, not by UI highlighting. If GitHub App identity resolution is temporarily unavailable, CodeBridge now ignores the command instead of widening routing to configured aliases.

## Routing Rules

### Command Interpretation

- Issue not managed:
  - accept assignment-trigger bootstrap
  - accept exact real GitHub App slug mention only
- Issue or PR thread managed:
  - treat any non-bot comment as a follow-up prompt
  - still allow explicit control verbs (`status`, `pause`, `resume`)
- PR review comment thread:
  - require explicit exact real GitHub App slug mention on every command
  - accept `run`, `reply`, `status`, `pause`, and `resume`
  - post acknowledgements and final responses on the PR conversation thread
- Discussion thread:
  - require explicit exact real GitHub App slug mention on every command
  - accept `run` and `reply`
  - answer `status`, `pause`, and `resume` with an unsupported-surface comment

### Tenant Resolution

1. `tenant:<id>` in comment text
2. existing session/issue binding
3. tenant mapped by repo in config

If resolution fails, post a bot error comment with valid tenant ids. Tenant resolution happens before session relay so explicit `tenant:<id>` hints are honored even on managed threads.

## GitHub Repo Resolution

For GitHub-originated events, CodeBridge should not inspect the process cwd or infer a repo from agent state. It should resolve the GitHub repository from the event payload, then own local clone/worktree lifecycle under `$HOME/workspace`.

Resolution flow:

1. Read `installation.id` and `repository.full_name` from the GitHub webhook or polling payload.
2. Resolve the default tenant by exact `github.apps[].appKey + installationId` match.
3. If installation id is absent or no tenant matches, fall back to exact repo match on `repos[].fullName`.
4. If the command includes `tenant:<id>`, validate that the hinted tenant:
   - is GitHub-enabled,
   - is compatible with the same installation id when one is present,
   - contains the same `repository.full_name`,
   - and allows that repo through `github.repoAllowlist` when configured.
5. Resolve the repo within that tenant by exact `repos[].fullName` match.
6. Derive or discover the base clone path under `$HOME/workspace`.
7. If the base clone is missing, clone it.
8. If the base clone exists, fetch/update it.
9. Create an isolated worktree for the specific task.
10. Pass that worktree path to the selected backend.

This means a mention on `owner/repo-a` will not be remapped to `owner/repo-b` through `defaultRepo`. `defaultRepo` is reserved for non-GitHub entrypoints that do not already carry a concrete GitHub repository identity.

Backend dispatch happens only after this repo resolution completes. The selected backend should receive the resolved worktree path; it must not infer a repository or worktree from the mention text, process cwd, or agent state.

## Multi-App GitHub Identity

- GitHub App credentials are now keyed under `secrets.githubApps.<appKey>`.
- Tenants bind installations per app under `github.apps[]`.
- Repos can override backend/agent/model/branch settings per app with `repos[].githubApps.<appKey>`.
- Webhook paths are app-specific: `/github/webhook/<appKey>`.
- Poll state is app-specific to avoid collisions when the same repo is watched by multiple apps.
- Run records persist `github.appKey`, and all outbound GitHub writes reuse that same app identity.
- Explicit mention of a second app on a managed thread starts a new run for that app instead of relaying into the prior app’s session.
- `assignmentAssignees` are assignment/bootstrap aids only. They must not widen the accepted comment mention prefixes on GitHub surfaces.
- Configured `commandPrefixes` no longer act as GitHub comment-routing fallbacks. The resolved live app slug is the only accepted GitHub comment handle.

## Agent Backend Selection

- `repos[].backend` selects the execution backend for that repo and defaults to `codex` when omitted.
- `repos[].agent` stores backend-specific agent metadata. It is currently forwarded to OpenCode sessions.
- Run records persist both `backend` and `agent` so status comments, commit messages, PR titles, and debugging reflect the chosen execution path.
- Current backend implementations:
  - `codex`: local Codex SDK thread started in the resolved task worktree
  - `opencode`: HTTP session created against the same resolved task worktree

## Local Checkout Model

Target design decision: GitHub-originated runs should execute in an isolated git worktree created by CodeBridge from a base clone under `$HOME/workspace`.

Target execution sequence:

1. Ensure the base clone for `owner/repo` exists under `$HOME/workspace`.
2. Refuse to mutate the base clone directly during a task run.
3. Fetch `origin` in the base clone.
4. Create a new per-task worktree from the remote default branch.
5. Run the selected backend inside that worktree only.
6. Commit, push, and open a PR from that task worktree when the task requires code changes.
7. Reuse the base clone for future tasks, but never reuse the task worktree for another run.

Why this design exists:

- the GitHub repo itself should be enough to discover local execution state
- tasks must be isolated from each other
- backends should receive a fresh worktree, not a shared mutable checkout
- it removes the need to preconfigure a fixed local path for every GitHub repo

Current implementation details:

- GitHub-originated runs now resolve a base clone under `$HOME/workspace`
- the preferred base clone path is `$HOME/workspace/<repo-name>`
- if that path is already occupied by another repo, CodeBridge falls back to `$HOME/workspace/<owner>__<repo-name>`
- per-task worktrees live under `$HOME/workspace/.codebridge/worktrees/<owner>__<repo-name>/<run-id>`
- `repos[].path` is now optional and is only required for entrypoints that do not already carry GitHub repo identity
- managed-session relay reuses the stored run worktree path instead of assuming a static configured checkout

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
                                  |  - executes prompt in task worktree|
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
          |        +--> require exact app slug mention
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
[Resolve GitHub repo -> ensure base clone -> create task worktree]
          |
          v
[Create/Reuse run; dedupe by source key]
          |
          v
[Set labels: agent:managed + agent:in-progress when the surface supports labels]
          |
          v
[Execute selected backend against isolated task worktree]
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
   - require explicit exact app slug mention for follow-up prompts
   - no issue-label lifecycle writes (discussions do not support issue labels)

## Recent Findings

Validated on March 17, 2026:

- The GitHub surface matrix should treat the PR case as part of the same test repo flow by default. `runGithubMentionE2ETest.ts` now reuses `--issue-repo` when `--pr-repo` is omitted.
- Multi-app routing now supports concurrent `codex` and `opencode` GitHub Apps against the same repository. App identity is part of webhook routing, poll high-water marks, run persistence, and managed-thread ownership checks.
- Live protocol validation passed on `dzianisv/codebridge-test` for assignment bootstrap, issue mention, PR conversation mention, and PR review comment mention.
- Discussion validation still needs a signed synthetic `discussion_comment` fallback on `VibeTechnologies/vibeteam-eval-hello-world` because the app lacks Discussions access there. Run creation is verified through persisted `sourceKey` evidence rather than an app-authored discussion status comment.
- PR review comment ingestion is now implemented in both webhook and polling paths. Review comments are explicit-command only and reuse the PR conversation thread for lifecycle/status feedback.
- Backend dispatch is per repo config. `backend` defaults to `codex`; `opencode` uses the same installation/repo resolution before any HTTP call is made.
- OpenCode integration uses server health, session creation, async prompt submission, session-status polling, and message polling. If the terminal assistant message contains only tool output, CodeBridge requests a final text summary in the same session.
- Live OpenCode validation showed transient untracked artifacts such as `.reflection/`, `.tts/`, and `.tts-debug.log`. Dirty-check and commit staging now ignore those paths so PRs only include intended user changes.
- GitHub-originated runs now follow the intended repo/worktree lifecycle: clone-on-demand under `$HOME/workspace` plus isolated per-task worktrees.
