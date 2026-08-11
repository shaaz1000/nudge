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
    // at begin() and arm a single timer for it. Instead we poll, but not at
    // a blind fixed cadence: idleMs() advances at most 1ms per elapsed ms, so
    // if the machine is currently active the idle threshold cannot be
    // crossed before `idleThresholdMs - idle` from now, and checking at
    // exactly that instant is both precise and cheap. A per-tier delay
    // override makes the required delay a constant for the whole wait —
    // idle state is irrelevant then, so a single exact timer suffices.
    const beginAt = clock.now()

    const firePhone = () => {
      d.onPhone(s, tier, 0)
      for (let i = 1; i <= cfg.escalation.phoneRepeat; i++) {
        const at = cfg.escalation.phoneRepeatIntervalMs * i
        this.#track(s.sessionId, clock.schedule(at, () => d.onPhone(s, tier, i)))
      }
    }

    const pollPhone = () => {
      const idle = d.idleMs()
      const required = escalateDelayFor(cfg, tier, idle)
      if (required === null) return
      const elapsed = clock.now() - beginAt
      const remaining = required - elapsed
      if (remaining <= 0) {
        firePhone()
        return
      }

      // idleMs advances at most 1ms per ms, so the active->idle regime
      // cannot flip before this. Once already idle, required cannot shrink
      // further.
      const untilRegimeFlip = idle >= cfg.escalation.idleThresholdMs
        ? Infinity
        : cfg.escalation.idleThresholdMs - idle

      // A per-tier override makes required a constant for the whole wait,
      // so idle state is irrelevant and a single timer is exact.
      const hasOverride = cfg.tiers[tier].escalateDelayMs !== undefined

      // untilRegimeFlip assumes idleMs() only grows with real elapsed time.
      // A caller whose idleMs() can jump between calls without an
      // intervening tick (a stubbed clock, a system clock adjustment, a
      // suspend/resume) could still cross the threshold before that
      // horizon. idleDelayMs is the shortest delay this config can ever
      // require, so capping the gap between checks at idleDelayMs bounds
      // how long such a jump can go unnoticed, without changing the fire
      // instant for a well-behaved (monotonic) idleMs. Math.max(1, ...) is
      // what keeps this delay strictly positive regardless of any
      // zero-valued config (closes the zero-delay spin either way).
      const nextCheckIn = hasOverride
        ? remaining
        : Math.max(1, Math.min(remaining, untilRegimeFlip, cfg.escalation.idleDelayMs))
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
