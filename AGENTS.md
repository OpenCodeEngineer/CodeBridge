# AGENTS.md

## Mission Acceptance Criteria (Hard Gate)

A mission is **NOT** complete until all of the following are true:

1. A dedicated evaluation suite exists for the implemented feature/use case.
2. Evaluation test cases cover the real user-facing behavior that was requested (not generic or unrelated cases).
3. Evaluation is run end-to-end against the integrated system.
4. Evaluation results pass according to defined thresholds.

If evaluation fails, the mission remains **in progress**.
Do not mark mission complete, do not claim completion, and do not close completion updates until evaluation passes.

## Evaluation Quality Requirements

- Always validate that eval scenarios are correct for the feature that was asked to implement.
- Always validate that eval coverage is sufficient (happy path, likely failure path, and key acceptance behavior).
- If coverage is weak or mismatched, expand/fix evaluation before reporting completion.
- Report exact eval command(s), run IDs/artifacts, and pass/fail summary in completion updates.

## Completion Reporting Rule

When reporting mission completion, include explicit proof:

- evaluation command run,
- evaluation scope/cases,
- final pass status,
- links/identifiers to results.

Without this proof and a passing result, mission status must remain **not completed**.
