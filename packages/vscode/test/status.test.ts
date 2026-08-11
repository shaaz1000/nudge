import { describe, it, expect, vi } from 'vitest'

// Same reason as toast.test.ts: `vscode` has no runtime package outside an
// editor host. This mock exists only so importing '../src/status.js' does
// not throw — every test below injects its own fake StatusBarSurface and
// never touches this mock's contents.
vi.mock('vscode', () => ({
  window: { createStatusBarItem: vi.fn() },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class ThemeColor { constructor(public id: string) {} },
}))

import type { SessionState } from '@nudge/shared/types'
import { StatusBar, type StatusBarSurface, type StatusBarItemLike, formatWaitDuration } from '../src/status.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

const WARNING_BG = { id: 'statusBarItem.warningBackground' }

function makeItem(): StatusBarItemLike {
  return {
    text: '',
    tooltip: undefined,
    backgroundColor: undefined,
    command: undefined,
    show: vi.fn(),
    dispose: vi.fn(),
  }
}

function makeSurface(item: StatusBarItemLike = makeItem()): StatusBarSurface {
  return {
    createStatusBarItem: () => item,
    warningBackgroundColor: WARNING_BG,
  }
}

describe('formatWaitDuration', () => {
  it('formats sub-minute waits in seconds', () => {
    expect(formatWaitDuration(45_000)).toBe('45s')
  })

  it('formats sub-hour waits in minutes', () => {
    expect(formatWaitDuration(3 * 60_000 + 20_000)).toBe('3m')
  })

  it('formats waits of an hour or more as hours and minutes', () => {
    expect(formatWaitDuration(90 * 60_000)).toBe('1h 30m')
  })

  it('never returns a negative duration for clock skew', () => {
    expect(formatWaitDuration(-500)).toBe('0s')
  })
})

describe('StatusBar', () => {
  it('shows the item immediately on construction', () => {
    const item = makeItem()
    new StatusBar(makeSurface(item))

    expect(item.show).toHaveBeenCalledTimes(1)
  })

  it('nothing waiting: dim/low-key icon, no background color, and the "nothing waiting" tooltip', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.render([], true)

    expect(item.text).toBe('$(bell) Nudge')
    expect(item.tooltip).toBe('Nothing waiting')
    expect(item.backgroundColor).toBeUndefined()
  })

  it('one or more waiting: warning background, bell-dot with the count, tooltip lists each session', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))
    const sessions = [
      session({ sessionId: 's1', project: 'repo-one', tier: 'blocked', waitingSince: Date.now() - 65_000 }),
      session({ sessionId: 's2', project: 'repo-two', tier: 'stalled', waitingSince: Date.now() - 3_000 }),
    ]

    bar.render(sessions, true)

    expect(item.text).toBe('$(bell-dot) Nudge 2')
    expect(item.backgroundColor).toBe(WARNING_BG)
    expect(item.tooltip).toContain('repo-one')
    expect(item.tooltip).toContain('blocked')
    expect(item.tooltip).toContain('repo-two')
    expect(item.tooltip).toContain('stalled')
  })

  it('one waiting session: count suffix is still present (N=1)', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.render([session()], true)

    expect(item.text).toBe('$(bell-dot) Nudge 1')
  })

  // sessionsForWindow (Task 2) filters only by folder membership — it
  // returns every session in this window, running or waiting. The Phase 2
  // plan's composition root (Task 6) passes that same array to both
  // StatusBar and Toaster, and Toaster already filters to tier !== null
  // before counting. StatusBar must do the same rather than trusting
  // `mine.length` as if it were already the waiting count.
  it('counts and lists only the sessions that are actually waiting, ignoring running ones in the same window', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))
    const mine = [
      session({ sessionId: 's1', project: 'running-repo', tier: null, status: 'running', waitingSince: null }),
      session({ sessionId: 's2', project: 'waiting-repo', tier: 'blocked', waitingSince: Date.now() - 5_000 }),
    ]

    bar.render(mine, true)

    expect(item.text).toBe('$(bell-dot) Nudge 1')
    expect(item.tooltip).toContain('waiting-repo')
    expect(item.tooltip).not.toContain('running-repo')
  })

  it('nothing waiting even when `mine` is non-empty, because every session in it is currently running', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))
    const mine = [
      session({ sessionId: 's1', project: 'running-repo', tier: null, status: 'running', waitingSince: null }),
    ]

    bar.render(mine, true)

    expect(item.text).toBe('$(bell) Nudge')
    expect(item.tooltip).toBe('Nothing waiting')
    expect(item.backgroundColor).toBeUndefined()
  })

  it('engine unreachable: bell-slash icon, no warning background, tooltip explains how to start it — not a warning color', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.render([], false)

    expect(item.text).toBe('$(bell-slash) Nudge')
    expect(item.backgroundColor).toBeUndefined()
    expect(item.tooltip).toMatch(/not running/i)
    expect(item.tooltip).toMatch(/nudge start/i)
  })

  // Self-review requirement: a disconnect can leave the extension holding a
  // stale, non-empty `mine` from the last broadcast before the engine died.
  // Reporting a confident count the extension can no longer verify would be
  // actively misleading, so `connected` must win regardless of `mine`.
  it('engine unreachable takes priority over a stale non-empty session list', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.render([session()], false)

    expect(item.text).toBe('$(bell-slash) Nudge')
    expect(item.backgroundColor).toBeUndefined()
    expect(item.tooltip).toMatch(/not running/i)
  })

  it('wires the click command to nudge.focusSession in every state', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.render([], false)
    expect(item.command).toBe('nudge.focusSession')

    bar.render([], true)
    expect(item.command).toBe('nudge.focusSession')

    bar.render([session()], true)
    expect(item.command).toBe('nudge.focusSession')
  })

  it('re-render after sessions clear returns to the dim, low-key state (no background color left over)', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.render([session()], true)
    expect(item.backgroundColor).toBe(WARNING_BG)

    bar.render([], true)
    expect(item.backgroundColor).toBeUndefined()
    expect(item.text).toBe('$(bell) Nudge')
  })

  it('dispose() disposes the underlying status bar item', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.dispose()

    expect(item.dispose).toHaveBeenCalledTimes(1)
  })

  it('dispose() is safe to call twice', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.dispose()
    expect(() => bar.dispose()).not.toThrow()
    expect(item.dispose).toHaveBeenCalledTimes(1)
  })

  it('render() after dispose() does not resurrect the item', () => {
    const item = makeItem()
    const bar = new StatusBar(makeSurface(item))

    bar.dispose()
    bar.render([session()], true)

    // No second show() beyond the one from construction, and dispose was
    // not called again — render() after dispose is simply a no-op.
    expect(item.show).toHaveBeenCalledTimes(1)
  })
})
