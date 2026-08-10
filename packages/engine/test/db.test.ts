import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/db.js'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'

let dir: string
let db: Db

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1000, turnStartedAt: null, lastEventAt: 1000,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

const ev = (over: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook: 'Notification',
  cwd: '/a/my-repo', project: 'my-repo', ts: 1000, message: 'Allow?', ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-db-'))
  db = new Db(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('schema', () => {
  it('creates the file and is reopenable', () => {
    db.recordEvent(ev())
    db.close()
    const again = new Db(join(dir, 'test.db'))
    expect(again.waitsSince(0)).toEqual([])
    again.close()
  })
})

describe('waits', () => {
  it('opens a wait and lists it as unresolved', () => {
    db.openWait(session(), 'blocked')
    const open = db.openWaits()
    expect(open).toHaveLength(1)
    expect(open[0].project).toBe('my-repo')
    expect(open[0].tier).toBe('blocked')
    expect(open[0].resolvedAt).toBeNull()
  })

  it('closes a wait with a timestamp and reason', () => {
    db.openWait(session(), 'blocked')
    db.closeWait('s1', 4000, 'PostToolUse')
    expect(db.openWaits()).toHaveLength(0)
    const all = db.waitsSince(0)
    expect(all[0].resolvedAt).toBe(4000)
    expect(all[0].resolvedBy).toBe('PostToolUse')
  })

  it('closes only the newest open wait for a session', () => {
    db.openWait(session(), 'idle-short')
    db.closeWait('s1', 2000, 'UserPromptSubmit')
    db.openWait(session({ waitingSince: 3000 }), 'blocked')
    db.closeWait('s1', 5000, 'PostToolUse')
    const all = db.waitsSince(0)
    expect(all).toHaveLength(2)
    expect(all.every(w => w.resolvedAt !== null)).toBe(true)
  })

  it('ignores closing a session with no open wait', () => {
    expect(() => db.closeWait('nope', 1, 'x')).not.toThrow()
  })

  it('filters by timestamp', () => {
    db.openWait(session({ waitingSince: 1000 }), 'blocked')
    db.openWait(session({ sessionId: 's2', waitingSince: 9000 }), 'blocked')
    expect(db.waitsSince(5000)).toHaveLength(1)
  })
})

describe('events and pruning', () => {
  it('records events', () => {
    db.recordEvent(ev())
    db.recordEvent(ev({ hook: 'Stop', ts: 2000 }))
    expect(db.eventCount()).toBe(2)
  })

  it('prunes rows older than the cutoff from both tables', () => {
    db.recordEvent(ev({ ts: 1000 }))
    db.recordEvent(ev({ ts: 90_000 }))
    db.openWait(session({ waitingSince: 1000 }), 'blocked')
    db.closeWait('s1', 1500, 'x')
    db.openWait(session({ sessionId: 's2', waitingSince: 90_000 }), 'blocked')
    const removed = db.prune(50_000)
    expect(removed).toBeGreaterThan(0)
    expect(db.eventCount()).toBe(1)
    expect(db.waitsSince(0)).toHaveLength(1)
  })

  it('never prunes a still-open wait', () => {
    db.openWait(session({ waitingSince: 1000 }), 'blocked')
    db.prune(50_000)
    expect(db.openWaits()).toHaveLength(1)
  })
})
