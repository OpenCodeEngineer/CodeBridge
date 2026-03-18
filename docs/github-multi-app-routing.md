# GitHub Multi-App Routing

## Goal

Support more than one GitHub App against the same CodeBridge deployment and the same GitHub repository at the same time.

Initial customer-facing target:

- mention `@<real-codex-app-slug>` -> run backend `codex`
- mention `@<real-opencode-app-slug>` -> run backend `opencode`
- both apps can watch the same repository concurrently
- the app that ingests the command is also the app that posts status, labels, and PRs for that run

The bootstrap mention must be the real installed GitHub App handle.
Do not rely on arbitrary text aliases for issue bootstrap.
In this design, "real handle" means the exact `@<app-slug>` resolved from the GitHub App identity. GitHub may render that token as plain text instead of an inline mention link in the comment body, so CodeBridge validates exact slug text plus matching app authorship rather than UI highlighting.

## Config Shape

CodeBridge now uses three separate layers:

1. global GitHub App registry
2. tenant app bindings
3. optional repo app overrides

### 1. Global app registry

```yaml
secrets:
  githubApps:
    codex:
      appId: 123456
      privateKey: "..."
      webhookSecret: "..."
      commandPrefixes:
        - "real-codex-app-slug"
    opencode:
      appId: 234567
      privateKey: "..."
      webhookSecret: "..."
      commandPrefixes:
        - "real-opencode-app-slug"
```

Each key is an internal CodeBridge `appKey`, not a GitHub installation id.

### 2. Tenant app bindings

```yaml
tenants:
  - id: local
    github:
      apps:
        - appKey: codex
          installationId: 111111
          repoAllowlist:
            - owner/repo
        - appKey: opencode
          installationId: 222222
          repoAllowlist:
            - owner/repo
```

This is where a tenant says which GitHub App installations it accepts.

### 3. Repo app overrides

```yaml
repos:
  - fullName: owner/repo
    path: /absolute/path/to/checkout
    backend: codex
    githubApps:
      opencode:
        backend: opencode
        agent: build
        model: openai/gpt-5
```

Base repo settings remain the default route. An app override only needs to specify what differs.

## Runtime Rules

### Webhooks

- Each GitHub App is mounted on its own webhook path:
  - `/github/webhook/codex`
  - `/github/webhook/opencode`
- Incoming event handling is scoped to that app key.
- Comment-trigger routing accepts only the exact GitHub App slug-derived mention when the app identity can be resolved.
- Configured `commandPrefixes` are fallback-only for degraded cases where GitHub App identity resolution is unavailable, and they must still equal the real slug.
- `assignmentAssignees` apply to assignment bootstrap only; they do not widen accepted GitHub comment prefixes.

### Polling

- Polling loops over every configured app key and every tenant binding for that app.
- Poll state keys are namespaced by app key to avoid collisions:
  - `owner/repo#app:codex`
  - `owner/repo#app:opencode`
  - `owner/repo#app:opencode#discussion`
  - `owner/repo#app:codex#pr-review`

### Managed-thread follow-ups

- Plain follow-up comments on a managed issue/PR thread are accepted only by the app that owns the latest run on that thread.
- Explicit mention of another app on the same managed thread does not relay into the old session; it creates a new run under the newly mentioned app.

### Outbound writes

Run records now persist `github.appKey`.

That field is used for:

- initial status comment
- lifecycle label updates
- discussion responses
- PR creation
- Codex notify session binding recovery

Without that persisted app identity, multi-app mode would ingest correctly but reply using the wrong GitHub App.

### Identity requirement

Multi-app support is not satisfied by routing alone.

For customer-facing proof, CodeBridge must show:

- the correct real mention handle for each app,
- the correct real bot author for each app,
- distinct GitHub App identities for `codex` and `opencode`.

If two app keys share one GitHub App slug or bot login, the hard-gate evaluator must fail.

### Backend-created PR recovery

Multi-app routing also needs the finalization path to respect backend-specific behavior.

OpenCode can finish a run by opening a GitHub PR itself and returning that PR URL in the final assistant message. When that happens, the local checkout may already be clean by the time CodeBridge inspects git status.

The runner now detects a GitHub PR URL in the backend response and finalizes the run as `succeeded` with that PR URL instead of incorrectly reporting `no_changes`.

This matters in multi-app mode because the app that handled the run must still post the final success summary and PR link back to the originating thread, even when CodeBridge did not create the PR itself.

## Compatibility

Legacy single-app config still works.

CodeBridge normalizes:

- `secrets.githubAppId/githubPrivateKey/githubWebhookSecret` -> `secrets.githubApps.default`
- `tenant.github.installationId` -> `tenant.github.apps[appKey=default]`

This keeps existing deployments working while allowing a gradual move to named app keys.

## Historical Validation Notes

- March 17, 2026 route/backend validation:
  - issue `dzianisv/codebridge-test#518`
  - resulting PR `dzianisv/codebridge-test#519`
  - persisted run status `succeeded` with `github_app_key=codex`
- March 17, 2026 OpenCode route after backend-created-PR fix:
  - issue `dzianisv/codebridge-test#524`
  - resulting PR `dzianisv/codebridge-test#525`
  - persisted run `ZkkIiFQf` with status `succeeded`, `backend=opencode`, `github_app_key=opencode`, and `pr_url=https://github.com/dzianisv/codebridge-test/pull/525`
- March 18, 2026 distinct-app hard-gate proof:
  - Codex issue flow `dzianisv/codebridge-test#559`
  - OpenCode issue-to-PR flow `dzianisv/codebridge-test#560` -> `#561`
  - reply authors `codexengineer[bot]` and `opencodebridgeapp[bot]`
  - OpenCode PR author `app/opencodebridgeapp`

The March 17 runs proved routing and backend selection.
The March 18 hard-gate run added distinct GitHub App identity proof.

The live customer-flow evaluator now rejects shared app credentials so this ambiguity cannot be silently accepted again.
