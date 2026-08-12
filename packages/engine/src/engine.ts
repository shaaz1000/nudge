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
  /**
   * Finding I7: persists the mute flag so `nudge status` (a separate
   * process, re-reading config.json fresh every time) agrees with `nudge
   * mute`, and so a restart doesn't silently unmute everything. Optional and
   * defaulting to a no-op so unit tests that build an Engine directly don't
   * touch any file; bin.ts wires this to shared/config's setMuted().
   */
  persistMuted?: (on: boolean) => void
}

export class Engine {
  #idleMs = 0
  #frontmost: string | null = null
  #stopWatchdog: (() => void) | null = null
  #stopDrift: (() => void) | null = null

  constructor(private d: EngineDeps) {}

  sessions(): SessionState[] { return this.d.store.list() }
  setIdle(ms: number): void { this.#idleMs = ms }
  setFrontmost(id: string | null): void {
    if (this.#frontmost === id) return
    this.#frontmost = id
    // Broadcast immediately rather than waiting for the next hook event:
    // focus changes are exactly when a client needs to start or stop
    // suppressing, and a session can sit blocked for minutes with no state
    // change at all.
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }
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
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  handle(ev: NudgeEvent): void {
    const t = this.d.store.apply(ev)
    this.d.db.recordEvent(ev)
    this.#applyTransition(t, ev.hook, ev.ts)
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  onWatchdogStall(t: Transition): void {
    this.#applyTransition(t, 'watchdog', this.d.clock.now())
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  /**
   * Finding I1: the watchdog's TTL sweep (`store.drop`) used to be the only
   * thing that happened to an expired session — nothing cancelled its
   * escalation ladder (if it was mid-wait when it went silent for 24h) and
   * nothing closed its DB wait row, since `prune()` never deletes an *open*
   * wait by design. Both are idempotent no-ops when there is nothing to
   * clean up (Escalator#cancel on an untracked id, Db#closeWait when no
   * open row matches), so this is always safe to call regardless of
   * whether the dropped session actually had a live wait.
   */
  onWatchdogDrop(sessionId: string): void {
    this.d.escalator.cancel(sessionId)
    this.d.db.closeWait(sessionId, this.d.clock.now(), 'ttl')
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  /**
   * Finding I2: retention used to run exactly once, in start(), before the
   * daemon settles in to run for however many weeks until its next
   * restart — after which nothing pruned old events or resolved waits
   * again. Watchdog now calls this periodically (see PRUNE_INTERVAL_MS in
   * watchdog.ts) with the same cutoff math start() already used.
   */
  onWatchdogPrune(): void {
    this.d.db.prune(this.d.clock.now() - this.d.cfg.retentionDays * 86_400_000)
  }

  snooze(id: string, ms: number): void {
    this.d.store.snooze(id, ms)
    this.d.escalator.cancel(id)
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  mute(on: boolean): void {
    this.d.cfg.muted = on
    try {
      this.d.persistMuted?.(on)
    } catch (err) {
      console.error('nudge engine: persistMuted failed', err)
    }
    if (on) this.d.escalator.cancelAll()
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  resolve(id: string): void {
    const t = this.d.store.resolve(id)
    if (t) this.#applyTransition(t, 'manual', this.d.clock.now())
    this.d.server.broadcast(this.d.store.list(), this.#frontmost)
  }

  /**
   * Local alert callback, invoked by the Escalator at t=0 and on each repeat
   * — directly inside a `clock.schedule` timer for every call after the
   * first. A throw here (e.g. from a misbehaving DesktopNotifier) would
   * propagate uncaught out of that timer and crash the daemon, so it is
   * caught and logged rather than left to escape.
   *
   * Review round 1, Finding 5 (USER-APPROVED): with the Electron tray
   * running, one waiting session used to produce TWO banners — this one
   * (fired synchronously, before `server.broadcast()` even runs, so no
   * tray-side change could ever preempt it) and the tray's own clickable
   * `Notifier` (packages/tray/src/notify.ts). `gui` (read via
   * `hasGuiClient()`, hoisted above the try/catch below — round 2, Finding
   * 4 — so a throw there can't silently suppress the alert it's meant to
   * gate) is re-checked on EVERY call (t=0 and every repeat), not cached
   * from begin() — so if the tray quits or crashes mid-wait, the very next
   * scheduled repeat (or `onGuiDisconnected`, immediately, see below) resumes
   * a real desktop banner rather than leaving the user silently unalerted.
   * Phone escalation (`onPhone`) and DB history are untouched.
   *
   * Round 2, Finding 1: the first fix here (round 1) called `return` before
   * `notifier.alert()` whenever a GUI was connected — which suppressed not
   * just the banner (redundant with the tray's own clickable one — the
   * intent) but also the sound AND every escalation-ladder repeat
   * (escalation.ts's `localRepeat`, 3 further pings at 60s by default),
   * since `alert()` used to be the only entry point for either and the
   * tray's own `Notifier` de-dups to one silent banner per wait. Net effect:
   * a waiting session went from "4 audible banners over 3 minutes" to "one
   * silent, auto-dismissing banner and nothing else." `DesktopNotifier` now
   * splits banner and sound (see desktop.ts's `alertSound()`), so the gate
   * below skips only the banner while a GUI is connected — the sound (which
   * honours a per-tier `sound: null`, unlike the tray's own always-`silent:
   * true` `Notifier`) still fires, on every repeat, restoring the ladder as
   * an audible re-ping without reintroducing the double VISUAL banner.
   */
  onLocal(s: SessionState, tier: Tier): void {
    let gui = false
    try { gui = this.d.server.hasGuiClient() } catch { /* default false: keep local alerts flowing */ }
    try {
      const sup = localSuppression(this.d.cfg, s, tier, this.#frontmost, this.d.clock.now())
      if (sup !== 'none') return
      if (gui) { this.d.notifier.alertSound(tier); return }
      this.d.notifier.alert(s, tier)
    } catch (err) {
      console.error(`nudge engine: onLocal failed for ${s.sessionId}`, err)
    }
  }

  /**
   * Finding 5: called by the server the instant the LAST connected GUI
   * client disconnects (tray quit or crashed) — see
   * `ServerHandlers.onGuiDisconnected`'s doc for why this can't just wait for
   * the escalation ladder's next scheduled repeat. Every session still
   * waiting was relying on the tray's own notification instead of this
   * engine's; that safety net just vanished, so re-run the exact same
   * `onLocal` check for each of them right now. `onLocal` re-checks
   * `hasGuiClient()` itself (now false — this is called exactly when it
   * transitions to false), so this reliably surfaces a real desktop
   * notification for every currently-waiting session, subject only to the
   * same suppression rules (DND, frontmost, mute) any other local alert
   * already respects.
   */
  onGuiDisconnected(): void {
    for (const s of this.d.store.list()) {
      if (s.tier === null || s.waitingSince === null) continue
      this.onLocal(s, s.tier)
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
        this.d.server.broadcast(this.d.store.list(), this.#frontmost)
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
