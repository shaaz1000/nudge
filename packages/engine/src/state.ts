import type { NudgeEvent, SessionState, Tier } from '@nudge/shared/types'
import { UNKNOWN_SURFACE } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock } from './clock.js'

export interface Transition {
  session: SessionState
  started: Tier | null
  cleared: Tier | null
  duplicate: boolean
}

/**
 * Tools whose invocation means Claude is now waiting on the human.
 *
 * AskUserQuestion has "Permission required: No", so it never fires the
 * Notification hook (anthropics/claude-code#59908) — without this, the
 * multiple-choice dialog would look like ordinary tool activity and would
 * CLEAR a pending wait instead of starting one.
 *
 * ExitPlanMode normally does fire Notification via the permission flow; it is
 * listed here so an allowlisted ExitPlanMode still registers as a wait.
 */
const BLOCKING_TOOLS: Record<string, string> = {
  AskUserQuestion: 'Claude is asking you a question',
  ExitPlanMode: 'Claude is waiting for you to approve its plan',
}

export class SessionStore {
  #sessions = new Map<string, SessionState>()

  constructor(private cfg: NudgeConfig, private clock: Clock) {}

  list(): SessionState[] { return [...this.#sessions.values()] }
  get(id: string): SessionState | undefined { return this.#sessions.get(id) }
  drop(id: string): void { this.#sessions.delete(id) }

  idsOlderThan(ms: number): string[] {
    const cutoff = this.clock.now() - ms
    return this.list().filter(s => s.lastEventAt < cutoff).map(s => s.sessionId)
  }

  #ensure(ev: NudgeEvent): SessionState {
    let s = this.#sessions.get(ev.sessionId)
    if (!s) {
      s = {
        sessionId: ev.sessionId,
        project: ev.project,
        cwd: ev.cwd,
        // Spread, not a direct assignment: UNKNOWN_SURFACE is a shared,
        // frozen singleton (see types.ts) — assigning it directly would give
        // every unknown-surface session the same object reference.
        surface: ev.surface ?? { ...UNKNOWN_SURFACE },
        status: 'running',
        tier: null,
        waitingSince: null,
        turnStartedAt: null,
        lastEventAt: ev.ts,
        message: null,
        snoozedUntil: null,
        pushFailed: false,
      }
      this.#sessions.set(ev.sessionId, s)
    }
    // A surface only ever arrives on SessionStart; never downgrade a known one.
    if (ev.surface && ev.surface.kind !== 'unknown') s.surface = ev.surface
    return s
  }

  #clearWaiting(s: SessionState): Tier | null {
    if (s.status !== 'blocked' && s.status !== 'idle' && s.status !== 'stalled') return null
    const was = s.tier
    s.status = 'running'
    s.tier = null
    s.waitingSince = null
    s.message = null
    s.pushFailed = false
    return was
  }

  /**
   * The governing rule: every event first clears any pending waiting state,
   * then applies whatever the new event implies.
   */
  apply(ev: NudgeEvent): Transition {
    const s = this.#ensure(ev)

    // De-duplication: a repeat Notification with the same message keeps the
    // original waitingSince and does not re-alert (spec 6.6).
    if (ev.hook === 'Notification' && s.status === 'blocked' && s.message === (ev.message ?? null)) {
      s.lastEventAt = ev.ts
      return { session: s, started: null, cleared: null, duplicate: true }
    }

    const cleared = this.#clearWaiting(s)
    s.lastEventAt = ev.ts

    let started: Tier | null = null

    switch (ev.hook) {
      case 'UserPromptSubmit':
        s.turnStartedAt = ev.ts
        break

      case 'Notification':
        s.status = 'blocked'
        s.tier = 'blocked'
        s.waitingSince = ev.ts
        s.message = ev.message ?? null
        started = 'blocked'
        break

      case 'Stop': {
        const ranFor = s.turnStartedAt === null ? 0 : ev.ts - s.turnStartedAt
        const tier: Tier = ranFor >= this.cfg.escalation.longTurnMs ? 'idle-long' : 'idle-short'
        s.status = 'idle'
        s.tier = tier
        s.waitingSince = ev.ts
        s.turnStartedAt = null
        started = tier
        break
      }

      case 'SessionEnd':
        s.status = 'gone'
        this.#sessions.delete(ev.sessionId)
        break

      case 'PreToolUse': {
        const prompt = ev.tool && Object.hasOwn(BLOCKING_TOOLS, ev.tool)
          ? BLOCKING_TOOLS[ev.tool]
          : undefined
        if (prompt) {
          s.status = 'blocked'
          s.tier = 'blocked'
          s.waitingSince = ev.ts
          s.message = prompt
          started = 'blocked'
        }
        break
      }

      case 'SessionStart':
      case 'PostToolUse':
        break
    }

    return { session: s, started, cleared, duplicate: false }
  }

  snooze(id: string, ms: number): void {
    const s = this.#sessions.get(id)
    if (s) s.snoozedUntil = this.clock.now() + ms
  }

  resolve(id: string): Transition | null {
    const s = this.#sessions.get(id)
    if (!s) return null
    const cleared = this.#clearWaiting(s)
    if (cleared === null) return null
    return { session: s, started: null, cleared, duplicate: false }
  }

  /** Only a session believed to be mid-turn can stall. */
  markStalled(id: string): Transition | null {
    const s = this.#sessions.get(id)
    if (!s || s.status !== 'running') return null
    s.status = 'stalled'
    s.tier = 'stalled'
    s.waitingSince = this.clock.now()
    return { session: s, started: 'stalled', cleared: null, duplicate: false }
  }
}
