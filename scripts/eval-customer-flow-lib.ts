export type KnowledgeVerification = {
  answerHas2018: boolean
  answerHasJune2018: boolean
  mentionsGpt1: boolean
  mentionsWikipedia: boolean
  unexpectedPr: boolean
}

const GITHUB_HANDLE_RE = /^[A-Za-z0-9-]+$/
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

export function botLoginMatchesExpected(actual: string | undefined, expected: string | string[]): boolean {
  if (!actual?.trim()) return false
  const actualVariants = normalizeBotLogins(actual)
  if (actualVariants.length === 0) return false

  const expectedValues = Array.isArray(expected) ? expected : [expected]
  const allowed = new Set(expectedValues.flatMap(value => normalizeBotLogins(value)))
  return actualVariants.some(value => allowed.has(value))
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

export function textStartsWithHandle(text: string, handle: string): boolean {
  const normalizedHandle = normalizeHandle(handle)
  if (!normalizedHandle) return false
  const normalizedText = text.trimStart().toLowerCase()
  return normalizedText === normalizedHandle || normalizedText.startsWith(`${normalizedHandle} `) || normalizedText.startsWith(`${normalizedHandle}\n`)
}

export function renderedHtmlHasHandleUserMentionLink(html: string | undefined, handle: string): boolean {
  if (!html?.trim()) return false
  const normalizedHandle = normalizeHandle(handle)
  if (!normalizedHandle) return false
  const slug = normalizedHandle.slice(1)
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(
    `<a[^>]+class="[^"]*\\buser-mention\\b[^"]*"[^>]*>(?:@${escapedSlug})<\\/a>`,
    "i"
  )
  return pattern.test(html)
}

export function githubAppSlugMatchesHandle(appSlug: string | undefined, handle: string): boolean {
  const normalizedSlug = normalizeHandle(appSlug)
  const normalizedHandle = normalizeHandle(handle)
  if (!normalizedSlug || !normalizedHandle) return false
  return normalizedSlug === normalizedHandle
}

function normalizeHandle(value: string | undefined): string | null {
  const raw = (value ?? "").trim()
  if (!raw) return null
  const trimmed = raw.startsWith("@") ? raw.slice(1) : raw
  if (!trimmed || !GITHUB_HANDLE_RE.test(trimmed)) return null
  return `@${trimmed.toLowerCase()}`
}
