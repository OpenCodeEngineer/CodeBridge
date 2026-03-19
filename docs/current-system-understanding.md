# Current System Understanding

This document separates:

- the target product architecture
- the current implementation shape
- the implementation details that matter for testing and further work

It is not just:

- GitHub comment in
- agent reply out

It is:

- GitHub as the control plane
- local checkout as the execution substrate
- GitHub App identity as the user-visible trust boundary
- CodeBridge as the router, state manager, and publisher
- evaluation as a proof system over real GitHub artifacts

## Target Product Architecture

At the repo lifecycle layer, the intended product architecture is:

```text
GitHub event
  -> resolve owner/repo + app identity
  -> ensure base clone exists under ~/workspace
  -> create isolated per-task worktree
  -> hand that worktree to Codex or OpenCode
  -> publish result back to GitHub as the same app
```

That means the backend should never mutate a long-lived shared checkout directly for GitHub-originated runs.

## Architecture Diagram

```mermaid
flowchart TD
    Human["Human operator<br/>web / mobile / GitHub UI"]

    subgraph GitHub["GitHub surfaces"]
      Assign["Issue assignment"]
      Issue["Issue comment"]
      PRConv["PR conversation comment"]
      PRReview["PR review comment"]
      Disc["Discussion comment"]
      Labels["Lifecycle labels<br/>managed / in-progress / idle / completed"]
      PR["Pull request"]
    end

    subgraph CodeBridge["CodeBridge"]
      Ingest["Ingress<br/>webhooks per appKey + pollers per appKey"]
      Route["Command routing<br/>bootstrap vs follow-up vs control verbs"]
      Identity["Real app identity check<br/>exact @app-slug, not alias text"]
      Resolve["Tenant + repo resolution<br/>installationId + owner/repo -> base clone"]
      RunSvc["Run service<br/>create run, source-key dedupe, post initial status"]
      Store[("Run store<br/>runs / events / poll state")]
      Queue["Queue<br/>memory or BullMQ"]
      Worker["Worker"]
      Backend{"Selected backend"}
      Worktree["Worktree manager<br/>ensure clone + create task worktree"]
      Codex["Codex backend<br/>local Codex thread in task worktree"]
      OpenCode["OpenCode backend<br/>HTTP session against task worktree"]
      GitOps["Git operations<br/>fetch, worktree, commit, push, PR"]
      Publish["GitHub publishing<br/>app-authored comments, labels, PR links"]
    end

    subgraph Local["Local execution substrate"]
      Repo["Base clone under<br/>$HOME/workspace"]
      TaskTree["Per-task worktree"]
    end

    subgraph Eval["Hard-gate evaluation"]
      EvalCodex["Post real @codex app command"]
      EvalOpen["Post real @opencode app command"]
      Collect["Collect evidence<br/>issue URLs, bot comment URLs, PR URL, DB status"]
      Judge["Judge collected evidence<br/>Promptfoo + model"]
    end

    Human --> Assign
    Human --> Issue
    Human --> PRConv
    Human --> PRReview
    Human --> Disc

    Assign --> Ingest
    Issue --> Ingest
    PRConv --> Ingest
    PRReview --> Ingest
    Disc --> Ingest

    Ingest --> Route --> Identity --> Resolve --> Worktree --> RunSvc
    RunSvc --> Store
    RunSvc --> Queue --> Worker --> Backend
    Store --> Worker

    Resolve --> Repo
    Repo --> Worktree --> TaskTree
    Backend -->|codex| Codex --> TaskTree
    Backend -->|opencode| OpenCode --> TaskTree

    TaskTree --> GitOps --> Publish
    Publish --> Issue
    Publish --> PRConv
    Publish --> Disc
    Publish --> Labels
    Publish --> PR

    EvalCodex --> Issue
    EvalOpen --> Issue
    Issue --> Collect
    PR --> Collect
    Store --> Collect
    Collect --> Judge
```

## Routing Semantics

```mermaid
flowchart TD
    C["Incoming GitHub event"] --> S{"Surface?"}

    S -->|Issue / PR conversation| T1{"Managed thread?"}
    S -->|PR review comment| T2["Always explicit command<br/>exact real @app-slug required"]
    S -->|Discussion comment| T3["Always explicit command<br/>exact real @app-slug required"]
    S -->|Assignment| T4["Bootstrap from assignment trigger"]

    T1 -->|No| B1["Bootstrap only<br/>exact real @app-slug required"]
    T1 -->|Yes| B2{"Comment mentions another app?"}

    B2 -->|No| F1["Plain human comment becomes follow-up<br/>only for app that owns latest run"]
    B2 -->|Yes| F2["Start new run under newly mentioned app"]
```

## Critical Product Invariants

- GitHub is the control plane, not just a notification sink.
- The GitHub repo itself must be enough to discover or create the local execution substrate.
- GitHub-originated runs should execute in isolated task worktrees, not a shared mutable checkout.
- The app that ingests a command is the same app that must publish status, labels, replies, and PRs.
- Real handle means exact `@<app-slug>` resolved from the GitHub App identity.
- Distinct `appKey` values are not enough; Codex and OpenCode must also have distinct GitHub App identities.
- OpenCode and Codex are backend implementations behind the same run lifecycle, not separate products.
- The hard gate is not satisfied by a success comment. It is satisfied by real GitHub artifacts plus persisted run state plus executable verification.

## Where I Previously Went Wrong

I collapsed two different things into one:

1. product proof
2. operator summary

The operator-authored status comment on `CodeBridge#7` was only a summary.
The actual proof was the app-authored bot comments and PR in `codebridge-test`.

That distinction is part of the product:

- CodeBridge emits app-authored evidence
- humans may summarize that evidence
- summaries are never the same thing as proof

That is the error I made, and it is exactly the kind of bullshit solution you do not want.

## Concrete Repo/Worktree Model

The intended and current GitHub repo lifecycle are now aligned here:

```text
GitHub repo -> ensure clone in ~/workspace -> create task worktree -> run backend there
```

Current implementation details:

- base clone discovery is filesystem-driven under `$HOME/workspace`
- preferred base clone path is `~/workspace/<repo-name>`
- occupied-name fallback path is `~/workspace/<owner>__<repo-name>`
- per-task worktrees live under `~/workspace/.codebridge/worktrees/<owner>__<repo-name>/<run-id>`
- `repos[].path` is optional and only required for non-GitHub entrypoints
- managed-thread relay now reuses the stored run worktree path instead of assuming a fixed configured checkout
