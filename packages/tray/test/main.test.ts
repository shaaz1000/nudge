import { describe, it, expect, vi, beforeEach } from 'vitest'

// `electron` has no runtime module outside an actual Electron host — see
// tray.ts's test suite for the identical reasoning. main.ts's OWN
// electron-facing calls are covered by the injected `AppSurface` fake in
// every test below; this mock only has to satisfy anything main.ts's *own*
// `defaultAppSurface()`/`defaultOpenHistoryFolder()` would touch if a test
// forgot to inject an override (it never should — see EngineClientLike's
// doc in main.ts for why a real EngineClient must never be constructed here).
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  },
  shell: { openPath: vi.fn() },
}))

import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import { main, type AppSurface, type EngineClientLike, type TrayLike } from '../src/main.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/**
 * A fake EngineClientLike, same shape/rationale as the VS Code extension's
 * (see packages/vscode/src/extension.ts's `EngineClientLike` doc): tests
 * must NEVER let `main()` fall through to constructing a real `EngineClient`
 * with no path override, because the default path is the real,
 * currently-running production engine socket.
 */
function makeClient() {
  let stateCb: ((s: SessionState[]) => void) | null = null
  const sent: ClientMessage[] = []
  const client = {
    connected: true,
    onState: (cb: (s: SessionState[]) => void) => { stateCb = cb },
    send: (msg: ClientMessage) => { sent.push(msg) },
    connect: vi.fn(),
    dispose: vi.fn(),
  }
  return { client: client as EngineClientLike & typeof client, sent, emit: (s: SessionState[]) => stateCb?.(s) }
}

function makeTray() {
  const renders: Array<{ sessions: SessionState[]; connected: boolean }> = []
  const dispose = vi.fn()
  const tray: TrayLike = {
    render: (sessions, connected) => { renders.push({ sessions, connected }) },
    dispose,
  }
  return { tray, renders, dispose }
}

/** A fully controllable fake AppSurface — every test injects one explicitly. */
function makeSurface(opts: { locked?: boolean } = {}) {
  const secondInstanceHandlers: Array<() => void> = []
  const beforeQuitHandlers: Array<() => void> = []
  const quit = vi.fn()
  let readyResolve: (() => void) | undefined
  const surface: AppSurface = {
    requestSingleInstanceLock: () => opts.locked ?? true,
    quit,
    whenReady: () => new Promise<void>(resolve => { readyResolve = resolve }),
    onSecondInstance: cb => { secondInstanceHandlers.push(cb) },
    onBeforeQuit: cb => { beforeQuitHandlers.push(cb) },
  }
  return {
    surface,
    quit,
    fireSecondInstance: () => { for (const h of secondInstanceHandlers) h() },
    fireBeforeQuit: () => { for (const h of beforeQuitHandlers) h() },
    resolveReady: () => readyResolve?.(),
    secondInstanceHandlerCount: () => secondInstanceHandlers.length,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('main: single-instance lock', () => {
  // Load-bearing: Phase 1 learned this the hard way one layer down (two
  // engines fighting over one socket). This is that same lesson enforced in
  // the UI layer — a second launch must exit before doing ANYTHING else: no
  // client construction, no connect(), no tray. Deliberately removing the
  // `if (!locked) return` guard in main.ts (or inverting the condition)
  // makes this go RED — see the task report for the exact command and
  // output.
  it('a second instance quits immediately and never connects or builds a tray', async () => {
    const { surface, quit } = makeSurface({ locked: false })
    const { client } = makeClient()
    const { tray, renders } = makeTray()
    const createTray = vi.fn(() => tray)

    main({ appSurface: surface, client, createTray })
    // Give any wrongly-reached whenReady().then(...) a chance to run —
    // without this await, a buggy version that removed the guard could
    // still pass this test by coincidence (the .then() callback hadn't run
    // yet), which is exactly the kind of test that "could not fail".
    await new Promise(r => setTimeout(r, 20))

    expect(quit).toHaveBeenCalledTimes(1)
    expect(client.connect).not.toHaveBeenCalled()
    expect(createTray).not.toHaveBeenCalled()
    expect(renders).toHaveLength(0)
  })

  it('the winning instance registers a second-instance handler and proceeds normally', async () => {
    const { surface, resolveReady, secondInstanceHandlerCount } = makeSurface({ locked: true })
    const { client } = makeClient()
    const { tray } = makeTray()
    const createTray = vi.fn(() => tray)

    main({ appSurface: surface, client, createTray })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    expect(secondInstanceHandlerCount()).toBe(1)
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(createTray).toHaveBeenCalledTimes(1)
  })
})

describe('main: wiring', () => {
  it('renders an initial neutral state, then re-renders on every broadcast with the exact sessions and connected flag', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client, emit } = makeClient()
    const { tray, renders } = makeTray()

    main({ appSurface: surface, client, createTray: () => tray })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    expect(renders[0]).toEqual({ sessions: [], connected: true })

    const s = session({ sessionId: 's9' })
    client.connected = false
    emit([s])

    const last = renders[renders.length - 1]
    expect(last.sessions).toEqual([s])
    expect(last.connected).toBe(false)
  })

  it('calls client.connect() exactly once', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { tray } = makeTray()

    main({ appSurface: surface, client, createTray: () => tray })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    expect(client.connect).toHaveBeenCalledTimes(1)
  })
})

describe('main: connectivity poll', () => {
  // Mirrors the VS Code extension's own fix for the identical gap
  // (extension.ts's CONNECTIVITY_POLL_MS / its doc's "Finding" comment):
  // client.onState() only fires on a fresh broadcast from the engine. If the
  // engine dies without ever sending one (a hard crash, not a graceful
  // shutdown), nothing would ever tell the tray to stop showing stale
  // "waiting" data — the exact "never silently blank" failure Task 3's own
  // brief calls out, just approached from the opposite direction (blank
  // would at least be honest; confidently WRONG is worse).
  it('re-renders to reflect a lost connection even with no fresh broadcast', async () => {
    vi.useFakeTimers()
    try {
      const { surface, resolveReady } = makeSurface()
      const { client, emit } = makeClient()
      const { tray, renders } = makeTray()

      main({ appSurface: surface, client, createTray: () => tray, pollIntervalMs: 10 })
      resolveReady()
      await vi.advanceTimersByTimeAsync(0)
      emit([session({ cwd: '/a/my-repo' })])
      expect(renders[renders.length - 1]).toEqual({ sessions: [session({ cwd: '/a/my-repo' })], connected: true })

      client.connected = false
      await vi.advanceTimersByTimeAsync(10)

      expect(renders[renders.length - 1].connected).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the poll timer on before-quit (clearInterval), not just a no-op on future ticks', async () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { surface, resolveReady, fireBeforeQuit } = makeSurface()
    const { client } = makeClient()
    const { tray } = makeTray()

    main({ appSurface: surface, client, createTray: () => tray, pollIntervalMs: 10 })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))
    const callsBefore = clearSpy.mock.calls.length

    fireBeforeQuit()

    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore)
    clearSpy.mockRestore()
  })
})

describe('main: before-quit disposal', () => {
  // Disposal must be PROVEN, not merely "ran without throwing" — a missing
  // dispose assertion was Phase 2's ninth vacuous test (per the Phase 3
  // brief's self-review). Assert each disposable was actually disposed.
  it('disposes both the client and the tray, not merely runs without throwing', async () => {
    const { surface, fireBeforeQuit, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { tray, dispose } = makeTray()

    main({ appSurface: surface, client, createTray: () => tray })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    expect(client.dispose).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()

    fireBeforeQuit()

    expect(client.dispose).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('is safe to fire before-quit twice and does not double-dispose', async () => {
    const { surface, fireBeforeQuit, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { tray } = makeTray()

    main({ appSurface: surface, client, createTray: () => tray })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    fireBeforeQuit()
    fireBeforeQuit()

    expect(client.dispose).toHaveBeenCalledTimes(1)
  })

  it('a second instance that quit immediately never registers a before-quit disposal for a client/tray it never built', async () => {
    const { surface, fireBeforeQuit } = makeSurface({ locked: false })
    const { client } = makeClient()
    const { tray, dispose } = makeTray()

    main({ appSurface: surface, client, createTray: () => tray })
    await new Promise(r => setTimeout(r, 20))

    // No before-quit handler was ever registered by the losing instance, so
    // firing one (as if the OS still called it) must not touch a client or
    // tray that was never constructed.
    expect(() => fireBeforeQuit()).not.toThrow()
    expect(client.dispose).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })
})
