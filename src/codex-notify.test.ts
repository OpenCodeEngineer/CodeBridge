import { describe, it, expect } from "vitest"
import { _testHelpers } from "./codex-notify.js"

const {
  normalizeTurnPayload,
  buildIssueTitle,
  buildIssueBody,
  buildUserPromptComment,
  buildAssistantComment,
  sessionMarker,
  sessionMarkerVariants,
  turnMarker,
  turnMarkerVariants,
  truncate,
  isLoopbackAddress,
  isLoopbackRequest
} = _testHelpers

// ── normalizeTurnPayload ─────────────────────────────────────────────

describe("normalizeTurnPayload", () => {
  it("parses agent-turn-complete format (kebab-case keys)", () => {
    const result = normalizeTurnPayload({
      type: "agent-turn-complete",
      "thread-id": "sess-001",
      "turn-id": "turn-001",
      cwd: "/tmp/repo",
      "input-messages": ["fix the bug"],
      "last-assistant-message": "Done, bug fixed."
    })
    expect(result).toEqual({
      sessionId: "sess-001",
      turnId: "turn-001",
      cwd: "/tmp/repo",
      inputMessages: ["fix the bug"],
      lastAssistantMessage: "Done, bug fixed."
    })
  })

  it("parses agent-turn-complete format (snake_case keys)", () => {
    const result = normalizeTurnPayload({
      type: "agent-turn-complete",
      thread_id: "sess-002",
      turn_id: "turn-002",
      cwd: "/tmp/repo",
      input_messages: ["create a file"],
      last_assistant_message: "File created."
    })
    expect(result).toEqual({
      sessionId: "sess-002",
      turnId: "turn-002",
      cwd: "/tmp/repo",
      inputMessages: ["create a file"],
      lastAssistantMessage: "File created."
    })
  })

  it("parses wrapped payload format", () => {
    const result = normalizeTurnPayload({
      payload: {
        type: "agent-turn-complete",
        "thread-id": "sess-003",
        "turn-id": "turn-003",
        cwd: "/tmp/repo",
        "input-messages": ["deploy"],
      }
    })
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe("sess-003")
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it("parses hook_event format (Codex CLI after_agent hook)", () => {
    const result = normalizeTurnPayload({
      session_id: "sess-cli",
      cwd: "/home/user/project",
      hook_event: {
        event_type: "after_agent",
        thread_id: "thread-ignored",
        turn_id: "turn-hook",
        input_messages: ["hello world"],
        last_assistant_message: "Hi there"
      }
    })
    expect(result).toEqual({
      sessionId: "sess-cli",
      turnId: "turn-hook",
      cwd: "/home/user/project",
      inputMessages: ["hello world"],
      lastAssistantMessage: "Hi there"
    })
  })

  it("returns null for missing required fields", () => {
    expect(normalizeTurnPayload({ type: "agent-turn-complete" })).toBeNull()
    expect(normalizeTurnPayload({
      type: "agent-turn-complete",
      "thread-id": "sess",
      // missing turn-id, cwd
    })).toBeNull()
  })

  it("returns null for non-object input", () => {
    expect(normalizeTurnPayload(null)).toBeNull()
    expect(normalizeTurnPayload(undefined)).toBeNull()
    expect(normalizeTurnPayload("string")).toBeNull()
    expect(normalizeTurnPayload(42)).toBeNull()
  })

  it("returns null for unknown hook_event type", () => {
    expect(normalizeTurnPayload({
      session_id: "s",
      cwd: "/tmp",
      hook_event: {
        event_type: "before_agent",
        turn_id: "t"
      }
    })).toBeNull()
  })

  it("trims whitespace from string fields", () => {
    const result = normalizeTurnPayload({
      type: "agent-turn-complete",
      "thread-id": "  sess  ",
      "turn-id": "  turn  ",
      cwd: "  /tmp  ",
      "input-messages": ["  hello  ", "  ", "world"]
    })
    expect(result!.sessionId).toBe("sess")
    expect(result!.turnId).toBe("turn")
    expect(result!.cwd).toBe("/tmp")
    expect(result!.inputMessages).toEqual(["hello", "world"])
  })

  it("rejects empty-string session/turn/cwd", () => {
    expect(normalizeTurnPayload({
      type: "agent-turn-complete",
      "thread-id": "   ",
      "turn-id": "t",
      cwd: "/tmp"
    })).toBeNull()
  })
})

// ── Issue auto-creation helpers ──────────────────────────────────────

describe("buildIssueTitle", () => {
  it("uses first non-empty line of prompt", () => {
    const title = buildIssueTitle("Fix the login bug", "sess-1")
    expect(title).toContain("Fix the login bug")
    expect(title).toContain("sess-1")
  })

  it("skips blank leading lines", () => {
    const title = buildIssueTitle("\n\n  Fix it\nmore details", "s")
    expect(title).toContain("Fix it")
  })

  it("truncates long titles to 120 chars", () => {
    const long = "A".repeat(200)
    const title = buildIssueTitle(long, "s")
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title).toContain("...")
  })

  it("falls back to 'Codex task' for empty prompt", () => {
    const title = buildIssueTitle("", "s")
    expect(title).toContain("Codex task")
  })
})

describe("buildIssueBody", () => {
  it("includes session marker for recovery", () => {
    const body = buildIssueBody("Do something", "sess-42")
    expect(body).toContain("<!-- codebridge-session:sess-42 -->")
  })

  it("includes the prompt text", () => {
    const body = buildIssueBody("Create hello.py", "s")
    expect(body).toContain("Create hello.py")
  })

  it("indicates auto-creation", () => {
    const body = buildIssueBody("task", "s")
    expect(body.toLowerCase()).toContain("automatically")
  })
})

// ── Comment mirroring (R6) ───────────────────────────────────────────

describe("buildUserPromptComment", () => {
  it("includes the turn marker for dedup", () => {
    const marker = turnMarker("s1", "t1", "user")
    const comment = buildUserPromptComment(marker, ["Fix the tests"])
    expect(comment).toContain(marker)
    expect(comment).toContain("Fix the tests")
  })

  it("joins multiple input messages", () => {
    const marker = turnMarker("s", "t", "user")
    const comment = buildUserPromptComment(marker, ["msg1", "msg2"])
    expect(comment).toContain("msg1")
    expect(comment).toContain("msg2")
  })

  it("shows _empty_ when no messages", () => {
    const marker = turnMarker("s", "t", "user")
    const comment = buildUserPromptComment(marker, [])
    expect(comment).toContain("_empty_")
  })
})

describe("buildAssistantComment", () => {
  it("includes marker and response body", () => {
    const marker = turnMarker("s1", "t1", "assistant")
    const comment = buildAssistantComment(marker, "I created the file.")
    expect(comment).toContain(marker)
    expect(comment).toContain("I created the file.")
    expect(comment).toContain("Codex response")
  })
})

// ── Markers (dedup & session recovery) ───────────────────────────────

describe("markers", () => {
  it("sessionMarker embeds session ID in HTML comment", () => {
    expect(sessionMarker("abc-123")).toBe("<!-- codebridge-session:abc-123 -->")
  })

  it("sessionMarkerVariants includes legacy format", () => {
    const variants = sessionMarkerVariants("abc")
    expect(variants).toHaveLength(2)
    expect(variants).toContain("<!-- codebridge-session:abc -->")
    expect(variants).toContain("<!-- codex-bridge-session:abc -->")
  })

  it("turnMarker embeds session, turn, and kind", () => {
    expect(turnMarker("s", "t", "user")).toBe("<!-- codebridge-turn:s:t:user -->")
    expect(turnMarker("s", "t", "assistant")).toBe("<!-- codebridge-turn:s:t:assistant -->")
  })

  it("turnMarkerVariants includes legacy format", () => {
    const variants = turnMarkerVariants("s", "t", "user")
    expect(variants).toHaveLength(2)
    expect(variants).toContain("<!-- codebridge-turn:s:t:user -->")
    expect(variants).toContain("<!-- codex-bridge-turn:s:t:user -->")
  })
})

// ── Loopback security ────────────────────────────────────────────────

describe("isLoopbackAddress", () => {
  it("accepts IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
  })

  it("accepts IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true)
  })

  it("accepts IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
  })

  it("rejects external IPs", () => {
    expect(isLoopbackAddress("192.168.1.1")).toBe(false)
    expect(isLoopbackAddress("10.0.0.1")).toBe(false)
  })

  it("rejects undefined/empty", () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress("")).toBe(false)
  })
})

describe("isLoopbackRequest", () => {
  it("accepts when either ip or remoteAddress is loopback", () => {
    expect(isLoopbackRequest("127.0.0.1", "10.0.0.1")).toBe(true)
    expect(isLoopbackRequest("10.0.0.1", "::1")).toBe(true)
  })

  it("rejects when neither is loopback", () => {
    expect(isLoopbackRequest("10.0.0.1", "192.168.1.1")).toBe(false)
  })
})

// ── truncate ─────────────────────────────────────────────────────────

describe("truncate", () => {
  it("leaves short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("truncates with ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello...")
  })

  it("handles exact boundary", () => {
    expect(truncate("12345", 5)).toBe("12345")
    expect(truncate("123456", 5)).toBe("12...")
  })
})
