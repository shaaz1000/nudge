import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import type { SessionState, Tier } from '@nudge/shared/types'
import { DEFAULT_CONFIG, loadConfig as loadNudgeConfig, type NudgeConfig } from '@nudge/shared/config'
import { configPath } from '@nudge/shared/paths'
import { isSessionSuppressed } from './suppression.js'

const TIERS = Object.keys(DEFAULT_CONFIG.tiers) as Tier[]

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

/**
 * Reads the tray-owned `tray` key out of the ordinary nudge config.json, so
 * the persistent bounce can be turned off (or re-tiered) without a rebuild:
 *
 *     { "tray": { "bounceOnBlocked": false } }
 *     { "tray": { "bounceTiers": ["blocked"] } }
 *
 * Read here rather than added to `@nudge/shared/config`'s `NudgeConfig`
 * because this is tray-only presentation, not engine behaviour — and
 * `mergeConfig` ignores top-level keys it does not know, so the engine reads
 * the same file unaffected.
 *
 * Validates loudly for the same reason the shared config does: a silently
 * ignored typo in a "turn this off" switch is worse than no switch, because
 * the user believes they have disabled something that is still running.
 */
export function loadAttentionConfig(path = configPath()): AttentionConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_ATTENTION_CONFIG
    // Rethrown unwrapped, exactly as @nudge/shared's readRawConfig does: an
    // EACCES or EISDIR is not a parse failure and must not be reported as one.
    throw err
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`tray config: could not parse ${path} as JSON (${(err as Error).message})`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`tray config: top level of ${path} must be an object`)
  }
  const tray = (raw as Record<string, unknown>).tray
  if (tray === undefined) return DEFAULT_ATTENTION_CONFIG
  if (typeof tray !== 'object' || tray === null || Array.isArray(tray)) {
    throw new Error(`tray config: "tray" must be an object, got ${JSON.stringify(tray)}`)
  }

  const out: AttentionConfig = { ...DEFAULT_ATTENTION_CONFIG }
  for (const [k, v] of Object.entries(tray as Record<string, unknown>)) {
    if (k === 'bounceOnBlocked') {
      if (typeof v !== 'boolean') throw new Error('tray config: tray.bounceOnBlocked must be a boolean')
      out.bounceOnBlocked = v
    } else if (k === 'bounceTiers') {
      if (!Array.isArray(v)) throw new Error('tray config: tray.bounceTiers must be an array of tier names')
      for (const t of v) {
        if (typeof t !== 'string' || !TIERS.includes(t as Tier)) {
          throw new Error(`tray config: unknown tier ${JSON.stringify(t)} in tray.bounceTiers`)
        }
      }
      out.bounceTiers = new Set(v as Tier[])
    } else {
      throw new Error(`tray config: unknown key "tray.${k}"`)
    }
  }
  return out
}

/** The macOS Dock methods this module touches. macOS-only in Electron's API — `app.dock` is undefined elsewhere. */
export interface DockSurface {
  /**
   * The real `app.dock.show()` is **async** — it resolves once the icon is
   * actually in the Dock. Bouncing before then is a race against an icon that
   * may not exist yet, so `AttentionManager` waits when a promise comes back.
   * Returning `void` is still allowed so plain synchronous fakes work.
   */
  show(): void | Promise<void>
  hide(): void
  /** Returns an id that must be handed back to `cancelBounce` to stop the animation. */
  bounce(type: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

/** The Windows/Linux taskbar-flash equivalent. */
export interface FlashSurface {
  flash(on: boolean): void
  dispose?(): void
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

function isPromise(v: unknown): v is Promise<void> {
  return typeof (v as Promise<void> | undefined)?.then === 'function'
}

export function isTierEligible(cfg: AttentionConfig, tier: Tier): boolean {
  return cfg.bounceOnBlocked && cfg.bounceTiers.has(tier)
}

/**
 * Re-exported so existing importers keep working; the rule itself now lives
 * in suppression.ts, shared with notify.ts. It was previously implemented
 * twice in this package with *different* rules, and the difference was a real
 * bug — see suppression.ts.
 *
 * The `enabled` check inside it is NOT redundant with `isTierEligible`: that
 * one keys off `bounceTiers` (which tiers deserve a *persistent* signal),
 * whereas `tiers[t].enabled` is the user switching a tier off entirely.
 */
export { isSessionSuppressed } from './suppression.js'

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

/** The real `app.dock`, narrowed to what `defaultSurface` drives. `show()` is async on the real API. */
export interface RealDockLike {
  show(): Promise<void>
  hide(): void
  bounce(type: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

/** Injection points for `defaultSurface`, so its one side effect (hiding the Dock) is testable. */
export interface DefaultSurfaceDeps {
  platform?: string
  /** Present-but-undefined means "this machine has no Dock" — distinct from omitted, which reads the real `app.dock`. */
  dock?: RealDockLike | undefined
  makeFlashWindow?: () => FlashSurface
}

/** The window methods `lazyFlashWindow` drives — a real BrowserWindow satisfies this structurally. */
export interface FlashWindowLike {
  isDestroyed(): boolean
  showInactive(): void
  minimize(): void
  flashFrame(on: boolean): void
  destroy(): void
}

/**
 * A window that exists purely to own a taskbar button so it can be flashed.
 *
 * `flashFrame` is a no-op against a window with no taskbar button, and a
 * window created with `show: false` has none — so the window has to be shown
 * to be flashable. `showInactive()` puts it on the taskbar without stealing
 * focus, and the immediate `minimize()` keeps a 1x1 frameless window from
 * appearing over the user's work. Created lazily on the first actual flash so
 * a macOS run (or a tray that never alerts) never builds one.
 *
 * `makeWindow` is injected so the sequencing above is testable without
 * Windows — the whole of the non-macOS behaviour lives in here, and leaving
 * it untested is how the `show`-vs-`showInactive` divergence went unnoticed.
 *
 * NOT VERIFIED ON A REAL WINDOWS OR LINUX MACHINE — the call sequence is
 * asserted in tests, but no real taskbar has been observed flashing. Linux is
 * additionally desktop-environment dependent (`flashFrame` maps to an urgency
 * hint some DEs ignore), so treat it as best-effort rather than a guarantee.
 */
export function lazyFlashWindow(makeWindow: () => FlashWindowLike = defaultFlashWindow): FlashSurface {
  let win: FlashWindowLike | null = null
  return {
    flash(on: boolean): void {
      // Window creation can genuinely fail at runtime (no display server on a
      // headless Linux box, for instance). Failing to flash is a missed
      // nudge; throwing here would take down the whole state-broadcast
      // handler, and with it the tray icon and the notifications.
      try {
        if (on) {
          if (win === null || win.isDestroyed()) {
            const w = makeWindow()
            try {
              w.showInactive()
              w.minimize()
            } catch (err) {
              // Destroy rather than keep a half-built window: retaining it
              // would leave a never-shown window that silently no-ops every
              // future flash, and dropping it without destroying would leak
              // one more window on every attempt.
              try { w.destroy() } catch { /* already gone */ }
              throw err
            }
            win = w
          }
          win.flashFrame(true)
        } else if (win !== null && !win.isDestroyed()) {
          win.flashFrame(false)
        }
      } catch (err) {
        console.error(`nudge tray: could not flash the taskbar: ${(err as Error).message}`)
      }
    },
    dispose(): void {
      if (win !== null && !win.isDestroyed()) {
        try { win.destroy() } catch { /* already gone */ }
      }
      win = null
    },
  }
}

function defaultFlashWindow(): FlashWindowLike {
  return new BrowserWindow({
    width: 1, height: 1, show: false, frame: false,
    skipTaskbar: false, title: 'Nudge',
  })
}

/**
 * Built lazily, and only when no surface is injected — never at module load —
 * so importing this file never itself touches the real `electron` binding.
 * Only production code (main.ts's composition root) reaches this; every test
 * supplies its own fake (see attention.test.ts).
 *
 * `app.dock` is guarded rather than assumed: it is macOS-only in Electron's
 * API and undefined everywhere else, so a missing dock degrades to "no
 * persistent attention" instead of a TypeError on boot.
 *
 * The `dock.hide()` below establishes the baseline this whole feature depends
 * on. An Electron app launches WITH a Dock icon; without hiding it once at
 * startup, "the icon appears exactly when you are needed" would instead be
 * "the icon is always there and occasionally bounces", and it would only
 * become conditional after the first completed bounce cycle happened to hide
 * it.
 */
export function defaultSurface(deps: DefaultSurfaceDeps = {}): AttentionSurface {
  const platform = deps.platform ?? process.platform
  const makeFlash = deps.makeFlashWindow ?? (() => lazyFlashWindow())
  if (platform === 'darwin') {
    const dock = 'dock' in deps ? deps.dock : app.dock
    if (!dock) return { platform, dock: null, flashWindow: null }
    dock.hide()
    return {
      platform,
      dock: {
        // Returned, not swallowed: AttentionManager waits on it before
        // bouncing, so the icon is actually in the Dock first.
        show: () => dock.show(),
        hide: () => dock.hide(),
        bounce: type => dock.bounce(type),
        cancelBounce: id => dock.cancelBounce(id),
      },
      flashWindow: null,
    }
  }
  return { platform, dock: null, flashWindow: makeFlash() }
}

/**
 * Persistent, non-self-dismissing attention: a bouncing macOS Dock icon or a
 * flashing Windows/Linux taskbar button, for as long as something is actually
 * waiting on the user.
 *
 * This is the strongest signal the product can raise short of the phone, and
 * the reason it exists: a notification banner auto-dismisses after a few
 * seconds, so one glanced-away moment loses it forever. A bouncing icon is
 * still bouncing when you come back from the browser.
 *
 * Edge-transition driven, not level-driven: it acts only when the aggregate
 * "does anything need me?" answer *changes*. The engine re-broadcasts state
 * on every change, and bouncing again on each of those would stack animations
 * and never stop.
 */
export class AttentionManager {
  readonly #surface: AttentionSurface
  readonly #config: AttentionConfig
  readonly #loadConfig: () => NudgeConfig
  readonly #now: () => number
  #lastGoodConfig: NudgeConfig | null = null
  #gen = 0
  /** An in-flight `dock.show()`, so `#stop()` can defer its `hide()` until the icon actually exists. */
  #showing: Promise<void> | null = null
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

    let cfg: NudgeConfig
    try {
      cfg = this.#loadConfig()
      this.#lastGoodConfig = cfg
    } catch (err) {
      // A hand-edited, malformed config.json makes loadConfig throw. Falling
      // back to the last good copy — rather than returning early — is what
      // keeps a bounce STOPPABLE: an early return would freeze `#attracting`
      // at true and leave the icon bouncing forever once the user answered,
      // which is exactly the failure this module exists to prevent.
      console.error(`nudge tray: using last-known-good config: ${(err as Error).message}`)
      if (this.#lastGoodConfig === null) return
      cfg = this.#lastGoodConfig
    }

    // Inside the try as well: `update()` is called straight from main.ts's
    // state-broadcast handler, which also renders the tray icon and raises
    // notifications. A throw escaping this method takes both of those down
    // with it — the least important consumer of a broadcast must not be able
    // to break the other two. (A malformed `tiers` map reaching
    // `isSessionSuppressed` did exactly that during live testing.)
    let wanted: boolean
    try {
      wanted = needsAttention(sessions, this.#config, cfg, this.#now(), frontmostSessionId)
    } catch (err) {
      console.error(`nudge tray: attention evaluation failed: ${(err as Error).message}`)
      // Fail toward SILENCE, not toward an early return. Returning here would
      // repeat the exact bug the loadConfig catch above exists to avoid: if
      // this throws while already bouncing, `#attracting` stays true, no
      // `#stop()` is ever reached, and the icon bounces until the user quits
      // Nudge. Treating a failed evaluation as "nothing needs attention"
      // means the worst case is a missed nudge rather than an unstoppable one.
      wanted = false
    }

    if (wanted && !this.#attracting) this.#start()
    else if (!wanted && this.#attracting) this.#stop()
  }

  #start(): void {
    const dock = this.#dock()
    // Bumped on every start and stop so a bounce that was queued behind an
    // async show() can tell whether the wait it belonged to is still current.
    const gen = ++this.#gen
    let shown = false
    try {
      if (dock) {
        const showing = dock.show()
        shown = true
        if (isPromise(showing)) {
          // The real Dock resolves this once the icon exists. Bouncing before
          // that is a race against an icon that may not be there yet.
          this.#attracting = true
          this.#showing = showing
          void showing
            .catch((err: Error) => {
              console.error(`nudge tray: could not show the Dock icon: ${err.message}`)
            })
            .then(() => {
              if (this.#showing === showing) this.#showing = null
              // A `#stop()` that ran while this was in flight could not hide
              // an icon that did not exist yet, so it deferred the hide to
              // here. Without this the icon lands in the Dock AFTER the wait
              // ended and stays there forever: `#attracting` is already false,
              // so no future `#stop()` will ever hide it. Answering a prompt
              // within a second or two of it appearing is the single most
              // common interaction this product has, so this race is the
              // normal case, not an exotic one.
              if (gen !== this.#gen) {
                try { dock.hide() } catch { /* nothing further to try */ }
                return
              }
              this.#bounceOnce(gen, dock)
            })
          return
        }
        // 'critical' bounces until the app is activated; 'informational' is a
        // single hop that is over before the user turns around, which defeats
        // the entire point of this module.
        this.#bounceId = dock.bounce('critical')
      } else {
        this.#surface.flashWindow?.flash(true)
      }
    } catch (err) {
      // Deliberately does NOT set `#attracting`: we are not bouncing, so a
      // later resolve must not think it has a bounce to cancel, and the next
      // update should be free to try again.
      console.error(`nudge tray: could not raise persistent attention: ${(err as Error).message}`)
      // But a Dock icon that was shown before the failure would otherwise sit
      // there permanently: `#attracting` stays false, so no later `#stop()`
      // will ever hide it.
      if (shown && dock) {
        try { dock.hide() } catch { /* nothing further to try */ }
      }
      return
    }
    this.#attracting = true
  }

  /**
   * Raises the bounce once an async `show()` has settled — but only if the
   * wait it belongs to is still the current one. Without the generation
   * check, a wait that resolved while `show()` was still in flight would
   * start bouncing *after* the user had already answered, with no matching
   * `#stop()` left to cancel it: a permanently bouncing icon reached through
   * the async path rather than the missing-cancel one.
   */
  #bounceOnce(gen: number, dock: DockSurface): void {
    if (gen !== this.#gen || this.#disposed || !this.#attracting) return
    try {
      this.#bounceId = dock.bounce('critical')
    } catch (err) {
      console.error(`nudge tray: could not raise persistent attention: ${(err as Error).message}`)
      // Must mirror the synchronous branch's failure handling exactly.
      // `#attracting` was set optimistically before awaiting `show()` so a
      // resolve arriving mid-flight could still cancel — but if the bounce
      // itself failed there is nothing bouncing, and leaving the flag set
      // would (a) strand a shown-but-motionless Dock icon for the whole
      // wait, because no `#stop()` would ever hide it, and (b) block every
      // retry, since `wanted && !this.#attracting` can never be true again.
      this.#attracting = false
      try { dock.hide() } catch { /* nothing further to try */ }
    }
  }

  /**
   * The load-bearing half. Without the `cancelBounce` below, the icon keeps
   * bouncing after the user has already answered — turning the product's best
   * signal into the reason it gets uninstalled.
   *
   * Verified against the real macOS Dock (macOS 26.5): the bounce visibly
   * stops on `cancelBounce` while the app is still running and the icon is
   * still in the Dock. Note the id really is `0` there — Apple documents 0 as
   * "request refused", but on this platform it is a valid id that cancels
   * correctly, so the return value must not be treated as a success signal.
   */
  #stop(): void {
    // Bumped so any bounce still queued behind an async show() is abandoned
    // rather than starting after this stop.
    this.#gen++
    // Cleared first so a throw below cannot wedge the manager into believing
    // it is still bouncing (which would block every future stop attempt).
    this.#attracting = false
    const dock = this.#dock()
    try {
      if (dock) {
        if (this.#bounceId !== null) dock.cancelBounce(this.#bounceId)
        dock.hide()
      } else {
        this.#surface.flashWindow?.flash(false)
      }
    } catch (err) {
      console.error(`nudge tray: could not clear persistent attention: ${(err as Error).message}`)
    } finally {
      this.#bounceId = null
    }
  }

  /** macOS uses the Dock; every other platform flashes a taskbar button. */
  #dock(): DockSurface | null {
    return this.#surface.platform === 'darwin' ? this.#surface.dock : null
  }

  /** Quitting mid-wait must not leave a bouncing icon (or a shown Dock) behind. */
  dispose(): void {
    if (this.#disposed) return
    if (this.#attracting) this.#stop()
    this.#surface.flashWindow?.dispose?.()
    this.#disposed = true
  }
}
