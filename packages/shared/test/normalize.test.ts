import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalize, isValidEvent } from '../src/normalize.js'
import { UNKNOWN_SURFACE } from '@nudge/shared/types'
import type { NudgeEvent } from '@nudge/shared/types'

// Moved here from packages/engine/test/normalize.test.ts (finding I5): this
// used to guard packages/engine/src/normalize.ts, which nothing in any src/
// tree imported — dead code. `normalize` now lives in @nudge/shared and is
// the actual implementation behind packages/hook/src/bin.ts's `buildEvent`
// (which calls it directly instead of re-implementing SUBSCRIBED/projectOf),
// so this fixture suite now exercises the live conversion path.

const FIXTURES = join(import.meta.dirname, 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

describe('normalize against real captured payloads', () => {
  const names = readdirSync(FIXTURES)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))

  it('has fixtures for all seven subscribed hooks', () => {
    expect(names.sort()).toEqual([
      'Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd',
      'SessionStart', 'Stop', 'UserPromptSubmit',
    ])
  })

  for (const name of names) {
    it(`normalizes ${name} into a complete NudgeEvent`, () => {
      const ev = normalize(load(name), UNKNOWN_SURFACE, 1234)
      expect(ev).not.toBeNull()
      expect(ev!.source).toBe('claude-code')
      expect(ev!.hook).toBe(name)
      expect(ev!.sessionId).toBeTruthy()
      expect(ev!.cwd).toBeTruthy()
      expect(ev!.project).toBe('fixture-project')
      expect(ev!.ts).toBe(1234)
    })
  }

  it('carries the Notification message through', () => {
    const ev = normalize(load('Notification'), UNKNOWN_SURFACE, 1)
    expect(typeof ev!.message).toBe('string')
    expect(ev!.message!.length).toBeGreaterThan(0)
  })

  it('carries the tool name through on PreToolUse', () => {
    const ev = normalize(load('PreToolUse'), UNKNOWN_SURFACE, 1)
    expect(typeof ev!.tool).toBe('string')
  })
})

describe('normalize edge cases', () => {
  it('returns null for a hook we do not subscribe to', () => {
    const ev = normalize(
      { hook_event_name: 'SubagentStop', session_id: 's', cwd: '/tmp/x' },
      UNKNOWN_SURFACE, 1,
    )
    expect(ev).toBeNull()
  })

  it('returns null for a payload missing session_id', () => {
    expect(normalize({ hook_event_name: 'Stop', cwd: '/tmp/x' }, UNKNOWN_SURFACE, 1)).toBeNull()
  })

  it('returns null for a non-object payload', () => {
    expect(normalize('nope', UNKNOWN_SURFACE, 1)).toBeNull()
    expect(normalize(null, UNKNOWN_SURFACE, 1)).toBeNull()
  })

  it('derives project from the last path segment, trailing slash or not', () => {
    const a = normalize({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/b/my-repo' }, UNKNOWN_SURFACE, 1)
    const b = normalize({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/b/my-repo/' }, UNKNOWN_SURFACE, 1)
    expect(a!.project).toBe('my-repo')
    expect(b!.project).toBe('my-repo')
  })

  it('attaches the surface only on SessionStart', () => {
    const surface = { kind: 'vscode' as const, termProgram: 'vscode' }
    const start = normalize({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/a/p' }, surface, 1)
    const stop = normalize({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/p' }, surface, 1)
    expect(start!.surface).toEqual(surface)
    expect(stop!.surface).toBeUndefined()
  })
})

/**
 * `isValidEvent` guards the *other* direction: a value already claiming to
 * be a finished NudgeEvent (the shape EngineServer receives off the wire),
 * as opposed to `normalize()`'s raw Claude Code hook payload. This is the
 * validator C1 wires into `EngineServer#handle` so a version-skewed hook, a
 * corrupted spool file, or a malicious client can never hand `ts` (or
 * anything else) straight to a SQLite bound parameter unchecked.
 */
describe('isValidEvent', () => {
  const valid: NudgeEvent = {
    source: 'claude-code', sessionId: 's1', hook: 'Notification',
    cwd: '/a/my-repo', project: 'my-repo', ts: 1234,
  }

  it('accepts a well-formed NudgeEvent', () => {
    expect(isValidEvent(valid)).toBe(true)
  })

  it('rejects a missing ts — the exact field that crashed the daemon (C1)', () => {
    const { ts, ...rest } = valid
    expect(isValidEvent(rest)).toBe(false)
  })

  it('rejects a non-number ts', () => {
    expect(isValidEvent({ ...valid, ts: '1234' })).toBe(false)
    expect(isValidEvent({ ...valid, ts: NaN })).toBe(false)
    expect(isValidEvent({ ...valid, ts: null })).toBe(false)
  })

  it('rejects a missing or empty sessionId', () => {
    const { sessionId, ...rest } = valid
    expect(isValidEvent(rest)).toBe(false)
    expect(isValidEvent({ ...valid, sessionId: '' })).toBe(false)
  })

  it('rejects a missing cwd or project', () => {
    const { cwd, ...restCwd } = valid
    expect(isValidEvent(restCwd)).toBe(false)
    const { project, ...restProject } = valid
    expect(isValidEvent(restProject)).toBe(false)
  })

  it('rejects a hook not in SUBSCRIBED', () => {
    expect(isValidEvent({ ...valid, hook: 'SubagentStop' })).toBe(false)
  })

  it('rejects a non-object value, including null, arrays, and primitives', () => {
    expect(isValidEvent(null)).toBe(false)
    expect(isValidEvent(undefined)).toBe(false)
    expect(isValidEvent('nope')).toBe(false)
    expect(isValidEvent(42)).toBe(false)
    expect(isValidEvent([])).toBe(false)
  })

  /**
   * Finding I10: `message`, `tool` and `source` were the three optional
   * NudgeEvent fields this guard never checked. Live repro: an event with
   * `message: {evil:true}` used to pass `isValidEvent`, get applied to the
   * store (the session showed up with `tier: "blocked"`), and only then blow
   * up inside `Db.recordEvent`'s SQLite bind — after the store mutation, so
   * the session was left orphaned with no wait row and no escalation ladder.
   */
  describe('non-string optional fields (I10)', () => {
    const badValues = [{ evil: true }, 42, ['a'], null]

    for (const bad of badValues) {
      it(`rejects a non-string message (${JSON.stringify(bad)})`, () => {
        expect(isValidEvent({ ...valid, message: bad })).toBe(false)
      })

      it(`rejects a non-string tool (${JSON.stringify(bad)})`, () => {
        expect(isValidEvent({ ...valid, tool: bad })).toBe(false)
      })

      it(`rejects a non-string source (${JSON.stringify(bad)})`, () => {
        expect(isValidEvent({ ...valid, source: bad })).toBe(false)
      })
    }

    it('still accepts the fields when absent — they remain optional', () => {
      expect(isValidEvent(valid)).toBe(true)
    })

    it('still accepts valid string values for all three', () => {
      expect(isValidEvent({ ...valid, message: 'hi', tool: 'Bash', source: 'claude-code' })).toBe(true)
    })
  })
})
