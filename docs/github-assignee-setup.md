# GitHub Assignee Setup

This document explains assignment bootstrap for CodeBridge and what to do when a GitHub App bot login is not assignable.

For installation scope, app identity, and org-install verification, see [GitHub Apps](github.md).

## Key Fact

Issue assignees must be assignable users for that repository (collaborator/member visibility rules apply). In many repos, custom GitHub App bot identities such as `codexengineer[bot]` are not exposed as assignable users.

For this reason, assignment bootstrap is best treated as optional. Mention bootstrap via real `@handle` prefixes is the portable default.

## Verify Assignability

Check whether GitHub currently allows assigning the bot on a repository:

```bash
gh api repos/<owner>/<repo>/assignees | jq -r '.[].login'
```

If `codexengineer[bot]` is missing, assignment to that bot will fail.

Direct check for a single assignee candidate:

```bash
gh api repos/<owner>/<repo>/assignees/codexengineer%5Bbot%5D -i
```

Expected:

- `204` => assignable
- `404` => not assignable

## Recommended Modes

### Mode A (Portable): Mention Bootstrap

Use comments with the app handle:

```text
@codexengineer run investigate flaky CI
```

After the issue is managed, plain comments work as follow-up prompts.

### Mode B (Assignment Bootstrap): Assignable Human/Machine User

If you need assignment-triggered bootstrap, use an assignable GitHub user (human or machine account) and configure it in tenant config:

```yaml
tenants:
  - id: local
    github:
      installationId: 123456
      assignmentAssignees:
        - "codex-operator"
```

Behavior:

- Assignment to any login in `assignmentAssignees` triggers bootstrap.
- Replies are still authored by the GitHub App bot identity.
- Comment mentions for these handles are also accepted as command prefixes automatically.

## Notes

- Keep app-handle mention mode enabled even when assignment mode is configured.
- Assignment and mention modes can be used together safely.
