import { describe, it, expect } from "vitest"
import { ProgressTracker } from "./progress.js"

describe("ProgressTracker", () => {
  it("starts with empty snapshot", () => {
    const tracker = new ProgressTracker()
    const snap = tracker.snapshot()
    expect(snap.lines).toEqual([])
    expect(snap.lastAgentMessage).toBeUndefined()
  })

  it("pushLine adds lines to snapshot", () => {
    const tracker = new ProgressTracker()
    tracker.pushLine("step 1")
    tracker.pushLine("step 2")
    const snap = tracker.snapshot()
    expect(snap.lines).toEqual(["step 1", "step 2"])
  })

  it("ignores empty lines", () => {
    const tracker = new ProgressTracker()
    tracker.pushLine("")
    tracker.pushLine("real line")
    tracker.pushLine("")
    const snap = tracker.snapshot()
    expect(snap.lines).toEqual(["real line"])
  })

  it("caps lines at 8, keeping the most recent", () => {
    const tracker = new ProgressTracker()
    for (let i = 1; i <= 12; i++) {
      tracker.pushLine(`line ${i}`)
    }
    const snap = tracker.snapshot()
    expect(snap.lines).toHaveLength(8)
    expect(snap.lines[0]).toBe("line 5")
    expect(snap.lines[7]).toBe("line 12")
  })

  it("setAgentMessage stores last agent message", () => {
    const tracker = new ProgressTracker()
    tracker.setAgentMessage("hello")
    expect(tracker.snapshot().lastAgentMessage).toBe("hello")
  })

  it("setAgentMessage overwrites previous message", () => {
    const tracker = new ProgressTracker()
    tracker.setAgentMessage("first")
    tracker.setAgentMessage("second")
    expect(tracker.snapshot().lastAgentMessage).toBe("second")
  })

  it("snapshot returns a copy of lines", () => {
    const tracker = new ProgressTracker()
    tracker.pushLine("a")
    const snap = tracker.snapshot()
    snap.lines.push("mutated")
    expect(tracker.snapshot().lines).toEqual(["a"])
  })

  it("updates updatedAt on pushLine", () => {
    const tracker = new ProgressTracker()
    const before = tracker.snapshot().updatedAt
    tracker.pushLine("x")
    const after = tracker.snapshot().updatedAt
    expect(after).toBeGreaterThanOrEqual(before)
  })
})
