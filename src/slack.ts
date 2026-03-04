import { createRequire } from "node:module"
import { WebClient } from "@slack/web-api"
import type { App as BoltApp } from "@slack/bolt"
import type { SlackContext, GitHubContext } from "./types.js"
import { extractCommand } from "./commands.js"
import { logger } from "./logger.js"
import type { AppConfig } from "./types.js"
import { findTenantBySlackTeam, resolveRepo } from "./repo.js"

const require = createRequire(import.meta.url)
const { App } = require("@slack/bolt") as { App: new (...args: any[]) => BoltApp }

export type SlackRuntime = {
  app: BoltApp
  client: WebClient
  botUserId: string
}

export type SlackCommandHandler = (input: {
  tenantId: string
  prompt: string
  repoHint?: string
  slack: SlackContext
  issue?: GitHubContext
}) => Promise<void>

export async function startSlack(
  config: AppConfig,
  env: {
    slackBotToken?: string
    slackAppToken?: string
    slackSigningSecret?: string
  },
  onCommand: SlackCommandHandler
): Promise<SlackRuntime | null> {
  if (!env.slackBotToken) return null

  const socketMode = Boolean(env.slackAppToken)
  const app = new App({
    token: env.slackBotToken,
    signingSecret: env.slackSigningSecret ?? "",
    socketMode,
    appToken: env.slackAppToken
  })

  const client = new WebClient(env.slackBotToken)
  const auth = await client.auth.test()
  const botUserId = auth.user_id ?? ""

  app.event("app_mention", async ({ event }) => {
    const teamId = event.team
    if (!teamId) return
    const tenant = findTenantBySlackTeam(config, teamId)
    if (!tenant?.slack) return

    const command = extractCommand(event.text ?? "", tenant.slack.commandPrefixes, botUserId)
    if (!command) return

    const repoHint = command.repoHint ?? (command.issue ? `${command.issue.owner}/${command.issue.repo}` : undefined)
    const repo = resolveRepo(tenant, repoHint)
    if (!repo) return

    const slackContext: SlackContext = {
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userId: event.user
    }

    await onCommand({
      tenantId: tenant.id,
      prompt: command.prompt,
      repoHint: repo.fullName,
      slack: slackContext,
      issue: command.issue ?? undefined
    })
  })

  app.event("message", async ({ event }) => {
    if (event.subtype) return
    if ((event as any).bot_id) return
    const teamId = event.team
    if (!teamId) return
    const tenant = findTenantBySlackTeam(config, teamId)
    if (!tenant?.slack) return

    const command = extractCommand(event.text ?? "", tenant.slack.commandPrefixes)
    if (!command) return

    const repoHint = command.repoHint ?? (command.issue ? `${command.issue.owner}/${command.issue.repo}` : undefined)
    const repo = resolveRepo(tenant, repoHint)
    if (!repo) return

    const slackContext: SlackContext = {
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userId: event.user
    }

    await onCommand({
      tenantId: tenant.id,
      prompt: command.prompt,
      repoHint: repo.fullName,
      slack: slackContext,
      issue: command.issue ?? undefined
    })
  })

  if (socketMode) {
    await app.start()
  } else {
    await app.start(0)
  }
  logger.info({ socketMode }, "Slack app started")

  return { app, client, botUserId }
}

export async function postSlackStatus(client: WebClient, slack: SlackContext, text: string): Promise<string> {
  const result = await client.chat.postMessage({
    channel: slack.channel,
    thread_ts: slack.threadTs,
    text
  })
  return result.ts ?? ""
}

export async function updateSlackStatus(client: WebClient, slack: SlackContext, text: string, messageTs: string): Promise<void> {
  await client.chat.update({
    channel: slack.channel,
    ts: messageTs,
    text
  })
}
