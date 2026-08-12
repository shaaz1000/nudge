// Runs the REAL AttentionManager against the REAL Electron API, in a real
// Electron main process, on whatever platform CI is running.
//
// Why this exists: every unit test injects a fake surface, so `defaultSurface()`
// and `lazyFlashWindow()` — 100% of the platform-specific behaviour — are
// executed by nothing. That gap is not theoretical. It hid a crash where
// `app.getLoginItemSettings()` does not exist on Linux and took the whole app
// down before it ever connected, and it hid two macOS Dock bugs that only
// showed up when the real thing ran.
//
// What it CAN prove: the real API accepts our calls, a taskbar window can be
// created/shown/minimized/flashed/destroyed, and the process still exits
// afterwards (a leaked window keeps Electron alive forever).
//
// What it CANNOT prove: that a Windows taskbar button visibly flashes, or
// that a macOS Dock icon visibly bounces. `flashFrame` on a window with no
// taskbar button is a silent no-op, and nothing in software can observe that.
// Those remain eyes-only checks — see the README's Limitations.
import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const log = m => console.log(`smoke-attention: ${m}`)
let failed = false
const fail = m => { console.error(`smoke-attention: FAIL ${m}`); failed = true }

const session = over => ({
  sessionId: 's1', project: 'smoke', cwd: process.cwd(),
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: Date.now(), turnStartedAt: null, lastEventAt: Date.now(),
  message: 'smoke test', snoozedUntil: null, pushFailed: false, ...over,
})

async function run() {
  await app.whenReady()
  const { AttentionManager, defaultSurface, DEFAULT_ATTENTION_CONFIG } =
    await import(join(dist, 'attention.js'))
  const { DEFAULT_CONFIG } = await import(join(dist, '..', '..', 'shared', 'dist', 'config.js'))

  // NUDGE_SMOKE_FORCE_FLASH exercises the Windows/Linux flash path even on a
  // Mac. It cannot make macOS grow a taskbar, but it DOES drive the real
  // BrowserWindow calls that path makes — create, showInactive, minimize,
  // flashFrame, destroy — which is where the crash risk actually lives, and
  // which no unit test reaches. Without it, a Mac-only developer has no way
  // to touch that code at all before CI.
  const { lazyFlashWindow } = await import(join(dist, 'attention.js'))
  const surface = process.env.NUDGE_SMOKE_FORCE_FLASH === '1'
    ? { platform: 'linux', dock: null, flashWindow: lazyFlashWindow() }
    : defaultSurface()
  log(`platform=${surface.platform} dock=${surface.dock ? 'yes' : 'no'} flash=${surface.flashWindow ? 'yes' : 'no'}`)

  const forced = process.env.NUDGE_SMOKE_FORCE_FLASH === '1'
  if (!forced) {
    // What `defaultSurface()` must decide for THIS platform. Getting this
    // backwards means the app silently has no persistent-attention mechanism
    // at all, which is precisely the failure that is invisible without a
    // real run.
    if (process.platform === 'darwin') {
      if (!surface.dock) fail('darwin should expose a dock surface')
      if (surface.flashWindow) fail('darwin should not build a taskbar window')
    } else {
      if (!surface.flashWindow) fail(`${process.platform} should expose a flash surface`)
      if (surface.dock) fail(`${process.platform} should not expose a dock surface`)
    }
  }

  const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, {
    loadConfig: () => structuredClone(DEFAULT_CONFIG),
    now: () => Date.now(),
  })

  // A full cycle, twice — the second proves the manager is reusable rather
  // than one-shot, which is how "it stopped nudging me after the first time"
  // would slip through.
  for (const round of [1, 2]) {
    attn.update([session()])
    await new Promise(r => setTimeout(r, 700))
    attn.update([])
    await new Promise(r => setTimeout(r, 300))
    log(`cycle ${round} ok`)
  }

  attn.dispose()
  log('disposed')

  // The leak check. `lazyFlashWindow` creates a real BrowserWindow on
  // Windows/Linux; if dispose() fails to destroy it, Electron never exits and
  // this script hangs until the CI step times out. Asserting it directly
  // turns a 6-minute mystery timeout into a one-line failure.
  const { BrowserWindow } = await import('electron')
  const alive = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
  if (alive.length > 0) fail(`${alive.length} window(s) still alive after dispose — the process would never exit`)

  if (failed) {
    console.error('smoke-attention: FAILED')
    app.exit(1)
    return
  }
  log('ok — real Electron surface exercised, cycled twice, no windows leaked')
  app.exit(0)
}

run().catch(e => {
  console.error(`smoke-attention: threw ${e.stack ?? e}`)
  app.exit(1)
})
