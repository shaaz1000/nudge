import { describe, it, expect } from 'vitest'
import { inQuietHours, localSuppression, phoneSuppression, minutesOfDay } from '../src/suppression.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { SessionState } from '@nudge/shared/types'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 0, turnStartedAt: null, lastEventAt: 0,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

describe('inQuietHours', () => {
  it('handles a window that does not cross midnight', () => {
    const q = { start: '13:00', end: '14:00' }
    expect(inQuietHours(q, 12 * 60 + 59)).toBe(false)
    expect(inQuietHours(q, 13 * 60)).toBe(true)
    expect(inQuietHours(q, 13 * 60 + 59)).toBe(true)
    expect(inQuietHours(q, 14 * 60)).toBe(false)
  })

  it('handles a window that crosses midnight', () => {
    const q = { start: '23:00', end: '08:00' }
    expect(inQuietHours(q, 22 * 60 + 59)).toBe(false)
    expect(inQuietHours(q, 23 * 60)).toBe(true)
    expect(inQuietHours(q, 3 * 60)).toBe(true)
    expect(inQuietHours(q, 7 * 60 + 59)).toBe(true)
    expect(inQuietHours(q, 8 * 60)).toBe(false)
  })

  it('is never active when unconfigured', () => {
    expect(inQuietHours(null, 3 * 60)).toBe(false)
  })
})

describe('minutesOfDay', () => {
  it('derives local minutes from a timestamp', () => {
    const d = new Date(2026, 7, 10, 14, 30, 0)
    expect(minutesOfDay(d.getTime())).toBe(14 * 60 + 30)
  })
})

describe('localSuppression, in priority order', () => {
  it('passes an ordinary blocked session through', () => {
    expect(localSuppression(DEFAULT_CONFIG, session(), 'blocked', null, 0)).toBe('none')
  })

  it('suppresses a disabled tier', () => {
    const cfg = mergeConfig({ tiers: { blocked: { enabled: false } } })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('tier-disabled')
  })

  it('suppresses when the session window is already frontmost', () => {
    expect(localSuppression(DEFAULT_CONFIG, session(), 'blocked', 's1', 0)).toBe('frontmost')
  })

  it('does not suppress when a different session is frontmost', () => {
    expect(localSuppression(DEFAULT_CONFIG, session(), 'blocked', 's2', 0)).toBe('none')
  })

  it('suppresses under global mute', () => {
    const cfg = mergeConfig({ muted: true })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('muted')
  })

  it('suppresses under a per-project mute keyed by cwd', () => {
    const cfg = mergeConfig({ projects: { '/a/my-repo': { muted: true } } })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('project-muted')
  })

  it('suppresses while snoozed and resumes after', () => {
    const s = session({ snoozedUntil: 600_000 })
    expect(localSuppression(DEFAULT_CONFIG, s, 'blocked', null, 500_000)).toBe('snoozed')
    expect(localSuppression(DEFAULT_CONFIG, s, 'blocked', null, 600_001)).toBe('none')
  })

  it('ranks frontmost above mute', () => {
    const cfg = mergeConfig({ muted: true })
    expect(localSuppression(cfg, session(), 'blocked', 's1', 0)).toBe('frontmost')
  })
})

describe('phoneSuppression', () => {
  it('passes a blocked session through outside quiet hours', () => {
    expect(phoneSuppression(DEFAULT_CONFIG, session(), 'blocked', 0, 12 * 60)).toBe('none')
  })

  it('holds phone push during quiet hours', () => {
    const cfg = mergeConfig({ quietHours: { start: '23:00', end: '08:00' } })
    expect(phoneSuppression(cfg, session(), 'blocked', 0, 3 * 60)).toBe('quiet-hours')
  })

  it('still allows local alerts during quiet hours', () => {
    const cfg = mergeConfig({ quietHours: { start: '23:00', end: '08:00' } })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('none')
  })

  it('suppresses a non-escalating tier', () => {
    expect(phoneSuppression(DEFAULT_CONFIG, session(), 'idle-short', 0, 12 * 60)).toBe('tier-disabled')
  })
})
