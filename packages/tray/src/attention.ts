import { app, BrowserWindow } from 'electron'
import type { SessionState, Tier } from '@nudge/shared/types'
import { DEFAULT_CONFIG, loadConfig as loadNudgeConfig, type NudgeConfig } from '@nudge/shared/config'

const TIERS: readonly Tier[] = ['blocked', 'idle-long', 'idle-short', 'stalled']

/**
 * The tiers that persistently demand attention, derived from DEFAULT_CONFIG
 * rather than hand-listed so the two can never drift apart.
 *
 * The rule is `escalates`: a tier important enough to eventually buzz your
 * phone is important enough to keep the Dock icon moving until you look. That
 * currently means `blocked` and `idle-long`, and deliberately excludes
 * `idle-short` — a "turn finished" ping is informational, and an icon that
 * bounced until dismissed for every completed turn would train the user to
 * ignore the signal entirely, which is the one failure this whole product
 * cannot survive.
 */
export const DEFAULT_BOUNCE_TIERS: ReadonlySet<Tier> = new Set(
  TIERS.filter(t => DEFAULT_CONFIG.tiers[t].escalates),
)

export interface AttentionConfig {
  /** Master switch. `false` disables persistent attention entirely, whatever `bounceTiers` says. */
  bounceOnBlocked: boolean
  bounceTiers: ReadonlySet<Tier>
}

export const DEFAULT_ATTENTION_CONFIG: AttentionConfig = {
  bounceOnBlocked: true,
  bounceTiers: DEFAULT_BOUNCE_TIERS,
}

/** The macOS Dock methods this module touches. macOS-only in Electron's API — `app.dock` is undefined elsewhere. */
export interface DockSurface {
  show(): void
  hide(): void
  /** Returns an id that must be handed back to `cancelBounce` to stop the animation. */
  bounce(type: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

/** The Windows/Linux taskbar-flash equivalent. */
export interface FlashSurface {
  flash(on: boolean): void
}

export interface AttentionSurface {
  platform: string
  dock: DockSurface | null
  flashWindow: FlashSurface | null
}

export interface AttentionDeps {
  /**
   * Re-read on every update rather than captured once at construction, so a
   * `nudge mute` takes effect on the very next broadcast instead of after a
   * tray restart. State broadcasts only arrive on an actual state change, so
   * this is a handful of small reads per session, not a hot path.
   */
  loadConfig?: () => NudgeConfig
  now?: () => number
}

export function isTierEligible(cfg: AttentionConfig, tier: Tier): boolean {
  return cfg.bounceOnBlocked && cfg.bounceTiers.has(tier)
}

/**
 * Mirrors packages/engine/src/suppression.ts's `localSuppression` rules
 * client-side, minus its `tier-disabled` clause (tier eligibility is a
 * separate, differently-configured question here — see `isTierEligible`).
 *
 * Duplicated rather than imported for the same reason notify.ts duplicates
 * TIER_TEXT: `packages/engine` is out of this task's scope, and the tray
 * cannot import from it. The engine remains the authority — if these rules
 * ever diverge, the engine's are correct and this must be corrected to match.
 */
export function isSessionSuppressed(
  cfg: NudgeConfig,
  s: SessionState,
  now: number,
  frontmostSessionId: string | null,
): boolean {
  if (frontmostSessionId !== null && frontmostSessionId === s.sessionId) return true
  if (cfg.muted) return true
  if (cfg.projects[s.cwd]?.muted) return true
  if (s.snoozedUntil !== null && now < s.snoozedUntil) return true
  return false
}

/** True when at least one session is both tier-eligible and unsuppressed. */
export function needsAttention(
  sessions: SessionState[],
  attn: AttentionConfig,
  cfg: NudgeConfig,
  now: number,
  frontmostSessionId: string | null,
): boolean {
  return sessions.some(s =>
    s.tier !== null
    && isTierEligible(attn, s.tier)
    && !isSessionSuppressed(cfg, s, now, frontmostSessionId),
  )
}

/**
 * A window that exists purely to own a taskbar button so it can be flashed.
 *
 * `flashFrame` is a no-op against a window with no taskbar button, and a
 * window created with `show: false` has none — so the window has to be
 * shown to be flashable. `showInactive()` puts it on the taskbar without
 * stealing focus, and the immediate `minimize()` keeps a 1x1 frameless
 * window from appearing over the user's work. Created lazily on the first
 * actual flash so a macOS run (or a tray that never alerts) never builds one.
 *
 * NOT VERIFIED ON WINDOWS OR LINUX — this was written and tested on macOS,
 * where this branch never executes. The macOS Dock path below is the one
 * that has been exercised end-to-end. Linux behaviour is additionally
 * desktop-environment dependent (`flashFrame` maps to an urgency hint that
 * some DEs ignore entirely), so treat it as best-effort rather than a
 * guarantee.
 */
function lazyFlashWindow(): FlashSurface {
  let win: BrowserWindow | null = null
  return {
    flash(on: boolean): void {
      // Window creation is the one part of this module that can genuinely
      // fail at runtime (no display server on a headless Linux box, for
      // instance). Failing to flash is a missed nudge; throwing here would
      // take down the whole state-broadcast handler, and with it the tray
      // icon and the notifications — a far worse outcome than no flash.
      try {
        if (on) {
          if (win === null || win.isDestroyed()) {
            win = new BrowserWindow({
              width: 1, height: 1, show: false, frame: false,
              skipTaskbar: false, title: 'Nudge',
            })
            win.showInactive()
            win.minimize()
          }
          win.flashFrame(true)
        } else if (win !== null && !win.isDestroyed()) {
          win.flashFrame(false)
        }
      } catch (err) {
        console.error(`nudge tray: could not flash the taskbar: ${(err as Error).message}`)
      }
    },
  }
}

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `electron` binding.
 * Only production code (main.ts's composition root) reaches this; every test
 * supplies its own fake (see attention.test.ts).
 *
 * `app.dock` is guarded rather than assumed: it is macOS-only in Electron's
 * API and undefined everywhere else, so a missing dock degrades to "no
 * persistent attention" instead of a TypeError on boot.
 */
export function defaultSurface(): AttentionSurface {
  const platform = process.platform
  if (platform === 'darwin') {
    const dock = app.dock
    return {
      platform,
      dock: dock
        ? {
            show: () => { void dock.show() },
            hide: () => dock.hide(),
            bounce: type => dock.bounce(type),
            cancelBounce: id => dock.cancelBounce(id),
          }
        : null,
      flashWindow: null,
    }
  }
  return { platform, dock: null, flashWindow: lazyFlashWindow() }
}

/**
 * Persistent, non-self-dismissing attention: a bouncing macOS Dock icon or a
 * flashing Windows/Linux taskbar button, for as long as something is
 * actually waiting on the user.
 *
 * This is the strongest signal the product can raise short of the phone, and
 * the reason it exists: a notification banner auto-dismisses after a few
 * seconds, so one glanced-away moment loses it forever. A bouncing icon is
 * still bouncing when you come back from the browser.
 *
 * Edge-transition driven, not level-driven: it acts only when the aggregate
 * "does anything need me?" answer *changes*. The engine re-broadcasts state
 * on every change, and bouncing again on each of those would stack
 * animations and never stop.
 */
export class AttentionManager {
  readonly #surface: AttentionSurface
  readonly #config: AttentionConfig
  readonly #loadConfig: () => NudgeConfig
  readonly #now: () => number
  #bounceId: number | null = null
  #attracting = false
  #disposed = false

  constructor(
    surface: AttentionSurface,
    config: AttentionConfig = DEFAULT_ATTENTION_CONFIG,
    deps: AttentionDeps = {},
  ) {
    this.#surface = surface
    this.#config = config
    this.#loadConfig = deps.loadConfig ?? (() => loadNudgeConfig())
    this.#now = deps.now ?? Date.now
  }

  /**
   * `frontmostSessionId` defaults to null because nothing currently feeds it:
   * the engine tracks frontmost privately (engine.ts's `#frontmost`, fed by
   * the VS Code extension) and does not include it in its state broadcast, so
   * a tray client has no way to observe it. The suppression rule is
   * implemented and tested here so that closing that gap is a wiring change
   * rather than a behaviour change — see the Task 7 report.
   */
  update(sessions: SessionState[], frontmostSessionId: string | null = null): void {
    if (this.#disposed) return

    let wanted: boolean
    try {
      wanted = needsAttention(sessions, this.#config, this.#loadConfig(), this.#now(), frontmostSessionId)
    } catch (err) {
      // A hand-edited, malformed config.json makes loadConfig throw. That must
      // not take down the broadcast handler that called us (and with it the
      // tray icon and notifications) — this is the least important of the
      // three consumers of a state broadcast.
      console.error(`nudge tray: attention update skipped: ${(err as Error).message}`)
      return
    }

    if (wanted && !this.#attracting) this.#start()
    else if (!wanted && this.#attracting) this.#stop()
  }

  #start(): void {
    this.#attracting = true
    const dock = this.#dock()
    if (dock) {
      dock.show()
      // 'critical' bounces until the app is activated; 'informational' is a
      // single hop that is over before the user turns around, which defeats
      // the entire point of this module.
      this.#bounceId = dock.bounce('critical')
      return
    }
    this.#surface.flashWindow?.flash(true)
  }

  /**
   * The load-bearing half. Without the `cancelBounce` below, the icon keeps
   * bouncing after the user has already answered — turning the product's
   * best signal into the reason it gets uninstalled.
   */
  #stop(): void {
    this.#attracting = false
    const dock = this.#dock()
    if (dock) {
      if (this.#bounceId !== null) dock.cancelBounce(this.#bounceId)
      this.#bounceId = null
      dock.hide()
      return
    }
    this.#surface.flashWindow?.flash(false)
  }

  /** macOS uses the Dock; every other platform flashes a taskbar button. */
  #dock(): DockSurface | null {
    return this.#surface.platform === 'darwin' ? this.#surface.dock : null
  }

  /** Quitting mid-wait must not leave a bouncing icon (or a shown Dock) behind. */
  dispose(): void {
    if (this.#disposed) return
    if (this.#attracting) this.#stop()
    this.#disposed = true
  }
}
