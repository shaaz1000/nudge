import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from '@nudge/client'
import { nudgeHome } from '@nudge/shared/paths'
import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import { NudgeTray, type TrayCallbacks } from './tray.js'
import { Notifier } from './notify.js'
import { focusSession } from './focus.js'
import {
  AttentionManager, DEFAULT_ATTENTION_CONFIG, defaultSurface as defaultAttentionSurface,
  loadAttentionConfig, type AttentionConfig,
} from './attention.js'

// esbuild's CJS output (used for the real, runnable app — see package.json's
// `bundle` script) zeroes out `import.meta` entirely ("import.meta is not
// available with the cjs output format and will be empty" — its own
// documented limitation), so `fileURLToPath(import.meta.url)` would throw
// there. That same CJS output DOES get a real `__dirname` injected by
// esbuild, covering exactly this case. `typeof __dirname` is safe to probe
// even where `__dirname` is not declared at all (real ESM, i.e. `tsc
// --build`'s own output, used by every test) — `typeof` on an undeclared
// identifier returns `'undefined'` rather than throwing a ReferenceError,
// unlike referencing the bare identifier itself — so this picks the correct
// path in both module systems without either one's build choking on an
// identifier the other doesn't have.
declare const __dirname: string | undefined
const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
// dist/main.js -> ../../engine/dist/bin.js (mirrors packages/cli/src/bin.ts's
// identical relative calculation — same directory depth: <pkg>/dist -> <pkg> -> packages -> engine/dist/bin.js).
const ENGINE_BIN = join(here, '..', '..', 'engine', 'dist', 'bin.js')

/**
 * The subset of `EngineClient`'s public members this module actually uses.
 * `Pick<EngineClient, ...>` strips the class's private (`#`) fields from the
 * resulting type, so a plain fake object satisfies it structurally in
 * tests — a real `EngineClient` cannot otherwise be faked because private
 * fields make classes non-structural (only the class itself, or a
 * subclass, is assignable to it). Same pattern and same warning as the VS
 * Code extension's identical type (packages/vscode/src/extension.ts):
 * tests MUST always inject a fake here via `MainDeps.client`, never let
 * `main()` fall through to constructing a real `EngineClient` with no path
 * override — the default path is the real, currently-running production
 * engine socket.
 */
export type EngineClientLike = Pick<EngineClient, 'connected' | 'onState' | 'send' | 'connect' | 'dispose'>

/** The subset of NudgeTray this module needs — lets tests inject a fake tray without touching Electron at all. */
export interface TrayLike {
  render(sessions: SessionState[], connected: boolean): void
  dispose(): void
}

/** The subset of Notifier this module needs — lets tests inject a fake notifier without touching Electron's real `Notification` at all. */
export interface NotifierLike {
  update(sessions: SessionState[]): void
  dispose(): void
}

/** The subset of AttentionManager this module needs — lets tests inject a fake without touching the real Dock. */
export interface AttentionLike {
  update(sessions: SessionState[], frontmostSessionId?: string | null): void
  dispose(): void
}

/**
 * The slice of the `electron.app` namespace main.ts needs. There is no
 * runtime `electron` module outside an Electron host — only the `electron`
 * package's own bundled `.d.ts` for compile-time typing — so a function
 * built straight on `app.requestSingleInstanceLock()`/`app.whenReady()`
 * cannot be exercised under plain Node/Vitest. Injecting this narrow
 * surface (rather than the whole namespace) lets tests drive the real
 * lifecycle/lock logic with a fake, and lets production code default to the
 * real thing. Same pattern Phase 2 used for `vscode`.
 */
export interface AppSurface {
  requestSingleInstanceLock(): boolean
  quit(): void
  whenReady(): Promise<void>
  onSecondInstance(cb: () => void): void
  onBeforeQuit(cb: () => void): void
  getLoginItemEnabled(): boolean
  setLoginItemEnabled(on: boolean): void
}

function defaultAppSurface(): AppSurface {
  return {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    whenReady: () => app.whenReady(),
    onSecondInstance: cb => { app.on('second-instance', () => cb()) },
    onBeforeQuit: cb => { app.on('before-quit', () => cb()) },
    // `getLoginItemSettings`/`setLoginItemSettings` are macOS+Windows ONLY —
    // Electron does not define them on Linux. They are called from the tray
    // menu, which is rebuilt on EVERY render, so an unguarded call threw a
    // TypeError out of the render, out of the un-caught `whenReady` callback,
    // and took the whole app down before `client.connect()` ever ran: a
    // permanently idle tray icon with no menu, no engine connection, and
    // nothing registered for disposal. Silent, on the platform least likely
    // to be tested.
    getLoginItemEnabled: () => {
      if (!supportsLoginItems()) return false
      try {
        return app.getLoginItemSettings().openAtLogin
      } catch (err) {
        console.error(`nudge tray: could not read login-item settings: ${(err as Error).message}`)
        return false
      }
    },
    // `openAsHidden` is macOS-only and ignored elsewhere; for a menu-bar app
    // there is nothing to show at login anyway, so starting hidden is right
    // on every platform that honours it.
    setLoginItemEnabled: on => {
      if (!supportsLoginItems()) return
      try {
        app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true })
      } catch (err) {
        console.error(`nudge tray: could not set login-item settings: ${(err as Error).message}`)
      }
    },
  }
}

/**
 * Spawns the engine in the background, mirroring packages/cli/src/bin.ts's
 * own `spawnEngine()` — but NOT reusing it verbatim, because
 * `process.execPath` means something different here: inside Electron's main
 * process it points at the Electron binary itself, not a plain `node`.
 * `ELECTRON_RUN_AS_NODE=1` is Electron's documented escape hatch — it makes
 * the *child* process launched from that same binary behave like an
 * ordinary Node process instead of booting the Electron/Chromium runtime.
 * Without it, this would try to launch packages/engine/dist/bin.js as if it
 * were an Electron app, not a plain script.
 */
function defaultSpawnEngine(): void {
  const p = spawn(process.execPath, [ENGINE_BIN], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  p.on('error', e => console.error(`nudge tray: could not start the engine: ${e.message}`))
  p.unref()
}

/** Electron implements login items on macOS and Windows only; on Linux the methods do not exist. */
function supportsLoginItems(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Runs a broadcast consumer so one throwing consumer cannot silence the
 * others. The three consumers are independent renderings of the same state,
 * and the least important of them (persistent attention) must never be able
 * to cost the user their tray icon or their notification.
 */
function guard(what: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error(`nudge tray: ${what} failed: ${(err as Error).message}`)
  }
}

const CONNECTIVITY_POLL_MS = 5_000

/**
 * `loadAttentionConfig` validates loudly, which is right for a typo in an
 * off-switch — but a throw here would abort the whole `whenReady` callback,
 * leaving the user with a tray icon frozen on "nothing waiting", no engine
 * connection, no notifications, and nothing registered for disposal. A
 * mistyped config key must not be able to kill the app.
 *
 * A daemon can afford to die loudly on stderr; a packaged GUI tray has no
 * stderr anyone will ever read, so the failure would be completely silent —
 * the exact "ships an app that silently does nothing" outcome the plan
 * forbids. Degrade to defaults and log instead.
 */
export function readAttentionConfig(): AttentionConfig {
  try {
    return loadAttentionConfig()
  } catch (err) {
    console.error(
      `nudge tray: ignoring the "tray" section of your config (${(err as Error).message}); `
      + 'using defaults — persistent attention stays ON',
    )
    return DEFAULT_ATTENTION_CONFIG
  }
}

export interface MainDeps {
  appSurface?: AppSurface
  client?: EngineClientLike
  createTray?: (send: (msg: ClientMessage) => void, callbacks: TrayCallbacks) => TrayLike
  /**
   * Task 4's seam: builds the clickable-notification module. `onFocus` is
   * the same callback wired to the tray's own per-session menu items
   * (`TrayCallbacks.onFocusSession`) — a click on the OS notification and a
   * click on the tray's context menu land on the exact same focus path.
   * Defaults to a real `Notifier` (electron `Notification`); tests must
   * always inject a fake here, never let a real one construct (see
   * `EngineClientLike`'s identical warning above).
   */
  createNotifier?: (onFocus: (s: SessionState) => void) => NotifierLike
  /**
   * Task 5's seam: brings the right window forward for a session, from
   * outside any editor. Defaults to the real `focusSession` (spawns
   * `code`/`osascript`/etc., or falls back to the clipboard) — tests must
   * always inject a fake, exactly like every other Electron-touching
   * default on this interface.
   */
  focusSession?: (s: SessionState) => Promise<void> | void
  /**
   * Task 7's seam: persistent attention (macOS Dock bounce / Windows-Linux
   * taskbar flash). Defaults to a real `AttentionManager` over the real Dock
   * — tests must always inject a fake, exactly like every other
   * Electron-touching default on this interface.
   */
  createAttention?: () => AttentionLike
  spawnEngine?: () => void
  openHistoryFolder?: (path: string) => void
  /** Overrides the connectivity poll interval — tests only; production always uses CONNECTIVITY_POLL_MS. */
  pollIntervalMs?: number
}

interface Disposable { dispose(): void }

// Module-scoped so `onBeforeQuit`'s callback (registered once per real
// launch) can tear down whatever the most recent main() built, mirroring
// the VS Code extension's identical `active`/`deactivate()` pattern.
let active: Disposable[] = []

/**
 * The composition root: acquires the single-instance lock, and — only if it
 * wins — builds the engine client and tray, wires the engine's state
 * broadcasts to the tray, and registers `before-quit` disposal.
 *
 * `deps` exists purely for testability (same pattern as the VS Code
 * extension's `activate(context, deps)`) — the real Electron entry point
 * (index.ts) only ever calls `main()` with no argument.
 */
export function main(deps: MainDeps = {}): void {
  const surface = deps.appSurface ?? defaultAppSurface()

  // Phase 1 learned this the hard way one layer down: two engines started
  // against the same NUDGE_HOME coexisted and fought over the socket file.
  // This is that same lesson enforced here, in the UI layer, before this
  // process does anything else at all — no client, no socket, no tray. A
  // losing second launch must return immediately; nothing below this guard
  // may run for it.
  if (!surface.requestSingleInstanceLock()) {
    surface.quit()
    return
  }

  // Fires on the SURVIVING instance when a second launch is attempted and
  // bails via the guard above. There is no window to bring forward (this is
  // a tray-only app — see the Task 2 brief), so there is nothing more useful
  // to do than note it happened.
  surface.onSecondInstance(() => {
    console.error('nudge tray: a second instance was launched and exited; this instance keeps running')
  })

  void surface.whenReady().then(() => {
    // See EngineClientLike's doc above: never construct a real EngineClient
    // with no override outside of production use (deps.client is undefined).
    // `gui: true` (review round 1, Finding 5 — USER-APPROVED): this tray IS
    // the clickable GUI notification the engine defers to — see notify.ts's
    // Notifier class doc for the double-notification problem this closes,
    // and engine.ts's onLocal for the other half of the fix.
    const client: EngineClientLike = deps.client ?? new EngineClient({ gui: true })
    const spawnEngine = deps.spawnEngine ?? defaultSpawnEngine
    const openHistoryFolder = deps.openHistoryFolder ?? (path => { void shell.openPath(path) })
    const focus = deps.focusSession ?? focusSession

    const callbacks: TrayCallbacks = {
      // Task 5's seam (see tray.ts's TrayCallbacks.onFocusSession doc): the
      // tray has no editor API of its own, so this delegates to focus.ts's
      // per-surface dispatch (VS Code/Cursor/Windsurf, the Claude desktop
      // app, Terminal.app/iTerm2, Windows Terminal, or a clipboard
      // fallback). Also the exact callback Notifier's own click handler
      // reaches (see below) — a click on the OS notification and a click
      // on the tray's context menu land on the identical focus path.
      onFocusSession: s => { void focus(s) },
      onStartEngine: () => spawnEngine(),
      onOpenHistoryFolder: () => openHistoryFolder(nudgeHome()),
      isLaunchAtLogin: () => surface.getLoginItemEnabled(),
      onToggleLaunchAtLogin: on => surface.setLoginItemEnabled(on),
      onQuit: () => surface.quit(),
    }

    const send = (msg: ClientMessage): void => client.send(msg)
    const tray: TrayLike = deps.createTray
      ? deps.createTray(send, callbacks)
      : new NudgeTray(send, callbacks)

    // Task 4's clickable-notification module. Wired to the SAME
    // `callbacks.onFocusSession` the tray's own per-session menu items use
    // (not a second, independent path to focus.ts) — see Notifier's class
    // doc for the de-duplication contract. Round 1, Finding 5 closed the
    // visual duplication against the engine's own osascript banner (the
    // engine skips its banner entirely while this tray is connected); round
    // 2, Finding 1 closed the follow-on audible gap that fix introduced (the
    // engine's sound-only alert, including escalation repeats, still plays
    // while this Notifier's own banner stays `silent: true`) — neither is an
    // open, out-of-scope gap any more.
    const notifier: NotifierLike = deps.createNotifier
      ? deps.createNotifier(s => callbacks.onFocusSession(s))
      : new Notifier(s => callbacks.onFocusSession(s))

    // NudgeTray's own constructor never calls render() (mirrors StatusBar —
    // see its doc) — without this, the icon would sit on whatever
    // #setIcon('idle') the constructor seeded, forever, until the first
    // broadcast. Rendered neutrally (as if reachable with nothing waiting)
    // for the identical reason extension.ts seeds StatusBar this way: a
    // fresh EngineClient always starts `connected === false` before its
    // first connection attempt even begins, and painting the "unreachable"
    // state synchronously here would be confidently wrong far more often
    // than it would be right.
    tray.render([], true)

    // Task 7. Unlike the tray icon (passive) and the notification (banner
    // that auto-dismisses in seconds), this one does not stop until the wait
    // actually clears — it is the signal that survives the user looking away,
    // which is the exact failure this product exists to fix.
    const attention: AttentionLike = deps.createAttention
      ? deps.createAttention()
      : new AttentionManager(defaultAttentionSurface(), readAttentionConfig())

    let lastSessions: SessionState[] = []
    client.onState(sessions => {
      lastSessions = sessions
      // Each consumer is isolated: the client swallows a throwing listener,
      // so without this a single failing render would silently stop the
      // notification AND the Dock bounce for that broadcast — and forever, if
      // the failure is deterministic. AttentionManager already guards its own
      // body for this reason; the ordering meant the other two could still
      // break it.
      guard('tray render', () => tray.render(sessions, client.connected))
      guard('notification update', () => notifier.update(sessions))
      // Frontmost is deliberately not passed: the engine tracks it privately
      // (engine.ts's `#frontmost`) and does not include it in its state
      // broadcast, so no client can observe it. AttentionManager implements
      // and tests the rule regardless — see its `update` doc.
      guard('attention update', () => attention.update(sessions))
      const waiting = sessions.filter(s => s.tier !== null).length
      console.error(`nudge tray: state — ${waiting} waiting, connected=${client.connected}`)
    })

    // client.onState() only fires on a fresh broadcast — if the engine dies
    // without ever sending one (a hard crash, not a graceful shutdown),
    // nothing would otherwise tell the tray to stop showing stale "waiting"
    // data. Mirrors the VS Code extension's identical fix
    // (extension.ts's CONNECTIVITY_POLL_MS) for the exact same gap.
    let lastConnected = client.connected
    const pollTimer = setInterval(() => {
      // Guarded: an unprotected throw in a bare timer callback is an uncaught
      // exception on the Electron main thread — an error dialog or a dead
      // app, every 5 seconds, forever.
      guard('tray render (poll)', () => tray.render(lastSessions, client.connected))
      // Attention is driven from the poll too, not just from broadcasts. If
      // the engine dies mid-wait it will never broadcast the resolve, and a
      // Dock icon bouncing on state the tray can no longer trust cannot be
      // stopped by anything short of quitting Nudge. Treating "disconnected"
      // as "nothing waiting" clears it; the next broadcast after a reconnect
      // starts it again if the wait is still real.
      //
      // Only on a connectivity *flip*, not every tick: `update()` re-reads
      // config.json, and doing that unconditionally would mean a synchronous
      // read + validate + clone on the Electron main thread every 5 seconds
      // for the entire time the app is logged in — plus a fresh error log
      // every 5 seconds for anyone with a broken config.
      if (client.connected !== lastConnected) {
        lastConnected = client.connected
        if (!client.connected) {
          // Drop the pre-outage snapshot as well as clearing the alert.
          // Keeping it meant a reconnect re-raised a bounce from stale data —
          // for waits the user may well have answered while the engine was
          // down. The engine sends a fresh snapshot on reconnect anyway.
          lastSessions = []
        }
        guard('attention update (poll)', () => attention.update(lastSessions))
      }
    }, deps.pollIntervalMs ?? CONNECTIVITY_POLL_MS)

    client.connect()

    // `attention` disposes with the rest: quitting mid-wait must not leave a
    // bouncing Dock icon behind (see AttentionManager#dispose).
    active = [client, tray, notifier, attention, { dispose: () => clearInterval(pollTimer) }]
  }).catch((err: Error) => {
    // Without this, ANY throw inside the whenReady callback aborted the rest
    // of startup silently: no engine connection, no notifications, and an
    // `active` array still empty so the live Tray had no disposal path. A
    // packaged GUI app has no stderr anyone reads, so the user would simply
    // see an inert icon and conclude the product does not work.
    console.error(`nudge tray: startup failed: ${err.stack ?? err.message}`)
  })

  surface.onBeforeQuit(() => {
    for (const d of active) d.dispose()
    active = []
  })
}
