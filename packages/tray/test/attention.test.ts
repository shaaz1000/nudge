import { describe, it, expect, vi } from 'vitest'

// `electron` has no runtime module outside an Electron host — see
// tray.ts/notify.ts/main.ts's identical doc for why this is mocked rather
// than real. Nothing below exercises this mock's *contents* — every test
// injects an explicit fake AttentionSurface (DockSurface/FlashSurface) and
// never lets attention.ts's own `defaultSurface()` run — it only has to
// exist so importing '../src/attention.js' does not throw, and so a
// forgotten override in a FUTURE test fails loudly against a fake rather
// than bouncing the real Dock on this machine.
// Kept deliberately faithful to the real API rather than convenient: `show()`
// is async on the real `app.dock` (defaultSurface awaits its rejection), and
// the window methods are the ones the code actually calls — `showInactive`,
// not `show`. An earlier version of this mock offered `show`/`isVisible` and
// no `showInactive`, a divergence that went unnoticed only because nothing
// reached the code under it. A mock that drifts from the real surface is how
// a passing suite hides a broken app.
vi.mock('electron', () => ({
  app: {
    dock: {
      show: vi.fn(async () => {}),
      hide: vi.fn(),
      bounce: vi.fn(() => 1),
      cancelBounce: vi.fn(),
    },
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    showInactive: vi.fn(),
    minimize: vi.fn(),
    isDestroyed: vi.fn(() => false),
    flashFrame: vi.fn(),
    destroy: vi.fn(),
  })),
}))

import type { SessionState } from '@nudge/shared/types'
import { DEFAULT_CONFIG, loadConfig as loadNudgeConfig, type NudgeConfig } from '@nudge/shared/config'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AttentionManager,
  DEFAULT_ATTENTION_CONFIG,
  DEFAULT_BOUNCE_TIERS,
  isSessionSuppressed,
  defaultSurface,
  isTierEligible,
  lazyFlashWindow,
  loadAttentionConfig,
  needsAttention,
  type AttentionConfig,
  type AttentionSurface,
  type DockSurface,
  type FlashSurface,
  type FlashWindowLike,
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

/**
 * Let a pending `dock.show()` settle so the bounce queued behind it runs.
 *
 * Required because the real `app.dock.show()` is async and production always
 * takes `#start()`'s async branch. Tests that assert on `bounce`/`cancelBounce`
 * without this were previously green only because the fake `show()` was
 * synchronous — i.e. they were exercising a branch macOS never runs.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** update() + let the async show/bounce settle, the way a real broadcast does. */
async function drive(
  attn: AttentionManager,
  sessions: SessionState[],
  frontmost: string | null = null,
): Promise<void> {
  attn.update(sessions, frontmost)
  await flush()
}

/**
 * A fully controllable fake DockSurface — records every call, returns
 * increasing ids.
 *
 * `show` is **async**, because the real `app.dock.show()` is: it returns a
 * Promise that resolves once the icon is actually in the Dock, so production
 * ALWAYS takes `#start()`'s async branch. An earlier version of this fake
 * returned `undefined`, which sent every test down the synchronous branch —
 * a branch no real macOS run ever executes — and two tests consequently
 * asserted guarantees that were false in production. That is the same
 * fake-diverges-from-the-real-API defect that produced the bounce-id-0 bug;
 * keep this faithful to the real contract.
 */
function makeDockSurface() {
  const show = vi.fn(async () => {})
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

describe('loadAttentionConfig: the user-facing off switch (Step 6)', () => {
  // Review finding 5: bounceOnBlocked existed as a type but nothing could set
  // it, so the user could not turn off the bounce without a rebuild. These
  // write to a temp file — never the real ~/.nudge/config.json.
  const write = (obj: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-tray-cfg-'))
    const p = join(dir, 'config.json')
    writeFileSync(p, JSON.stringify(obj), 'utf8')
    return p
  }

  it('defaults when the config file does not exist', () => {
    expect(loadAttentionConfig(join(tmpdir(), 'nudge-does-not-exist', 'config.json')))
      .toEqual(DEFAULT_ATTENTION_CONFIG)
  })

  it('defaults when the file exists but has no tray key — the engine\'s own config is untouched', () => {
    expect(loadAttentionConfig(write({ muted: true, retentionDays: 7 }))).toEqual(DEFAULT_ATTENTION_CONFIG)
  })

  it('turns the bounce off — the switch the user actually asked for', () => {
    const c = loadAttentionConfig(write({ tray: { bounceOnBlocked: false } }))
    expect(c.bounceOnBlocked).toBe(false)
    expect(isTierEligible(c, 'blocked')).toBe(false)
  })

  it('narrows bounceTiers to just the named tiers', () => {
    const c = loadAttentionConfig(write({ tray: { bounceTiers: ['blocked'] } }))
    expect(isTierEligible(c, 'blocked')).toBe(true)
    expect(isTierEligible(c, 'idle-long')).toBe(false)
  })

  it('an empty bounceTiers array really does disable every tier', () => {
    const c = loadAttentionConfig(write({ tray: { bounceTiers: [] } }))
    for (const t of ['blocked', 'idle-long', 'idle-short', 'stalled'] as const) {
      expect(isTierEligible(c, t)).toBe(false)
    }
  })

  // Fails loud, matching the shared config's rule. A silently ignored typo in
  // an off switch is worse than no switch: the user believes they disabled
  // something that is still bouncing at them.
  it('throws on an unknown tray key rather than ignoring it', () => {
    expect(() => loadAttentionConfig(write({ tray: { bounceOnBlockd: false } })))
      .toThrow(/unknown key "tray.bounceOnBlockd"/)
  })

  it('throws on a misspelled tier name', () => {
    expect(() => loadAttentionConfig(write({ tray: { bounceTiers: ['blocked', 'idle_long'] } })))
      .toThrow(/unknown tier/)
  })

  it('throws when bounceOnBlocked is not a boolean', () => {
    expect(() => loadAttentionConfig(write({ tray: { bounceOnBlocked: 'no' } })))
      .toThrow(/must be a boolean/)
  })

  it('throws when tray is not an object', () => {
    expect(() => loadAttentionConfig(write({ tray: 'off' }))).toThrow(/must be an object/)
  })

  it('throws when tray is an array — arrays are objects to typeof, the classic hole', () => {
    expect(() => loadAttentionConfig(write({ tray: ['blocked'] }))).toThrow(/must be an object/)
  })

  it('throws on a non-object JSON root, matching mergeConfig rather than silently defaulting', () => {
    expect(() => loadAttentionConfig(write(5))).toThrow(/top level/)
  })

  it('reports a read error as itself, not as a JSON parse failure', () => {
    // A directory yields EISDIR. The shared config deliberately rethrows fs
    // errors unwrapped for exactly this reason: an unreadable file is not a
    // malformed one, and saying "could not parse" sends the user hunting for
    // a syntax error that isn't there.
    const dir = mkdtempSync(join(tmpdir(), 'nudge-tray-cfg-'))
    expect(() => loadAttentionConfig(dir)).toThrow(/EISDIR|illegal operation on a directory/)
  })

  /**
   * The cross-package contract this whole feature rests on: the tray writes
   * its key into the SAME config.json the engine reads. If `mergeConfig` were
   * ever hardened with a strict unknown-top-level-key sweep, every user who
   * set `tray.bounceOnBlocked` would find the ENGINE refusing to boot — a
   * failure that would look nothing like the tray change that caused it.
   */
  it('a config carrying a tray key is still accepted by the engine\'s own loader', () => {
    const p = write({ muted: false, tray: { bounceOnBlocked: false } })
    expect(() => loadNudgeConfig(p)).not.toThrow()
    expect(loadNudgeConfig(p).muted).toBe(false)
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

describe('isSessionSuppressed: tier-disabled — the engine applies `enabled` at alert time, not when assigning tier', () => {
  // Review finding 1. The engine's localSuppression checks
  // `cfg.tiers[tier].enabled` FIRST; the tray originally dropped that clause,
  // so a user who turned `blocked` off got silence from the engine and a
  // bouncing Dock from the tray. The broadcast still carries tier:'blocked'
  // for a disabled tier (engine/src/state.ts assigns tier unconditionally),
  // so nothing else would have caught this.
  it('a session whose tier the user has disabled is suppressed', () => {
    const c = cfg()
    c.tiers.blocked.enabled = false
    expect(isSessionSuppressed(c, session({ tier: 'blocked' }), 100, null)).toBe(true)
  })

  it('disabling a DIFFERENT tier does not suppress this one', () => {
    const c = cfg()
    c.tiers['idle-long'].enabled = false
    expect(isSessionSuppressed(c, session({ tier: 'blocked' }), 100, null)).toBe(false)
  })

  // Found by the live Electron probe, which crashed here: a config whose
  // `tiers` map is missing an entry must not read as "disabled" (which a bare
  // `!cfg.tiers[t].enabled` would give), and must not throw either — the
  // throw escaped update() and would have taken the tray icon and the
  // notifications down with it.
  it('a config missing the tier entry neither suppresses nor throws', () => {
    const c = { ...cfg(), tiers: {} } as unknown as NudgeConfig
    expect(() => isSessionSuppressed(c, session({ tier: 'blocked' }), 100, null)).not.toThrow()
    expect(isSessionSuppressed(c, session({ tier: 'blocked' }), 100, null)).toBe(false)
  })

  /**
   * Whole-branch review, Important 4. The evaluation catch used to `return`,
   * which is the exact freeze the loadConfig catch above exists to prevent:
   * throw while already bouncing → `#attracting` stays true → no `#stop()` is
   * ever reached → the icon bounces until the user quits Nudge. A failed
   * evaluation must fail toward SILENCE (a missed nudge) rather than toward
   * an unstoppable one.
   */
  it('stops a bounce in progress when evaluation starts throwing, instead of freezing mid-bounce', async () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    let broken = false
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, {
      loadConfig: () => (broken
        ? ({ ...cfg(), tiers: null } as unknown as NudgeConfig) // makes needsAttention throw
        : cfg()),
      now: () => 100,
    })

    await drive(attn, [session({ tier: 'blocked' })])
    broken = true
    await drive(attn, [session({ tier: 'blocked' })])

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('a throw while evaluating attention never escapes update() into the broadcast handler', () => {
    const { surface } = makeDockSurface()
    const exploding = { get muted(): boolean { throw new Error('config exploded') } } as unknown as NudgeConfig
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, {
      loadConfig: () => exploding, now: () => 100,
    })

    expect(() => attn.update([session({ tier: 'blocked' })])).not.toThrow()
  })

  it('a disabled tier never bounces the Dock end-to-end', () => {
    const { surface, bounce } = makeDockSurface()
    const c = cfg()
    c.tiers.blocked.enabled = false
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: () => c, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(bounce).not.toHaveBeenCalled()
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
  it('shows the Dock, then bounces critical — not informational', async () => {
    const { surface, show, bounce, bounceTypes } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])

    expect(show).toHaveBeenCalledTimes(1)
    expect(bounce).toHaveBeenCalledTimes(1)
    expect(bounceTypes).toEqual(['critical'])
  })

  it('does not re-bounce on a second broadcast of the same still-waiting session', async () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    await drive(attn, [session({ tier: 'blocked' })])
    await drive(attn, [session({ tier: 'blocked' })])

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('bounces again for a fresh wait after a previous one resolved', async () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    await drive(attn, [])
    await drive(attn, [session({ tier: 'blocked' })])

    expect(bounce).toHaveBeenCalledTimes(2)
  })
})

describe('AttentionManager: cancel on resolve — load-bearing (Step 2)', () => {
  // See the task report for the deliberate-break command + RED output that
  // proves this test actually exercises cancelBounce: commenting out the
  // `cancelBounce` call in attention.ts's #stop() must make this go red.
  it('cancels the EXACT bounce id returned by bounce(), and hides the Dock, the instant the wait clears', async () => {
    const { surface, bounce, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    const returnedId = bounce.mock.results[0]?.value as number

    await drive(attn, [])

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(cancelBounce).toHaveBeenCalledWith(returnedId)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('also cancels and hides when the session transitions to tier: null (resolved), not only when it drops out of the list', async () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    await drive(attn, [session({ tier: null, status: 'running', waitingSince: null })])

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  /**
   * Regression, found by live-probing the real Electron Dock (not by this
   * suite): `app.dock.bounce('critical')` returns **0** for the first bounce
   * of a process. `makeDockSurface` above starts its ids at 1, so a
   * truthiness guard (`if (this.#bounceId)`) instead of an explicit
   * `!== null` passes every other test in this file while never cancelling
   * the very first bounce in production — the exact forever-bouncing icon
   * this whole task exists to prevent.
   */
  it('cancels a bounce id of 0 — the id real Electron returns first, which a truthiness guard would skip', async () => {
    const zeroDock = {
      show: vi.fn(), hide: vi.fn(),
      bounce: vi.fn(() => 0),
      cancelBounce: vi.fn(),
    }
    const surface: AttentionSurface = { platform: 'darwin', dock: zeroDock, flashWindow: null }
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    await drive(attn, [])

    expect(zeroDock.cancelBounce).toHaveBeenCalledWith(0)
  })

  it('does NOT cancel or hide while a different session is still waiting', () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ sessionId: 's1', tier: 'blocked' }), session({ sessionId: 's2', tier: 'blocked' })])
    attn.update([session({ sessionId: 's2', tier: 'blocked' })]) // s1 resolved, s2 still waiting

    expect(cancelBounce).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it('cancels and hides only once no session needs attention any more, after the last one clears', async () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ sessionId: 's1', tier: 'blocked' }), session({ sessionId: 's2', tier: 'blocked' })])
    attn.update([session({ sessionId: 's2', tier: 'blocked' })]) // s1 resolved, s2 still waiting
    attn.update([]) // s2 resolved too

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})

describe('AttentionManager: the real dock.show() is async (found live, not by tests)', () => {
  /** A dock whose show() resolves only when the test says so. */
  function deferredDock() {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const dock: DockSurface = {
      show: vi.fn(() => gate),
      hide: vi.fn(),
      bounce: vi.fn(() => 0),
      cancelBounce: vi.fn(),
    }
    const surface: AttentionSurface = { platform: 'darwin', dock, flashWindow: null }
    return { surface, dock, release }
  }

  it('waits for show() to resolve before bouncing — the icon must exist first', async () => {
    const { surface, dock, release } = deferredDock()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    expect(dock.show).toHaveBeenCalledTimes(1)
    expect(dock.bounce).not.toHaveBeenCalled() // still in flight

    release()
    await Promise.resolve(); await Promise.resolve()

    expect(dock.bounce).toHaveBeenCalledWith('critical')
  })

  /**
   * The nasty one. If the wait resolves while show() is still in flight, a
   * naive implementation bounces *after* the user has already answered — and
   * because #stop() already ran, nothing is left to cancel it. A permanently
   * bouncing icon reached through the async path instead of the missing-cancel
   * path this task was built around.
   */
  it('abandons the bounce when the wait resolves before show() settles', async () => {
    const { surface, dock, release } = deferredDock()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    attn.update([]) // answered while the Dock was still appearing
    release()
    await Promise.resolve(); await Promise.resolve()

    expect(dock.bounce).not.toHaveBeenCalled()
  })

  /**
   * Whole-branch review, Important 5. `#stop()` cannot hide an icon that does
   * not exist yet: if the wait resolves while `show()` is still in flight, the
   * hide is issued against nothing, the icon then lands in the Dock, and
   * because `#attracting` is already false no future `#stop()` will ever hide
   * it — a permanent icon for a wait that already ended. Answering a prompt a
   * second or two after it appears is the product's single most common
   * interaction, so this is the normal case rather than an exotic one.
   */
  it('hides the Dock once a show() that landed AFTER the wait ended finally settles', async () => {
    const { surface, dock, release } = deferredDock()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])
    attn.update([])           // answered while the Dock was still appearing
    const hidesBeforeIconExists = (dock.hide as ReturnType<typeof vi.fn>).mock.calls.length
    release()                 // ...and only now does the icon actually exist
    await flush()

    expect(dock.bounce).not.toHaveBeenCalled()
    // Counting, not `toHaveBeenCalled()`: `#stop()` already issued a hide
    // synchronously — against an icon that did not exist yet, which is the
    // whole bug — so a bare "was hide called?" passes even with the deferred
    // hide deleted. What must be true is that ANOTHER hide lands after the
    // show settles.
    expect((dock.hide as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(hidesBeforeIconExists)
  })

  it('abandons the bounce when disposed before show() settles', async () => {
    const { surface, dock, release } = deferredDock()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    attn.dispose()
    release()
    await Promise.resolve(); await Promise.resolve()

    expect(dock.bounce).not.toHaveBeenCalled()
  })

  it('still bounces when show() rejects — a failed show must not cost the nudge', async () => {
    const dock: DockSurface = {
      show: vi.fn(() => Promise.reject(new Error('dock busy'))),
      hide: vi.fn(), bounce: vi.fn(() => 0), cancelBounce: vi.fn(),
    }
    const surface: AttentionSurface = { platform: 'darwin', dock, flashWindow: null }
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    expect(dock.bounce).toHaveBeenCalledWith('critical')
  })

  it('cancels the id from an async bounce once it finally arrives', async () => {
    const { surface, dock, release } = deferredDock()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    release()
    await Promise.resolve(); await Promise.resolve()
    await drive(attn, [])

    expect(dock.cancelBounce).toHaveBeenCalledWith(0)
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

  it('a per-project-muted session does not bounce, but an unrelated project\'s session still does', async () => {
    const { surface, bounce } = makeDockSurface()
    const c = cfg({ projects: { '/a/muted-repo': { muted: true } } })
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: () => c, now: () => 100 })

    await drive(attn, [
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

  it('bounces once the same session stops being reported as frontmost while still waiting', async () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ sessionId: 's1', tier: 'blocked' })], 's1')
    await drive(attn, [session({ sessionId: 's1', tier: 'blocked' })], null)

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('a snoozed session does not bounce until the snooze expires', async () => {
    const { surface, bounce } = makeDockSurface()
    let now = 100
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => now })

    await drive(attn, [session({ tier: 'blocked', snoozedUntil: 1_000 })])
    expect(bounce).not.toHaveBeenCalled()

    now = 1_001
    await drive(attn, [session({ tier: 'blocked', snoozedUntil: 1_000 })])
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

  it('bounces for blocked under the default config', async () => {
    const { surface, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])

    expect(bounce).toHaveBeenCalledTimes(1)
  })

  it('bounceOnBlocked: false is a master switch — even a blocked session never bounces', () => {
    const { surface, bounce } = makeDockSurface()
    const off: AttentionConfig = { bounceOnBlocked: false, bounceTiers: DEFAULT_BOUNCE_TIERS }
    const attn = new AttentionManager(surface, off, { loadConfig: cfg, now: () => 100 })

    attn.update([session({ tier: 'blocked' })])

    expect(bounce).not.toHaveBeenCalled()
  })

  it('a custom tier filter can enable stalled and disable blocked', async () => {
    const { surface, bounce } = makeDockSurface()
    const custom: AttentionConfig = { bounceOnBlocked: true, bounceTiers: new Set(['stalled']) }
    const attn = new AttentionManager(surface, custom, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ sessionId: 's1', tier: 'blocked' })])
    expect(bounce).not.toHaveBeenCalled()

    await drive(attn, [session({ sessionId: 's2', tier: 'stalled' })])
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

describe('AttentionManager: a broken config must never strand a bouncing icon', () => {
  // Review finding 2. loadConfig genuinely throws (malformed JSON, EACCES).
  // The first version logged and returned early, which froze #attracting at
  // true — so the icon kept bouncing forever once the user had answered. The
  // whole point of Step 2 reached through the error path instead of the
  // happy path.
  it('still cancels the bounce when the config goes unreadable mid-wait', async () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    let broken = false
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, {
      loadConfig: () => { if (broken) throw new Error('EACCES: permission denied'); return cfg() },
      now: () => 100,
    })

    await drive(attn, [session({ tier: 'blocked' })])
    broken = true
    attn.update([]) // the wait resolved, but the config can no longer be read

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all when the very first config read fails — no last-known-good to fall back to', () => {
    const { surface, show, bounce } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, {
      loadConfig: () => { throw new Error('unparseable') },
      now: () => 100,
    })

    expect(() => attn.update([session({ tier: 'blocked' })])).not.toThrow()
    expect(show).not.toHaveBeenCalled()
    expect(bounce).not.toHaveBeenCalled()
  })
})

describe('AttentionManager: a throwing surface must not wedge the manager', () => {
  it('does not claim to be bouncing when bounce() throws — a later resolve has nothing to cancel', async () => {
    // async show(): the branch production actually runs. With a sync show()
    // this test exercised a branch macOS never takes, and passed while the
    // real async path left the icon stranded in the Dock.
    const dock: DockSurface = {
      show: vi.fn(async () => {}), hide: vi.fn(),
      bounce: vi.fn(() => { throw new Error('dock is gone') }),
      cancelBounce: vi.fn(),
    }
    const surface: AttentionSurface = { platform: 'darwin', dock, flashWindow: null }
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    expect(() => attn.update([session({ tier: 'blocked' })])).not.toThrow()
    await drive(attn, [])

    // Never started, so nothing to stop: a cancelBounce here would be against
    // a bounce id that was never returned.
    expect(dock.cancelBounce).not.toHaveBeenCalled()
  })

  it('hides a Dock it showed when bounce() then throws, rather than stranding the icon', async () => {
    const dock: DockSurface = {
      show: vi.fn(), hide: vi.fn(),
      bounce: vi.fn(() => { throw new Error('dock is gone') }),
      cancelBounce: vi.fn(),
    }
    const surface: AttentionSurface = { platform: 'darwin', dock, flashWindow: null }
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])

    // #attracting stayed false, so no later #stop() would ever hide it.
    expect(dock.hide).toHaveBeenCalledTimes(1)
  })

  it('retries on the next update after a failed start rather than giving up for good', async () => {
    let fail = true
    const dock: DockSurface = {
      show: vi.fn(async () => {}), hide: vi.fn(),
      bounce: vi.fn(() => { if (fail) throw new Error('transient'); return 7 }),
      cancelBounce: vi.fn(),
    }
    const surface: AttentionSurface = { platform: 'darwin', dock, flashWindow: null }
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    fail = false
    await drive(attn, [session({ tier: 'blocked' })])

    expect(dock.bounce).toHaveBeenCalledTimes(2)
  })
})

describe('lazyFlashWindow: the Windows/Linux path (Steps 3-4), driven through an injected window factory', () => {
  function makeWin() {
    let destroyed = false
    const w: FlashWindowLike = {
      isDestroyed: () => destroyed,
      showInactive: vi.fn(),
      minimize: vi.fn(),
      flashFrame: vi.fn(),
      destroy: vi.fn(() => { destroyed = true }),
    }
    return w
  }

  it('shows the window INACTIVE and minimizes it before flashing — a focus-stealing window would be worse than no flash', () => {
    const w = makeWin()
    const calls: string[] = []
    const tracked: FlashWindowLike = {
      isDestroyed: () => w.isDestroyed(),
      showInactive: () => { calls.push('showInactive') },
      minimize: () => { calls.push('minimize') },
      flashFrame: () => { calls.push('flashFrame') },
      destroy: () => { calls.push('destroy') },
    }
    const surface = lazyFlashWindow(() => tracked)

    surface.flash(true)

    // Order matters: flashFrame against a window with no taskbar button is a
    // silent no-op, which is what makes this whole path fail invisibly.
    expect(calls).toEqual(['showInactive', 'minimize', 'flashFrame'])
  })

  /**
   * The off path was previously asserted by nobody: deleting the
   * `flashFrame(false)` branch outright left all seven of these tests green,
   * which is a Windows/Linux taskbar flashing forever after the user has
   * already answered — the exact analogue of the `cancelBounce` defect the
   * plan calls load-bearing. Caught in re-review as the sixteenth
   * test-that-cannot-fail in this project.
   */
  it('stops the flash on resolve — the load-bearing half of the taskbar path', () => {
    const w = makeWin()
    const surface = lazyFlashWindow(() => w)

    surface.flash(true)
    surface.flash(false)

    expect(w.flashFrame).toHaveBeenLastCalledWith(false)
  })

  it('reuses the same window across flashes instead of creating one per alert', () => {
    const w = makeWin()
    const make = vi.fn(() => w)
    const surface = lazyFlashWindow(make)

    surface.flash(true)
    surface.flash(false)
    surface.flash(true)

    expect(make).toHaveBeenCalledTimes(1)
  })

  it('creates no window at all until something actually needs flashing', () => {
    const make = vi.fn(makeWin)
    lazyFlashWindow(make)
    expect(make).not.toHaveBeenCalled()
  })

  it('turning the flash off before one was ever raised does not build a window', () => {
    const make = vi.fn(makeWin)
    const surface = lazyFlashWindow(make)
    surface.flash(false)
    expect(make).not.toHaveBeenCalled()
  })

  it('rebuilds after the window is destroyed out from under it', () => {
    const first = makeWin()
    const second = makeWin()
    const make = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const surface = lazyFlashWindow(make)

    surface.flash(true)
    first.destroy()
    surface.flash(true)

    expect(make).toHaveBeenCalledTimes(2)
    expect(second.flashFrame).toHaveBeenCalledWith(true)
  })

  it('destroys a half-built window when showInactive throws, rather than keeping one that silently never flashes', () => {
    const w = makeWin()
    w.showInactive = vi.fn(() => { throw new Error('no display server') })
    const make = vi.fn(() => w)
    const surface = lazyFlashWindow(make)

    expect(() => surface.flash(true)).not.toThrow()

    expect(w.destroy).toHaveBeenCalledTimes(1)
    // And the next attempt must build a fresh one rather than no-op forever
    // against the broken window.
    const w2 = makeWin()
    make.mockReturnValue(w2)
    surface.flash(true)
    expect(w2.flashFrame).toHaveBeenCalledWith(true)
  })

  it('dispose() destroys the window it created', () => {
    const w = makeWin()
    const surface = lazyFlashWindow(() => w)
    surface.flash(true)
    surface.dispose?.()
    expect(w.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('defaultSurface: the hidden-Dock baseline (review finding 3)', () => {
  // An Electron app launches WITH a Dock icon. Without this one hide() call,
  // "the icon appears exactly when you are needed" is really "the icon is
  // always there", and only becomes conditional after the first completed
  // bounce cycle happens to hide it. Previously this line had no test at all.
  function fakeDock() {
    return {
      show: vi.fn(async () => {}),
      hide: vi.fn(),
      bounce: vi.fn(() => 3),
      cancelBounce: vi.fn(),
    }
  }

  it('hides the Dock once while building the surface, so the icon starts absent', () => {
    const dock = fakeDock()
    const s = defaultSurface({ platform: 'darwin', dock })

    expect(dock.hide).toHaveBeenCalledTimes(1)
    expect(dock.show).not.toHaveBeenCalled()
    expect(s.dock).not.toBeNull()
  })

  it('wires the returned surface through to the real dock methods', () => {
    const dock = fakeDock()
    const s = defaultSurface({ platform: 'darwin', dock })

    expect(s.dock?.bounce('critical')).toBe(3)
    expect(dock.bounce).toHaveBeenCalledWith('critical')
    s.dock?.cancelBounce(3)
    expect(dock.cancelBounce).toHaveBeenCalledWith(3)
  })

  it('a rejected dock.show() is caught, not left as an unhandled rejection in the main process', async () => {
    const dock = fakeDock()
    dock.show = vi.fn(async () => { throw new Error('dock unavailable') })
    const s = defaultSurface({ platform: 'darwin', dock })

    expect(() => s.dock?.show()).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
  })

  it('degrades to no persistent attention on a Mac with no dock rather than throwing', () => {
    const s = defaultSurface({ platform: 'darwin', dock: undefined })
    expect(s.dock).toBeNull()
    expect(s.flashWindow).toBeNull()
  })

  it('uses the taskbar flash path off darwin, and never touches a dock there', () => {
    const dock = fakeDock()
    const flash: FlashSurface = { flash: vi.fn() }
    const s = defaultSurface({ platform: 'win32', dock, makeFlashWindow: () => flash })

    expect(s.dock).toBeNull()
    expect(s.flashWindow).toBe(flash)
    expect(dock.hide).not.toHaveBeenCalled()
  })
})

describe('AttentionManager: dispose', () => {
  it('dispose() while bouncing cancels the bounce and hides the Dock — a quit mid-wait must not leave it hanging', async () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
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

  it('is safe to dispose twice and does not double-cancel/hide', async () => {
    const { surface, cancelBounce, hide } = makeDockSurface()
    const attn = new AttentionManager(surface, DEFAULT_ATTENTION_CONFIG, { loadConfig: cfg, now: () => 100 })

    await drive(attn, [session({ tier: 'blocked' })])
    attn.dispose()
    attn.dispose()

    expect(cancelBounce).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
