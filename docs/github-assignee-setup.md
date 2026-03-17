# GitHub Assignee Setup

This document explains assignment bootstrap for CodeBridge and what to do when a GitHub App bot login is not assignable.

For installation scope, app identity, and webhook setup, see the GitHub App setup section in [README](../README.md).

## Key Fact

Issue assignees must be assignable users for that repository (collaborator/member visibility rules apply). In many repos, custom GitHub App bot identities such as `codexengineer[bot]` are not exposed as assignable users.

For this reason, assignment bootstrap is best treated as optional. Mention bootstrap via real `@handle` prefixes is the portable default.

For GitHub partner coding agents, assignability is controlled by Copilot coding-agent policies. After enabling Codex coding agent, the native actor appears as `openai-code-agent` in `suggestedActors`, while issue assignee login may surface as `Codex`.

## Verify Assignability

Check whether GitHub currently allows assigning the bot on a repository:

```bash
gh api repos/<owner>/<repo>/assignees | jq -r '.[].login'
```

If `codexengineer[bot]` is missing, assignment to that bot will fail.

Check native assignable actors exactly as GitHub sees them:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{__typename ... on User{login id} ... on Bot{login id}}}}}' \
  -f owner=<owner> \
  -f repo=<repo>
```

Only actors returned in `suggestedActors(capabilities:[CAN_BE_ASSIGNED])` can be assigned natively by the evaluation runner.

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

If you need assignment-triggered bootstrap, use a native assignable actor and configure it in tenant config:

```yaml
tenants:
  - id: local
    github:
      installationId: 123456
      assignmentAssignees:
        - "openai-code-agent"
```

Behavior:

- Assignment to any login in `assignmentAssignees` triggers bootstrap.
- Replies are still authored by the GitHub App bot identity.
- Comment mentions for these handles are also accepted as command prefixes automatically.
- Hard eval/protocol assignment case is native-only and does not inject synthetic `issues.assigned` webhooks.
- Runtime assignee matching normalizes native coding-agent aliases (`openai-code-agent` <-> `codex`, `copilot-swe-agent` <-> `copilot`) and strips `[bot]` suffixes for compatibility with GitHub issue payloads.

## Strict `@codexengineer` Gate

If mission acceptance requires **exact** assignment to `@codexengineer` (not `openai-code-agent`/`Codex` alias), run:

```bash
pnpm eval:strict-codexengineer
```

When blocked, collect diagnostics for GitHub Support:

```bash
pnpm test:github-assignment-evidence -- --repo <owner/repo> --assignment-handle @codexengineer
```

The script writes a support-ready JSON artifact in `reports/github-assignment-evidence-*.json`.

## Notes

- Keep app-handle mention mode enabled even when assignment mode is configured.
- Assignment and mention modes can be used together safely.
