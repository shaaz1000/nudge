import { Notification } from 'electron'
import type { SessionState, Tier } from '@nudge/shared/types'
import { loadConfig as loadNudgeConfig, type NudgeConfig } from '@nudge/shared/config'
import { isWaiting } from './suppression.js'

/**
 * Mirrors packages/engine/src/desktop.ts's TIER_TEXT (also duplicated,
 * unchanged, in packages/vscode/src/toast.ts). Duplicated rather than
 * imported: packages/engine is out of this task's scope (see the Phase 3
 * plan's Task 4/5 briefs — "Scope: packages/tray only"), and this is a tiny,
 * self-contained constant, not shared protocol logic like `@nudge/shared`
 * covers.
 */
const TIER_TEXT: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

/**
 * Pure — no Electron touched. `||`, not `??`, matching desktop.ts's and
 * toast.ts's identical fallback: an empty-string `message` is falsy but not
 * null/undefined, and must still fall back to the tier text rather than
 * rendering nothing after the title.
 *
 * Full detail, unconditionally — no `detailLevel` check. That is the
 * deliberate asymmetry against the *phone* payload (see
 * packages/engine/src/dispatch.ts's `buildAlert`, which gates `detail` on
 * `cfg.detailLevel === 'full'`): a phone push leaves this machine over the
 * network, so minimal-by-default is the safe choice there. A desktop
 * notification never leaves the machine it was raised on, so there is
 * nothing to protect by withholding the actual question or exact command —
 * withholding it here would only make the notification less useful for no
 * privacy benefit. This exactly matches what Phase 1's own local
 * `DesktopNotifier.alert()` already shows (see desktop.ts) — the tray does
 * not add any new exposure by matching it.
 */
export function notificationContent(s: SessionState): { title: string; body: string } {
  const tier = s.tier as Tier // non-null: only ever called for a session with tier !== null (see Notifier#show)
  return {
    title: `${s.project} needs you`,
    body: s.message || TIER_TEXT[tier],
  }
}

/**
 * The minimal shape of a real Electron `Notification` this module touches.
 * A real `Notification` instance satisfies this structurally (its `on` and
 * `close` are strictly more permissive than what is declared here); a test
 * fake needs nothing more.
 */
export interface NotificationLike {
  show(): void
  on(event: 'click', cb: () => void): void
  close(): void
}

/**
 * The slice of Electron's `Notification` constructor this module needs.
 * There is no runtime `electron` module outside an Electron host — only the
 * `electron` package's own bundled `.d.ts` for compile-time typing — so
 * `new Notification(...)` cannot be constructed under plain Node/Vitest.
 * Injecting this narrow surface (rather than calling the constructor
 * directly) lets tests drive the real de-dup/click logic with a fake, and
 * lets production code default to the real thing. Same pattern Task 3's
 * `tray.ts` used for `electron.Tray`.
 */
export interface NotifySurface {
  create(opts: { title: string; body: string; silent: boolean }): NotificationLike
}

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `electron`
 * binding. Only production code (main.ts's composition root) calls
 * `new Notifier(onFocus)` with no second argument; every test supplies its
 * own fake instead.
 */
function defaultSurface(): NotifySurface {
  return { create: opts => new Notification(opts) }
}

/**
 * Electron `Notification` with a real, clickable action — the reason Phase 3
 * exists at all (see the plan's top-level "Why this exists" section):
 * macOS's `osascript` banner (what Phase 1's engine fires locally, see
 * packages/engine/src/desktop.ts) cannot carry a click handler. This can.
 *
 * ## De-duplication
 *
 * The engine broadcasts full state on every change, not only on
 * transitions — a session that has been waiting for an hour reappears in
 * every array passed to `update()` for that whole hour. Without tracking
 * which session ids have already been notified, every one of those
 * broadcasts would pop a new OS notification. `#shown` is that tracking —
 * identical in shape and intent to packages/vscode/src/toast.ts's
 * `Toaster#toasted`, except it is a `Map` (session id -> the live
 * `NotificationLike` handle) rather than a bare `Set`, so a resolved
 * session's lingering banner can be `close()`d, not merely forgotten. A
 * session id is added the first time it is seen waiting, and removed (and
 * its notification closed) the moment it stops waiting (tier goes back to
 * `null`, it drops out of the list entirely, or it becomes snoozed) — so a
 * later re-block notifies again.
 *
 * ## The double-notification problem (Task 4, Step 4) — history, and its resolution
 *
 * Phase 1's engine (packages/engine/src/engine.ts's `onLocal`, invoked by
 * the `Escalator` at t=0 the instant a session starts waiting, and again on
 * every local repeat) used to unconditionally fire its own `osascript`/
 * `notify-send`/PowerShell banner via `DesktopNotifier.alert()` —
 * regardless of whether this tray, the VS Code extension, both, or neither
 * was running. At the time this class was first built (Task 4), there was
 * no lever to suppress it without changing `packages/engine`/
 * `packages/shared`, which were out of scope for that task — see this
 * class's git history for the full reasoning that used to live here (why
 * `mute` and `frontmost` were each the wrong tool for this).
 *
 * **Review round 1, Finding 5 (USER-APPROVED) closed the VISUAL half of
 * this**: the engine now knows when a GUI client is connected
 * (`subscribe({gui:true})`, see `@nudge/client`'s `EngineClientOptions.gui`
 * and main.ts's wiring of this exact `EngineClient`) and skips its own
 * banner entirely while one is (see packages/engine/src/engine.ts's
 * `onLocal`). With this tray running, only this Notifier's banner shows —
 * no duplicate.
 *
 * Every notification here is still built `silent: true` (see `#show`
 * below), and that is deliberately final, not a residual gap: **round 2,
 * Finding 1** closed the AUDIBLE half by splitting the engine's own alert
 * into a banner and a sound (`DesktopNotifier#alertSound`,
 * packages/engine/src/desktop.ts) and having `onLocal` skip only the banner
 * while a GUI is connected. The engine's per-tier sound (which alone can
 * honour a configured `.wav` or an explicit `sound: null` — this tray has
 * no `NudgeConfig` of its own to check) still plays on every alert,
 * including every escalation-ladder repeat. So: exactly one clickable
 * (silent) banner from this Notifier, plus exactly one configured sound
 * from the engine, per alert — not a redundant second ding, and not
 * silence either.
 *
 * This Notifier still only ever fires ONCE per wait (de-dup, above), but
 * that no longer costs anything: the engine's own ladder is NOT paused
 * while a GUI is connected (round 2, Finding 1 fixed this — it used to be,
 * which was worse than the double banner it replaced) — it keeps firing its
 * sound-only alert up to `cfg.escalation.localRepeat` additional times
 * (default 3, every `localRepeatIntervalMs` = 60s), so a long wait still
 * gets audible re-pings even though this banner itself does not repeat.
 */
export interface NotifierDeps {
  /** Re-read per update so `nudge mute` takes effect on the next broadcast, not the next restart. */
  loadConfig?: () => NudgeConfig
  now?: () => number
}

export class Notifier {
  readonly #onFocus: (s: SessionState) => void
  readonly #surface: NotifySurface
  readonly #loadConfig: () => NudgeConfig
  readonly #now: () => number
  /** sessionId -> the banner on screen, plus what it was raised FOR. */
  readonly #shown = new Map<string, { n: NotificationLike; tier: Tier; message: string | null }>()
  #lastGoodConfig: NudgeConfig | null = null
  #disposed = false

  constructor(
    onFocus: (s: SessionState) => void,
    surface: NotifySurface = defaultSurface(),
    deps: NotifierDeps = {},
  ) {
    this.#onFocus = onFocus
    this.#surface = surface
    this.#loadConfig = deps.loadConfig ?? (() => loadNudgeConfig())
    this.#now = deps.now ?? Date.now
  }

  update(mine: SessionState[]): void {
    if (this.#disposed) return

    // FULL suppression, not just snooze — see suppression.ts for why this is
    // load-bearing rather than tidiness. This used to check only tier and
    // snooze, which was survivable while the engine also raised its own
    // banner. It no longer does: the tray declares `gui: true`, so the engine
    // stands its banner down and this becomes the ONLY banner source.
    // Ignoring `muted` here meant `nudge mute` silenced the engine and the
    // tray notified anyway — the user muted Nudge and Nudge kept notifying,
    // with no escape short of quitting the tray. Same for a tier switched off
    // entirely.
    //
    // Applied through ONE predicate used by both the clearing loop and
    // notify-eligibility: a session that becomes muted or snoozed mid-wait
    // has its banner closed rather than left on screen, and the two can never
    // disagree about what counts as waiting.
    const now = this.#now()
    let cfg: NudgeConfig
    try {
      cfg = this.#loadConfig()
      this.#lastGoodConfig = cfg
    } catch (err) {
      // Same fail-soft shape as AttentionManager: a broken config must not
      // strand banners on screen with no way to clear them.
      console.error(`nudge tray: notifier using last-known-good config: ${(err as Error).message}`)
      if (this.#lastGoodConfig === null) return
      cfg = this.#lastGoodConfig
    }
    const waiting = (s: SessionState): boolean => isWaiting(cfg, s, now)
    const waitingIds = new Set(mine.filter(waiting).map(s => s.sessionId))

    // Clear-on-resolve: close the OS notification (if still on screen) and
    // drop tracking for any session this update no longer reports as
    // waiting, so it notifies again if it re-blocks later. Iterating and
    // deleting from the same Map is well-defined in JS — a Map iterator is
    // unaffected by deletions of entries already visited or not yet due.
    for (const [id, shown] of this.#shown) {
      if (!waitingIds.has(id)) {
        shown.n.close()
        this.#shown.delete(id)
      }
    }

    for (const s of mine) {
      if (!waiting(s)) continue
      const already = this.#shown.get(s.sessionId)
      // Re-notify when the WAIT ITSELF changed, not just when a new session
      // appears. A session can go idle-short ("turn finished") -> blocked
      // ("may I run this?") without ever passing through tier: null, and
      // de-duping on sessionId alone left the user looking at a banner that
      // said the turn had finished while Claude was actually asking them a
      // question. Same for a message that changes mid-wait.
      if (already && already.tier === s.tier && already.message === s.message) continue
      if (already) already.n.close()
      this.#shown.set(s.sessionId, {
        n: this.#show(s),
        tier: s.tier as Tier,
        message: s.message,
      })
    }
  }

  #show(s: SessionState): NotificationLike {
    const { title, body } = notificationContent(s)
    // silent: true — see the class doc's "double-notification problem"
    // section: the engine already plays its own per-tier sound for this
    // same event, so this module's own default banner sound would be pure,
    // avoidable duplication.
    const n = this.#surface.create({ title, body, silent: true })
    n.on('click', () => {
      // The user can click well after this Notifier was disposed (tray
      // quitting, engine restart tearing down `active` in main.ts) —
      // without this guard a stale click would still call into focus logic
      // built for a torn-down process.
      if (this.#disposed) return
      this.#onFocus(s)
    })
    n.show()
    return n
  }

  /**
   * Marks this Notifier inert (see `#show`'s click guard) and closes every
   * currently-shown OS notification rather than leaving stale banners (and
   * their now-orphaned click handlers) on screen after the tray itself has
   * quit.
   */
  dispose(): void {
    this.#disposed = true
    for (const shown of this.#shown.values()) shown.n.close()
    this.#shown.clear()
  }
}
