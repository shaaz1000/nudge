import { describe, it, expect, beforeEach } from 'vitest'
import { Escalator } from '../src/escalation.js'
import { FakeClock } from '../src/clock.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 0, turnStartedAt: null, lastEventAt: 0,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

let clock: FakeClock
let local: Array<{ tier: Tier; repeat: number }>
let phone: Array<{ tier: Tier; repeat: number }>

function build(cfg = DEFAULT_CONFIG, idleMs = 0) {
  clock = new FakeClock(0)
  local = []
  phone = []
  return new Escalator({
    cfg, clock,
    idleMs: () => idleMs,
    onLocal: (_s, tier, repeat) => local.push({ tier, repeat }),
    onPhone: (_s, tier, repeat) => phone.push({ tier, repeat }),
  })
}

describe('local alerting', () => {
  it('fires immediately at t=0', () => {
    const e = build()
    e.begin(session(), 'blocked')
    expect(local).toEqual([{ tier: 'blocked', repeat: 0 }])
  })

  it('repeats three times at sixty seconds apart, then stops', () => {
    const e = build()
    e.begin(session(), 'blocked')
    clock.advance(60_000); expect(local).toHaveLength(2)
    clock.advance(60_000); expect(local).toHaveLength(3)
    clock.advance(60_000); expect(local).toHaveLength(4)
    clock.advance(600_000); expect(local).toHaveLength(4)
    expect(local.map(l => l.repeat)).toEqual([0, 1, 2, 3])
  })
})

describe('phone escalation timing', () => {
  it('pushes after the active delay when the machine is in use', () => {
    const e = build(DEFAULT_CONFIG, 0)
    e.begin(session(), 'blocked')
    clock.advance(179_999); expect(phone).toHaveLength(0)
    clock.advance(2); expect(phone).toEqual([{ tier: 'blocked', repeat: 0 }])
  })

  it('pushes after the idle delay when the human has walked away', () => {
    const e = build(DEFAULT_CONFIG, 90_000)
    e.begin(session(), 'blocked')
    clock.advance(44_999); expect(phone).toHaveLength(0)
    clock.advance(2); expect(phone).toHaveLength(1)
  })

  it('never pushes for a non-escalating tier', () => {
    const e = build()
    e.begin(session({ tier: 'idle-short' }), 'idle-short')
    clock.advance(3_600_000)
    expect(phone).toHaveLength(0)
  })

  it('still fires the local alert for a non-escalating but enabled tier', () => {
    const e = build()
    e.begin(session({ tier: 'idle-short' }), 'idle-short')
    expect(local).toHaveLength(1)
  })

  it('honours a per-tier delay override regardless of idle state', () => {
    const cfg = mergeConfig({ tiers: { blocked: { escalateDelayMs: 5_000 } } })
    const e = build(cfg as NudgeConfig, 90_000)
    e.begin(session(), 'blocked')
    clock.advance(5_001)
    expect(phone).toHaveLength(1)
  })

  it('does not repeat the phone push by default', () => {
    const e = build()
    e.begin(session(), 'blocked')
    clock.advance(3_600_000)
    expect(phone).toHaveLength(1)
  })

  it('repeats the phone push when configured', () => {
    const cfg = mergeConfig({ escalation: { phoneRepeat: 2, phoneRepeatIntervalMs: 300_000 } })
    const e = build(cfg as NudgeConfig)
    e.begin(session(), 'blocked')
    clock.advance(180_000); expect(phone).toHaveLength(1)
    clock.advance(300_000); expect(phone).toHaveLength(2)
    clock.advance(300_000); expect(phone).toHaveLength(3)
    clock.advance(900_000); expect(phone).toHaveLength(3)
  })

  it('reads idle state at push time, not at begin time', () => {
    let idle = 0
    clock = new FakeClock(0)
    local = []; phone = []
    const e = new Escalator({
      cfg: DEFAULT_CONFIG, clock,
      idleMs: () => idle,
      onLocal: (_s, tier, repeat) => local.push({ tier, repeat }),
      onPhone: (_s, tier, repeat) => phone.push({ tier, repeat }),
    })
    e.begin(session(), 'blocked')
    idle = 90_000
    clock.advance(45_001)
    expect(phone).toHaveLength(1)
  })
})

describe('cancellation', () => {
  it('cancels every pending timer for a session', () => {
    const e = build()
    e.begin(session(), 'blocked')
    e.cancel('s1')
    clock.advance(3_600_000)
    expect(local).toHaveLength(1)
    expect(phone).toHaveLength(0)
    expect(e.activeCount()).toBe(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('replaces timers when begin is called twice for one session', () => {
    const e = build()
    e.begin(session(), 'blocked')
    e.begin(session(), 'blocked')
    expect(e.activeCount()).toBe(1)
    clock.advance(180_001)
    expect(phone).toHaveLength(1)
  })

  it('cancelAll clears every session', () => {
    const e = build()
    e.begin(session(), 'blocked')
    e.begin(session({ sessionId: 's2' }), 'blocked')
    expect(e.activeCount()).toBe(2)
    e.cancelAll()
    expect(e.activeCount()).toBe(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('runs two sessions on independent ladders', () => {
    const e = build()
    e.begin(session(), 'blocked')
    clock.advance(100_000)
    e.begin(session({ sessionId: 's2' }), 'blocked')
    clock.advance(80_001)
    expect(phone).toHaveLength(1)
    clock.advance(100_000)
    expect(phone).toHaveLength(2)
  })
})
