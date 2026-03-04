export class Throttler {
  private last = 0
  constructor(private intervalMs: number) {}

  shouldRun() {
    const now = Date.now()
    if (now - this.last >= this.intervalMs) {
      this.last = now
      return true
    }
    return false
  }
}
