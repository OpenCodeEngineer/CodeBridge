# GitHub Surface Test Protocol

This protocol validates the exact interaction surfaces required for CodeBridge:

1. issue assigned to `@githubapphandle`
2. `@githubapphandle` mention in GitHub issue comments
3. `@githubapphandle` mention in GitHub PR conversation comments
4. `@githubapphandle` mention in GitHub PR review comments
5. `@githubapphandle` mention in GitHub discussion comments

## Preconditions

- CodeBridge is running in polling mode:
  - `GITHUB_POLL_INTERVAL` set (for example `10`)
  - `GITHUB_POLL_BACKFILL=false`
- If webhook mode is being validated, target the app-specific webhook path:
  - `/github/webhook/codex`
  - `/github/webhook/opencode`
- Target repos are in tenant `repoAllowlist` and `repos` config.
- App handle is resolvable (for example `@codexengineer`).
- For assignment bootstrap:
  - assignment target must resolve to a native assignable actor in `suggestedActors(capabilities:[CAN_BE_ASSIGNED])` for that repo.
  - assignment case is native-only (no synthetic assignment fallback).
- For discussions:
  - repository has discussions enabled;
  - GitHub App has Discussions permission (read/write).
- For PR review comment coverage:
  - there must be at least one open PR with a reviewable added line so the runner can post a line comment.

## Runner

Use:

```bash
pnpm test:github-protocol \
  --issue-repo <owner/repo> \
  [--pr-repo <owner/repo>] \
  --discussion-repo <owner/repo> \
  --assignment-handle <@native-assignable-handle> \
  --database-url <sqlite://path-to-running-bridge.db> \
  --discussion-number <existing-discussion-number>
```

If `--pr-repo` is omitted, the runner reuses `--issue-repo`.

In multi-app mode, run the protocol once per app key/backend route you want to validate.

Strict `@codexengineer` mission gate run:

```bash
pnpm eval:strict-codexengineer
```

When strict assignment is blocked, the eval runner writes:

- `reports/codexengineer-assignment-evidence-<timestamp>.json`

Informational native-Codex run (non-gating when strict mode is required):

```bash
pnpm eval:codex-native
```

Output is JSON:

- `pass`: app accepted the command on that surface and produced run-start evidence
- `blocked`: external platform prerequisite missing (assignability/permissions/settings)
- `fail`: bridge behavior failed for a valid preconditioned case

The script exits non-zero only when at least one case is `fail`.

For support escalation evidence when strict `@codexengineer` assignment is blocked:

```bash
pnpm test:github-assignment-evidence -- --repo <owner/repo> --assignment-handle @codexengineer
```

## Notes On GitHub Platform Constraints

- Some repos do not allow assigning GitHub App bot identities as issue assignees.
  - In that case, assignment case is reported as `blocked` with native actor diagnostics.
- Discussions require explicit app permissions beyond Issues/PR permissions.
  - Without Discussions permission, protocol runner emits a signed synthetic `discussion_comment` webhook and verifies run creation via `sourceKey` in persistence.
  - When the bridge runs on a non-default sqlite path, pass the same runtime DB via `--database-url` so the fallback looks at the correct persistence file.
- Discussion case now targets an existing discussion thread (no `createDiscussion` mutation required).
  - Use `--discussion-number` to force a stable target.
  - If omitted, the script uses the most recently updated discussion.

## Last Verified Run

Date: March 17, 2026 (America/Los_Angeles)

Command:

```bash
bun scripts/runGithubMentionE2ETest.ts \
  --issue-repo dzianisv/codebridge-test \
  --discussion-repo VibeTechnologies/vibeteam-eval-hello-world \
  --discussion-number 108 \
  --assignment-handle @openai-code-agent \
  --timeout 240 \
  --poll 5 \
  --hook-target http://127.0.0.1:8788/github/webhook/codex \
  --webhook-secret codebridge-eval-secret \
  --database-url sqlite:///var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/codebridge-e2e-wvi_bl7g/codebridge-e2e.db
```

Result matrix:

- `assignment-to-app-handle`: `pass`
  - mode: native assignment actor (`openai-code-agent`)
  - evidence: [issue #507](https://github.com/dzianisv/codebridge-test/issues/507)
- `issue-mention`: `pass`
  - evidence: [issue #509](https://github.com/dzianisv/codebridge-test/issues/509)
- `pr-mention`: `pass`
  - evidence: [PR #508](https://github.com/dzianisv/codebridge-test/pull/508)
- `pr-review-mention`: `pass`
  - evidence: [PR #503](https://github.com/dzianisv/codebridge-test/pull/503)
- `discussion-mention`: `pass`
  - mode: synthetic `discussion_comment` webhook fallback
  - evidence: report `reports/codebridge-test-report-2026-03-17T16-12-48-856Z.json`

Additional multi-app customer-flow verification on March 17, 2026:

- `issue-mention` via `@OpenCodeApp`: `pass`
  - issue: [#524](https://github.com/dzianisv/codebridge-test/issues/524)
  - final status comment: [#issuecomment-4078045205](https://github.com/dzianisv/codebridge-test/issues/524#issuecomment-4078045205)
  - resulting PR: [#525](https://github.com/dzianisv/codebridge-test/pull/525)
  - persistence evidence: sqlite run `ZkkIiFQf` stored `status=succeeded`, `backend=opencode`, `github_app_key=opencode`, `pr_url=https://github.com/dzianisv/codebridge-test/pull/525`
