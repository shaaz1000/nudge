import { describe, it, expect, vi } from 'vitest'

// `electron` has no runtime module outside an Electron host — see
// tray.ts/notify.ts/main.ts's identical doc for why this is mocked rather
// than real. Nothing below exercises this mock's *contents* — every test
// injects an explicit fake AttentionSurface (DockSurface/FlashSurface) and
// never lets attention.ts's own `defaultSurface()` run — it only has to
// exist so importing '../src/attention.js' does not throw, and so a
// forgotten override in a FUTURE test fails loudly against a fake rather
// than bouncing the real Dock on this machine.
vi.mock('electron', () => ({
  app: {
    dock: {
      show: vi.fn(),
      hide: vi.fn(),
      bounce: vi.fn(() => 1),
      cancelBounce: vi.fn(),
    },
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    minimize: vi.fn(),
    isVisible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    flashFrame: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
  })),
}))

import type { SessionState } from '@nudge/shared/types'
import { DEFAULT_CONFIG, type NudgeConfig } from '@nudge/shared/config'
import {
  AttentionManager,
  DEFAULT_ATTENTION_CONFIG,
  DEFAULT_BOUNCE_TIERS,
  isSessionSuppressed,
  isTierEligible,
  needsAttention,
  type AttentionConfig,
  type AttentionSurface,
  type DockSurface,
  type FlashSurface,
} from '../src/attention.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

const cfg = (over: Partial<NudgeConfig> = {}): NudgeConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  ...over,
})

/** A fully controllable fake DockSurface — records every call, returns increasing ids. */
function makeDockSurface() {
  const show = vi.fn()
  const hide = vi.fn()
  let nextId = 1
  const bounceTypes: Array<'critical' | 'informational'> = []
  const bounce = vi.fn((type: 'critical' | 'informational') => {
    bounceTypes.push(type)
    return nextId++
  })
  const cancelBounce = vi.fn()
  const dock: DockSurface = { show, hide, bounce, cancelBounce }
  const surface: AttentionSurface = { platform: 'darwin', dock, flashWindow: null }
  return { surface, dock, show, hide, bounce, bounceTypes, cancelBounce }
}

/** A fully controllable fake FlashSurface (Windows/Linux taskbar path) — no dock at all. */
function makeFlashSurface() {
  const flash = vi.fn()
  const flashWindow: FlashSurface = { flash }
  const surface: AttentionSurface = { platform: 'win32', dock: null, flashWindow }
  return { surface, flash }
}

describe('DEFAULT_BOUNCE_TIERS: tiers that escalate under DEFAULT_CONFIG', () => {
  it('includes blocked and idle-long', () => {
    expect(DEFAULT_BOUNCE_TIERS.has('blocked')).toBe(true)
    expect(DEFAULT_BOUNCE_TIERS.has('idle-long')).toBe(true)
  })

  // Load-bearing for the tier-filter self-review question: if this ever
  // regresses to include idle-short, this assertion (and the AttentionManager
  // integration test below) goes red.
  it('excludes idle-short and stalled — a Turn-finished ping must not persistently bounce the Dock', () => {
    expect(DEFAULT_BOUNCE_TIERS.has('idle-short')).toBe(false)
    expect(DEFAULT_BOUNCE_TIERS.has('stalled')).toBe(false)
  })
})

describe('isTierEligible: pure', () => {
  it('true when bounceOnBlocked is on and the tier is in bounceTiers', () => {
    expect(isTierEligible(DEFAULT_ATTENTION_CONFIG, 'blocked')).toBe(true)
  })

  it('false for a tier not in bounceTiers, even with bounceOnBlocked on', () => {
    expect(isTierEligible(DEFAULT_ATTENTION_CONFIG, 'idle-short')).toBe(false)
  })

  it('false for every tier when bounceOnBlocked is off, even one that is in bounceTiers', () => {
    const off: AttentionConfig = { bounceOnBlocked: false, bounceTiers: new Set(['blocked']) }
    expect(isTierEligible(off, 'blocked')).toBe(false)
  })

  it('a custom bounceTiers set really filters — stalled can be enabled and blocked disabled', () => {
    const custom: AttentionConfig = { bounceOnBlocked: true, bounceTiers: new Set(['stalled']) }
    expect(isTierEligible(custom, 'stalled')).toBe(true)
    expect(isTierEligible(custom, 'blocked')).toBe(false)
  })
})

describe('isSessionSuppressed: pure — mirrors packages/engine/src/suppression.ts\'s rules client-side', () => {
  it('suppressed when globally muted', () => {
    expect(isSessionSuppressed(cfg({ muted: true }), session(), 100, null)).toBe(true)
  })

  it('not suppressed when not muted', () => {
    expect(isSessionSuppressed(cfg(), session(), 100, null)).toBe(false)
  })

  it('suppressed when this session\'s project is muted', () => {
    const c = cfg({ projects: { '/a/my-repo': { muted: true } } })
    expect(isSessionSuppressed(c, session({ cwd: '/a/my-repo' }), 100, null)).toBe(true)
  })

  it('a DIFFERENT project\'s mute does not suppress this session — scoped, not global', () => {
    const c = cfg({ projects: { '/a/other-repo': { muted: true } } })
    expect(isSessionSuppressed(c, session({ cwd: '/a/my-repo' }), 100, null)).toBe(false)
  })

  it('suppressed while snoozed (snoozedUntil in the future)', () => {
    expect(isSessionSuppressed(cfg(), session({ snoozedUntil: 500 }), 100, null)).toBe(true)
  })

  it('not suppressed once a snooze has expired', () => {
    expect(isSessionSuppressed(cfg(), session({ snoozedUntil: 50 }), 100, null)).toBe(false)
  })

  it('suppressed when this exact session is the reported frontmost session', () => {
    expect(isSessionSuppressed(cfg(), session({ sessionId: 's1' }), 100, 's1')).toBe(true)
  })

  it('not suppressed when a DIFFERENT session is frontmost', () => {
    expect(isSessionSuppressed(cfg(), session({ sessionId: 's1' }), 100, 's2')).toBe(false)
  })

  it('not suppressed when nothing is reported frontmost (null)', () => {
    expect(isSessionSuppressed(cfg(), session({ sessionId: 's1' }), 100, null)).toBe(false)
  })
})

describe('needsAttention: pure aggregate — at least one eligible, unsuppressed session', () => {
  it('false for an empty session list', () => {
    expect(needsAttention([], DEFAULT_ATTENTION_CONFIG, cfg(), 100, null)).toBe(false)
  })

  it('false when the only waiting session is muted', () => {
    const s = session({ tier: 'blocked' })
    expect(needsAttention([s], DEFAULT_ATTENTION_CONFIG, cfg({ muted: true }), 100, null)).toBe(false)
  })

  it('true when at least one session is eligible and unsuppressed, even if others are not', () => {
    const suppressed = session({ sessionId: 's1', tier: 'idle-short' }) // wrong tier
    const eligible = session({ sessionId: 's2', tier: 'blocked' })
    expect(needsAttention([suppressed, eligible], DEFAULT_ATTENTION_CONFIG, cfg(), 100, null)).toBe(true)
  })
})

describe('AttentionManager: macOS Dock bounce on entering a waiting state (Step 1)', () => {
  it('shows the Dock, then bounces critical — not informational', () => {
    const { surface, show, bounce, bounceTypes } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(show).toHaveBeenCalledTimes(1)
    expect(bounce).toHaveBeenCalledTimes(1)
    expect(bounceTypes).toEqual(['critical'])
  })

  it('does not re-bounce on a second broadcast of the same still-waiting session', () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.update([session({ tier: 'blocked' })])
    attn.update([session({ tier: 'blocked' })])

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('bounces again for a fresh wait after a previous one resolved', () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.update([])
    attn.update([session({ tier: 'blocked' })])

    expect(bounce).toHaveBeenCalledTimes(2)
  })
})

describe('AttentionManager: cancel on resolve — load-bearing (Step 2)', () => {
  // See the task report for the deliberate-break command + RED output that
  // proves this test actually exercises cancelBounce: commenting out the
  // `cancelBounce` call in attention.ts's #stop() must make this go red.
  it('cancels the EXACT bounce id returned by bounce(), and hides the Dock, the instant the wait clears', () => {
    const { surface, bounce, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    const returnedId = bounce.mock.results[0]?.value as number

    attn.update([])

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(cancelBounce).toHaveBeenCalledWith(returnedId)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('also cancels and hides when the session transitions to tier: null (resolved), not only when it drops out of the list', () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.update([session({ tier: null, status: 'running', waitingSince: null })])

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('does NOT cancel or hide while a different session is still waiting', () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ sessionId: 's1', tier: 'blocked' }), session({ sessionId: 's2', tier: 'blocked' })])
    attn.update([session({ sessionId: 's2', tier: 'blocked' })]) // s1 resolved, s2 still waiting

    expect(cancelBounce).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it('cancels and hides only once no session needs attention any more, after the last one clears', () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ sessionId: 's1', tier: 'blocked' }), session({ sessionId: 's2', tier: 'blocked' })])
    attn.update([session({ sessionId: 's2', tier: 'blocked' })]) // s1 resolved, s2 still waiting
    attn.update([]) // s2 resolved too

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})

describe('AttentionManager: suppression — same rules as every other local alert (Step 5)', () => {
  it('a globally muted session never bounces the Dock at all', () => {
    const { surface, show, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: () => cfg({ muted: true }), now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(show).not.toHaveBeenCalled()
    expect(bounce).not.toHaveBeenCalled()
  })

  it('a per-project-muted session does not bounce, but an unrelated project\'s session still does', () => {
    const { surface, bounce } = makeDockSurface()
    const c = cfg({ projects: { '/a/muted-repo': { muted: true } } })
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: () => c, now: () => 100 })

    attn.update([
      session({ sessionId: 's1', cwd: '/a/muted-repo', tier: 'blocked' }),
      session({ sessionId: 's2', cwd: '/a/other-repo', tier: 'blocked' }),
    ])

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('the frontmost session is suppressed — the user is already looking at it', () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ sessionId: 's1', tier: 'blocked' })], 's1')

    expect(bounce).not.toHaveBeenCalled()
  })

  it('bounces once the same session stops being reported as frontmost while still waiting', () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ sessionId: 's1', tier: 'blocked' })], 's1')
    attn.update([session({ sessionId: 's1', tier: 'blocked' })], null)

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('a snoozed session does not bounce until the snooze expires', () => {
    const { surface, bounce } = makeDockSurface()
    let now = 100
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => now })

    attn.update([session({ tier: 'blocked', snoozedUntil: 1_000 })])
    expect(bounce).not.toHaveBeenCalled()

    now = 1_001
    attn.update([session({ tier: 'blocked', snoozedUntil: 1_000 })])
    expect(bounce).toHaveBeenCalledTimes(1)
  })
})

describe('AttentionManager: tier filter — configurable (Step 6)', () => {
  it('does not bounce for idle-short under the default config — a Turn-finished ping is not "blocked"', () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'idle-short', status: 'idle' })])

    expect(bounce).not.toHaveBeenCalled()
  })

  it('bounces for blocked under the default config', () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('bounceOnBlocked: false is a master switch — even a blocked session never bounces', () => {
    const { surface, bounce } = makeDockSurface()
    const off: AttentionConfig = { bounceOnBlocked: false, bounceTiers: DEFAULT_BOUNCE_TIERS }
    const attn = new AttentionManager(surface, off, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(bounce).not.toHaveBeenCalled()
  })

  it('a custom tier filter can enable stalled and disable blocked', () => {
    const { surface, bounce } = makeDockSurface()
    const custom: AttentionConfig = { bounceOnBlocked: true, bounceTiers: new Set(['stalled']) }
    const attn = new AttentionManager(surface, custom, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ sessionId: 's1', tier: 'blocked' })])
    expect(bounce).not.toHaveBeenCalled()

    attn.update([session({ sessionId: 's2', tier: 'stalled' })])
    expect(bounce).toHaveBeenCalledTimes(1)
  })
})

describe('AttentionManager: Windows/Linux taskbar flash (Steps 3-4)', () => {
  it('flashes the taskbar-present window on entering a waiting state', () => {
    const { surface, flash } = makeFlashSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(flash).toHaveBeenCalledWith(true)
  })

  it('stops flashing the instant the wait clears', () => {
    const { surface, flash } = makeFlashSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.update([])

    expect(flash).toHaveBeenLastCalledWith(false)
  })

  it('a muted session does not flash the taskbar either — suppression is platform-independent', () => {
    const { surface, flash } = makeFlashSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: () => cfg({ muted: true }), now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(flash).not.toHaveBeenCalled()
  })
})

describe('AttentionManager: dispose', () => {
  it('dispose() while bouncing cancels the bounce and hides the Dock — a quit mid-wait must not leave it hanging', () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.dispose()

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('dispose() while idle does not touch the Dock at all', () => {
    const { surface, cancelBounce, hide, show, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.dispose()

    expect(cancelBounce).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    expect(bounce).not.toHaveBeenCalled()
  })

  it('update() after dispose() is a no-op — no action fires after teardown', () => {
    const { surface, show, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.dispose()
    attn.update([session({ tier: 'blocked' })])

    expect(show).not.toHaveBeenCalled()
    expect(bounce).not.toHaveBeenCalled()
  })

  it('is safe to dispose twice and does not double-cancel/hide', () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.dispose()
    attn.dispose()

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
