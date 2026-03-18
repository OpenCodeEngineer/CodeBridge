export type KnowledgeVerification = {
  answerHas2018: boolean
  answerHasJune2018: boolean
  mentionsGpt1: boolean
  mentionsWikipedia: boolean
  unexpectedPr: boolean
}

export function normalizeBotLogins(raw: string): string[] {
  const seed = raw
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)

  const variants = new Set<string>()
  for (const value of seed) {
    const normalized = value.replace(/^@/, "").trim().toLowerCase()
    if (!normalized) continue
    variants.add(normalized)
    if (normalized.endsWith("[bot]")) {
      variants.add(normalized.replace(/\[bot\]$/i, ""))
      variants.add(`app/${normalized.replace(/\[bot\]$/i, "")}`)
    } else {
      variants.add(`${normalized}[bot]`)
      variants.add(`app/${normalized}`)
    }
  }
  return [...variants]
}

export function verifyKnowledgeResponse(botResponse: string, prUrl?: string | null): KnowledgeVerification {
  const normalized = botResponse
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, "-")
  return {
    answerHas2018: /\b2018\b/.test(normalized),
    answerHasJune2018: /\bjune\s+2018\b/.test(normalized),
    mentionsGpt1: /\bgpt-?1\b/.test(normalized) || /generative pre-?training/.test(normalized),
    mentionsWikipedia: /\bwikipedia\b/.test(normalized),
    unexpectedPr: Boolean(prUrl)
  }
}

export function issueLinkMentioned(prBody: string | undefined, issueNumber: number): boolean {
  if (!prBody?.trim()) return false
  const normalized = prBody.toLowerCase()
  return [
    `closes #${issueNumber}`,
    `fixes #${issueNumber}`,
    `resolves #${issueNumber}`
  ].some(token => normalized.includes(token))
}

export function textMentionsUrl(text: string, url: string | undefined): boolean {
  if (!url?.trim()) return false
  return text.includes(url.trim())
}
