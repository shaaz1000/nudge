import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from '@nudge/client'
import { nudgeHome } from '@nudge/shared/paths'
import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import { NudgeTray, type TrayCallbacks } from './tray.js'

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
}

function defaultAppSurface(): AppSurface {
  return {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    whenReady: () => app.whenReady(),
    onSecondInstance: cb => { app.on('second-instance', () => cb()) },
    onBeforeQuit: cb => { app.on('before-quit', () => cb()) },
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

export interface MainDeps {
  appSurface?: AppSurface
  client?: EngineClientLike
  createTray?: (send: (msg: ClientMessage) => void, callbacks: TrayCallbacks) => TrayLike
  spawnEngine?: () => void
  openHistoryFolder?: (path: string) => void
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
    const client: EngineClientLike = deps.client ?? new EngineClient()
    const spawnEngine = deps.spawnEngine ?? defaultSpawnEngine
    const openHistoryFolder = deps.openHistoryFolder ?? (path => { void shell.openPath(path) })

    const callbacks: TrayCallbacks = {
      // Task 5's seam (see tray.ts's TrayCallbacks.onFocusSession doc): the
      // tray has no editor API of its own yet. This is the one call site
      // Task 5 replaces — nothing in tray.ts or main.ts's own wiring needs
      // to change when it does.
      onFocusSession: s => {
        console.error(`nudge tray: focusSession not yet implemented (Phase 3 Task 5) — ${s.project} (${s.cwd})`)
      },
      onStartEngine: () => spawnEngine(),
      onOpenHistoryFolder: () => openHistoryFolder(nudgeHome()),
      onQuit: () => surface.quit(),
    }

    const send = (msg: ClientMessage): void => client.send(msg)
    const tray: TrayLike = deps.createTray
      ? deps.createTray(send, callbacks)
      : new NudgeTray(send, callbacks)

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

    client.onState(sessions => {
      tray.render(sessions, client.connected)
      const waiting = sessions.filter(s => s.tier !== null).length
      console.error(`nudge tray: state — ${waiting} waiting, connected=${client.connected}`)
    })

    client.connect()

    active = [client, tray]
  })

  surface.onBeforeQuit(() => {
    for (const d of active) d.dispose()
    active = []
  })
}
