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

  // Minor fix #3: toast.ts used `??` here where desktop.ts's copy of the
  // exact same fallback logic uses `||` — latent drift on an already-
  // duplicated block. The only case where they disagree is an empty-string
  // message (`??` keeps `''`, `||` falls back to TIER_TEXT): a session
  // whose `message` is `''` (falsy, not null/undefined) must show the tier
  // text, not a message that renders as nothing after the colon.
  it('falls back to tier text for a falsy empty-string message, matching desktop.ts\'s || (not ??)', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session({ message: '' })])

    expect(messages[0]).toContain('Waiting on you: permission or question')
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

  // Minor fix #2: a snooze doesn't clear `tier` server-side (it's a separate
  // suppression overlay — see packages/engine/src/suppression.ts), so a
  // just-snoozed session is still `tier !== null` on the very next update().
  // Two things must both hold: no spurious extra toast the instant it's
  // snoozed (it must NOT look "newly waiting" just because de-dup tracking
  // forgot it), and it toasts again once the snooze naturally expires if
  // it's still genuinely waiting then.
  it('does not toast again the moment a still-waiting session becomes snoozed', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()]) // toasts once
    toaster.update([session({ snoozedUntil: Date.now() + 600_000 })]) // now snoozed

    expect(messages).toHaveLength(1)
  })

  it('toasts again once a snooze naturally expires, for a session that never stopped waiting', () => {
    const { surface, messages } = makeSurface()
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()]) // toasts once
    toaster.update([session({ snoozedUntil: Date.now() + 600_000 })]) // snoozed: no new toast
    toaster.update([session({ snoozedUntil: Date.now() - 1_000 })]) // snooze expired, still waiting

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

  // I4 mutation coverage: `#toasted.add()` runs regardless of the
  // `showToasts` gate (see toast.ts's own doc on `update()`). A mutation
  // that moved the `.add()` inside the `if (showToasts)` branch left every
  // other test in this file green, because none of them flip the setting
  // mid-wait for a session that was already silently tracked. This does
  // exactly that: showToasts starts false (session waits silently, never
  // toasted, but must still be TRACKED as toasted), then flips true while
  // the SAME session is still waiting — it must not retroactively toast.
  it('tracks a session as toasted even while showToasts is false, so flipping the setting on mid-wait does not backlog a toast', () => {
    let showToasts = false
    const messages: string[] = []
    const surface: ToastSurface = {
      showWarningMessage: (message: string) => { messages.push(message); return Promise.resolve(undefined) },
      getConfiguration: () => ({ get: <T,>(_key: string, def: T): T => (showToasts ?? def) as T }),
      executeCommand: vi.fn(),
    }
    const toaster = new Toaster(vi.fn(), surface)

    toaster.update([session()]) // showToasts false: silent, but must be tracked
    expect(messages).toHaveLength(0)

    showToasts = true
    toaster.update([session()]) // same still-waiting session, setting now on

    expect(messages).toHaveLength(0)
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
