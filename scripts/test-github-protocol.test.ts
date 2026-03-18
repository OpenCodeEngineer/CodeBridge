import path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveCandidateSqlitePaths, resolveSqliteFilePath } from "./test-github-protocol.js"

describe("resolveSqliteFilePath", () => {
  it("accepts sqlite:// file URLs", () => {
    expect(resolveSqliteFilePath("sqlite:///tmp/codebridge.db")).toBe("/tmp/codebridge.db")
  })

  it("accepts plain sqlite file paths", () => {
    expect(resolveSqliteFilePath("./tmp/codebridge.db")).toBe(path.join(process.cwd(), "./tmp/codebridge.db"))
  })

  it("rejects in-memory sqlite URLs for file-backed polling", () => {
    expect(resolveSqliteFilePath(":memory:")).toBeNull()
    expect(resolveSqliteFilePath("sqlite::memory:")).toBeNull()
  })
})

describe("resolveCandidateSqlitePaths", () => {
  it("includes plain sqlite file paths", () => {
    const candidates = resolveCandidateSqlitePaths("./tmp/codebridge.db")
    expect(candidates).toContain(path.join(process.cwd(), "./tmp/codebridge.db"))
  })
})
