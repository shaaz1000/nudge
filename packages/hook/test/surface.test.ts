import { describe, it, expect, vi } from 'vitest'
import {
  detectSurface, detectHostApp, detectSurfaceForHook, isAgentBinary,
  parsePsOutput, parsePowershellOutput,
  parseTtyOutput, detectTtyPath,
  HOP_LIMIT, WALK_DEADLINE_MS, POSIX_HOP_TIMEOUT_MS, WINDOWS_HOP_TIMEOUT_MS,
  type ProcessProbe, type TtyProbe,
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

// --- Review round 1, Finding 4 (USER-APPROVED) ---
// detectSurface() used to store `String(process.stderr.fd)` in `surface.tty` — the
// literal "2" (a constant, not a device path — fd 2 is always stderr). This is the
// replacement: a real `ps -o tty=`-backed probe, gated to SessionStart, POSIX-only,
// never throwing. See surface.ts's own "Amendment" doc above detectTtyPath for the
// full investigation (why /proc doesn't exist on darwin, why isTTY on fd 2 is not
// the right signal, and the empirical proof that `ps -o tty=` reports the SESSION
// controlling terminal correctly even with piped stdio).
describe('parseTtyOutput', () => {
  it('prefixes a real device name with /dev/, matching what AppleScript\'s `tty of t` reports', () => {
    expect(parseTtyOutput('ttys002')).toBe('/dev/ttys002')
  })

  it('tolerates surrounding whitespace (ps pads its column output)', () => {
    expect(parseTtyOutput('  ttys002  \n')).toBe('/dev/ttys002')
  })

  it('parses a Linux-shaped pty name the same way', () => {
    expect(parseTtyOutput('pts/0')).toBe('/dev/pts/0')
  })

  it('returns undefined (never throws) for "no controlling terminal" (`?`/`??`) or empty output', () => {
    expect(parseTtyOutput('??')).toBeUndefined()
    expect(parseTtyOutput('?')).toBeUndefined()
    expect(parseTtyOutput('')).toBeUndefined()
    expect(parseTtyOutput('   ')).toBeUndefined()
  })
})

describe('detectTtyPath', () => {
  it('returns the parsed device path from an injected probe', () => {
    const probe: TtyProbe = () => 'ttys003'
    expect(detectTtyPath(123, probe)).toBe('/dev/ttys003')
  })

  it('returns undefined when the probe reports no controlling terminal', () => {
    const probe: TtyProbe = () => '??'
    expect(detectTtyPath(123, probe)).toBeUndefined()
  })

  it('returns undefined rather than throwing when the probe throws (missing ps, timeout, etc.)', () => {
    const probe: TtyProbe = () => { throw new Error('ENOENT: ps not found') }
    expect(() => detectTtyPath(123, probe)).not.toThrow()
    expect(detectTtyPath(123, probe)).toBeUndefined()
  })

  it('returns undefined rather than throwing when the probe returns null', () => {
    const probe: TtyProbe = () => null
    expect(detectTtyPath(123, probe)).toBeUndefined()
  })

  it('never calls the probe on win32 — there is no POSIX `ps`, and nothing reads surface.tty there anyway', () => {
    const probe = vi.fn((_pid: number): string | null => 'ttys000')
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(detectTtyPath(123, probe)).toBeUndefined()
      expect(probe).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  // Same "refuse to start unless it can finish in time" rule detectHostApp's walk
  // uses (review round 1 of an earlier task) — sized for a single call rather than
  // a loop, so unlike the walk it cannot overshoot by more than one hop's timeout
  // even without this guard, but the guard still means it never even tries.
  it('never calls the probe once the deadline cannot be met', () => {
    const probe = vi.fn((_pid: number): string | null => 'ttys000')
    expect(detectTtyPath(123, probe, Date.now() - 1)).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })

  it('warns callers (via this test itself) that omitting the probe spawns a real ps — always inject in tests', () => {
    // Mirrors detectHostApp's identical documented convention just above.
    expect(() => detectTtyPath()).not.toThrow()
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
    detectSurfaceForHook('SessionStart', {}, probe, undefined, () => null)
    expect(probe).toHaveBeenCalled()
  })

  it('lets an env-var match take precedence over a process-walk match, but still records the app', () => {
    const probe = vi.fn(() => ({ ppid: 1, comm: '/Applications/Claude.app/Contents/MacOS/Claude' }))
    const s = detectSurfaceForHook('SessionStart', { TERM_PROGRAM: 'vscode' }, probe, undefined, () => null)
    expect(s.kind).toBe('vscode')
    expect(s.app?.name).toBe('Claude')
  })

  it('falls back to the process-walk kind only when the env vars left it unknown', () => {
    const probe = vi.fn(() => ({ ppid: 1, comm: '/Applications/Claude.app/Contents/MacOS/Claude' }))
    const s = detectSurfaceForHook('SessionStart', {}, probe, undefined, () => null)
    expect(s.kind).toBe('desktop')
    expect(s.app?.name).toBe('Claude')
  })

  describe('tty wiring (Finding 4)', () => {
    it('never invokes the tty probe for a hook other than SessionStart', () => {
      const ttyProbe = vi.fn((_pid: number): string | null => 'ttys000')
      const s = detectSurfaceForHook('PreToolUse', {}, () => null, undefined, ttyProbe)
      expect(ttyProbe).not.toHaveBeenCalled()
      expect(s.tty).toBeUndefined()
    })

    it('records a real device path on SessionStart when the tty probe finds one', () => {
      const s = detectSurfaceForHook('SessionStart', {}, () => null, undefined, () => 'ttys004')
      expect(s.tty).toBe('/dev/ttys004')
    })

    it('leaves tty absent (not a misleading fallback value) when the tty probe finds no controlling terminal', () => {
      const s = detectSurfaceForHook('SessionStart', {}, () => null, undefined, () => '??')
      expect(s.tty).toBeUndefined()
    })

    it('a throwing tty probe does not prevent the rest of surface detection (env vars, host-app walk) from completing', () => {
      const probe = vi.fn(() => ({ ppid: 1, comm: '/Applications/Claude.app/Contents/MacOS/Claude' }))
      const ttyProbe: TtyProbe = () => { throw new Error('ENOENT') }
      const s = detectSurfaceForHook('SessionStart', {}, probe, undefined, ttyProbe)
      expect(s.tty).toBeUndefined()
      expect(s.app?.name).toBe('Claude')
    })
  })
})

describe('the host-app walk must not stop on Claude Code itself', () => {
  /**
   * Reported from real use: a session started from the VS Code extension was
   * recorded as `kind: 'desktop'`, so clicking the notification opened the
   * Claude DESKTOP app while the user was working in VS Code.
   *
   * This is the actual chain, copied from the machine it happened on:
   *
   *   .../.vscode/extensions/anthropic.claude-code-2.1.220-darwin-arm64/
   *       resources/native-binary/claude
   *     <- Code Helper (Plugin)
   *       <- /Applications/Visual Studio Code.app/Contents/MacOS/Code
   *
   * HOST_APP_PATTERN matched "claude" on the FIRST hop — the agent's own
   * binary — and never reached VS Code. Every existing test passed because no
   * fake probe had ever included the agent's own process in the chain: the
   * fixtures started one level too high.
   */
  const VSCODE_CHAIN: Record<number, { comm: string; ppid: number }> = {
    10: { comm: '/Users/x/.vscode/extensions/anthropic.claude-code-2.1.220-darwin-arm64/resources/native-binary/claude', ppid: 11 },
    11: { comm: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', ppid: 12 },
    12: { comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Code', ppid: 1 },
  }
  const chainProbe = (chain: Record<number, { comm: string; ppid: number }>): ProcessProbe =>
    (pid: number) => chain[pid]

  it('walks PAST the extension-bundled claude binary to the editor hosting it', () => {
    const original = process.ppid
    Object.defineProperty(process, 'ppid', { value: 10, configurable: true })
    try {
      const app = detectHostApp(chainProbe(VSCODE_CHAIN))
      expect(app?.name).not.toBe('claude')
      expect(app?.path).toMatch(/Visual Studio Code/)
    } finally {
      Object.defineProperty(process, 'ppid', { value: original, configurable: true })
    }
  })

  it('still identifies the REAL Claude desktop app, which lives in an .app bundle', () => {
    const chain = {
      10: { comm: '/Applications/Claude.app/Contents/MacOS/Claude', ppid: 1 },
    }
    const original = process.ppid
    Object.defineProperty(process, 'ppid', { value: 10, configurable: true })
    try {
      const app = detectHostApp(chainProbe(chain))
      expect(app?.name).toBe('Claude')
      expect(app?.path).toMatch(/Claude\.app/)
    } finally {
      Object.defineProperty(process, 'ppid', { value: original, configurable: true })
    }
  })
})

describe('isAgentBinary', () => {
  it('treats the extension-bundled CLI as the agent, not a host app', () => {
    expect(isAgentBinary('/Users/x/.vscode/extensions/anthropic.claude-code-2.1.220-darwin-arm64/resources/native-binary/claude')).toBe(true)
  })

  it('treats a bare `claude` on PATH as the agent', () => {
    expect(isAgentBinary('claude')).toBe(true)
    expect(isAgentBinary('/opt/homebrew/bin/claude')).toBe(true)
  })

  it('does NOT treat the real desktop app bundle as the agent', () => {
    expect(isAgentBinary('/Applications/Claude.app/Contents/MacOS/Claude')).toBe(false)
  })

  it('leaves every other host application alone', () => {
    expect(isAgentBinary('/Applications/Visual Studio Code.app/Contents/MacOS/Code')).toBe(false)
    expect(isAgentBinary('Cursor')).toBe(false)
    expect(isAgentBinary('windsurf')).toBe(false)
  })
})
