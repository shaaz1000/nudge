import { describe, it, expect, beforeEach } from 'vitest'
import { SessionStore } from '../src/state.js'
import { Watchdog } from '../src/watchdog.js'
import { FakeClock } from '../src/clock.js'
import { mergeConfig } from '@nudge/shared/config'
import type { HookName, NudgeEvent } from '@nudge/shared/types'
import type { Transition } from '../src/state.js'

let clock: FakeClock
let store: SessionStore
let stalls: Transition[]
let wd: Watchdog

const cfg = mergeConfig({ watchdog: { stallAfterMs: 900_000, sessionTtlMs: 86_400_000, tickMs: 30_000 } })

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook,
  cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), ...extra,
})

beforeEach(() => {
  clock = new FakeClock(0)
  store = new SessionStore(cfg, clock)
  stalls = []
  wd = new Watchdog(cfg, clock, store, t => stalls.push(t))
})

describe('stall detection', () => {
  it('does not stall a session that is still emitting events', () => {
    store.apply(ev('SessionStart'))
    clock.advance(800_000)
    store.apply(ev('PreToolUse', { tool: 'Bash', ts: clock.now() }))
    clock.advance(800_000)
    wd.tick()
    expect(stalls).toHaveLength(0)
  })

  it('stalls a running session silent past the threshold', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('PreToolUse', { tool: 'Bash' }))
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(1)
    expect(stalls[0].started).toBe('stalled')
    expect(store.get('s1')!.status).toBe('stalled')
  })

  it('never stalls a blocked session — it is waiting on the human, not hung', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(0)
    expect(store.get('s1')!.status).toBe('blocked')
  })

  it('never stalls an idle session', () => {
    store.apply(ev('UserPromptSubmit'))
    store.apply(ev('Stop'))
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(0)
  })

  it('stalls a session only once', () => {
    store.apply(ev('SessionStart'))
    clock.advance(900_001)
    wd.tick()
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(1)
  })
})

describe('session TTL', () => {
  it('drops a session with no events past the TTL', () => {
    store.apply(ev('SessionStart'))
    clock.advance(86_400_001)
    wd.tick()
    expect(store.get('s1')).toBeUndefined()
  })

  it('keeps a session inside the TTL', () => {
    store.apply(ev('SessionStart'))
    clock.advance(86_000_000)
    wd.tick()
    expect(store.get('s1')).toBeDefined()
  })

  it('drops rather than stalls when both thresholds have passed', () => {
    store.apply(ev('SessionStart'))
    clock.advance(900_001)
    wd.tick()
    stalls.length = 0
    clock.advance(86_400_001)
    wd.tick()
    expect(store.get('s1')).toBeUndefined()
    expect(stalls).toHaveLength(0)
  })
})

describe('onDrop callback (I1)', () => {
  it('calls onDrop with the sessionId when a session is dropped past its TTL', () => {
    const drops: string[] = []
    const wd2 = new Watchdog(cfg, clock, store, () => {}, id => drops.push(id))
    store.apply(ev('SessionStart'))
    clock.advance(86_400_001)
    wd2.tick()
    expect(drops).toEqual(['s1'])
  })

  it('does not call onDrop for a session that merely stalls', () => {
    const drops: string[] = []
    const wd2 = new Watchdog(cfg, clock, store, () => {}, id => drops.push(id))
    store.apply(ev('SessionStart'))
    clock.advance(900_001)
    wd2.tick()
    expect(drops).toEqual([])
  })

  it('defaults to a no-op onDrop when the callback is omitted, without throwing', () => {
    const wd2 = new Watchdog(cfg, clock, store, () => {})
    store.apply(ev('SessionStart'))
    clock.advance(86_400_001)
    expect(() => wd2.tick()).not.toThrow()
    expect(store.get('s1')).toBeUndefined()
  })

  it('survives a throwing onDrop callback and continues ticking', () => {
    const wd2 = new Watchdog(cfg, clock, store, () => {}, () => { throw new Error('boom') })
    store.apply(ev('SessionStart', { sessionId: 's1' }))
    clock.advance(86_400_001)
    expect(() => wd2.tick()).not.toThrow()

    store.apply(ev('SessionStart', { sessionId: 's2', ts: clock.now() }))
    clock.advance(86_400_001)
    expect(() => wd2.tick()).not.toThrow()
    expect(store.get('s2')).toBeUndefined()
  })
})

describe('start/stop', () => {
  it('ticks on the configured interval until cancelled', () => {
    store.apply(ev('SessionStart'))
    const cancel = wd.start()
    clock.advance(900_001)
    expect(stalls).toHaveLength(1)
    cancel()
    expect(clock.pendingCount()).toBe(0)
  })
})

describe('resilience to throwing callbacks', () => {
  it('survives a throwing onStall callback and continues ticking', () => {
    let callCount = 0
    const throwingCallback = (t: Transition) => {
      callCount++
      if (callCount === 1) throw new Error('simulated callback failure')
      stalls.push(t)
    }
    const wd2 = new Watchdog(cfg, clock, store, throwingCallback)

    // First session stalls and callback throws
    store.apply(ev('SessionStart', { sessionId: 's1' }))
    clock.advance(900_001)
    const cancel = wd2.start()

    // Let the first stall happen and throw
    clock.advance(30_000)
    expect(callCount).toBe(1)
    expect(stalls).toHaveLength(0)

    // Create second session that also stalls
    store.apply(ev('SessionStart', { sessionId: 's2', ts: clock.now() }))
    clock.advance(900_001)

    // Verify second stall was detected (proves loop is still alive)
    clock.advance(30_000)
    expect(callCount).toBe(2)
    expect(stalls).toHaveLength(1)
    expect(stalls[0].session.sessionId).toBe('s2')

    cancel()
  })

  it('one session throwing does not prevent another from stalling in same tick', () => {
    let callCount = 0
    const throwingCallback = (t: Transition) => {
      callCount++
      if (t.session.sessionId === 's1') throw new Error('s1 throws')
      stalls.push(t)
    }
    const wd2 = new Watchdog(cfg, clock, store, throwingCallback)

    // Create two sessions
    store.apply(ev('SessionStart', { sessionId: 's1' }))
    clock.advance(1)
    store.apply(ev('SessionStart', { sessionId: 's2', ts: clock.now() }))

    // Advance past stall threshold
    clock.advance(900_001)

    // Tick once; both should stall, s1 throws but s2 should still be recorded
    wd2.tick()
    expect(callCount).toBe(2)
    expect(stalls).toHaveLength(1)
    expect(stalls[0].session.sessionId).toBe('s2')
  })
})
