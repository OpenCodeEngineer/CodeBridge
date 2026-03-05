# GitHub Surface Test Protocol

This protocol validates the exact interaction surfaces required for CodeBridge:

1. issue assigned to `@githubapphandle`
2. `@githubapphandle` mention in GitHub issue comments
3. `@githubapphandle` mention in GitHub PR conversation comments
4. `@githubapphandle` mention in GitHub discussion comments

## Preconditions

- CodeBridge is running in polling mode:
  - `GITHUB_POLL_INTERVAL` set (for example `10`)
  - `GITHUB_POLL_BACKFILL=false`
- Target repos are in tenant `repoAllowlist` and `repos` config.
- App handle is resolvable (for example `@codexengineer`).
- For assignment bootstrap:
  - the app handle must be assignable in that repo (`/assignees/<login>` returns `204`).
- For discussions:
  - repository has discussions enabled;
  - GitHub App has Discussions permission (read/write).

## Runner

Use:

```bash
pnpm test:github-protocol \
  --issue-repo <owner/repo> \
  --pr-repo <owner/repo> \
  --discussion-repo <owner/repo> \
  --discussion-number <existing-discussion-number>
```

Output is JSON:

- `pass`: case succeeded end-to-end
- `blocked`: external platform prerequisite missing (assignability/permissions/settings)
- `fail`: bridge behavior failed for a valid preconditioned case

The script exits non-zero only when at least one case is `fail`.

## Notes On GitHub Platform Constraints

- Some repos do not allow assigning GitHub App bot identities as issue assignees.
  - In that case, assignment case is reported as `blocked`.
  - Mention-based bootstrap remains the functional path.
- Discussions require explicit app permissions beyond Issues/PR permissions.
  - Without Discussions permission, discussion case is `blocked` with
    `Resource not accessible by integration`.
- Discussion case now targets an existing discussion thread (no `createDiscussion` mutation required).
  - Use `--discussion-number` to force a stable target.
  - If omitted, the script uses the most recently updated discussion.

## Last Verified Run

Date: March 4, 2026 (America/Los_Angeles)

Command:

```bash
pnpm test:github-protocol \
  --issue-repo dzianisv/codebridge-test \
  --pr-repo VibeTechnologies/VibeWebAgent \
  --discussion-repo VibeTechnologies/vibeteam-eval-hello-world \
  --discussion-number 6 \
  --timeout 240 \
  --poll 5
```

Result matrix:

- `assignment-to-app-handle`: `blocked`
  - reason: `codexengineer[bot]` / `codexengineer` not assignable in `dzianisv/codebridge-test`
- `issue-mention`: `pass`
  - evidence: [issue #22](https://github.com/dzianisv/codebridge-test/issues/22)
- `pr-mention`: `pass`
  - evidence: [PR #638](https://github.com/VibeTechnologies/VibeWebAgent/pull/638)
- `discussion-mention`: `blocked`
  - reason: app installation lacks Discussions permission on `VibeTechnologies/vibeteam-eval-hello-world`
