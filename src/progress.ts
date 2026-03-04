export type ProgressSnapshot = {
  lines: string[]
  lastAgentMessage?: string
  updatedAt: number
}

export class ProgressTracker {
  private lines: string[] = []
  private lastAgentMessage?: string
  private updatedAt: number = Date.now()

  pushLine(line: string) {
    if (!line) return
    this.lines.push(line)
    if (this.lines.length > 8) this.lines = this.lines.slice(-8)
    this.updatedAt = Date.now()
  }

  setAgentMessage(text: string) {
    this.lastAgentMessage = text
    this.updatedAt = Date.now()
  }

  snapshot(): ProgressSnapshot {
    return {
      lines: [...this.lines],
      lastAgentMessage: this.lastAgentMessage,
      updatedAt: this.updatedAt
    }
  }
}
