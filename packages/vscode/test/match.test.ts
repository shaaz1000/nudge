import { describe, it, expect } from 'vitest'
import { sessionsForWindow } from '../src/match.js'
import type { SessionState } from '@nudge/shared/types'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1',
  project: 'my-repo',
  cwd: '/a/my-repo',
  surface: { kind: 'vscode' },
  status: 'blocked',
  tier: 'blocked',
  waitingSince: 1,
  turnStartedAt: null,
  lastEventAt: 1,
  message: 'Allow?',
  snoozedUntil: null,
  pushFailed: false,
  ...over,
})

describe('sessionsForWindow', () => {
  it('returns empty array when no folders are open', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project' }),
      session({ sessionId: 's2', cwd: '/b/other' }),
    ]
    const folders: readonly string[] = []

    const result = sessionsForWindow(sessions, folders)

    expect(result).toEqual([])
  })

  it('matches session with exact folder path', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project' }),
      session({ sessionId: 's2', cwd: '/b/other' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('s1')
  })

  it('matches session in a subdirectory of a folder', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project/src' }),
      session({ sessionId: 's2', cwd: '/b/other' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('s1')
  })

  it('matches session in a deeply nested subdirectory', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project/src/components/button' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('s1')
  })

  it('does not match sibling directory with common prefix', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project-two' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toEqual([])
  })

  it('does not match parent directory when session is outside folder', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toEqual([])
  })

  it('matches multiple sessions in multi-root workspace', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project' }),
      session({ sessionId: 's2', cwd: '/b/other' }),
      session({ sessionId: 's3', cwd: '/c/third' }),
      session({ sessionId: 's4', cwd: '/a/project/src' }),
    ]
    const folders = ['/a/project', '/b/other']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(3)
    expect(result.map(s => s.sessionId).sort()).toEqual(['s1', 's2', 's4'])
  })

  it('handles trailing slash on folder path', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project' }),
      session({ sessionId: 's2', cwd: '/a/project/src' }),
    ]
    const folders = ['/a/project/']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(2)
    expect(result.map(s => s.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('handles trailing slash on cwd path', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project/' }),
      session({ sessionId: 's2', cwd: '/a/project/src/' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(2)
    expect(result.map(s => s.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('handles trailing slashes on both folder and cwd', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/a/project/' }),
      session({ sessionId: 's2', cwd: '/a/project/src/' }),
    ]
    const folders = ['/a/project/']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(2)
    expect(result.map(s => s.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('preserves session order from input', () => {
    const sessions = [
      session({ sessionId: 's3', cwd: '/a/project/c' }),
      session({ sessionId: 's1', cwd: '/a/project' }),
      session({ sessionId: 's2', cwd: '/a/project/b' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(3)
    expect(result.map(s => s.sessionId)).toEqual(['s3', 's1', 's2'])
  })

  it('does not match unrelated directories', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/x/project' }),
      session({ sessionId: 's2', cwd: '/y/other' }),
    ]
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toEqual([])
  })

  it('handles empty sessions array', () => {
    const sessions: SessionState[] = []
    const folders = ['/a/project']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toEqual([])
  })

  it('correctly handles complex sibling scenarios', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/workspace/my-app' }),
      session({ sessionId: 's2', cwd: '/workspace/my-app-server' }),
      session({ sessionId: 's3', cwd: '/workspace/my-app-cli' }),
      session({ sessionId: 's4', cwd: '/workspace/my-app/src' }),
      session({ sessionId: 's5', cwd: '/workspace/my-application' }),
    ]
    const folders = ['/workspace/my-app']

    const result = sessionsForWindow(sessions, folders)

    expect(result).toHaveLength(2)
    expect(result.map(s => s.sessionId).sort()).toEqual(['s1', 's4'])
  })
})
