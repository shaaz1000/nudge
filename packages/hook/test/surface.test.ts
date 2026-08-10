import { describe, it, expect, vi } from 'vitest'
import { detectSurface, detectHostApp, detectSurfaceForHook } from '../src/surface.js'

describe('detectSurface', () => {
  it('identifies VSCode from TERM_PROGRAM', () => {
    const s = detectSurface({ TERM_PROGRAM: 'vscode', TERM_SESSION_ID: 'abc' })
    expect(s.kind).toBe('vscode')
    expect(s.termProgram).toBe('vscode')
    expect(s.termSessionId).toBe('abc')
  })

  it('identifies Cursor and Windsurf', () => {
    expect(detectSurface({ TERM_PROGRAM: 'cursor' }).kind).toBe('cursor')
    expect(detectSurface({ TERM_PROGRAM: 'windsurf' }).kind).toBe('windsurf')
  })

  it('identifies a macOS terminal', () => {
    expect(detectSurface({ TERM_PROGRAM: 'iTerm.app' }).kind).toBe('terminal')
    expect(detectSurface({ TERM_PROGRAM: 'Apple_Terminal' }).kind).toBe('terminal')
  })

  it('identifies Windows Terminal and records its session', () => {
    const s = detectSurface({ WT_SESSION: 'w-1' })
    expect(s.kind).toBe('terminal')
    expect(s.wtSession).toBe('w-1')
  })

  it('flags tmux', () => {
    expect(detectSurface({ TMUX: '/tmp/tmux-501/default,1,0' }).tmux).toBe(true)
  })

  it('falls back to unknown with no signals', () => {
    expect(detectSurface({}).kind).toBe('unknown')
  })

  it('is case-insensitive about TERM_PROGRAM', () => {
    expect(detectSurface({ TERM_PROGRAM: 'VSCode' }).kind).toBe('vscode')
  })
})

// --- Amendment: host-app detection via a bounded, injectable parent-process walk ---

describe('detectHostApp', () => {
  it('returns undefined rather than throwing when the probe command is missing or times out', () => {
    const probe = vi.fn(() => { throw new Error('ENOENT: ps not found') })
    expect(() => detectHostApp(probe)).not.toThrow()
    expect(detectHostApp(probe)).toBeUndefined()
  })

  it('finds a host app within the hop limit and reports its pid', () => {
    const chain: Record<number, { ppid: number; comm: string }> = {
      [process.ppid]: { ppid: 2000, comm: 'bash' },
      2000: { ppid: 3000, comm: '/Applications/Claude.app/Contents/MacOS/Claude' },
    }
    const probe = vi.fn((pid: number) => chain[pid] ?? null)
    const app = detectHostApp(probe)
    expect(app).toEqual({ name: 'Claude', path: '/Applications/Claude.app/Contents/MacOS/Claude', pid: 2000 })
  })

  it('bounds the walk to at most 5 hops when nothing ever matches', () => {
    const probe = vi.fn((pid: number) => ({ ppid: pid + 1, comm: 'bash' }))
    const app = detectHostApp(probe)
    expect(app).toBeUndefined()
    expect(probe.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('stops immediately (no match) once the probe reports pid 1 / no such process', () => {
    const probe = vi.fn(() => null)
    expect(detectHostApp(probe)).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('detectSurfaceForHook', () => {
  it('never invokes the process-probe walk for a hook other than SessionStart', () => {
    const probe = vi.fn()
    const s = detectSurfaceForHook('PreToolUse', {}, probe)
    expect(probe).not.toHaveBeenCalled()
    expect(s.kind).toBe('unknown')
  })

  it('invokes the walk only for SessionStart', () => {
    const probe = vi.fn(() => null)
    detectSurfaceForHook('SessionStart', {}, probe)
    expect(probe).toHaveBeenCalled()
  })

  it('lets an env-var match take precedence over a process-walk match, but still records the app', () => {
    const probe = vi.fn(() => ({ ppid: 1, comm: '/Applications/Claude.app/Contents/MacOS/Claude' }))
    const s = detectSurfaceForHook('SessionStart', { TERM_PROGRAM: 'vscode' }, probe)
    expect(s.kind).toBe('vscode')
    expect(s.app?.name).toBe('Claude')
  })

  it('falls back to the process-walk kind only when the env vars left it unknown', () => {
    const probe = vi.fn(() => ({ ppid: 1, comm: '/Applications/Claude.app/Contents/MacOS/Claude' }))
    const s = detectSurfaceForHook('SessionStart', {}, probe)
    expect(s.kind).toBe('desktop')
    expect(s.app?.name).toBe('Claude')
  })
})
