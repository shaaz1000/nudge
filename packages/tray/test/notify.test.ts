import { describe, it, expect, vi } from 'vitest'

// `electron` has no runtime module outside an Electron host — see
// tray.ts/main.ts's identical doc for why this is mocked rather than real.
// Nothing below exercises this mock's *contents* — every test injects an
// explicit fake NotifySurface — it only has to exist so importing
// '../src/notify.js' does not throw.
vi.mock('electron', () => ({ Notification: vi.fn() }))

import type { SessionState } from '@nudge/shared/types'
import { DEFAULT_CONFIG, type NudgeConfig } from '@nudge/shared/config'
import { Notifier, notificationContent, type NotifySurface, type NotificationLike } from '../src/notify.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/** Records every notification "shown", and lets a test fire its click handler directly. */
function makeSurface() {
  const created: Array<{
    opts: { title: string; body: string; silent: boolean }
    handlers: Record<string, () => void>
    show: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }> = []
  const surface: NotifySurface = {
    create: opts => {
      const handlers: Record<string, () => void> = {}
      const show = vi.fn()
      const close = vi.fn()
      const n: NotificationLike = {
        show,
        on: (event, cb) => { handlers[event] = cb },
        close,
      }
      created.push({ opts, handlers, show, close })
      return n
    },
  }
  return { surface, created }
}

describe('notificationContent: pure — no Electron involved', () => {
  it('uses the session message when present — full detail, the exact question/command', () => {
    expect(notificationContent(session({ message: 'Run `git push --force`?' })).body)
      .toBe('Run `git push --force`?')
  })

  it('falls back to tier text for a falsy empty-string message (matches desktop.ts\'s || not ??)', () => {
    expect(notificationContent(session({ message: '', tier: 'blocked' })).body)
      .toBe('Waiting on you: permission or question')
  })

  it('titles with the project name', () => {
    expect(notificationContent(session({ project: 'repo-x' })).title).toBe('repo-x needs you')
  })
})

describe('Notifier: shows on entering a waiting state', () => {
  it('shows a notification when a session enters a waiting state', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])

    expect(created).toHaveLength(1)
    expect(created[0].show).toHaveBeenCalledTimes(1)
    expect(created[0].opts.title).toBe('my-repo needs you')
  })

  it('does not notify a session that is not waiting (tier: null)', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session({ tier: null, status: 'running', waitingSince: null })])

    expect(created).toHaveLength(0)
  })

  it('carries full detail in the body — the actual question/command, not a generic summary', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session({ message: 'rm -rf build/ — proceed?' })])

    expect(created[0].opts.body).toBe('rm -rf build/ — proceed?')
  })

  // Documented decision (see notify.ts's module doc): the tray's notification
  // is deliberately silent so it never doubles Phase 1 engine's own
  // afplay/paplay/PowerShell sound for the same event — only the VISUAL
  // click-capable banner is genuinely new, so only the sound is worth
  // suppressing on the tray's side.
  it('always creates the notification silent, to avoid doubling the engine\'s own sound', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])

    expect(created[0].opts.silent).toBe(true)
  })
})

// The load-bearing property: the engine broadcasts full state on every
// change, not just transitions, so a still-waiting session appears in every
// broadcast for the whole time it waits. Without de-dup tracking this fires
// ten notifications instead of one.
describe('Notifier: de-duplication', () => {
  it('de-duplicates: ten identical broadcasts of the same waiting session produce exactly one notification', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    for (let i = 0; i < 10; i++) notifier.update([session()])

    expect(created).toHaveLength(1)
  })

  it('notifies again after a session resolves (tier: null) and later re-enters a waiting state', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])
    notifier.update([session({ tier: null, status: 'running', waitingSince: null })])
    notifier.update([session()])

    expect(created).toHaveLength(2)
  })

  it('closes the shown OS notification the instant its session resolves, clearing on resolve', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])
    notifier.update([session({ tier: null, status: 'running', waitingSince: null })])

    expect(created[0].close).toHaveBeenCalledTimes(1)
  })

  it('clears de-dup tracking when a session disappears from the list entirely, not only on tier: null', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])
    notifier.update([])
    notifier.update([session()])

    expect(created).toHaveLength(2)
  })

  // Minor fix #2 from Phase 2 applies identically here: a snooze doesn't
  // clear `tier` server-side (it's a separate suppression overlay), so a
  // just-snoozed session is still `tier !== null` on the very next update().
  it('does not notify again the moment a still-waiting session becomes snoozed', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])
    notifier.update([session({ snoozedUntil: Date.now() + 600_000 })])

    expect(created).toHaveLength(1)
  })

  it('notifies again once a snooze naturally expires, for a session that never stopped waiting', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session()])
    notifier.update([session({ snoozedUntil: Date.now() + 600_000 })])
    notifier.update([session({ snoozedUntil: Date.now() - 1_000 })])

    expect(created).toHaveLength(2)
  })

  it('notifies distinct waiting sessions independently rather than sharing one dedup slot', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session({ sessionId: 's1' }), session({ sessionId: 's2', project: 'other-repo' })])

    expect(created).toHaveLength(2)
  })
})

describe('Notifier: click fires focus — the reason this phase exists', () => {
  it('clicking the notification calls onFocus with the exact waiting session', () => {
    const onFocus = vi.fn()
    const { surface, created } = makeSurface()
    const notifier = new Notifier(onFocus, surface)
    const s = session({ sessionId: 's7', project: 'repo-click' })

    notifier.update([s])
    created[0].handlers.click()

    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onFocus).toHaveBeenCalledWith(s)
  })

  it('does not call onFocus merely because a notification was constructed — only an actual click does', () => {
    const onFocus = vi.fn()
    const { surface } = makeSurface()
    const notifier = new Notifier(onFocus, surface)

    notifier.update([session()])

    expect(onFocus).not.toHaveBeenCalled()
  })

  it('a click after dispose() does not call onFocus — no action fires after teardown', () => {
    const onFocus = vi.fn()
    const { surface, created } = makeSurface()
    const notifier = new Notifier(onFocus, surface)

    notifier.update([session()])
    notifier.dispose()
    created[0].handlers.click()

    expect(onFocus).not.toHaveBeenCalled()
  })
})

describe('Notifier: dispose', () => {
  it('dispose() stops update() from notifying further', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.dispose()
    notifier.update([session()])

    expect(created).toHaveLength(0)
  })

  it('dispose() closes every currently-shown notification', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface)

    notifier.update([session({ sessionId: 's1' }), session({ sessionId: 's2', project: 'other-repo' })])
    notifier.dispose()

    expect(created[0].close).toHaveBeenCalledTimes(1)
    expect(created[1].close).toHaveBeenCalledTimes(1)
  })
})

describe('Notifier: suppression — the tray is the ONLY banner source while it runs', () => {
  /**
   * Whole-branch review, Critical. The tray declares `gui: true`, so the
   * engine stands its own banner down and defers to this module. This module
   * used to check only tier + snooze — so `nudge mute` silenced the engine
   * and the tray notified anyway. The user muted Nudge and Nudge kept
   * notifying them, with no escape short of quitting the tray.
   *
   * These drive the real suppression path with an injected config; none of
   * them touches the real ~/.nudge/config.json.
   */
  const cfg = (over: Partial<NudgeConfig> = {}): NudgeConfig => ({
    ...structuredClone(DEFAULT_CONFIG),
    ...over,
  })

  it('a globally muted session raises NO banner', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface, { loadConfig: () => cfg({ muted: true }), now: () => 100 })

    notifier.update([session({ tier: 'blocked' })])

    expect(created).toHaveLength(0)
  })

  it('still notifies when not muted — the suppression must not be unconditional', () => {
    const { surface, created } = makeSurface()
    const notifier = new Notifier(vi.fn(), surface, { loadConfig: () => cfg(), now: () => 100 })

    notifier.update([session({ tier: 'blocked' })])

    expect(created).toHaveLength(1)
  })

  it('a per-project mute scopes to that project only', () => {
    const { surface, created } = makeSurface()
    const c = cfg({ projects: { '/a/muted-repo': { muted: true } } })
    const notifier = new Notifier(vi.fn(), surface, { loadConfig: () => c, now: () => 100 })

    notifier.update([
      session({ sessionId: 's1', cwd: '/a/muted-repo', tier: 'blocked' }),
      session({ sessionId: 's2', cwd: '/a/other-repo', tier: 'blocked' }),
    ])

    expect(created).toHaveLength(1)
  })

  it('a tier the user switched off never notifies', () => {
    const { surface, created } = makeSurface()
    const c = cfg()
    c.tiers['idle-short'].enabled = false
    const notifier = new Notifier(vi.fn(), surface, { loadConfig: () => c, now: () => 100 })

    notifier.update([session({ tier: 'idle-short', status: 'idle' })])

    expect(created).toHaveLength(0)
  })

  it('muting mid-wait CLOSES the banner already on screen, rather than leaving it stranded', () => {
    const { surface, created } = makeSurface()
    let muted = false
    const notifier = new Notifier(vi.fn(), surface, {
      loadConfig: () => cfg({ muted }), now: () => 100,
    })

    notifier.update([session({ tier: 'blocked' })])
    expect(created).toHaveLength(1)

    muted = true
    notifier.update([session({ tier: 'blocked' })])

    expect(created[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('a broken config falls back to last-known-good rather than stranding banners', () => {
    const { surface, created } = makeSurface()
    let broken = false
    const notifier = new Notifier(vi.fn(), surface, {
      loadConfig: () => { if (broken) throw new Error('EACCES'); return cfg() },
      now: () => 100,
    })

    notifier.update([session({ tier: 'blocked' })])
    broken = true
    notifier.update([]) // resolved, but the config can no longer be read

    expect(created[0]?.close).toHaveBeenCalledTimes(1)
  })
})
