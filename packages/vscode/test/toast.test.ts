import { describe, it, expect, vi } from 'vitest'

// `vscode` has no runtime package outside an editor host (only @types/vscode
// for compile-time typing) — see src/toast.ts's module doc for why it is
// imported at all. `vi.mock` intercepts the specifier before Node's resolver
// ever looks for a real module on disk, so this works even though nothing
// named `vscode` exists in node_modules. None of the tests below exercise
// this mock's *contents* — every test injects an explicit fake `ToastSurface`
// — it only has to exist so importing '../src/toast.js' does not throw.
vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn() },
  workspace: { getConfiguration: vi.fn() },
  commands: { executeCommand: vi.fn() },
}))

import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import { Toaster, type ToastSurface } from '../src/toast.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/**
 * A fake ToastSurface that records every `showWarningMessage` call and lets
 * the test resolve each one individually (in call order) with whichever
 * button label — or `undefined` for "dismissed" — it wants to simulate.
 */
function makeSurface(opts: { showToasts?: boolean } = {}) {
  const resolvers: Array<(choice: string | undefined) => void> = []
  const messages: string[] = []
  const executeCommand = vi.fn()
  const getConfiguration = vi.fn().mockReturnValue({
    get: (_key: string, def: boolean) => opts.showToasts ?? def,
  })
  const surface: ToastSurface = {
    showWarningMessage: (message: string) => {
      messages.push(message)
      return new Promise<string | undefined>(resolve => { resolvers.push(resolve) })
    },
    getConfiguration,
    executeCommand,
  }
  return { surface, resolvers, messages, executeCommand, getConfiguration }
}

describe('Toaster', () => {
  it('shows a toast when a session enters a waiting state', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('my-repo')
  })

  it('does not toast a session that is not waiting (tier: null)', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session({ tier: null, status: 'running', waitingSince: null })])

    expect(messages).toHaveLength(0)
  })

  // The load-bearing property: the engine broadcasts full state on every
  // change, not just transitions, so a still-waiting session appears in
  // `mine` on every one of those broadcasts. Without de-dup tracking this
  // fires showWarningMessage ten times.
  it('de-duplicates: ten identical broadcasts of the same waiting session produce exactly one toast', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    for (let i = 0; i < 10; i++) toaster.update([session()])

    expect(messages).toHaveLength(1)
  })

  it('toasts again after a session resolves (tier: null) and later re-enters a waiting state', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()])
    toaster.update([session({ tier: null, status: 'running', waitingSince: null })])
    toaster.update([session()])

    expect(messages).toHaveLength(2)
  })

  it('clears de-dup tracking when a session disappears from `mine` entirely, not only on tier: null', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()])
    toaster.update([])
    toaster.update([session()])

    expect(messages).toHaveLength(2)
  })

  it('toasts distinct waiting sessions independently rather than sharing one dedup slot', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session({ sessionId: 's1' }), session({ sessionId: 's2', project: 'other-repo' })])

    expect(messages).toHaveLength(2)
  })

  it('"Go to it" runs the focus command with the waiting session', async () => {
    const { surface, resolvers, executeCommand } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)
    toaster.update([session()])

    resolvers[0]('Go to it')
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    expect(executeCommand).toHaveBeenCalledWith('nudge.focusSession', expect.objectContaining({ sessionId: 's1' }))
  })

  it('"Snooze 10m" sends {t:"snooze", sessionId, ms: 600000} to the engine', async () => {
    const { surface, resolvers } = makeSurface()
    const sent: ClientMessage[] = []
    const toaster = new Toaster(msg => sent.push(msg), surface)
    toaster.update([session()])

    resolvers[0]('Snooze 10m')
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0]).toMatchObject({ t: 'snooze', sessionId: 's1', ms: 600_000 })
  })

  it('dismissing the toast (resolves undefined) runs neither action', async () => {
    const { surface, resolvers, executeCommand } = makeSurface()
    const sent: ClientMessage[] = []
    const toaster = new Toaster(msg => sent.push(msg), surface)
    toaster.update([session()])

    resolvers[0](undefined)
    await new Promise(r => setTimeout(r, 20))

    expect(executeCommand).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('respects nudge.showToasts=false by staying status-bar-only', () => {
    const { surface, messages, getConfiguration } = makeSurface({ showToasts: false })
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()])

    expect(messages).toHaveLength(0)
    expect(getConfiguration).toHaveBeenCalledWith('nudge')
  })

  it('dispose() stops update() from toasting further', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.dispose()
    toaster.update([session()])

    expect(messages).toHaveLength(0)
  })

  it('dispose() prevents a toast action from firing after teardown', async () => {
    const { surface, resolvers, executeCommand } = makeSurface()
    const sent: ClientMessage[] = []
    const toaster = new Toaster(msg => sent.push(msg), surface)
    toaster.update([session()])

    toaster.dispose()
    resolvers[0]('Go to it')
    await new Promise(r => setTimeout(r, 20))

    expect(executeCommand).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })
})
