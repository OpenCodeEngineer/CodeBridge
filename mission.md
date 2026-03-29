# CodeBridge Mission Status

**Date**: 2026-03-29
**Status**: PASS (all hard-gate acceptance criteria met)

## Evaluation Summary

### Hard-Gate Eval (Promptfoo customer-flow)
- **Command**: `bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --repo-path /tmp/codebridge-test-eval-1772741604 --app-handle @codexengineer --webhook-secret codebridge-eval-secret --timeout 180 --poll 10`
- **Result**: 4/4 PASS
- **Artifacts**:
  - Raw: `reports/eval-raw-2026-03-29T11-15-23-612Z.json`
  - Output: `reports/eval-output-2026-03-29T11-15-23-612Z.json`
- **Cases**:
  - `python-hello-world` (mention trigger, terminal completion) — PASS
  - `typescript-bun-hello` (mention trigger, terminal completion) — PASS
  - `mention-bootstrap-status-only` (mention trigger, started only) — PASS
  - `direct-assignment-no-mention` (assignment trigger, started only) — PASS

### Protocol Matrix (GitHub surface coverage)
- **Command**: `bun scripts/runGithubMentionE2ETest.ts`
- **Result**: 4 PASS, 0 FAIL, 1 BLOCKED
- **Artifacts**: `reports/codebridge-test-report-2026-03-29T11-15-02-939Z.md`
- **Cases**:
  - `assignment-to-app-handle` — PASS
  - `issue-mention` — PASS
  - `pr-mention` — PASS
  - `pr-review-mention` — PASS
  - `discussion-mention` — BLOCKED (external: no GitHub App configured for VibeTechnologies org)

### Codex Session Relay E2E
- **Command**: `bun scripts/test-codex-session-relay.ts --repo dzianisv/codebridge-test --notify-url http://127.0.0.1:8788/codex/notify --timeout 240 --poll 5`
- **Result**: PASS
- **Artifact**: `reports/codex-session-relay-2026-03-29T11-13-12-882Z.json`
- **Issue**: https://github.com/dzianisv/codebridge-test/issues/663

### Quality Gates
- **Lint**: `pnpm lint` — PASS (zero warnings)
- **Build**: `pnpm build` — PASS (clean)
- **Tests**: `pnpm test` — 235/235 PASS

## Bugs Fixed (this session)

### Bug #1: `loadConfiguredAssignmentHandles` config path mismatch
- **File**: `scripts/github-assignment-handle.ts:50`
- **Root cause**: Code accessed `tenant.github.assignmentAssignees` but normalized config puts it under `tenant.github.apps[].assignmentAssignees`.
- **Fix**: Changed to traverse `tenant.github.apps[]` and flatMap `assignmentAssignees`.

### Bug #2: `resolveCodexModelReasoningEffort()` dated model variants
- **File**: `src/runner.ts:712`
- **Root cause**: Used exact match `"gpt-5.4-pro"` but actual model resolves to `"gpt-5.4-pro-2026-03-05"`.
- **Fix**: Changed to `startsWith("gpt-5.4-pro")`.

### Bug #3: `model_reasoning_effort` in Codex CLI config
- **File**: `~/.codex/config.toml`
- **Root cause**: Had `model_reasoning_effort = "none"` which is invalid for gpt-5.4-pro.
- **Fix**: Changed to `"medium"`.

### Bug #4: Orphaned test in eval-customer-flow-lib.test.ts
- **File**: `scripts/eval-customer-flow-lib.test.ts`
- **Fix**: Moved orphaned `it()` block inside its `describe("textStartsWithHandle")` block.

### Bug #5: `/codex/notify` never creates a run record (CRITICAL)
- **File**: `src/codex-notify.ts`
- **Root cause**: The notify handler created an in-memory session binding via `registerSessionBinding()` and a GitHub issue, but never persisted a run record to the database. The polling path (`isManagedIssueOwnedByApp` in `github-poll.ts`) checks `store.getLatestRunForIssue()` for ownership — with no run record, it always returned `false`, causing follow-up comments on notify-created issues to be silently skipped.
- **Fix**: Added `store.createRun()` call after `registerSessionBinding()` in the notify handler, with the correct `appKey` from `selectGithubAppKeyForBackend()`. The run is immediately marked as `succeeded` since the actual work is handled by the external Codex session.
- **Files changed**: `src/codex-notify.ts` (added store import, createRun call), `src/index.ts` (pass store to handler).

## Known Blockers (external)

- `discussion-mention` protocol case is BLOCKED because no GitHub App is configured/installed for the `VibeTechnologies` organization. This is an infrastructure prerequisite, not a code bug.
