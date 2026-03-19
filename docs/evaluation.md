# Customer-Flow Evaluation

This is the mission gate for CodeBridge.

The fast checks in CI (`lint`, `build`, `test`) are necessary, but they do not prove the product works from GitHub issue to local agent execution to GitHub back-report.

The live gate does.

## What It Proves

The hard eval runs two real GitHub customer flows against `dzianisv/codebridge-test`.

It is only valid when:

- the Codex route uses the real installed Codex GitHub App handle,
- the OpenCode route uses the real installed OpenCode GitHub App handle,
- the two app keys resolve to distinct app ids, slugs, and bot authors.

Shared credentials under two different `appKey` names are not accepted.
For this gate, "real handle" means the exact `@<app-slug>` resolved from the GitHub App identity. GitHub currently renders GitHub App slug tokens as plain text in issue/PR/discussion comment `body_html` instead of `<a class="user-mention">` links, but this hard gate now treats highlighted mention rendering as a required acceptance condition. The mission remains incomplete until the trigger comments are both exact-handle matches and real rendered `user-mention` links.

1. `@<real-codex-app-slug>` issue flow
   - posts a GitHub issue command
   - routes to backend `codex`
   - answers a knowledge question on the issue thread
   - expected answer: first GPT model released in 2018
   - expected final run status in persistence: `no_changes`

2. `@<real-opencode-app-slug>` issue-to-PR flow
   - posts a GitHub issue command
   - routes to backend `opencode`
   - creates a Bun + TypeScript hello-world app in an issue-scoped directory
   - runs `bun test`
   - runs `bun run src/main.ts`
   - leaves the repository locally ready for CodeBridge to open a pull request linked to the issue
   - reports the PR URL and command results back on the issue thread
   - expected final run status in persistence: `succeeded`

The suite does not trust GitHub comments alone.

It checks three evidence layers:

- GitHub-visible evidence
  - trigger comment starts with the real GitHub App handle
  - trigger comment `body_html` is captured and must contain a real rendered user-mention link for the expected handle
  - issue URL
  - final bot comment URL
  - final issue-thread bot author matches the expected app
  - final issue-thread `performed_via_github_app.slug` matches the expected app slug
  - PR URL
  - PR author matches the expected app for the OpenCode route
  - PR body linkage
- For the OpenCode PR case, the live-eval prompt explicitly forbids the backend from using GitHub CLI/MCP/API/website writes or `git push` to publish the PR flow itself. CodeBridge also sends `tools.github=false` on GitHub-originated OpenCode prompt requests so the local OpenCode server cannot reach its configured GitHub MCP during the eval. CodeBridge must publish the branch and create the PR with the handling GitHub App identity after the backend leaves the local checkout ready for review.
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

Latest passing distinct-app proof from this branch:

- March 19, 2026 local hard-gate run:
  - Codex issue flow: `dzianisv/codebridge-test#570`
  - OpenCode issue-to-PR flow: `dzianisv/codebridge-test#571` -> `#572`
  - Codex reply author: `codexengineer[bot]`
  - Codex reply `performed_via_github_app.slug`: `codexengineer`
  - OpenCode reply author: `opencodebridgeapp[bot]`
  - OpenCode reply `performed_via_github_app.slug`: `opencodebridgeapp`
  - OpenCode PR author: `app/opencodebridgeapp`
  - persisted worktree paths: both runs used `$WORKSPACE_ROOT/.codebridge/worktrees/<owner>__<repo>/<run-id>`

Rejected historical note:

- A March 18, 2026 local run produced route/backend evidence on `dzianisv/codebridge-test#542` and `dzianisv/codebridge-test#543` -> `#544`.
- That run used one GitHub App author (`codexengineer[bot]`) for both routes, so it does **not** satisfy the distinct-app identity requirement.
- The evaluator and config generator now reject that setup instead of silently accepting it.

## Local Run

```bash
pnpm tsx scripts/eval-customer-flow.ts \
  --repo dzianisv/codebridge-test \
  --workspace-root /absolute/path/to/dedicated/codebridge-workspace \
  --database-url /absolute/path/to/codebridge-eval.db \
  --codex-app-key codex \
  --opencode-app-key opencode \
  --timeout 300 \
  --poll 10
```

Use a dedicated workspace root for `--workspace-root`.
The eval runner clears that workspace root before the first case, then verifies that runs execute from per-task worktree paths under that managed root instead of mutating the base clone directly.
It resolves the real GitHub App slugs and bot logins from `CODEBRIDGE_EVAL_*` credentials and fails if the resolved identities are shared.

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
4. generates a temporary CodeBridge config with no fixed `repo.path` for the GitHub test repo,
5. starts CodeBridge in polling mode with `CODEBRIDGE_WORKSPACE_ROOT`,
6. runs the live customer-flow eval,
7. uploads reports and service logs as artifacts.

The workflow is intentionally separate from the fast PR CI because it creates real GitHub issues and pull requests in the test repository.

## Required Secrets

- `CODEBRIDGE_EVAL_GH_TOKEN`
- `CODEBRIDGE_EVAL_GITHUB_APP_ID`
- `CODEBRIDGE_EVAL_GITHUB_PRIVATE_KEY`
- `CODEBRIDGE_EVAL_GITHUB_INSTALLATION_ID`
- `CODEBRIDGE_EVAL_OPENCODE_GITHUB_APP_ID`
- `CODEBRIDGE_EVAL_OPENCODE_GITHUB_PRIVATE_KEY`
- `CODEBRIDGE_EVAL_OPENCODE_GITHUB_INSTALLATION_ID`
- `CODEBRIDGE_EVAL_CODEX_API_KEY`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_BASE_URL`
- `AZURE_RESOURCE_NAME`

Optional overrides:

- `CODEBRIDGE_EVAL_OPENCODE_MODEL`
  - defaults to `opencode/minimax-m2.5-free`, which completed a real repo mutation against `opencode serve` on March 18, 2026 while the GitHub Copilot default route was rate-limited
  - override it only when your local OpenCode server explicitly supports a better `provider/model`

Important:

- the hard gate no longer accepts configured alias prefixes such as `@OpenCodeEvalApp`
- it derives the real handles from the GitHub App slugs
- it now fails if GitHub does not render the trigger comment as a real `user-mention` link for the expected app handle
- it fails fast if Codex and OpenCode resolve to the same app id, slug, or bot login
- it fails if the collected issue-thread authors, `performed_via_github_app` slugs, or PR author do not match the expected real GitHub App identity

## Temporary Config Generator

The workflow uses:

- `scripts/write-live-eval-config.ts`

Inputs:

- `--output`
- `--repo`

It writes a tenant config that:

- binds `codex` and `opencode` app keys,
- maps the test repository by `fullName` only so GitHub-originated runs must resolve through the managed workspace root,
- keeps `codex` as the default route,
- overrides only the OpenCode route to backend `opencode`,
- defaults the OpenCode `model` field to `opencode/minimax-m2.5-free` unless `CODEBRIDGE_EVAL_OPENCODE_MODEL` is explicitly set,
- stores the real GitHub App slugs in config for traceability, while the live bridge still resolves the accepted GitHub comment handle from `GET /app` at runtime.
