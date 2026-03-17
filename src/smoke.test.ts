import { describe, it, expect } from "vitest"

describe("Smoke test", () => {
  it("should run basic assertions", () => {
    expect(1 + 1).toBe(2)
  })

  it("should handle async operations", async () => {
    const result = await Promise.resolve("test")
    expect(result).toBe("test")
  })
})
