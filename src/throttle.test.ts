import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Throttler } from "./throttle.js"

describe("Throttler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("allows the first call", () => {
    const throttler = new Throttler(1000)
    expect(throttler.shouldRun()).toBe(true)
  })

  it("blocks calls within the interval", () => {
    const throttler = new Throttler(1000)
    expect(throttler.shouldRun()).toBe(true)
    expect(throttler.shouldRun()).toBe(false)
  })

  it("allows calls after the interval elapses", () => {
    const throttler = new Throttler(1000)
    expect(throttler.shouldRun()).toBe(true)

    vi.advanceTimersByTime(999)
    expect(throttler.shouldRun()).toBe(false)

    vi.advanceTimersByTime(1)
    expect(throttler.shouldRun()).toBe(true)
  })

  it("resets the timer after each allowed call", () => {
    const throttler = new Throttler(500)
    expect(throttler.shouldRun()).toBe(true)

    vi.advanceTimersByTime(500)
    expect(throttler.shouldRun()).toBe(true)

    vi.advanceTimersByTime(250)
    expect(throttler.shouldRun()).toBe(false)

    vi.advanceTimersByTime(250)
    expect(throttler.shouldRun()).toBe(true)
  })

  it("works with zero interval (always allows)", () => {
    const throttler = new Throttler(0)
    expect(throttler.shouldRun()).toBe(true)
    expect(throttler.shouldRun()).toBe(true)
    expect(throttler.shouldRun()).toBe(true)
  })
})
