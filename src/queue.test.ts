import { describe, it, expect } from "vitest"

// queue.ts has a mix of Redis-dependent and pure-logic code.
// We test the memory queue and the resolveMode logic.
// Redis queue tests would require a running Redis instance.

describe("memory queue", () => {
  it("creates a memory queue without redis", async () => {
    const { createQueue } = await import("./queue.js")
    const { queue, connection } = createQueue(undefined, "memory")
    expect(queue).toBeDefined()
    expect(queue.add).toBeTypeOf("function")
    expect(connection).toBeNull()
  })

  it("enqueues and processes jobs", async () => {
    const { createQueue, startWorker } = await import("./queue.js")
    const { queue } = createQueue(undefined, "memory")

    const processed: string[] = []
    const { worker } = startWorker(undefined, async (job) => {
      processed.push(job.runId)
    }, "memory")

    await queue.add("test-job", { runId: "run-1" })

    // Give the async memory queue time to process
    await new Promise(r => setTimeout(r, 100))

    expect(processed).toContain("run-1")

    await worker.close()
  })

  it("processes multiple jobs in order", async () => {
    const { createQueue, startWorker } = await import("./queue.js")
    const { queue } = createQueue(undefined, "memory")

    const processed: string[] = []
    const { worker } = startWorker(undefined, async (job) => {
      processed.push(job.runId)
    }, "memory")

    await queue.add("job-1", { runId: "r1" })
    await queue.add("job-2", { runId: "r2" })
    await queue.add("job-3", { runId: "r3" })

    await new Promise(r => setTimeout(r, 200))

    expect(processed).toEqual(["r1", "r2", "r3"])

    await worker.close()
  })

  it("handler errors don't crash the queue", async () => {
    const { createQueue, startWorker } = await import("./queue.js")
    const { queue } = createQueue(undefined, "memory")

    const processed: string[] = []
    const { worker } = startWorker(undefined, async (job) => {
      if (job.runId === "fail") throw new Error("boom")
      processed.push(job.runId)
    }, "memory")

    await queue.add("f", { runId: "fail" })
    await queue.add("s", { runId: "success" })

    await new Promise(r => setTimeout(r, 200))

    expect(processed).toContain("success")

    await worker.close()
  })

  it("worker close removes handler", async () => {
    const { createQueue, startWorker } = await import("./queue.js")
    const { queue } = createQueue(undefined, "memory")

    const processed: string[] = []
    const { worker } = startWorker(undefined, async (job) => {
      processed.push(job.runId)
    }, "memory")

    await worker.close()

    await queue.add("after-close", { runId: "should-not-process" })
    await new Promise(r => setTimeout(r, 100))

    // Job should not be processed since handler was removed
    expect(processed).not.toContain("should-not-process")
  })
})

describe("queue mode resolution", () => {
  it("defaults to memory when no redis URL", async () => {
    const { createQueue } = await import("./queue.js")
    const { connection } = createQueue(undefined)
    expect(connection).toBeNull()
  })

  it("defaults to memory when redis URL is 'memory'", async () => {
    const { createQueue } = await import("./queue.js")
    const { connection } = createQueue("memory")
    expect(connection).toBeNull()
  })

  it("uses memory when explicitly set", async () => {
    const { createQueue } = await import("./queue.js")
    const { connection } = createQueue("redis://localhost:6379", "memory")
    expect(connection).toBeNull()
  })
})
