import { Queue, Worker } from "bullmq"
import { logger } from "./logger.js"

export type RunJob = {
  runId: string
}

export type RunQueue = {
  add: (name: string, job: RunJob) => Promise<void>
}

type QueueMode = "redis" | "memory"

type MemoryState = {
  jobs: RunJob[]
  processing: boolean
  handlers: Set<(job: RunJob) => Promise<void>>
}

const memoryState: MemoryState = {
  jobs: [],
  processing: false,
  handlers: new Set()
}

function scheduleMemoryQueue() {
  void processMemoryQueue().catch(error => {
    logger.error(error, "Memory queue processing crashed")
  })
}

async function processMemoryQueue() {
  if (memoryState.processing) return
  memoryState.processing = true
  try {
    while (memoryState.jobs.length > 0) {
      const job = memoryState.jobs.shift()
      if (!job) continue
      for (const handler of memoryState.handlers) {
        try {
          await handler(job)
        } catch (error) {
          logger.error(error, "Memory queue job failed")
        }
      }
    }
  } finally {
    memoryState.processing = false
    // A job may be enqueued while `processing` is still true but the loop is
    // already exiting. Kick the processor again to avoid stranded jobs.
    if (memoryState.jobs.length > 0) {
      scheduleMemoryQueue()
    }
  }
}

function resolveMode(redisUrl?: string, mode?: QueueMode): QueueMode {
  if (mode) return mode
  if (!redisUrl || redisUrl === "memory") return "memory"
  return "redis"
}

export function createQueue(redisUrl?: string, mode?: QueueMode) {
  const resolved = resolveMode(redisUrl, mode)
  if (resolved === "memory") {
    const queue: RunQueue = {
      add: async (_name: string, job: RunJob) => {
        memoryState.jobs.push(job)
        scheduleMemoryQueue()
      }
    }
    return {
      queue,
      connection: null
    }
  }

  const connection = resolveRedisConnection(redisUrl as string)
  const bullQueue = new Queue<RunJob, void, string>("codex-runs", { connection })
  const queue: RunQueue = {
    add: async (name: string, job: RunJob) => {
      await bullQueue.add(name, job)
    }
  }
  return { queue, connection }
}

export function startWorker(redisUrl: string | undefined, handler: (job: RunJob) => Promise<void>, mode?: QueueMode) {
  const resolved = resolveMode(redisUrl, mode)
  if (resolved === "memory") {
    memoryState.handlers.add(handler)
    scheduleMemoryQueue()
    return {
      worker: {
        close: async () => {
          memoryState.handlers.delete(handler)
        }
      },
      connection: null
    }
  }

  const connection = resolveRedisConnection(redisUrl as string)
  const worker = new Worker<RunJob>(
    "codex-runs",
    async job => {
      await handler(job.data)
    },
    { connection }
  )
  return { worker, connection }
}

function resolveRedisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl)
  const db = parsed.pathname ? Number(parsed.pathname.replace("/", "")) : undefined
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    tls: parsed.protocol === "rediss:" ? {} : undefined
  }
}
