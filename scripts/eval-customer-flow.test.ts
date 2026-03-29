import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { verifyWorkspaceRunPath } from "./eval-customer-flow.js"

describe("verifyWorkspaceRunPath", () => {
  it("reports base clone existence separately from the task worktree path", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codebridge-workspace-proof-"))
    try {
      const baseClonePath = path.join(root, "codebridge-test")
      const worktreePath = path.join(root, ".codebridge", "worktrees", "dzianisv__codebridge-test", "run-123")
      mkdirSync(baseClonePath, { recursive: true })
      mkdirSync(worktreePath, { recursive: true })

      expect(
        verifyWorkspaceRunPath({
          repo: "dzianisv/codebridge-test",
          repoPath: worktreePath,
          workspaceRoot: root
        })
      ).toEqual({
        workspaceRoot: root,
        expectedBaseClonePath: baseClonePath,
        baseCloneExists: true,
        repoPath: worktreePath,
        repoPathWithinWorkspace: true,
        repoPathUsesWorktreeLayout: true,
        repoPathEqualsBaseClone: false
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
