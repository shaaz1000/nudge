import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainSpool } from '../src/drain.js'
import type { NudgeEvent } from '@nudge/shared/types'

let dir: string

const spooled = (sessionId: string, ts: number) => JSON.stringify({
  t: 'event',
  event: {
    source: 'claude-code', sessionId, hook: 'Notification',
    cwd: '/a/my-repo', project: 'my-repo', ts, message: 'Allow?',
  },
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-drain-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('drainSpool', () => {
  it('returns zero when the directory does not exist', async () => {
    expect(await drainSpool(() => {}, join(dir, 'nope'))).toBe(0)
  })

  it('replays spooled events and deletes the files', async () => {
    writeFileSync(join(dir, '1-a.json'), spooled('s1', 1000))
    writeFileSync(join(dir, '2-b.json'), spooled('s2', 2000))
    const seen: NudgeEvent[] = []
    expect(await drainSpool(ev => seen.push(ev), dir)).toBe(2)
    expect(seen).toHaveLength(2)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('replays in timestamp order so the state machine sees a coherent sequence', async () => {
    writeFileSync(join(dir, '9-late.json'), spooled('late', 9000))
    writeFileSync(join(dir, '1-early.json'), spooled('early', 1000))
    const seen: NudgeEvent[] = []
    await drainSpool(ev => seen.push(ev), dir)
    expect(seen.map(e => e.sessionId)).toEqual(['early', 'late'])
  })

  it('discards a malformed spool file instead of stalling the drain', async () => {
    writeFileSync(join(dir, '1-bad.json'), 'not json')
    writeFileSync(join(dir, '2-good.json'), spooled('s1', 2000))
    expect(await drainSpool(() => {}, dir)).toBe(1)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('does not let a throwing handler abort the drain', async () => {
    writeFileSync(join(dir, '1-a.json'), spooled('s1', 1000))
    writeFileSync(join(dir, '2-b.json'), spooled('s2', 2000))
    let calls = 0
    const count = await drainSpool(() => { calls++; if (calls === 1) throw new Error('boom') }, dir)
    expect(calls).toBe(2)
    expect(count).toBe(1)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('ignores non-json files', async () => {
    mkdirSync(join(dir, 'subdir'))
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    writeFileSync(join(dir, '1-a.json'), spooled('s1', 1000))
    expect(await drainSpool(() => {}, dir)).toBe(1)
  })
})
