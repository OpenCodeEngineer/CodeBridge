import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { parseOpenCodeModel, runOpenCodePrompt } from "./opencode.js"

describe("parseOpenCodeModel", () => {
  it("parses provider/model ids", () => {
    expect(parseOpenCodeModel("openai/gpt-5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5"
    })
  })

  it("throws on invalid values", () => {
    expect(() => parseOpenCodeModel("gpt-5")).toThrow("provider/model")
  })
})

describe("runOpenCodePrompt", () => {
  const servers = new Set<http.Server>()

  afterEach(async () => {
    await Promise.all([...servers].map(server => closeServer(server)))
    servers.clear()
  })

  it("submits prompts with directory scoping and returns the final assistant text", async () => {
    let statusCalls = 0
    let promptBody: any
    const headers: string[] = []
    const directories: string[] = []

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      headers.push(String(req.headers["x-opencode-directory"] ?? ""))
      if (!url.pathname.startsWith("/global/")) {
        directories.push(url.searchParams.get("directory") ?? "")
      }

      if (req.method === "GET" && url.pathname === "/global/health") {
        return json(res, 200, { healthy: true, version: "1.2.27" })
      }
      if (req.method === "POST" && url.pathname === "/session") {
        return json(res, 200, { id: "ses_1", title: "Session title", directory: "/tmp/repo" })
      }
      if (req.method === "POST" && url.pathname === "/session/ses_1/prompt_async") {
        promptBody = await readJson(req)
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === "GET" && url.pathname === "/session/status") {
        statusCalls += 1
        return json(res, 200, {
          ses_1: {
            type: statusCalls >= 2 ? "idle" : "busy"
          }
        })
      }
      if (req.method === "GET" && url.pathname === "/session/ses_1/message") {
        return json(res, 200, [
          {
            info: {
              id: "msg_1",
              role: "assistant",
              time: { created: 1, completed: 2 },
              providerID: "openai",
              modelID: "gpt-5"
            },
            parts: [
              {
                id: "part_1",
                type: "text",
                text: "Done"
              }
            ]
          }
        ])
      }

      res.writeHead(404)
      res.end()
    })
    servers.add(server)

    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await runOpenCodePrompt({
      integration: {
        baseUrl,
        timeoutMs: 30_000,
        pollIntervalMs: 10
      },
      directory: "/tmp/repo",
      title: "Session title",
      prompt: "Fix it",
      agent: "build",
      model: "openai/gpt-5",
      tools: {
        github: false
      }
    })

    expect(result.sessionId).toBe("ses_1")
    expect(result.responseText).toBe("Done")
    expect(headers[0]).toBe(encodeURIComponent("/tmp/repo"))
    expect(directories.every(directory => directory === "/tmp/repo")).toBe(true)
    expect(promptBody).toMatchObject({
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5"
      },
      tools: {
        github: false
      }
    })
    expect(promptBody.parts[0]).toMatchObject({
      type: "text",
      text: "Fix it"
    })
  })

  it("requests a summary when the assistant returns no text part", async () => {
    let summaryRequested = false
    let statusCalls = 0

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (req.method === "GET" && url.pathname === "/global/health") {
        return json(res, 200, { healthy: true, version: "1.2.27" })
      }
      if (req.method === "POST" && url.pathname === "/session") {
        return json(res, 200, { id: "ses_1", title: "Session title", directory: "/tmp/repo" })
      }
      if (req.method === "POST" && url.pathname === "/session/ses_1/prompt_async") {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === "GET" && url.pathname === "/session/status") {
        statusCalls += 1
        return json(res, 200, {
          ses_1: {
            type: statusCalls >= 2 ? "idle" : "busy"
          }
        })
      }
      if (req.method === "GET" && url.pathname === "/session/ses_1/message") {
        return json(res, 200, [
          {
            info: {
              id: "msg_1",
              role: "assistant",
              time: { created: 1, completed: 2 },
              providerID: "openai",
              modelID: "gpt-5"
            },
            parts: [
              {
                id: "tool_1",
                type: "tool",
                tool: "edit",
                state: {
                  status: "completed",
                  title: "Updated file"
                }
              }
            ]
          }
        ])
      }
      if (req.method === "POST" && url.pathname === "/session/ses_1/message") {
        const body = await readJson(req)
        summaryRequested = body?.tools?.["*"] === false
        return json(res, 200, {
          info: {
            id: "msg_2",
            role: "assistant",
            time: { created: 3, completed: 4 },
            providerID: "openai",
            modelID: "gpt-5"
          },
          parts: [
            {
              id: "part_2",
              type: "text",
              text: "Summary text"
            }
          ]
        })
      }

      res.writeHead(404)
      res.end()
    })
    servers.add(server)

    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await runOpenCodePrompt({
      integration: {
        baseUrl,
        timeoutMs: 30_000,
        pollIntervalMs: 10
      },
      directory: "/tmp/repo",
      title: "Session title",
      prompt: "Fix it",
      model: "openai/gpt-5"
    })

    expect(summaryRequested).toBe(true)
    expect(result.responseText).toBe("Summary text")
  })

  it("ignores a trailing empty assistant placeholder and summarizes the last meaningful completed turn", async () => {
    let summaryRequested = false
    let statusCalls = 0

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (req.method === "GET" && url.pathname === "/global/health") {
        return json(res, 200, { healthy: true, version: "1.2.27" })
      }
      if (req.method === "POST" && url.pathname === "/session") {
        return json(res, 200, { id: "ses_1", title: "Session title", directory: "/tmp/repo" })
      }
      if (req.method === "POST" && url.pathname === "/session/ses_1/prompt_async") {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === "GET" && url.pathname === "/session/status") {
        statusCalls += 1
        return json(res, 200, statusCalls === 1 ? {
          ses_1: {
            type: "busy"
          }
        } : {})
      }
      if (req.method === "GET" && url.pathname === "/session/ses_1/message") {
        return json(res, 200, [
          {
            info: {
              id: "msg_1",
              role: "assistant",
              time: { created: 1, completed: 2 },
              providerID: "openai",
              modelID: "gpt-5"
            },
            parts: [
              {
                id: "tool_1",
                type: "tool",
                tool: "edit",
                state: {
                  status: "completed",
                  title: "Updated file"
                }
              }
            ]
          },
          {
            info: {
              id: "msg_2",
              role: "assistant",
              time: { created: 3 },
              providerID: "openai",
              modelID: "gpt-5"
            },
            parts: []
          }
        ])
      }
      if (req.method === "POST" && url.pathname === "/session/ses_1/message") {
        const body = await readJson(req)
        summaryRequested = body?.tools?.["*"] === false
        return json(res, 200, {
          info: {
            id: "msg_3",
            role: "assistant",
            time: { created: 4, completed: 5 },
            providerID: "openai",
            modelID: "gpt-5"
          },
          parts: [
            {
              id: "part_3",
              type: "text",
              text: "Recovered summary"
            }
          ]
        })
      }

      res.writeHead(404)
      res.end()
    })
    servers.add(server)

    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await runOpenCodePrompt({
      integration: {
        baseUrl,
        timeoutMs: 30_000,
        pollIntervalMs: 10
      },
      directory: "/tmp/repo",
      title: "Session title",
      prompt: "Fix it",
      model: "openai/gpt-5"
    })

    expect(summaryRequested).toBe(true)
    expect(result.responseText).toBe("Recovered summary")
  })

  it("fails fast when the session becomes idle with only an empty assistant placeholder", async () => {
    let statusCalls = 0

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (req.method === "GET" && url.pathname === "/global/health") {
        return json(res, 200, { healthy: true, version: "1.2.27" })
      }
      if (req.method === "POST" && url.pathname === "/session") {
        return json(res, 200, { id: "ses_1", title: "Session title", directory: "/tmp/repo" })
      }
      if (req.method === "POST" && url.pathname === "/session/ses_1/prompt_async") {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === "GET" && url.pathname === "/session/status") {
        statusCalls += 1
        return json(res, 200, statusCalls === 1 ? {
          ses_1: {
            type: "busy"
          }
        } : {})
      }
      if (req.method === "GET" && url.pathname === "/session/ses_1/message") {
        return json(res, 200, [
          {
            info: {
              id: "msg_1",
              role: "assistant",
              time: { created: 1 },
              providerID: "github-copilot",
              modelID: "gemini-3.1-pro-preview"
            },
            parts: []
          }
        ])
      }

      res.writeHead(404)
      res.end()
    })
    servers.add(server)

    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await expect(runOpenCodePrompt({
      integration: {
        baseUrl,
        timeoutMs: 30_000,
        pollIntervalMs: 250
      },
      directory: "/tmp/repo",
      title: "Session title",
      prompt: "Fix it",
      model: "github-copilot/gemini-3.1-pro-preview"
    })).rejects.toThrow("OpenCode stalled without a terminal response")
  })
})

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(error) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
  return server
}

async function closeServer(server: http.Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : undefined
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
