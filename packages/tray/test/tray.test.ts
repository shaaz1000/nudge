import { describe, it, expect, vi, beforeEach } from 'vitest'

// `electron` has no runtime module outside an actual Electron host (only the
// `electron` package's own bundled .d.ts for compile-time typing — see
// tray.ts's module doc). vi.mock intercepts the specifier before Node's
// resolver ever looks for a real module on disk — the same trick Phase 2
// used for `vscode` (see packages/vscode/test/status.test.ts). Nothing below
// exercises this mock's *contents* — every test injects an explicit fake
// TraySurface — it only has to exist so importing '../src/tray.js' does not
// throw.
vi.mock('electron', () => ({
  Tray: vi.fn(),
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}))

import type { SessionState } from '@nudge/shared/types'
import type { ClientMessage } from '@nudge/shared/protocol'
import {
  NudgeTray, resolveIcon, formatWaitDuration,
  type TraySurface, type TrayIconLike, type MenuItemSpec, type TrayCallbacks,
} from '../src/tray.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

// ---------------------------------------------------------------------------
// resolveIcon: pure, no Electron involved at all.
// ---------------------------------------------------------------------------
describe('resolveIcon', () => {
  it('picks the light asset for a given state when not dark', () => {
    expect(resolveIcon('idle', { platform: 'darwin', dark: false }).file).toBe('tray-idle-light.png')
    expect(resolveIcon('waiting', { platform: 'darwin', dark: false }).file).toBe('tray-waiting-light.png')
    expect(resolveIcon('unreachable', { platform: 'darwin', dark: false }).file).toBe('tray-unreachable-light.png')
  })

  it('picks the dark asset when dark is true, for every state', () => {
    expect(resolveIcon('idle', { platform: 'win32', dark: true }).file).toBe('tray-idle-dark.png')
    expect(resolveIcon('waiting', { platform: 'win32', dark: true }).file).toBe('tray-waiting-dark.png')
    expect(resolveIcon('unreachable', { platform: 'win32', dark: true }).file).toBe('tray-unreachable-dark.png')
  })

  it('marks the image as a template only on darwin — the OS handles inversion there, nowhere else', () => {
    expect(resolveIcon('idle', { platform: 'darwin', dark: false }).template).toBe(true)
    expect(resolveIcon('idle', { platform: 'darwin', dark: true }).template).toBe(true)
    expect(resolveIcon('idle', { platform: 'win32', dark: false }).template).toBe(false)
    expect(resolveIcon('idle', { platform: 'linux', dark: true }).template).toBe(false)
  })
})

describe('formatWaitDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatWaitDuration(45_000)).toBe('45s')
    expect(formatWaitDuration(90_000)).toBe('1m')
    expect(formatWaitDuration(3_690_000)).toBe('1h 1m')
  })

  it('never goes negative on clock skew', () => {
    expect(formatWaitDuration(-5_000)).toBe('0s')
  })
})

// ---------------------------------------------------------------------------
// NudgeTray: render(), context menu, disposal — via an injected TraySurface.
// ---------------------------------------------------------------------------

/** Records every image load, tooltip/title/menu set on a fake tray icon. */
function makeSurface() {
  const icon: TrayIconLike = {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
  }
  const loadedImages: Array<{ path: string; template: boolean }> = []
  const builtMenus: MenuItemSpec[][] = []
  const surface: TraySurface = {
    platform: 'darwin',
    isDark: () => false,
    loadImage: (path, template) => {
      loadedImages.push({ path, template })
      return { __img: path }
    },
    createTray: () => icon,
    buildMenu: items => { builtMenus.push(items); return { __menu: items } },
  }
  return { surface, icon, loadedImages, builtMenus, lastMenu: () => builtMenus[builtMenus.length - 1] }
}

function makeCallbacks() {
  const onFocusSession = vi.fn()
  const onStartEngine = vi.fn()
  const onOpenHistoryFolder = vi.fn()
  const onQuit = vi.fn()
  const callbacks: TrayCallbacks = { onFocusSession, onStartEngine, onOpenHistoryFolder, onQuit }
  return { callbacks, onFocusSession, onStartEngine, onOpenHistoryFolder, onQuit }
}

/** Finds a non-separator item by label; throws (via ! assertion) if absent — tests should fail loudly, not silently pass on `undefined`. */
function findItem(items: MenuItemSpec[], label: string): MenuItemSpec & { type?: 'normal' } {
  const item = items.find(i => i.type !== 'separator' && 'label' in i && i.label === label)
  if (!item) throw new Error(`no menu item labelled "${label}" among: ${items.map(i => ('label' in i ? i.label : '(separator)')).join(', ')}`)
  return item as MenuItemSpec & { type?: 'normal' }
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('NudgeTray: idle state', () => {
  it('renders the plain idle icon with an empty tooltip and no title when nothing is waiting', () => {
    const { surface, icon, loadedImages } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([], true)

    expect(loadedImages[loadedImages.length - 1].path).toContain('tray-idle-light.png')
    expect(icon.setToolTip).toHaveBeenLastCalledWith('')
    expect(icon.setTitle).toHaveBeenLastCalledWith('')
  })
})

describe('NudgeTray: waiting state', () => {
  it('badges the icon with the exact waiting count — not hardcoded to a fixed number', () => {
    const { surface, icon } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([session({ sessionId: 's1' }), session({ sessionId: 's2' })], true)
    expect(icon.setTitle).toHaveBeenLastCalledWith('2')

    tray.render([session({ sessionId: 's1' })], true)
    expect(icon.setTitle).toHaveBeenLastCalledWith('1')
  })

  it('uses the waiting icon asset while any session is waiting', () => {
    const { surface, loadedImages } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([session()], true)

    expect(loadedImages[loadedImages.length - 1].path).toContain('tray-waiting-light.png')
  })

  it('tooltip lists project, tier AND elapsed wait time for every waiting session — not just a count', () => {
    vi.useFakeTimers()
    try {
      const now = 1_000_000
      vi.setSystemTime(now)
      const { surface, icon } = makeSurface()
      const { callbacks } = makeCallbacks()
      const tray = new NudgeTray(vi.fn(), callbacks, surface)

      tray.render([
        session({ sessionId: 's1', project: 'repo-a', tier: 'blocked', waitingSince: now - 90_000 }),
        session({ sessionId: 's2', project: 'repo-b', tier: 'idle-long', waitingSince: now - 45_000 }),
      ], true)

      const tooltip = icon.setToolTip.mock.calls[icon.setToolTip.mock.calls.length - 1][0] as string
      expect(tooltip).toContain('repo-a')
      expect(tooltip).toContain('blocked')
      expect(tooltip).toContain('1m') // 90s elapsed
      expect(tooltip).toContain('repo-b')
      expect(tooltip).toContain('idle-long')
      expect(tooltip).toContain('45s') // 45s elapsed
    } finally {
      vi.useRealTimers()
    }
  })

  // Minor fix #2 from Phase 2 (status.ts/toast.ts) applies here too: a
  // snooze doesn't clear `tier` server-side — it's a separate suppression
  // overlay — so a still-snoozed session must not count as "waiting".
  it('excludes a currently-snoozed session from the count, icon and tooltip', () => {
    const { surface, icon } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([session({ snoozedUntil: Date.now() + 600_000 })], true)

    expect(icon.setTitle).toHaveBeenLastCalledWith('')
  })
})

describe('NudgeTray: engine unreachable', () => {
  it('renders a distinct unreachable icon and a non-empty tooltip explaining why — never blank', () => {
    const { surface, icon, loadedImages } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([session()], false) // even with stale "waiting" data, connected wins

    expect(loadedImages[loadedImages.length - 1].path).toContain('tray-unreachable-light.png')
    const tooltip = icon.setToolTip.mock.calls[icon.setToolTip.mock.calls.length - 1][0] as string
    expect(tooltip.length).toBeGreaterThan(0)
    expect(tooltip.toLowerCase()).toContain('not running')
  })

  it('offers a "Start engine" menu item that calls back when clicked', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks, onStartEngine } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([], false)
    const item = findItem(lastMenu(), 'Start engine')
    item.click?.()

    expect(onStartEngine).toHaveBeenCalledTimes(1)
  })

  it('does not list per-session focus items when the engine is unreachable (there is no live data to trust)', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([session({ project: 'stale-repo' })], false)

    expect(lastMenu().some(i => i.type !== 'separator' && 'label' in i && i.label.includes('stale-repo'))).toBe(false)
  })
})

describe('NudgeTray: context menu — session items', () => {
  it('has one item per waiting session, and clicking one calls onFocusSession with that exact session', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks, onFocusSession } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    const a = session({ sessionId: 's1', project: 'repo-a', tier: 'blocked' })
    const b = session({ sessionId: 's2', project: 'repo-b', tier: 'idle-short' })
    tray.render([a, b], true)

    const itemA = findItem(lastMenu(), 'repo-a — blocked')
    const itemB = findItem(lastMenu(), 'repo-b — idle-short')
    itemA.click?.()
    expect(onFocusSession).toHaveBeenCalledWith(a)
    itemB.click?.()
    expect(onFocusSession).toHaveBeenCalledWith(b)
  })
})

describe('NudgeTray: Snooze 10m', () => {
  it('sends a snooze message for every currently-waiting session, each with ms: 600000', () => {
    const sent: ClientMessage[] = []
    const { surface, lastMenu } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(msg => sent.push(msg), callbacks, surface)

    const a = session({ sessionId: 's1' })
    const b = session({ sessionId: 's2' })
    tray.render([a, b], true)

    findItem(lastMenu(), 'Snooze 10m').click?.()

    expect(sent).toContainEqual({ t: 'snooze', id: expect.any(Number), sessionId: 's1', ms: 600_000 })
    expect(sent).toContainEqual({ t: 'snooze', id: expect.any(Number), sessionId: 's2', ms: 600_000 })
  })

  it('is present but disabled when nothing is waiting, rather than absent', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([], true)

    const item = findItem(lastMenu(), 'Snooze 10m')
    expect(item.enabled).toBe(false)
  })
})

describe('NudgeTray: Mute/Unmute', () => {
  it('toggles label and the {t:"mute", on} value sent on each click', () => {
    const sent: ClientMessage[] = []
    const { surface, lastMenu } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(msg => sent.push(msg), callbacks, surface)

    tray.render([], true)
    findItem(lastMenu(), 'Mute').click?.()
    expect(sent).toContainEqual(expect.objectContaining({ t: 'mute', on: true }))

    tray.render([], true) // re-render to rebuild the menu with the new toggle state
    findItem(lastMenu(), 'Unmute').click?.()
    expect(sent).toContainEqual(expect.objectContaining({ t: 'mute', on: false }))
  })
})

describe('NudgeTray: Open history folder / Quit', () => {
  it('"Open history folder" calls onOpenHistoryFolder', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks, onOpenHistoryFolder } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([], true)
    findItem(lastMenu(), 'Open history folder').click?.()

    expect(onOpenHistoryFolder).toHaveBeenCalledTimes(1)
  })

  it('"Quit" calls onQuit', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks, onQuit } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([], true)
    findItem(lastMenu(), 'Quit').click?.()

    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  it('both are present and enabled even when the engine is unreachable', () => {
    const { surface, lastMenu } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    tray.render([], false)

    expect(findItem(lastMenu(), 'Open history folder').enabled).not.toBe(false)
    expect(findItem(lastMenu(), 'Quit').enabled).not.toBe(false)
  })
})

describe('NudgeTray: disposal', () => {
  it('destroys the underlying tray icon exactly once, not merely runs without throwing', () => {
    const { surface, icon } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)

    expect(icon.destroy).not.toHaveBeenCalled()
    tray.dispose()
    expect(icon.destroy).toHaveBeenCalledTimes(1)

    tray.dispose() // idempotent: a second call must not destroy again
    expect(icon.destroy).toHaveBeenCalledTimes(1)
  })

  it('render() after dispose() is a no-op — does not touch the (destroyed) icon', () => {
    const { surface, icon } = makeSurface()
    const { callbacks } = makeCallbacks()
    const tray = new NudgeTray(vi.fn(), callbacks, surface)
    tray.dispose()

    icon.setImage.mockClear()
    icon.setToolTip.mockClear()
    tray.render([session()], true)

    expect(icon.setImage).not.toHaveBeenCalled()
    expect(icon.setToolTip).not.toHaveBeenCalled()
  })
})
