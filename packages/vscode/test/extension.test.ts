import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Same reason as status.test.ts/toast.test.ts/focus.test.ts: `vscode` has no
// runtime module outside an editor host. This mock exists only so importing
// '../src/extension.js' (which transitively imports status.ts, toast.ts and
// focus.ts) does not throw. extension.ts's OWN vscode-facing calls are
// covered by the injected `ExtensionSurface` fake in every test below — this
// mock only has to satisfy StatusBar's, Toaster's and focus.ts's *own*
// internal `defaultSurface()`s, which extension.ts constructs with no
// override (`new StatusBar()`, `new Toaster(...)`, `focusSession(target)`).
// vi.mock(...) is hoisted above every top-level statement in this file,
// including ordinary `const` declarations — referencing a plain module-level
// const from inside the factory throws "Cannot access before initialization"
// at that hoisted call site. vi.hoisted() is hoisted together with vi.mock
// itself, which is what makes this work.
const { statusBarItem, vscodeMock } = vi.hoisted(() => {
  const statusBarItem = {
    text: '', tooltip: undefined as unknown, backgroundColor: undefined as unknown, command: undefined as unknown,
    show: vi.fn(), dispose: vi.fn(),
  }
  const vscodeMock = {
    window: {
      createStatusBarItem: vi.fn(() => statusBarItem),
      showWarningMessage: vi.fn(),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(public id: string) {} },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: (_k: string, def: unknown) => def })),
      workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
    },
    commands: { executeCommand: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p }) },
  }
  return { statusBarItem, vscodeMock }
})
vi.mock('vscode', () => vscodeMock)

import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import {
  activate, deactivate, clientOptionsFromConfig,
  type ExtensionSurface, type SessionQuickPickItem,
} from '../src/extension.js'
// Toaster itself is NOT mocked (only 'vscode' is) — activate() constructs a
// real Toaster internally with no injection seam of its own (see toast.ts's
// own test suite for that layer's coverage). Spying on the real prototype
// method is how this file observes that the specific instance activate()
// built was actually disposed, without adding a needless injection point to
// extension.ts just to satisfy this one assertion.
import { Toaster } from '../src/toast.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/**
 * A fake EngineClientLike. Its shape is checked structurally against
 * `Pick<EngineClient, ...>` — see extension.ts's doc for why that is safe:
 * this file must NEVER construct a real `EngineClient` with no path
 * override, because the default path is the real, currently-running
 * production engine socket.
 */
function makeClient() {
  let stateCb: ((s: SessionState[]) => void) | null = null
  const sent: ClientMessage[] = []
  // Deliberately NOT typed as EngineClientLike here: that type's `connected`
  // is a readonly-in-practice getter mirror, and this fake needs to flip it
  // mid-test (simulating the engine going away). Left as its own mutable
  // inferred type; TS still checks it structurally against EngineClientLike
  // when it's handed to activate() below, since widening a mutable property
  // to a readonly-typed parameter is always sound.
  const client = {
    connected: true,
    onState: (cb: (s: SessionState[]) => void) => { stateCb = cb },
    send: (msg: ClientMessage) => { sent.push(msg) },
    connect: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    client,
    sent,
    emit: (sessions: SessionState[]) => stateCb?.(sessions),
  }
}

interface FakeCommand { id: string; cb: (...args: unknown[]) => unknown; disposed: boolean }

/** A fully controllable fake ExtensionSurface — every test injects one explicitly. */
function makeSurface(opts: { folders?: string[]; focused?: boolean } = {}) {
  const commands = new Map<string, FakeCommand>()
  const windowStateHandlers: Array<(e: { focused: boolean }) => void> = []
  const windowStateDisposed = { value: false }
  const showQuickPick = vi.fn<(items: SessionQuickPickItem[], opts?: unknown) => Promise<SessionQuickPickItem | undefined>>()
    .mockResolvedValue(undefined)
  const showInformationMessage = vi.fn().mockResolvedValue(undefined)
  const configGet = <T,>(_k: string, def: T): T => def

  const surface: ExtensionSurface = {
    workspaceFolderPaths: () => opts.folders ?? [],
    getConfiguration: () => ({ get: configGet }),
    isWindowFocused: () => opts.focused ?? true,
    onDidChangeWindowState: cb => {
      windowStateHandlers.push(cb)
      return { dispose: () => { windowStateDisposed.value = true } }
    },
    registerCommand: (id, cb) => {
      const entry: FakeCommand = { id, cb, disposed: false }
      commands.set(id, entry)
      return { dispose: () => { entry.disposed = true } }
    },
    showQuickPick,
    showInformationMessage,
  }

  return {
    surface,
    commands,
    invoke: (id: string, ...args: unknown[]) => commands.get(id)!.cb(...args),
    fireWindowState: (focused: boolean) => { for (const h of windowStateHandlers) h({ focused }) },
    windowStateDisposed,
    showQuickPick,
    showInformationMessage,
    configGet,
  }
}

function makeContext() {
  const subscriptions: { dispose(): void }[] = []
  return { context: { subscriptions } as unknown as import('vscode').ExtensionContext, subscriptions }
}

beforeEach(() => {
  statusBarItem.text = ''
  statusBarItem.tooltip = undefined
  statusBarItem.backgroundColor = undefined
  statusBarItem.command = undefined
  statusBarItem.show.mockClear()
  statusBarItem.dispose.mockClear()
  vscodeMock.window.createStatusBarItem.mockClear()
  vscodeMock.window.showWarningMessage.mockClear()
  vscodeMock.commands.executeCommand.mockClear()
  vscodeMock.workspace.workspaceFolders = undefined
})

afterEach(() => {
  deactivate()
})

describe('clientOptionsFromConfig', () => {
  it('passes no path override when the setting is empty (production default socket)', () => {
    expect(clientOptionsFromConfig('')).toEqual({})
  })

  it('passes the configured path through when the setting is set', () => {
    expect(clientOptionsFromConfig('/custom/engine.sock')).toEqual({ path: '/custom/engine.sock' })
  })
})

describe('activate: rendering', () => {
  // StatusBar's own constructor never calls render() (see status.ts) — without
  // an explicit initial render, the item would sit blank (no icon at all,
  // not even the "unreachable" one) until the first broadcast or the first
  // poll tick, which could be seconds away. But — Finding I1 — a fresh
  // `EngineClient` always starts with `connected === false` (it hasn't tried
  // yet; `client.connect()` is only called at the end of activate(), and is
  // async even then). Rendering THAT value synchronously used to paint
  // "$(bell-slash) Nudge — The Nudge engine is not running" before any
  // connection attempt had even started, let alone failed. This is now a
  // neutral initial paint instead: it must NOT claim the engine is down
  // before a real attempt has resolved one way or the other.
  it('renders an immediate initial status — synchronously, before any broadcast or poll tick — without claiming the engine is down before any attempt has resolved', () => {
    const { client } = makeClient()
    client.connected = false // fresh client: hasn't attempted to connect yet
    const { surface } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface, pollIntervalMs: 60_000 })

    expect(statusBarItem.text).not.toBe('$(bell-slash) Nudge')
  })

  // Companion to the test above: the neutral seed must still be a real,
  // correctable placeholder, not a state nothing can move on from. A stale
  // `client.connected` read is exactly what production activate() has
  // available synchronously — this proves genuine information (a broadcast,
  // here standing in for the list-snapshot / poll paths) still overrides it.
  it('the neutral initial paint is corrected by the first real broadcast, connected or not', () => {
    const { client, emit } = makeClient()
    client.connected = false
    const { surface } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()

    activate(context, { client, surface, pollIntervalMs: 60_000 })
    client.connected = true
    emit([session({ sessionId: 's1', cwd: '/a/my-repo' })])

    expect(statusBarItem.text).toBe('$(bell-dot) Nudge 1')
  })

  it('renders the status bar and toasts from sessionsForWindow(sessions, folders), not the raw broadcast', () => {
    const { client, emit } = makeClient()
    const { surface } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([
      session({ sessionId: 's1', project: 'mine', cwd: '/a/my-repo' }),
      session({ sessionId: 's2', project: 'not-mine', cwd: '/b/other' }),
    ])

    expect(statusBarItem.text).toBe('$(bell-dot) Nudge 1')
    expect(statusBarItem.tooltip).toContain('mine')
    expect(statusBarItem.tooltip).not.toContain('not-mine')
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(1)
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('mine'), 'Go to it', 'Snooze 10m')
  })

  it('calls client.connect() once during activation', () => {
    const { client } = makeClient()
    const { surface } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })

    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('re-renders the status bar to reflect a lost connection even with no fresh broadcast (poll)', () => {
    vi.useFakeTimers()
    try {
      const { client, emit } = makeClient()
      const { surface } = makeSurface({ folders: ['/a/my-repo'] })
      const { context } = makeContext()

      activate(context, { client, surface, pollIntervalMs: 10 })
      emit([session({ cwd: '/a/my-repo' })])
      expect(statusBarItem.text).toBe('$(bell-dot) Nudge 1')

      client.connected = false
      vi.advanceTimersByTime(10)

      expect(statusBarItem.text).toBe('$(bell-slash) Nudge')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('activate: frontmost reporting', () => {
  it('sends {t:"frontmost", sessionId} when this window gains focus and owns a waiting session', () => {
    const { client, emit, sent } = makeClient()
    const { surface, fireWindowState } = makeSurface({ folders: ['/a/my-repo'], focused: false })
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([session({ sessionId: 's1', cwd: '/a/my-repo' })])

    fireWindowState(true)

    expect(sent).toContainEqual({ t: 'frontmost', sessionId: 's1' })
  })

  it('sends {t:"frontmost", sessionId: null} when this window loses focus', () => {
    const { client, emit, sent } = makeClient()
    const { surface, fireWindowState } = makeSurface({ folders: ['/a/my-repo'], focused: true })
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([session({ sessionId: 's1', cwd: '/a/my-repo' })])
    sent.length = 0 // clear whatever activation-time noise, isolate the loss event

    fireWindowState(false)

    expect(sent).toContainEqual({ t: 'frontmost', sessionId: null })
  })

  // Load-bearing negative case: gaining focus while this window owns NOTHING
  // waiting must not send anything at all — not even `{sessionId: null}` —
  // per the brief's explicit gate ("gains focus AND owns a waiting
  // session"). A version that always fires on gain (with null as a
  // fallback) would still look plausible but would spam the wire on every
  // window switch.
  it('does not send a frontmost message at all when this window gains focus but owns nothing waiting', () => {
    const { client, emit, sent } = makeClient()
    const { surface, fireWindowState } = makeSurface({ folders: ['/a/my-repo'], focused: false })
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([session({ sessionId: 's1', cwd: '/a/my-repo', tier: null, status: 'running', waitingSince: null })])
    sent.length = 0

    fireWindowState(true)

    expect(sent).toHaveLength(0)
  })

  it('re-reports frontmost when the waiting set changes while still focused, without waiting for a focus toggle', () => {
    const { client, emit, sent } = makeClient()
    const { surface } = makeSurface({ folders: ['/a/my-repo'], focused: true })
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([session({ sessionId: 's1', cwd: '/a/my-repo', tier: null, status: 'running', waitingSince: null })])
    expect(sent).toHaveLength(0) // nothing waiting yet, focused: no send

    emit([session({ sessionId: 's1', cwd: '/a/my-repo', tier: 'blocked' })])

    expect(sent).toContainEqual({ t: 'frontmost', sessionId: 's1' })
  })

  // Finding I2: the engine holds ONE global frontmost, not one per window.
  // A window that never reported a non-null frontmost (because it never
  // owned a waiting session while focused) must not send `{sessionId: null}`
  // on blur either — doing so unconditionally would clear whatever a
  // DIFFERENT, legitimately-reporting window had just claimed.
  it('does not send {t:"frontmost", sessionId: null} on blur if this window never reported a non-null frontmost in the first place', () => {
    const { client, sent } = makeClient()
    const { surface, fireWindowState } = makeSurface({ folders: ['/b/unrelated'], focused: true })
    const { context } = makeContext()

    activate(context, { client, surface })
    // No emit(): this window never owns anything, so it never sent a
    // non-null frontmost report — there is nothing here for it to clear.

    fireWindowState(false)

    expect(sent).toHaveLength(0)
  })

  // Two-window interleaving, the scenario the finding actually describes:
  // window A owns a waiting session and is the one legitimately reporting
  // frontmost. Window B is a completely separate window (different
  // workspace, different EngineClient/socket in the real world, but here
  // driven through its own activate()) that never owns anything. B losing
  // focus — e.g. the user briefly alt-tabbed to it and back — must not
  // touch the engine's frontmost pointer at all, let alone clear A's claim.
  it('two-window interleaving: window B blurring never sends anything, so it cannot clobber window A\'s legitimate frontmost claim', () => {
    const { client: clientA, emit: emitA, sent: sentA } = makeClient()
    const { surface: surfaceA, fireWindowState: fireA } = makeSurface({ folders: ['/a/my-repo'], focused: false })
    const { context: contextA } = makeContext()
    activate(contextA, { client: clientA, surface: surfaceA })
    emitA([session({ sessionId: 'sA', cwd: '/a/my-repo' })])
    fireA(true)
    expect(sentA).toContainEqual({ t: 'frontmost', sessionId: 'sA' })
    deactivate()

    const { client: clientB, sent: sentB } = makeClient()
    const { surface: surfaceB, fireWindowState: fireB } = makeSurface({ folders: ['/b/unrelated'], focused: true })
    const { context: contextB } = makeContext()
    activate(contextB, { client: clientB, surface: surfaceB })

    fireB(false)

    // B never claimed anything: on the real (single global frontmost)
    // engine, this must not clear A's still-valid claim above.
    expect(sentB).toHaveLength(0)
  })
})

describe('activate: command registration', () => {
  it('registers exactly the four Task 6 commands', () => {
    const { client } = makeClient()
    const { surface, commands } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })

    expect([...commands.keys()].sort()).toEqual([
      'nudge.focusSession', 'nudge.mute', 'nudge.showList', 'nudge.snooze',
    ])
  })
})

describe('nudge.focusSession command — the no-resolve rule', () => {
  // The rule most likely to be broken later by someone "tidying up" (per the
  // Task 5 brief): focusing must never resolve the wait, because resolving
  // closes the history row early and cancels a still-valid escalation.
  // Confirmed this goes RED by temporarily adding
  // `client.send({t:'resolve', ...})` right after `focusSession(target)` in
  // extension.ts's nudge.focusSession handler — see the task report for the
  // failure output. Kept permanently: unlike focus.ts (which structurally
  // has no way to send anything), this handler genuinely holds a `client`
  // with a working `send`, so this is the one place the rule could actually
  // be violated by a future edit.
  it('never sends {t:"resolve"} regardless of which branch (this window, another folder, or no-arg fallback) fires', async () => {
    const scenarios: Array<{ folders: string[]; wsFolders: { uri: { fsPath: string } }[]; arg?: SessionState }> = [
      { folders: ['/a/my-repo'], wsFolders: [{ uri: { fsPath: '/a/my-repo' } }], arg: session({ sessionId: 's1', cwd: '/a/my-repo' }) },
      { folders: ['/a/my-repo'], wsFolders: [{ uri: { fsPath: '/a/my-repo' } }], arg: session({ sessionId: 's2', cwd: '/b/other' }) },
      { folders: ['/a/my-repo'], wsFolders: [{ uri: { fsPath: '/a/my-repo' } }] }, // no-arg fallback branch
    ]

    for (const scenario of scenarios) {
      const { client, emit, sent } = makeClient()
      const { surface, invoke } = makeSurface({ folders: scenario.folders })
      const { context } = makeContext()
      vscodeMock.workspace.workspaceFolders = scenario.wsFolders

      activate(context, { client, surface })
      if (!scenario.arg) emit([session({ sessionId: 's1', cwd: '/a/my-repo' })])

      await invoke('nudge.focusSession', ...(scenario.arg ? [scenario.arg] : []))

      expect(sent.some(m => m.t === 'resolve')).toBe(false)
      deactivate()
    }
  })


  it('focusing a session in this window reveals the terminal and never calls client.send', async () => {
    const { client, emit, sent } = makeClient()
    const { surface, invoke } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/a/my-repo' } }]

    activate(context, { client, surface })
    const s = session({ sessionId: 's1', cwd: '/a/my-repo' })
    emit([s])

    await invoke('nudge.focusSession', s)

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('workbench.action.terminal.focus')
    // Not toHaveLength(0): the emit() above legitimately triggers a
    // `frontmost` report (this window is focused and now owns a waiting
    // session — a separate, correct feature). The rule under test is
    // specifically that focusing never resolves the wait.
    expect(sent.some(m => m.t === 'resolve')).toBe(false)
  })

  it('focusing a session in a different folder opens/reuses that folder and never calls client.send', async () => {
    const { client, sent } = makeClient()
    const { surface, invoke } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/a/my-repo' } }]

    activate(context, { client, surface })
    const other = session({ sessionId: 's2', cwd: '/b/other' })

    await invoke('nudge.focusSession', other)

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder', expect.anything(), { forceNewWindow: false },
    )
    expect(sent).toHaveLength(0)
  })

  it('invoked with no argument (status bar click) falls back to the single session this window owns, still without resolving', async () => {
    const { client, emit, sent } = makeClient()
    const { surface, invoke } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/a/my-repo' } }]

    activate(context, { client, surface })
    emit([session({ sessionId: 's1', cwd: '/a/my-repo' })])

    await invoke('nudge.focusSession')

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('workbench.action.terminal.focus')
    // Same reasoning as the test above: emit() legitimately triggers a
    // `frontmost` report; only `resolve` is forbidden here.
    expect(sent.some(m => m.t === 'resolve')).toBe(false)
  })

  it('invoked with no argument and nothing waiting does nothing (no command, no send, no popup)', async () => {
    const { client } = makeClient()
    const { surface, invoke, showInformationMessage } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()

    activate(context, { client, surface })

    await invoke('nudge.focusSession')

    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled()
    expect(showInformationMessage).not.toHaveBeenCalled()
  })
})

describe('nudge.snooze command', () => {
  it('sends {t:"snooze", sessionId, ms:600000} for an explicitly-passed session', () => {
    const { client, sent } = makeClient()
    const { surface, invoke } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })
    invoke('nudge.snooze', session({ sessionId: 's1' }))

    expect(sent).toContainEqual(expect.objectContaining({ t: 'snooze', sessionId: 's1', ms: 600_000 }))
  })

  it('with no argument and exactly one session waiting anywhere, snoozes that one without prompting', async () => {
    const { client, emit, sent } = makeClient()
    const { surface, invoke, showQuickPick } = makeSurface({ folders: [] })
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([session({ sessionId: 's1' })])

    await invoke('nudge.snooze')

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(sent).toContainEqual(expect.objectContaining({ t: 'snooze', sessionId: 's1', ms: 600_000 }))
  })

  it('with no argument and nothing waiting anywhere, shows an info message and sends nothing', async () => {
    const { client, sent } = makeClient()
    const { surface, invoke, showInformationMessage } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })

    await invoke('nudge.snooze')

    expect(sent).toHaveLength(0)
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('nothing'))
  })

  it('with no argument and multiple sessions waiting, prompts a quick pick and snoozes the chosen one', async () => {
    const { client, emit, sent } = makeClient()
    const { surface, invoke, showQuickPick } = makeSurface()
    const { context } = makeContext()
    const a = session({ sessionId: 's1', project: 'repo-a' })
    const b = session({ sessionId: 's2', project: 'repo-b' })
    showQuickPick.mockResolvedValue({ label: 'repo-b', session: b } as SessionQuickPickItem)

    activate(context, { client, surface })
    emit([a, b])

    await invoke('nudge.snooze')

    expect(showQuickPick).toHaveBeenCalledTimes(1)
    expect(sent).toContainEqual(expect.objectContaining({ t: 'snooze', sessionId: 's2', ms: 600_000 }))
  })

  // I4 mutation coverage: `allWaiting` (used by both nudge.snooze and
  // nudge.showList's no-arg fallback) must filter to `tier !== null` — a
  // mutation that dropped the filter (allWaiting = sessions verbatim) left
  // every other test in this file green because they only ever emit
  // already-waiting sessions. Mixing in a non-waiting one is what exposes
  // it: with the filter, exactly one session qualifies (no prompt needed);
  // without it, two "waiting" sessions would trigger a quick pick instead.
  it('allWaiting excludes sessions with tier: null, not just the ones nudge.showList happens to be fed', async () => {
    const { client, emit, sent } = makeClient()
    const { surface, invoke, showQuickPick } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })
    emit([
      session({ sessionId: 'not-waiting', tier: null, status: 'running', waitingSince: null }),
      session({ sessionId: 'waiting', tier: 'blocked' }),
    ])

    await invoke('nudge.snooze')

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(sent).toContainEqual(expect.objectContaining({ t: 'snooze', sessionId: 'waiting', ms: 600_000 }))
  })
})

describe('nudge.mute command', () => {
  it('toggles: first invocation mutes, second unmutes', () => {
    const { client, sent } = makeClient()
    const { surface, invoke } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })
    invoke('nudge.mute')
    invoke('nudge.mute')

    expect(sent[0]).toMatchObject({ t: 'mute', on: true })
    expect(sent[1]).toMatchObject({ t: 'mute', on: false })
  })
})

describe('nudge.showList command', () => {
  it('with nothing waiting, shows an info message and never opens a quick pick', async () => {
    const { client } = makeClient()
    const { surface, invoke, showQuickPick, showInformationMessage } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })
    await invoke('nudge.showList')

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('nothing'))
  })

  it('lists every waiting session system-wide (not only this window\'s), and focusing the picked one never resolves it', async () => {
    const { client, emit, sent } = makeClient()
    const { surface, invoke, showQuickPick } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/a/my-repo' } }]
    const mine = session({ sessionId: 's1', project: 'mine', cwd: '/a/my-repo' })
    const theirs = session({ sessionId: 's2', project: 'theirs', cwd: '/b/other' })
    showQuickPick.mockResolvedValue({ label: 'theirs', session: theirs } as SessionQuickPickItem)

    activate(context, { client, surface })
    emit([mine, theirs])

    await invoke('nudge.showList')

    const [items] = showQuickPick.mock.calls[0]
    expect(items.map(i => i.session.sessionId).sort()).toEqual(['s1', 's2'])
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder', expect.anything(), { forceNewWindow: false },
    )
    // Same reasoning as the nudge.focusSession tests above: emit() above
    // legitimately triggers a `frontmost` report; only `resolve` is
    // forbidden here.
    expect(sent.some(m => m.t === 'resolve')).toBe(false)
  })
})

describe('deactivate', () => {
  it('disposes the client, the status bar item, the toaster, and every registered command — not merely runs without throwing', () => {
    const toasterDisposeSpy = vi.spyOn(Toaster.prototype, 'dispose')
    try {
      const { client } = makeClient()
      const { surface, commands } = makeSurface()
      const { context } = makeContext()

      activate(context, { client, surface })
      expect(statusBarItem.dispose).not.toHaveBeenCalled()
      expect(client.dispose).not.toHaveBeenCalled()
      expect(toasterDisposeSpy).not.toHaveBeenCalled()

      deactivate()

      expect(client.dispose).toHaveBeenCalledTimes(1)
      expect(statusBarItem.dispose).toHaveBeenCalledTimes(1)
      expect(toasterDisposeSpy).toHaveBeenCalledTimes(1)
      for (const cmd of commands.values()) expect(cmd.disposed).toBe(true)
    } finally {
      toasterDisposeSpy.mockRestore()
    }
  })

  // Closes the loop on the assertion above: dispose() being *called* is not
  // the same as it actually mattering. toast.ts:108 guards exactly this case
  // (`if (this.#disposed) return`) — a toast shown before deactivate() can
  // still have its action resolved well after, and the guard is what stops a
  // stale "Go to it" from reaching focusSession()/executeCommand at all.
  it('a toast\'s "Go to it" action is a no-op if it resolves after deactivate() has already disposed the toaster', async () => {
    const { client, emit } = makeClient()
    const { surface } = makeSurface({ folders: ['/a/my-repo'] })
    const { context } = makeContext()
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/a/my-repo' } }]

    let resolveChoice: ((choice: string | undefined) => void) | undefined
    vscodeMock.window.showWarningMessage.mockImplementationOnce(
      () => new Promise<string | undefined>(resolve => { resolveChoice = resolve }),
    )

    activate(context, { client, surface })
    emit([session({ sessionId: 's1', cwd: '/a/my-repo' })])
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(1)

    deactivate()
    // Isolate: only care what happens as a result of resolving below, not
    // anything the render/activation path already did.
    vscodeMock.commands.executeCommand.mockClear()

    resolveChoice?.('Go to it')
    await new Promise(r => setTimeout(r, 20))

    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled()
  })

  it('disposes the window-focus subscription', () => {
    const { client } = makeClient()
    const { surface, windowStateDisposed } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })
    deactivate()

    expect(windowStateDisposed.value).toBe(true)
  })

  it('cancels the connectivity poll timer (clearInterval), not just a no-op on future ticks', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { client } = makeClient()
    const { surface } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface, pollIntervalMs: 10 })
    const callsBefore = clearSpy.mock.calls.length

    deactivate()

    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore)
    clearSpy.mockRestore()
  })

  it('is safe to call twice and does not double-dispose', () => {
    const { client } = makeClient()
    const { surface } = makeSurface()
    const { context } = makeContext()

    activate(context, { client, surface })
    deactivate()
    expect(() => deactivate()).not.toThrow()
    expect(client.dispose).toHaveBeenCalledTimes(1)
  })
})
