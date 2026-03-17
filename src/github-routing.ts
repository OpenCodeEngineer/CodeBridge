import { extractCommand, extractCommandFromManagedIssue, type ParsedCommand } from "./commands.js"

export type RoutedGitHubCommand = ParsedCommand & {
  explicit: boolean
}

export function routeIssueCommentCommand(input: {
  body: string
  prefixes: string[]
  issueManaged: boolean
}): RoutedGitHubCommand | null {
  const explicit = extractCommand(input.body, input.prefixes)
  if (explicit) {
    return { ...explicit, explicit: true }
  }

  if (!input.issueManaged) return null

  const managed = extractCommandFromManagedIssue(input.body)
  if (!managed) return null

  return {
    ...(managed.type === "run" ? { ...managed, type: "reply" as const } : managed),
    explicit: false
  }
}

export function routeExplicitGitHubCommand(input: {
  body: string
  prefixes: string[]
}): RoutedGitHubCommand | null {
  const command = extractCommand(input.body, input.prefixes)
  if (!command) return null
  return { ...command, explicit: true }
}

export function routeDiscussionCommentCommand(input: {
  body: string
  prefixes: string[]
}): RoutedGitHubCommand | null {
  return routeExplicitGitHubCommand(input)
}

export function shouldRelayManagedIssueCommand(input: {
  issueManaged: boolean
  command: RoutedGitHubCommand
}): boolean {
  return input.issueManaged && input.command.type === "reply"
}
