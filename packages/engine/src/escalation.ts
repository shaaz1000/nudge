import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import { escalateDelayFor } from '@nudge/shared/config'
import type { Clock, Cancel } from './clock.js'

export interface EscalatorDeps {
  cfg: NudgeConfig
  clock: Clock
  /** How long the machine has been idle, read at the moment of decision. */
  idleMs: () => number
  onLocal: (s: SessionState, tier: Tier, repeat: number) => void
  onPhone: (s: SessionState, tier: Tier, repeat: number) => void
}

export class Escalator {
  #timers = new Map<string, Cancel[]>()

  constructor(private d: EscalatorDeps) {}

  activeCount(): number { return this.#timers.size }

  #track(sessionId: string, cancel: Cancel): void {
    const list = this.#timers.get(sessionId)
    if (list) list.push(cancel)
    else this.#timers.set(sessionId, [cancel])
  }

  /** Start the ladder for a session that has just begun waiting. */
  begin(s: SessionState, tier: Tier): void {
    this.cancel(s.sessionId)
    this.#timers.set(s.sessionId, [])

    const d = this.d
    const { cfg, clock } = d

    // t=0 — local alert.
    d.onLocal(s, tier, 0)

    // Local repeats.
    for (let i = 1; i <= cfg.escalation.localRepeat; i++) {
      const at = cfg.escalation.localRepeatIntervalMs * i
      this.#track(s.sessionId, clock.schedule(at, () => d.onLocal(s, tier, i)))
    }

    // Phone escalation. The required delay is idle-adaptive, and idle state
    // can change at any moment during the wait — so we can't compute it once
    // at begin() and arm a single timer for it. Instead we poll: every
    // `idleDelayMs` (or sooner, if less time remains), re-read idleMs() and
    // recompute the delay the *current* idle state demands, firing as soon
    // as the elapsed wait satisfies it. This guarantees the idle reading
    // that actually decides the push is taken at (near) fire time, not at
    // begin time, so a human who walks away mid-wait gets the faster path.
    const beginAt = clock.now()

    const firePhone = () => {
      d.onPhone(s, tier, 0)
      for (let i = 1; i <= cfg.escalation.phoneRepeat; i++) {
        const at = cfg.escalation.phoneRepeatIntervalMs * i
        this.#track(s.sessionId, clock.schedule(at, () => d.onPhone(s, tier, i)))
      }
    }

    const pollPhone = () => {
      const required = escalateDelayFor(cfg, tier, d.idleMs())
      if (required === null) return
      const remaining = required - (clock.now() - beginAt)
      if (remaining <= 0) {
        firePhone()
        return
      }
      const nextCheckIn = Math.min(remaining, cfg.escalation.idleDelayMs)
      this.#track(s.sessionId, clock.schedule(nextCheckIn, pollPhone))
    }
    pollPhone()
  }

  cancel(sessionId: string): void {
    const list = this.#timers.get(sessionId)
    if (!list) return
    for (const c of list) c()
    this.#timers.delete(sessionId)
  }

  cancelAll(): void {
    for (const id of [...this.#timers.keys()]) this.cancel(id)
  }
}
