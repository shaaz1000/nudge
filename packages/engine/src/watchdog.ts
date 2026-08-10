import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock, Cancel } from './clock.js'
import type { SessionStore, Transition } from './state.js'

/**
 * Heuristic, and honest about it: a session sitting in PreToolUse on a
 * nine-minute test script is indistinguishable from a crashed one. Hence the
 * conservative default and no phone escalation unless explicitly enabled.
 */
export class Watchdog {
  constructor(
    private cfg: NudgeConfig,
    private clock: Clock,
    private store: SessionStore,
    private onStall: (t: Transition) => void,
  ) {}

  start(): Cancel {
    let cancelled = false
    let cancelTimer: Cancel = () => {}
    const loop = () => {
      if (cancelled) return
      this.tick()
      cancelTimer = this.clock.schedule(this.cfg.watchdog.tickMs, loop)
    }
    cancelTimer = this.clock.schedule(this.cfg.watchdog.tickMs, loop)
    return () => { cancelled = true; cancelTimer() }
  }

  tick(): void {
    // TTL first: an expired session should be dropped, not resurrected as stalled.
    for (const id of this.store.idsOlderThan(this.cfg.watchdog.sessionTtlMs)) {
      this.store.drop(id)
    }

    const cutoff = this.clock.now() - this.cfg.watchdog.stallAfterMs
    for (const s of this.store.list()) {
      if (s.status !== 'running') continue
      if (s.lastEventAt > cutoff) continue
      const t = this.store.markStalled(s.sessionId)
      if (t) this.onStall(t)
    }
  }
}
