import { Menu, Tray, nativeImage, nativeTheme } from 'electron'
import type { NativeImage, MenuItemConstructorOptions } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientMessage } from '@nudge/shared/protocol'
import type { SessionState } from '@nudge/shared/types'

// See main.ts's identical `here` computation for why this can't simply be
// `dirname(fileURLToPath(import.meta.url))`: esbuild's CJS bundle (used for
// the real, runnable app) zeroes out `import.meta`, but injects a real
// `__dirname` for exactly that case; `tsc --build`'s real-ESM output (used
// by every test) has the opposite shape. `typeof __dirname` probes safely
// either way — it never throws, even where `__dirname` isn't declared.
declare const __dirname: string | undefined
const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
// `here` is always dist/ (whether from `tsc --build`'s real ESM output or
// esbuild's bundled CJS output), and the `copy-assets` build step puts the
// committed PNGs at dist/assets on both paths.
//
// This used to point at `../src/assets` — the source tree — because nothing
// copied them into the build output. That worked for every way the app ran
// at the time (tests inject a fake loadImage() and never touch the
// filesystem; `electron .` in dev runs out of the monorepo where src/ is a
// sibling of dist/) and would have broken the moment it was packaged, since
// electron-builder ships dist/ and not src/. Resolving inside the build
// output is what makes the packaged artefact work.
const ASSETS_DIR = join(here, 'assets')

const SNOOZE_MS = 600_000

export type IconState = 'idle' | 'waiting' | 'unreachable'

/**
 * Pure — no Electron API touched. Which asset file to load, and whether the
 * OS should treat it as a `Template` image (macOS only: template images are
 * alpha-masked and the OS recolors them for the current menu bar
 * appearance, so `template` — not `dark` — is what actually drives light/
 * dark correctness there). `dark` is still resolved on darwin (via
 * `nativeTheme.shouldUseDarkColors` in the real surface below) so a single
 * code path works on every platform; it simply doesn't matter cosmetically
 * once `template` is true, because template mode ignores the source pixels'
 * literal color and keys off the alpha channel alone.
 *
 * No `scale` parameter: each returned filename has a `@2x` sibling
 * committed alongside it (see src/assets) and Electron's `nativeImage`
 * finds it automatically — loading `tray-idle-light.png` when
 * `tray-idle-light@2x.png` sits next to it on disk transparently gives you
 * a HiDPI-aware image with both representations built in. See
 * https://www.electronjs.org/docs/latest/api/native-image#high-resolution-image
 */
export function resolveIcon(
  state: IconState,
  opts: { platform: NodeJS.Platform; dark: boolean },
): { file: string; template: boolean } {
  const theme = opts.dark ? 'dark' : 'light'
  return { file: `tray-${state}-${theme}.png`, template: opts.platform === 'darwin' }
}

/**
 * "65000" -> "1m", "90 minutes" -> "1h 30m". Never negative (clock skew).
 * Deliberately duplicated from packages/vscode/src/status.ts's identical
 * helper rather than imported: packages/vscode is out of scope for this
 * task (see the Phase 3 brief), and this is a tiny, self-contained pure
 * function — not shared protocol logic like `@nudge/shared` covers. Sharing
 * it would mean either depending on packages/vscode (wrong direction: the
 * tray must not depend on the editor extension) or extracting it to
 * `@nudge/shared`, which is out of scope here and better done as its own
 * small refactor if a third caller ever needs it.
 */
export function formatWaitDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

/** Opaque handle for a loaded icon image — real code never inspects it, only passes it to setImage(). */
export type TrayImageLike = unknown

export type MenuItemSpec =
  | { type: 'separator' }
  | { type?: 'normal'; label: string; enabled?: boolean; click?: () => void }
  | { type: 'checkbox'; label: string; checked: boolean; click?: () => void }

/**
 * The minimal shape of a real `electron.Tray` this module touches. A real
 * Tray instance satisfies this structurally; a test fake needs nothing more.
 */
export interface TrayIconLike {
  setImage(image: TrayImageLike): void
  setToolTip(tooltip: string): void
  setTitle(title: string): void
  setContextMenu(menu: unknown): void
  destroy(): void
}

/**
 * The slice of the `electron` namespace tray.ts needs. There is no runtime
 * `electron` module outside an Electron host — only the `electron` package's
 * own bundled `.d.ts` for compile-time typing — so a class built straight on
 * `new Tray(...)`/`nativeImage.createFromPath(...)`/`Menu.buildFromTemplate(...)`
 * cannot be constructed, let alone asserted on, under plain Node/Vitest.
 * Injecting this narrow surface (rather than the whole namespace) lets tests
 * drive real render() and menu-building logic with a fake, and lets
 * production code default to the real thing. Same pattern Phase 2 used for
 * `vscode` (see packages/vscode/src/status.ts's identical doc).
 */
export interface TraySurface {
  platform: NodeJS.Platform
  isDark(): boolean
  loadImage(absolutePath: string, template: boolean): TrayImageLike
  createTray(image: TrayImageLike): TrayIconLike
  buildMenu(items: MenuItemSpec[]): unknown
}

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `electron` binding.
 * Only production code (main.ts's composition root) calls `new NudgeTray(...)`
 * with no surface argument; every test supplies its own fake instead.
 */
function defaultSurface(): TraySurface {
  return {
    platform: process.platform,
    isDark: () => nativeTheme.shouldUseDarkColors,
    loadImage: (path, template) => {
      const image = nativeImage.createFromPath(path)
      // Template mode is macOS-only; setTemplateImage exists on every
      // platform's NativeImage but only darwin's menu bar acts on it, so
      // calling it unconditionally (guarded by resolveIcon's own
      // platform-gated `template` flag) is harmless elsewhere.
      if (template) image.setTemplateImage(true)
      return image
    },
    createTray: image => new Tray(image as NativeImage),
    buildMenu: items => Menu.buildFromTemplate(items as MenuItemConstructorOptions[]),
  }
}

/** The four fixed actions Task 5/main.ts wire up — see each callback's own doc below. */
export interface TrayCallbacks {
  /**
   * Task 5's seam: the tray has no editor API of its own, so "focus" has to
   * be implemented per-surface (VS Code, a terminal, a bare desktop app —
   * see the Phase 3 plan's Task 5 table) outside this module entirely. This
   * is the ONE call site that needs to change once that lands — nothing
   * about how the menu is built or clicked does.
   */
  onFocusSession(session: SessionState): void
  /** "Start engine" — only ever offered while unreachable (see #menuItems). */
  onStartEngine(): void
  onOpenHistoryFolder(): void
  /** Current mute state, read fresh each render — mute persists across restarts and other clients can change it. */
  isMuted(): boolean
  /**
   * Current launch-at-login state, read fresh each time the menu is built so
   * the checkmark reflects what the OS actually has registered rather than
   * what this process last set.
   */
  isLaunchAtLogin(): boolean
  onToggleLaunchAtLogin(on: boolean): void
  onQuit(): void
}

/**
 * The tray icon: a persistent menu-bar/taskbar indicator of every session
 * across the whole machine (not scoped to one editor window, unlike the VS
 * Code extension's StatusBar) that is currently waiting on the user — see
 * the Phase 3 plan's Task 3:
 *
 *  - engine unreachable: a distinct icon, a tooltip that says so, and a
 *    "Start engine" menu item — never a blank/idle-looking icon, which would
 *    be indistinguishable from "nothing is wrong" (the plan's explicit
 *    "never silently blank" rule).
 *  - nothing waiting: the plain idle icon, empty tooltip, no badge.
 *  - N waiting: the waiting icon, badged with the count, tooltip listing
 *    project / tier / elapsed per session.
 *
 * `connected` always wins over stale session data, exactly like the VS Code
 * extension's StatusBar: a disconnect can leave the caller holding a stale,
 * non-empty session list from the last broadcast before the engine died,
 * and showing a confident waiting-count the tray can no longer verify would
 * be worse than saying plainly that the engine is unreachable.
 *
 * `send` mirrors the VS Code extension's Toaster constructor (a direct
 * `(msg: ClientMessage) => void`, not a further-removed callback) — Snooze
 * and Mute/Unmute are protocol-level actions this module is allowed to send
 * directly per the plan ("renders engine state and sends commands"); only
 * per-session *focus* is deliberately kept out of protocol reach (see
 * TrayCallbacks.onFocusSession's doc) because focusing must never resolve a
 * wait.
 */
export class NudgeTray {
  readonly #send: (msg: ClientMessage) => void
  readonly #callbacks: TrayCallbacks
  readonly #surface: TraySurface
  readonly #tray: TrayIconLike
  #disposed = false
  #nextId = 1

  constructor(
    send: (msg: ClientMessage) => void,
    callbacks: TrayCallbacks,
    surface: TraySurface = defaultSurface(),
  ) {
    this.#send = send
    this.#callbacks = callbacks
    this.#surface = surface
    const { file, template } = resolveIcon('idle', { platform: surface.platform, dark: surface.isDark() })
    const image = surface.loadImage(join(ASSETS_DIR, file), template)
    this.#tray = surface.createTray(image)
  }

  render(sessions: SessionState[], connected: boolean): void {
    if (this.#disposed) return

    if (!connected) {
      this.#setIcon('unreachable')
      this.#tray.setTitle('')
      this.#tray.setToolTip('The Nudge engine is not running.')
      this.#tray.setContextMenu(this.#surface.buildMenu(this.#menuItems([], false)))
      return
    }

    const now = Date.now()
    const waiting = sessions.filter(s => s.tier !== null && (s.snoozedUntil === null || now >= s.snoozedUntil))

    if (waiting.length === 0) {
      this.#setIcon('idle')
      this.#tray.setTitle('')
      this.#tray.setToolTip('')
    } else {
      this.#setIcon('waiting')
      this.#tray.setTitle(String(waiting.length))
      this.#tray.setToolTip(
        waiting
          .map(s => `${s.project} — ${s.tier} — waiting ${formatWaitDuration(now - (s.waitingSince ?? now))}`)
          .join('\n'),
      )
    }
    this.#tray.setContextMenu(this.#surface.buildMenu(this.#menuItems(waiting, true)))
  }

  #setIcon(state: IconState): void {
    const { file, template } = resolveIcon(state, { platform: this.#surface.platform, dark: this.#surface.isDark() })
    this.#tray.setImage(this.#surface.loadImage(join(ASSETS_DIR, file), template))
  }

  /**
   * Static shape, dynamic content: the same fixed items always appear in
   * the same order (session items, then Snooze 10m / Mute-Unmute / Open
   * history folder / Quit) per the plan — only which per-session items
   * exist, and whether Snooze is enabled, varies with state. The one
   * exception is the unreachable branch, which replaces the (untrustworthy,
   * stale) session items with a single explanatory line and a "Start
   * engine" action instead.
   */
  #menuItems(waiting: SessionState[], connected: boolean): MenuItemSpec[] {
    const items: MenuItemSpec[] = []

    if (!connected) {
      items.push({ label: 'Nudge engine is not running', enabled: false })
      items.push({ label: 'Start engine', click: () => this.#callbacks.onStartEngine() })
    } else if (waiting.length === 0) {
      items.push({ label: 'Nothing waiting', enabled: false })
    } else {
      for (const s of waiting) {
        items.push({ label: `${s.project} — ${s.tier}`, click: () => this.#callbacks.onFocusSession(s) })
      }
    }

    items.push({ type: 'separator' })
    items.push({
      label: 'Snooze 10m',
      enabled: connected && waiting.length > 0,
      click: () => {
        for (const s of waiting) this.#send({ t: 'snooze', id: this.#nextId++, sessionId: s.sessionId, ms: SNOOZE_MS })
      },
    })
    // Read live, exactly like "Start at login" below and for the same reason.
    // This used to be a private `#muted` boolean seeded `false` on every
    // launch: mute persists to config.json, so a freshly started tray showed
    // "Mute" while Nudge was already muted, and clicking it sent a no-op
    // `{on:true}` and then flipped the label — right only by luck. Muting
    // from the CLI or another client inverted it again.
    const muted = this.#callbacks.isMuted()
    items.push({
      type: 'checkbox',
      label: 'Mute',
      checked: muted,
      click: () => { this.#send({ t: 'mute', id: this.#nextId++, on: !muted }) },
    })
    items.push({ label: 'Open history folder', click: () => this.#callbacks.onOpenHistoryFolder() })
    // Read live rather than cached: the user can also change this in the OS's
    // own login-items settings, and a stale checkmark would be a lie.
    const atLogin = this.#callbacks.isLaunchAtLogin()
    items.push({
      type: 'checkbox',
      label: 'Start at login',
      checked: atLogin,
      click: () => this.#callbacks.onToggleLaunchAtLogin(!atLogin),
    })
    items.push({ label: 'Quit', click: () => this.#callbacks.onQuit() })
    return items
  }

  /** Destroys the underlying Tray icon. Guarded so a second call (e.g. from both `before-quit` and an explicit Quit click racing) never double-destroys. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#tray.destroy()
  }
}
