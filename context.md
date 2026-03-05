# CodeBridge - Project Context

Date: 2026-03-05

## What Is CodeBridge

CodeBridge is a bridge service that connects **GitHub issues/PRs/discussions** and **Slack threads** to a **local Codex CLI runner**. When a human mentions the bot or assigns it to an issue, CodeBridge runs Codex against the target repo and posts progress updates, answers, and pull requests back to the conversation thread.

## Architecture

- **API server** (Express, port 8788): receives GitHub webhooks or polls GitHub for new mentions
- **Worker** (BullMQ or in-memory queue): executes Codex SDK runs against local repo clones
- **Storage**: PostgreSQL (prod) or SQLite (dev) for runs, events, poll state
- **Queue**: Redis/BullMQ (prod) or in-memory (dev)

## GitHub Integration

Two modes for receiving events:
1. **Webhook mode** via Probot at `/github/webhook`
2. **Polling mode** with configurable interval (no public endpoint needed)

Supported triggers:
- `issue_comment.created` (mention-based)
- `discussion_comment.created` (mention-based)
- `issues.assigned` (assignment-based)

Issue lifecycle labels: `agent:managed`, `agent:in-progress`, `agent:idle`, `agent:completed`

## Current State

- Core bridge logic is implemented and working
- GitHub polling and webhook paths both functional
- Issue mention flow: **working**
- PR mention flow: **working**
- Discussion mention flow: needs Discussions permission on app
- Assignment flow: bot handles not always assignable; mention-based bootstrap is the portable default
- Codex notify endpoint (`POST /codex/notify`) mirrors external Codex sessions to GitHub issues
- Vibe Agents mirror integration available (optional)

## Configuration

Config loaded from YAML (`config/tenants.yaml` or `~/.config/codebridge/config.yaml`):
- GitHub App credentials (appId, privateKey)
- Tenant definitions with repo mappings, Slack team IDs, and GitHub installation IDs

## Next Steps

1. Ensure all 4 GitHub interaction surfaces pass E2E (assignment, issue mention, PR mention, discussion mention)
2. Stabilize dedupe logic to prevent duplicate bot replies
3. Documentation cleanup
4. CI/CD pipeline
