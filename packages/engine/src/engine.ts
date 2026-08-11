import type { NudgeEvent, SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock } from './clock.js'
import type { SessionStore, Transition } from './state.js'
import type { Escalator } from './escalation.js'
import type { Dispatcher } from './dispatch.js'
import type { DesktopNotifier } from './desktop.js'
import type { Watchdog } from './watchdog.js'
import type { EngineServer } from './server.js'
import type { Db } from './db.js'
import { localSuppression, phoneSuppression, minutesOfDay } from './suppression.js'

export interface EngineDeps {
  cfg: NudgeConfig
  clock: Clock
  store: SessionStore
  db: Db
  escalator: Escalator
  dispatcher: Dispatcher
  notifier: DesktopNotifier
  watchdog: Watchdog
  server: EngineServer
  /** Optional; when absent the engine simply does not re-arm after sleep. */
  drift?: { start(): () => void }
}

export class Engine {
  #idleMs = 0
  #frontmost: string | null = null
  #stopWatchdog: (() => void) | null = null
  #stopDrift: (() => void) | null = null

  constructor(private d: EngineDeps) {}

  sessions(): SessionState[] { return this.d.store.list() }
  setIdle(ms: number): void { this.#idleMs = ms }
  setFrontmost(id: string | null): void { this.#frontmost = id }
  idleMs(): number { return this.#idleMs }

  async start(): Promise<void> {
    await this.d.server.listen()
    this.#stopWatchdog = this.d.watchdog.start()
    this.#stopDrift = this.d.drift?.start() ?? null
    this.d.db.prune(this.d.clock.now() - this.d.cfg.retentionDays * 86_400_000)
  }

  async stop(): Promise<void> {
    this.#stopWatchdog?.()
    this.#stopDrift?.()
    this.d.escalator.cancelAll()
    await this.d.server.close()
    this.d.db.close()
  }

  /**
   * Called after a sleep or clock change. Ladders scheduled before the jump are
   * no longer trustworthy, so every still-waiting session is re-armed from now
   * and the watchdog re-evaluates immediately.
   */
  onResume(): void {
    for (const s of this.d.store.list()) {
      if (s.tier === null || s.waitingSince === null) continue
      this.d.escalator.cancel(s.sessionId)
      this.d.escalator.begin(s, s.tier)
    }
    this.d.watchdog.tick()
    this.d.server.broadcast(this.d.store.list())
  }

  handle(ev: NudgeEvent): void {
    const t = this.d.store.apply(ev)
    this.d.db.recordEvent(ev)
    this.#applyTransition(t, ev.hook, ev.ts)
    this.d.server.broadcast(this.d.store.list())
  }

  onWatchdogStall(t: Transition): void {
    this.#applyTransition(t, 'watchdog', this.d.clock.now())
    this.d.server.broadcast(this.d.store.list())
  }

  snooze(id: string, ms: number): void {
    this.d.store.snooze(id, ms)
    this.d.escalator.cancel(id)
    this.d.server.broadcast(this.d.store.list())
  }

  mute(on: boolean): void {
    this.d.cfg.muted = on
    if (on) this.d.escalator.cancelAll()
    this.d.server.broadcast(this.d.store.list())
  }

  resolve(id: string): void {
    const t = this.d.store.resolve(id)
    if (t) this.#applyTransition(t, 'manual', this.d.clock.now())
    this.d.server.broadcast(this.d.store.list())
  }

  /**
   * Local alert callback, invoked by the Escalator at t=0 and on each repeat
   * — directly inside a `clock.schedule` timer for every call after the
   * first. A throw here (e.g. from a misbehaving DesktopNotifier) would
   * propagate uncaught out of that timer and crash the daemon, so it is
   * caught and logged rather than left to escape.
   */
  onLocal(s: SessionState, tier: Tier): void {
    try {
      const sup = localSuppression(this.d.cfg, s, tier, this.#frontmost, this.d.clock.now())
      if (sup !== 'none') return
      this.d.notifier.alert(s, tier)
    } catch (err) {
      console.error(`nudge engine: onLocal failed for ${s.sessionId}`, err)
    }
  }

  /**
   * Phone escalation callback, invoked by the Escalator when the delay
   * expires. Callers invoke this as `void engine.onPhone(...)`, which
   * discards the returned promise without attaching a `.catch` — so a
   * rejection here (e.g. from a broken channel's resolver) would surface as
   * an unhandled rejection. Caught and logged for the same reason onLocal is.
   */
  async onPhone(s: SessionState, tier: Tier): Promise<void> {
    try {
      const now = this.d.clock.now()
      const sup = phoneSuppression(this.d.cfg, s, tier, now, minutesOfDay(now))
      if (sup !== 'none') return
      const result = await this.d.dispatcher.dispatch(s, tier)
      const live = this.d.store.get(s.sessionId)
      if (live) {
        live.pushFailed = !result.ok
        this.d.server.broadcast(this.d.store.list())
      }
    } catch (err) {
      console.error(`nudge engine: onPhone failed for ${s.sessionId}`, err)
    }
  }

  /**
   * One place enforces the two cross-module rules: a cleared wait always
   * cancels its ladder and closes its history row, and history is recorded
   * even when the alert itself is suppressed.
   */
  #applyTransition(t: Transition, reason: string, at: number): void {
    if (t.duplicate) return

    if (t.cleared) {
      this.d.escalator.cancel(t.session.sessionId)
      this.d.db.closeWait(t.session.sessionId, at, reason)
    }

    if (t.started) {
      this.d.db.openWait(t.session, t.started)
      this.d.escalator.begin(t.session, t.started)
    }
  }
}
