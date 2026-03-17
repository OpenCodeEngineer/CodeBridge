# GitHub Support Ticket Template: `@codexengineer` Assignability

Use this template when mission acceptance requires exact direct assignment to `@codexengineer`.

## Subject

`codexengineer` is not exposed in `suggestedActors(CAN_BE_ASSIGNED)` for repository where Codex partner agent is enabled

## Body

Hello GitHub Support,

We are validating Copilot coding-agent assignment behavior for repository:

- Repository: `<owner>/<repo>`
- Account type: `<personal|organization-managed>`
- Date/time (UTC): `<timestamp>`

Expected behavior:

- `@codexengineer` should be directly assignable to issues in this repository.
- `codexengineer` (or `codexengineer[bot]`) should appear in GraphQL:
  - `repository.suggestedActors(capabilities:[CAN_BE_ASSIGNED])`

Actual behavior:

- `codexengineer` does not appear in `suggestedActors(CAN_BE_ASSIGNED)`.
- We only see `openai-code-agent` (assignee surfaces as `Codex`) and `copilot-swe-agent`.
- Direct assignment to `@codexengineer` cannot be performed natively.

What we already enabled:

- Personal/Org Copilot coding agent enabled.
- Partner agent toggle enabled: **Allow Codex coding agent**.
- Repository coding agent enabled and included in repository access policy.

Attached evidence:

- `reports/github-assignment-evidence-<timestamp>.json`

Key payloads in the artifact:

- `assignableActors`: actor list from `suggestedActors(CAN_BE_ASSIGNED)`.
- `candidateLookups`: `users/<candidate>` resolution (`codexengineer`, `codexengineer[bot]`).
- `mutationAttempts`: `addAssigneesToAssignable` results and GraphQL errors.
- `finalAssignees`: post-mutation assignee state on probe issue.

Please confirm whether `codexengineer` can be exposed as an assignable actor for this repository, or if current behavior intentionally maps Codex assignment only through `openai-code-agent`/`Codex`.

Thanks.
