import type { RunRecord } from "./types.js"
import type { ProgressSnapshot } from "./progress.js"

export function formatSlackStatus(run: RunRecord, snapshot: ProgressSnapshot, state: string): string {
  const lines = snapshot.lines.map(line => `- ${line}`).join("\n")
  const header = `Codex run ${run.id} on ${run.repoFullName}`
  const branch = run.branchName ? `Branch: ${run.branchName}` : ""
  const body = lines ? `\n${lines}` : ""
  const status = `Status: ${state}`
  const agent = snapshot.lastAgentMessage ? `\nLatest: ${truncate(snapshot.lastAgentMessage, 240)}` : ""
  return [header, status, branch].filter(Boolean).join("\n") + body + agent
}

export function formatGitHubStatus(run: RunRecord, snapshot: ProgressSnapshot, state: string): string {
  const lines = snapshot.lines.map(line => `- ${line}`).join("\n")
  const branch = run.branchName ? `Branch: \`${run.branchName}\`` : ""
  const header = `**Codex run ${run.id}**`
  const status = `Status: ${state}`
  const agent = snapshot.lastAgentMessage ? `\nLatest: ${truncate(snapshot.lastAgentMessage, 600)}` : ""
  const body = lines ? `\n${lines}` : ""
  return [header, status, branch].filter(Boolean).join("\n") + body + agent
}

export function formatFinalSummary(run: RunRecord, summary: string, prUrl?: string): string {
  const header = `Codex run ${run.id} complete`
  const prLine = prUrl ? `PR: ${prUrl}` : "No PR created"
  return `${header}\n${prLine}\n${summary}`
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + "..."
}
