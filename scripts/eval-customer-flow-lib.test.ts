import { describe, expect, it } from "vitest"
import {
  botLoginMatchesExpected,
  githubAppSlugMatchesHandle,
  issueLinkMentioned,
  normalizeBotLogins,
  renderedHtmlHasHandleUserMentionLink,
  textStartsWithHandle,
  textMentionsUrl,
  verifyKnowledgeResponse
} from "./eval-customer-flow-lib.js"

describe("normalizeBotLogins", () => {
  it("adds useful bot and app variants", () => {
    expect(normalizeBotLogins("@CodexEngineer")).toEqual([
      "codexengineer",
      "codexengineer[bot]",
      "app/codexengineer"
    ])
  })

  it("normalizes existing bot logins", () => {
    expect(normalizeBotLogins("codexengineer[bot]")).toEqual([
      "codexengineer[bot]",
      "codexengineer",
      "app/codexengineer"
    ])
  })
})

describe("verifyKnowledgeResponse", () => {
  it("detects the expected GPT-1 release answer", () => {
    expect(
      verifyKnowledgeResponse(
        "The first GPT model was GPT-1, released by OpenAI in June 2018 according to Wikipedia."
      )
    ).toEqual({
      answerHas2018: true,
      answerHasJune2018: true,
      mentionsGpt1: true,
      mentionsWikipedia: true,
      unexpectedPr: false
    })
  })

  it("flags unexpected PR output", () => {
    expect(
      verifyKnowledgeResponse(
        "The first GPT model was released in 2018.",
        "https://github.com/example/repo/pull/1"
      ).unexpectedPr
    ).toBe(true)
  })

  it("treats unicode dash variants in GPT-1 as a match", () => {
    expect(
      verifyKnowledgeResponse(
        "Answer: OpenAI's first GPT model (GPT‑1) was introduced in June 2018."
      ).mentionsGpt1
    ).toBe(true)
  })
})

describe("botLoginMatchesExpected", () => {
  it("accepts equivalent bot-login variants", () => {
    expect(botLoginMatchesExpected("codexengineer[bot]", "codexengineer")).toBe(true)
    expect(botLoginMatchesExpected("app/codexengineer", "codexengineer[bot]")).toBe(true)
  })

  it("rejects different GitHub App authors", () => {
    expect(botLoginMatchesExpected("codexengineer[bot]", "opencodeengineer[bot]")).toBe(false)
  })
})

describe("issueLinkMentioned", () => {
  it("accepts standard closing keywords", () => {
    expect(issueLinkMentioned("Closes #42", 42)).toBe(true)
    expect(issueLinkMentioned("Fixes #42", 42)).toBe(true)
    expect(issueLinkMentioned("Resolves #42", 42)).toBe(true)
  })

  it("rejects unrelated bodies", () => {
    expect(issueLinkMentioned("Related to #42", 42)).toBe(false)
  })
})

describe("textMentionsUrl", () => {
  it("checks whether the final GitHub reply surfaced the PR url", () => {
    expect(textMentionsUrl("PR: https://github.com/acme/repo/pull/5", "https://github.com/acme/repo/pull/5")).toBe(true)
    expect(textMentionsUrl("No PR here", "https://github.com/acme/repo/pull/5")).toBe(false)
  })
})

describe("textStartsWithHandle", () => {
  it("requires the real GitHub App handle at the start of the command", () => {
    expect(textStartsWithHandle("@codexengineer run fix the bug", "@codexengineer")).toBe(true)
    expect(textStartsWithHandle("@OpenCodeEvalApp run fix the bug", "@opencodeengineer")).toBe(false)
  })
})

describe("renderedHtmlHasHandleUserMentionLink", () => {
  it("detects rendered user-mention links", () => {
    expect(renderedHtmlHasHandleUserMentionLink('<p><a class="user-mention" href="/codexengineer">@codexengineer</a></p>', "@codexengineer")).toBe(true)
  })

  it("does not treat plain handle text as a rendered mention link", () => {
    expect(renderedHtmlHasHandleUserMentionLink("<p>@opencodebridgeapp run it</p>", "@opencodebridgeapp")).toBe(false)
  })

  it("does not match a different mention in the same html", () => {
    expect(renderedHtmlHasHandleUserMentionLink('<p><a class="user-mention" href="/someoneelse">@someoneelse</a></p>', "@opencodebridgeapp")).toBe(false)
  })
})

describe("githubAppSlugMatchesHandle", () => {
  it("matches the performed_via slug to the expected handle", () => {
    expect(githubAppSlugMatchesHandle("opencodebridgeapp", "@opencodebridgeapp")).toBe(true)
  })

  it("rejects mismatched app slugs", () => {
    expect(githubAppSlugMatchesHandle("codexengineer", "@opencodebridgeapp")).toBe(false)
  })
})
