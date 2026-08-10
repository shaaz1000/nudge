import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalize } from '../src/normalize.js'
import { UNKNOWN_SURFACE } from '@nudge/shared/types'

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
