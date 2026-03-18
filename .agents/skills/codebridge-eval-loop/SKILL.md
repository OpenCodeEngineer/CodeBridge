---
name: codebridge-eval-loop
description: Run the CodeBridge end-to-end evaluation loop, collect proof artifacts, and report status against the mission hard gate.
license: MIT
compatibility: codex, opencode
metadata:
  audience: developers
  workflow: evaluation
---

# CodeBridge Eval Loop

Use this skill when you need to run the full CodeBridge mission validation cycle and report status with proof artifacts.

## Inputs
- Running local CodeBridge API at `http://127.0.0.1:8788`
- Configured GitHub App integration and repo mapping
- `gh` CLI authenticated via keyring (run with `GITHUB_TOKEN`/`GH_TOKEN` unset when needed)

## Steps
1. Run hard-gate Promptfoo eval:
   - `bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --repo-path /tmp/codebridge-test-eval-1772741604 --app-handle @codexengineer --webhook-secret codebridge-eval-secret --timeout 180 --poll 10`
2. Run protocol matrix:
   - `bun scripts/runGithubMentionE2ETest.ts`
3. Run Codex session relay E2E:
   - `bun scripts/test-codex-session-relay.ts --repo dzianisv/codebridge-test --notify-url http://127.0.0.1:8788/codex/notify --timeout 240 --poll 5`
4. Run local quality gates:
   - `pnpm lint`
   - `pnpm build`
5. Update `mission.md` with:
   - command used,
   - artifact paths,
   - pass/fail summary,
   - remaining blockers.
6. Post the same status proof to GitHub mission issue (`OpenCodeEngineer/CodeBridge#3`).

## Failure Handling
- If hard-gate eval fails, inspect the failing case in the latest `reports/eval-raw-*.json`, patch eval/test logic, and rerun from step 1.
- If protocol matrix has `FAIL`, treat mission as not complete and fix bridge behavior before rerun.
- If protocol matrix has only `BLOCKED`, document explicit external prerequisite (assignability, app permissions).
