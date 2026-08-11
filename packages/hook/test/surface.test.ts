import { describe, it, expect, vi } from 'vitest'
import {
  detectSurface, detectHostApp, detectSurfaceForHook,
  parsePsOutput, parsePowershellOutput,
  HOP_LIMIT, WALK_DEADLINE_MS, POSIX_HOP_TIMEOUT_MS, WINDOWS_HOP_TIMEOUT_MS,
  type ProcessProbe,
} from '../src/surface.js'

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

  // --- Review round 1, Finding 1 ---
  // The old guard checked `Date.now() >= deadline` *before* starting a hop, which
  // only stops the walk once the deadline has already passed. A hop that starts
  // just before the deadline still ran its own full timeout on top, overshooting
  // by up to one hop's worth of time. `execFileSync` is synchronous and can't be
  // preempted mid-call, so the fix has to refuse to *start* a hop unless it can
  // finish, in its own worst case, before the deadline — proven here with a probe
  // that genuinely busy-waits for the full configured hop timeout on every call
  // (i.e. "always consumes its full timeout"), not a probe that merely returns
  // immediately.
  function slowProbe(delayMs: number): ProcessProbe {
    return pid => {
      const start = Date.now()
      while (Date.now() - start < delayMs) { /* busy-wait: simulate a real, maximally slow probe */ }
      return { ppid: pid + 1, comm: 'bash' } // never matches, forces the walk to keep going
    }
  }

  it('never overshoots the deadline, even when every hop consumes its full configured timeout', () => {
    const hopTimeout = process.platform === 'win32' ? WINDOWS_HOP_TIMEOUT_MS : POSIX_HOP_TIMEOUT_MS
    const probe = vi.fn(slowProbe(hopTimeout))
    const deadline = Date.now() + WALK_DEADLINE_MS

    const app = detectHostApp(probe, deadline)

    expect(app).toBeUndefined()
    // The walk must stop at or before the deadline — not "deadline + one more
    // hop's timeout," which is what the old bug allowed. A few ms of tolerance
    // covers ordinary JS scheduling/Date.now() polling jitter, not a whole hop.
    expect(Date.now()).toBeLessThanOrEqual(deadline + 10)
    // And it must have stopped *early* — the evidence that the new guard fired,
    // not that the walk merely happened to run out of hops on its own.
    expect(probe.mock.calls.length).toBeLessThan(HOP_LIMIT)
  })

  it('warns callers (via this test itself) that omitting the probe spawns a real ps/powershell — always inject in tests', () => {
    // No assertion beyond "doesn't throw": this test exists to document the
    // convention (see detectHostApp's doc comment) that every other test in this
    // file injects a fake probe on purpose. Exercises the real default probe once,
    // deliberately, so a future change to the default parameter is at least
    // caught by *a* test rather than silently spawning `ps` from every other test.
    expect(() => detectHostApp()).not.toThrow()
  })
})

describe('parsePsOutput', () => {
  it('parses a typical `ps -o ppid=,comm=` line (leading-space-padded ppid column)', () => {
    expect(parsePsOutput(' 1234 /Applications/Claude.app/Contents/MacOS/Claude'))
      .toEqual({ ppid: 1234, comm: '/Applications/Claude.app/Contents/MacOS/Claude' })
  })

  it('parses a command name that itself contains spaces', () => {
    expect(parsePsOutput('  5678 Google Chrome Helper (Renderer)'))
      .toEqual({ ppid: 5678, comm: 'Google Chrome Helper (Renderer)' })
  })

  it('parses a bare command name with no path', () => {
    expect(parsePsOutput('   42 bash')).toEqual({ ppid: 42, comm: 'bash' })
  })

  it('returns null (never throws) for empty, whitespace-only, or non-numeric-ppid output', () => {
    expect(parsePsOutput('')).toBeNull()
    expect(parsePsOutput('   ')).toBeNull()
    expect(parsePsOutput('not-a-pid bash')).toBeNull()
  })
})

describe('parsePowershellOutput', () => {
  it('parses the two-line ParentProcessId/Name form', () => {
    expect(parsePowershellOutput('4321\r\nCode.exe\r\n')).toEqual({ ppid: 4321, comm: 'Code.exe' })
  })

  it('tolerates surrounding whitespace and blank lines', () => {
    expect(parsePowershellOutput('\r\n  4321  \r\n\r\n  Claude.exe  \r\n')).toEqual({ ppid: 4321, comm: 'Claude.exe' })
  })

  it('returns null (never throws) when the name line is missing, or output is empty/non-numeric', () => {
    expect(parsePowershellOutput('1234\r\n')).toBeNull()
    expect(parsePowershellOutput('')).toBeNull()
    expect(parsePowershellOutput('not-a-pid\r\nCode.exe\r\n')).toBeNull()
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
