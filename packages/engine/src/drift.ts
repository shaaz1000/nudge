import type { Clock, Cancel } from './clock.js'

export interface DriftDeps {
  clock: Clock
  /** Wall clock, normally Date.now. */
  wall: () => number
  /** Monotonic source, normally performance.now — unaffected by clock sets. */
  mono: () => number
  onDrift: (skewMs: number) => void
  intervalMs?: number
  thresholdMs?: number
}

/**
 * setTimeout does not fire while a machine sleeps, and a wall clock can be set
 * backwards at any time. Comparing wall movement against a monotonic source
 * detects both: a divergence past the threshold means the engine's view of
 * elapsed time is no longer trustworthy and waiting sessions must be re-armed.
 */
export class DriftDetector {
  #lastWall: number | null = null
  #lastMono: number | null = null

  constructor(private d: DriftDeps) {}

  start(): Cancel {
    const interval = this.d.intervalMs ?? 10_000
    let cancelled = false
    let cancelTimer: Cancel = () => {}
    this.check()
    const loop = () => {
      if (cancelled) return
      try {
        this.check()
      } catch (err) {
        console.error('nudge drift: check failed', err)
      } finally {
        cancelTimer = this.d.clock.schedule(interval, loop)
      }
    }
    cancelTimer = this.d.clock.schedule(interval, loop)
    return () => { cancelled = true; cancelTimer() }
  }

  check(): void {
    const wall = this.d.wall()
    const mono = this.d.mono()

    if (this.#lastWall === null || this.#lastMono === null) {
      this.#lastWall = wall
      this.#lastMono = mono
      return
    }

    const skew = (wall - this.#lastWall) - (mono - this.#lastMono)
    this.#lastWall = wall
    this.#lastMono = mono

    if (Math.abs(skew) >= (this.d.thresholdMs ?? 5_000)) this.d.onDrift(skew)
  }
}
