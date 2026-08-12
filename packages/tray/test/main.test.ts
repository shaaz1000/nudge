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
  // main.ts statically imports notify.ts/focus.ts (for their real, default
  // production wiring), and both of those import `Notification`/`clipboard`
  // from 'electron' at module load — so this mock must provide them even
  // though every test below injects its own fake createNotifier/
  // focusSession and never lets the real defaults run.
  Notification: vi.fn(),
  clipboard: { writeText: vi.fn() },
}))

import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import { main, type AppSurface, type EngineClientLike, type TrayLike, type NotifierLike, type AttentionLike } from '../src/main.js'

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

/**
 * A fake NotifierLike, plus the `onFocus` callback main.ts's real
 * `deps.createNotifier` factory is invoked with — captured here so a test
 * can fire it directly and prove main.ts wired it to the exact same focus
 * path as the tray's own `TrayCallbacks.onFocusSession` (Task 4/5's
 * click-fires-focus chain, exercised at the main.ts wiring layer rather than
 * inside Notifier or focus.ts themselves, which each have their own tests).
 */
function makeNotifier() {
  const updates: SessionState[][] = []
  const dispose = vi.fn()
  const notifier: NotifierLike = {
    update: sessions => { updates.push(sessions) },
    dispose,
  }
  let capturedOnFocus: ((s: SessionState) => void) | null = null
  const createNotifier = vi.fn((onFocus: (s: SessionState) => void) => {
    capturedOnFocus = onFocus
    return notifier
  })
  return { notifier, updates, dispose, createNotifier, fireOnFocus: (s: SessionState) => capturedOnFocus?.(s) }
}

/**
 * A fake AttentionLike (Task 7's Dock-bounce/taskbar-flash module). Injected
 * for the same reason as every other fake in this file: the real one drives
 * the actual macOS Dock, and this suite runs on the user's own machine.
 */
function makeAttention() {
  const updates: SessionState[][] = []
  const dispose = vi.fn()
  const attention: AttentionLike = {
    update: sessions => { updates.push(sessions) },
    dispose,
  }
  return { attention, updates, dispose, createAttention: vi.fn(() => attention) }
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
    const { createNotifier } = makeNotifier()

    main({ appSurface: surface, client, createTray, createNotifier, focusSession: vi.fn() })
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
    const { createNotifier } = makeNotifier()

    main({ appSurface: surface, client, createTray, createNotifier, focusSession: vi.fn() })
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
    const { createNotifier } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn() })
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
    const { createNotifier } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn() })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    expect(client.connect).toHaveBeenCalledTimes(1)
  })
})

describe('main: notifier wiring (Task 4)', () => {
  it('calls notifier.update(sessions) on every broadcast, with the exact sessions broadcast', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client, emit } = makeClient()
    const { tray } = makeTray()
    const { createNotifier, updates } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn() })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    const s = session({ sessionId: 's9' })
    emit([s])

    expect(updates[updates.length - 1]).toEqual([s])
  })

  // The full click-fires-focus chain, exercised at the wiring layer: a click
  // on the OS notification calls Notifier's `onFocus` (see notify.test.ts
  // for that half); main.ts must hand Notifier the SAME callback the tray's
  // own context-menu items use (TrayCallbacks.onFocusSession), which in turn
  // must call the injected `focusSession` — not merely log, not a dead end.
  // Deliberately removing `void focus(s)` from callbacks.onFocusSession (or
  // wiring createNotifier to some other, disconnected callback) makes this
  // go RED — see the task report for the exact command and output.
  it('the notifier\'s onFocus callback is wired to the exact same path as the tray\'s onFocusSession, which calls the injected focusSession', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { tray } = makeTray()
    const { createNotifier, fireOnFocus } = makeNotifier()
    const focusSpy = vi.fn()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: focusSpy })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    const s = session({ sessionId: 's9', project: 'clicked-repo' })
    fireOnFocus(s)

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(focusSpy).toHaveBeenCalledWith(s)
  })

  it('the tray\'s own onFocusSession callback (its context-menu items) also calls the injected focusSession, with the exact session', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { createNotifier } = makeNotifier()
    const focusSpy = vi.fn()
    let capturedCallbacks: import('../src/tray.js').TrayCallbacks | undefined
    const { tray } = makeTray()
    const createTray = vi.fn((_send: (msg: ClientMessage) => void, callbacks: import('../src/tray.js').TrayCallbacks) => {
      capturedCallbacks = callbacks
      return tray
    })

    main({ appSurface: surface, client, createTray, createNotifier, focusSession: focusSpy })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    const s = session({ sessionId: 's3', project: 'menu-clicked-repo' })
    capturedCallbacks?.onFocusSession(s)

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(focusSpy).toHaveBeenCalledWith(s)
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
      const { createNotifier } = makeNotifier()

      main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn(), pollIntervalMs: 10 })
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
    const { createNotifier } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn(), pollIntervalMs: 10 })
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
  it('disposes the client, the tray AND the notifier, not merely runs without throwing', async () => {
    const { surface, fireBeforeQuit, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { tray, dispose } = makeTray()
    const { createNotifier, dispose: notifierDispose } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn() })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    expect(client.dispose).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(notifierDispose).not.toHaveBeenCalled()

    fireBeforeQuit()

    expect(client.dispose).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(notifierDispose).toHaveBeenCalledTimes(1)
  })

  it('is safe to fire before-quit twice and does not double-dispose', async () => {
    const { surface, fireBeforeQuit, resolveReady } = makeSurface()
    const { client } = makeClient()
    const { tray } = makeTray()
    const { createNotifier, dispose: notifierDispose } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn() })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    fireBeforeQuit()
    fireBeforeQuit()

    expect(client.dispose).toHaveBeenCalledTimes(1)
    expect(notifierDispose).toHaveBeenCalledTimes(1)
  })

  it('a second instance that quit immediately never registers a before-quit disposal for a client/tray/notifier it never built', async () => {
    const { surface, fireBeforeQuit } = makeSurface({ locked: false })
    const { client } = makeClient()
    const { tray, dispose } = makeTray()
    const { createNotifier, dispose: notifierDispose } = makeNotifier()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, focusSession: vi.fn() })
    await new Promise(r => setTimeout(r, 20))

    // No before-quit handler was ever registered by the losing instance, so
    // firing one (as if the OS still called it) must not touch a client or
    // tray that was never constructed.
    expect(() => fireBeforeQuit()).not.toThrow()
    expect(client.dispose).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(notifierDispose).not.toHaveBeenCalled()
  })
})

describe('main: attention wiring (Task 7)', () => {
  /**
   * The wiring, not the bouncing — AttentionManager's own suite covers what
   * it does with the sessions. This proves main.ts actually hands them over
   * on every broadcast: without the `attention.update(sessions)` call in
   * main.ts's onState handler, the Dock never bounces at all, and every one
   * of attention.test.ts's 41 passing tests would still be green.
   */
  it('feeds every state broadcast to the attention manager', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client, emit } = makeClient()
    const { tray } = makeTray()
    const { createNotifier } = makeNotifier()
    const { createAttention, updates } = makeAttention()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, createAttention, focusSession: vi.fn() })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    const blocked = [session({ tier: 'blocked' })]
    emit(blocked)
    emit([])

    expect(updates).toEqual([blocked, []])
  })

  it('disposes the attention manager on before-quit — quitting mid-wait must not leave the Dock bouncing', async () => {
    const { surface, resolveReady, fireBeforeQuit } = makeSurface()
    const { client, emit } = makeClient()
    const { tray } = makeTray()
    const { createNotifier } = makeNotifier()
    const { createAttention, dispose } = makeAttention()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, createAttention, focusSession: vi.fn() })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))
    emit([session({ tier: 'blocked' })])

    expect(dispose).not.toHaveBeenCalled()

    fireBeforeQuit()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  /**
   * Review finding 4. If the engine dies mid-wait it never broadcasts the
   * resolve, so nothing driven only by `onState` can ever stop. A Dock icon
   * bouncing on state the tray can no longer trust is unstoppable short of
   * quitting Nudge — the poll is the only thing that notices.
   */
  it('the connectivity poll clears attention when the engine goes away mid-wait', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client, emit } = makeClient()
    const { tray } = makeTray()
    const { createNotifier } = makeNotifier()
    const { createAttention, updates } = makeAttention()

    main({
      appSurface: surface, client, createTray: () => tray, createNotifier, createAttention,
      focusSession: vi.fn(), pollIntervalMs: 5,
    })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    emit([session({ tier: 'blocked' })])
    expect(updates.at(-1)).toHaveLength(1)

    client.connected = false
    await new Promise(r => setTimeout(r, 20))

    expect(updates.at(-1)).toEqual([])
  })

  it('the poll keeps feeding the real sessions while the engine is still reachable', async () => {
    const { surface, resolveReady } = makeSurface()
    const { client, emit } = makeClient()
    const { tray } = makeTray()
    const { createNotifier } = makeNotifier()
    const { createAttention, updates } = makeAttention()

    main({
      appSurface: surface, client, createTray: () => tray, createNotifier, createAttention,
      focusSession: vi.fn(), pollIntervalMs: 5,
    })
    resolveReady()
    await new Promise(r => setTimeout(r, 0))

    emit([session({ tier: 'blocked' })])
    await new Promise(r => setTimeout(r, 20))

    // Still connected, so the poll must NOT clear a genuinely waiting session.
    expect(updates.at(-1)).toHaveLength(1)
  })

  it('a second instance never builds an attention manager at all', async () => {
    const { surface } = makeSurface({ locked: false })
    const { client } = makeClient()
    const { tray } = makeTray()
    const { createNotifier } = makeNotifier()
    const { createAttention } = makeAttention()

    main({ appSurface: surface, client, createTray: () => tray, createNotifier, createAttention, focusSession: vi.fn() })
    await new Promise(r => setTimeout(r, 20))

    expect(createAttention).not.toHaveBeenCalled()
  })
})
