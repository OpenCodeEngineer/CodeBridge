import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { createVibeAgentsSink } from "../src/vibe-agents.js"
import type { RunRecord } from "../src/types.js"

type CapturedRequest = {
  headers: Record<string, string | string[] | undefined>
  body: any
}

const captured: CapturedRequest[] = []

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", chunk => chunks.push(Buffer.from(chunk)))
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8")
    captured.push({
      headers: req.headers,
      body: raw ? JSON.parse(raw) : {}
    })
    res.statusCode = 204
    res.end()
  })
})

server.listen(0, "127.0.0.1")
await once(server, "listening")

try {
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server port")
  }

  const sink = createVibeAgentsSink({
    endpoint: `http://127.0.0.1:${address.port}/agents`,
    token: "test-token",
    author: "dzianisv",
    project: "VibeWebAgent",
    enabled: true,
    timeoutMs: 2000
  })

  const run: RunRecord = {
    id: "run-123",
    tenantId: "local",
    repoFullName: "dzianisv/codebridge-test",
    repoPath: "/tmp/repo",
    status: "queued",
    prompt: "Investigate the issue",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    github: {
      owner: "dzianisv",
      repo: "codebridge-test",
      issueNumber: 3
    }
  }

  await sink.sendRunCreated(run)
  await sink.sendRunStatus(run, "running")
  await sink.sendRunStatus(run, "failed", { summary: "Runner crashed" })
  await sink.sendRunStatus(run, "succeeded", {
    summary: "Completed",
    prUrl: "https://github.com/dzianisv/codebridge-test/pull/7"
  })

  assert.equal(captured.length, 4, "expected 4 lifecycle events")
  assert.equal(captured[0].body.eventType, "session.created")
  assert.equal(captured[1].body.lifecycle, "in-progress")
  assert.equal(captured[2].body.lifecycle, "idle")
  assert.equal(captured[3].body.lifecycle, "completed")
  assert.equal(captured[3].body.prUrl, "https://github.com/dzianisv/codebridge-test/pull/7")
  assert.equal(captured[0].headers.authorization, "Bearer test-token")
  assert.equal(captured[0].body.author, "dzianisv")
  assert.equal(captured[0].body.project, "VibeWebAgent")

  console.log("test:vibe-agents passed")
} finally {
  server.close()
  await once(server, "close")
}
