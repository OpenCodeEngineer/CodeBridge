# Customer-Flow Evaluation

This is the mission gate for CodeBridge.

The fast checks in CI (`lint`, `build`, `test`) are necessary, but they do not prove the product works from GitHub issue to local agent execution to GitHub back-report.

The live gate does.

## What It Proves

The hard eval runs two real GitHub customer flows against `dzianisv/codebridge-test`:

1. `@CodexApp` issue flow
   - posts a GitHub issue command
   - routes to backend `codex`
   - answers a knowledge question on the issue thread
   - expected answer: first GPT model released in 2018
   - expected final run status in persistence: `no_changes`

2. `@OpenCodeApp` issue-to-PR flow
   - posts a GitHub issue command
   - routes to backend `opencode`
   - creates a Bun + TypeScript hello-world app in an issue-scoped directory
   - runs `bun test`
   - runs `bun run src/main.ts`
   - opens a pull request linked to the issue
   - reports the PR URL and command results back on the issue thread
   - expected final run status in persistence: `succeeded`

The suite does not trust GitHub comments alone.

It checks three evidence layers:

- GitHub-visible evidence
  - issue URL
  - final bot comment URL
  - PR URL
  - PR body linkage
- CodeBridge persistence
  - `backend`
  - `github_app_key`
  - final `status`
  - persisted `pr_url`
- executable PR verification
  - clone the generated PR branch
  - run `bun test`
  - run `bun run src/main.ts`
  - verify the output is exactly `Hello, world!`

This gate is intentionally strong enough to catch clean-branch false negatives.
On March 18, 2026, live issue `dzianisv/codebridge-test#536` showed that OpenCode could commit and push the prepared branch while leaving the checkout clean and omitting a PR URL.
That run incorrectly landed in `no_changes` before the runner was hardened.
The current gate would fail that behavior because the OpenCode case requires a real PR, persisted `status=succeeded`, and executable verification on the PR branch.

Promptfoo then uses `azure:chat:gpt-4.1` as the judge on the collected JSON evidence.

Latest validated local run on March 18, 2026:

- Codex knowledge flow: `dzianisv/codebridge-test#542`
- OpenCode issue-to-PR flow: `dzianisv/codebridge-test#543` -> `dzianisv/codebridge-test#544`
- Promptfoo result: `2 passed, 0 failed, 0 errors`
- Artifacts:
  - `reports/customer-flow-eval-report-2026-03-18T01-20-35-826Z.md`
  - `reports/customer-flow-eval-raw-2026-03-18T01-20-35-826Z.json`
  - `reports/customer-flow-eval-output-2026-03-18T01-20-35-826Z.json`

## Local Run

```bash
pnpm tsx scripts/eval-customer-flow.ts \
  --repo dzianisv/codebridge-test \
  --repo-path /absolute/path/to/dedicated/codebridge-test-clone \
  --database-url sqlite:///absolute/path/to/codebridge-eval.db \
  --codex-handle @CodexApp \
  --codex-bot-login codexengineer[bot] \
  --codex-app-key codex \
  --opencode-handle @OpenCodeApp \
  --opencode-bot-login codexengineer[bot] \
  --opencode-app-key opencode \
  --timeout 300 \
  --poll 10
```

Use a dedicated test clone for `--repo-path`.
The eval runner hard-resets and cleans that checkout between cases.

Artifacts are written to `reports/`:

- `customer-flow-eval-config-*.json`
- `customer-flow-eval-raw-*.json`
- `customer-flow-eval-output-*.json`
- `customer-flow-eval-report-*.md`

## GitHub Actions

Workflow:

- `.github/workflows/live-customer-flow-eval.yml`

This workflow:

1. installs dependencies,
2. installs `opencode`,
3. starts `opencode serve` locally on the runner,
4. generates a temporary CodeBridge config,
5. starts CodeBridge in polling mode,
6. runs the live customer-flow eval,
7. uploads reports and service logs as artifacts.

The workflow is intentionally separate from the fast PR CI because it creates real GitHub issues and pull requests in the test repository.

## Required Secrets

- `CODEBRIDGE_EVAL_GH_TOKEN`
- `CODEBRIDGE_EVAL_GITHUB_APP_ID`
- `CODEBRIDGE_EVAL_GITHUB_PRIVATE_KEY`
- `CODEBRIDGE_EVAL_GITHUB_INSTALLATION_ID`
- `CODEBRIDGE_EVAL_CODEX_API_KEY`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_BASE_URL`
- `AZURE_RESOURCE_NAME`

Optional overrides:

- `CODEBRIDGE_EVAL_OPENCODE_GITHUB_APP_ID`
- `CODEBRIDGE_EVAL_OPENCODE_GITHUB_PRIVATE_KEY`
- `CODEBRIDGE_EVAL_OPENCODE_GITHUB_INSTALLATION_ID`
- `CODEBRIDGE_EVAL_CODEX_PREFIX`
- `CODEBRIDGE_EVAL_OPENCODE_PREFIX`
- `CODEBRIDGE_EVAL_OPENCODE_MODEL`

If the optional OpenCode GitHub App secrets are not set, the generated eval config reuses the Codex GitHub App credentials under the `opencode` app key.
That still proves route selection through persisted `github_app_key` and backend choice, but it does not prove distinct GitHub bot identities.

## Temporary Config Generator

The workflow uses:

- `scripts/write-live-eval-config.ts`

Inputs:

- `--output`
- `--repo-path`
- `--repo`

It writes a tenant config that:

- binds `codex` and `opencode` app keys,
- maps the test repository to the dedicated checkout path,
- keeps `codex` as the default route,
- overrides only the OpenCode route to backend `opencode`.
