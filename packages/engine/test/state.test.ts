import { describe, it, expect, beforeEach } from 'vitest'
import { SessionStore } from '../src/state.js'
import { FakeClock } from '../src/clock.js'
import { DEFAULT_CONFIG } from '@nudge/shared/config'
import type { HookName, NudgeEvent } from '@nudge/shared/types'

let clock: FakeClock
let store: SessionStore

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code',
  sessionId: 's1',
  hook,
  cwd: '/a/my-repo',
  project: 'my-repo',
  ts: clock.now(),
  ...extra,
})

beforeEach(() => {
  clock = new FakeClock(0)
  store = new SessionStore(DEFAULT_CONFIG, clock)
})

describe('the governing rule: any event clears prior waiting state', () => {
  it('clears a blocked session when the tool actually runs', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    const blocked = store.apply(ev('Notification', { message: 'Allow Bash?' }))
    expect(blocked.started).toBe('blocked')
    expect(blocked.session.status).toBe('blocked')

    clock.advance(5_000)
    const cleared = store.apply(ev('PostToolUse', { tool: 'Bash' }))
    expect(cleared.cleared).toBe('blocked')
    expect(cleared.session.status).toBe('running')
    expect(cleared.session.waitingSince).toBeNull()
  })

  it('clears a blocked session when the user types a reply', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('Notification', { message: 'Which file?' }))
    const cleared = store.apply(ev('UserPromptSubmit'))
    expect(cleared.cleared).toBe('blocked')
    expect(cleared.session.status).toBe('running')
  })

  it('clears an idle session when the user sends the next prompt', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    store.apply(ev('Stop'))
    const cleared = store.apply(ev('UserPromptSubmit'))
    expect(cleared.cleared).toBe('idle-short')
    expect(cleared.session.status).toBe('running')
  })
})

describe('tier assignment', () => {
  it('assigns idle-short when the turn was quick', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    clock.advance(60_000)
    const t = store.apply(ev('Stop'))
    expect(t.started).toBe('idle-short')
  })

  it('assigns idle-long when the turn ran past three minutes', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    clock.advance(200_000)
    const t = store.apply(ev('Stop'))
    expect(t.started).toBe('idle-long')
  })

  it('treats a Stop with no known turn start as idle-short', () => {
    const t = store.apply(ev('Stop'))
    expect(t.started).toBe('idle-short')
  })

  it('records the notification message on a blocked session', () => {
    store.apply(ev('Notification', { message: 'Allow Bash(rm)?' }))
    expect(store.get('s1')!.message).toBe('Allow Bash(rm)?')
  })
})

describe('de-duplication', () => {
  it('flags a repeat Notification with the same message as duplicate', () => {
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(60_000)
    const again = store.apply(ev('Notification', { message: 'Allow Bash?' }))
    expect(again.duplicate).toBe(true)
    expect(again.started).toBeNull()
  })

  it('does not flag a Notification with a different message', () => {
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    const other = store.apply(ev('Notification', { message: 'Allow Write?' }))
    expect(other.duplicate).toBe(false)
    expect(other.started).toBe('blocked')
  })

  it('keeps the original waitingSince across a duplicate', () => {
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    const first = store.get('s1')!.waitingSince
    clock.advance(60_000)
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    expect(store.get('s1')!.waitingSince).toBe(first)
  })
})

describe('session identity and lifecycle', () => {
  it('tracks concurrent sessions independently', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('SessionStart', { sessionId: 's2', cwd: '/a/other', project: 'other' }))
    store.apply(ev('Notification', { message: 'Allow?' }))
    expect(store.get('s1')!.status).toBe('blocked')
    expect(store.get('s2')!.status).toBe('running')
    expect(store.list()).toHaveLength(2)
  })

  it('retains the surface captured at SessionStart', () => {
    store.apply(ev('SessionStart', { surface: { kind: 'vscode', termProgram: 'vscode' } }))
    store.apply(ev('Stop'))
    expect(store.get('s1')!.surface.kind).toBe('vscode')
  })

  it('removes a session on SessionEnd', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('Notification', { message: 'Allow?' }))
    const t = store.apply(ev('SessionEnd'))
    expect(t.cleared).toBe('blocked')
    expect(store.get('s1')).toBeUndefined()
  })

  it('lists sessions with no SessionStart, created lazily', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    expect(store.get('s1')!.project).toBe('my-repo')
  })
})

describe('snooze and manual resolve', () => {
  it('records a snooze deadline', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    store.snooze('s1', 600_000)
    expect(store.get('s1')!.snoozedUntil).toBe(600_000)
  })

  it('clears waiting state on manual resolve', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    const t = store.resolve('s1')
    expect(t!.cleared).toBe('blocked')
    expect(store.get('s1')!.status).toBe('running')
  })

  it('returns null resolving a session that is not waiting', () => {
    store.apply(ev('SessionStart'))
    expect(store.resolve('s1')).toBeNull()
  })
})

describe('stall marking and TTL', () => {
  it('marks a running session stalled', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('PreToolUse', { tool: 'Bash' }))
    const t = store.markStalled('s1')
    expect(t!.started).toBe('stalled')
    expect(store.get('s1')!.status).toBe('stalled')
  })

  it('refuses to mark a blocked session stalled', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    expect(store.markStalled('s1')).toBeNull()
  })

  it('reports sessions older than a cutoff', () => {
    store.apply(ev('SessionStart'))
    clock.advance(100_000)
    store.apply(ev('SessionStart', { sessionId: 's2' }))
    expect(store.idsOlderThan(50_000)).toEqual(['s1'])
  })
})

describe('AskUserQuestion and other blocking tools', () => {
  it('treats an AskUserQuestion PreToolUse as a blocked wait, not as activity', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    const t = store.apply(ev('PreToolUse', { tool: 'AskUserQuestion' }))
    expect(t.started).toBe('blocked')
    expect(t.session.status).toBe('blocked')
    expect(t.session.waitingSince).toBe(clock.now())
    expect(t.session.message).toMatch(/question/i)
  })

  it('treats ExitPlanMode the same way', () => {
    const t = store.apply(ev('PreToolUse', { tool: 'ExitPlanMode' }))
    expect(t.started).toBe('blocked')
    expect(t.session.message).toMatch(/plan/i)
  })

  it('still treats an ordinary tool as activity that clears a wait', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    const t = store.apply(ev('PreToolUse', { tool: 'Bash' }))
    expect(t.cleared).toBe('blocked')
    expect(t.started).toBeNull()
    expect(t.session.status).toBe('running')
  })

  it('resolves the question wait when the user answers', () => {
    store.apply(ev('PreToolUse', { tool: 'AskUserQuestion' }))
    clock.advance(30_000)
    const t = store.apply(ev('PostToolUse', { tool: 'AskUserQuestion', ts: clock.now() }))
    expect(t.cleared).toBe('blocked')
    expect(t.session.status).toBe('running')
    expect(t.session.waitingSince).toBeNull()
  })

  it('does not stall a session that is blocked on a question', () => {
    store.apply(ev('PreToolUse', { tool: 'AskUserQuestion' }))
    expect(store.markStalled('s1')).toBeNull()
  })

  it('does not treat a PostToolUse for a blocking tool as a new wait', () => {
    const t = store.apply(ev('PostToolUse', { tool: 'AskUserQuestion' }))
    expect(t.started).toBeNull()
  })
})
