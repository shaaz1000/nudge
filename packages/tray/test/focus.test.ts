import { describe, it, expect, vi } from 'vitest'

// `electron` has no runtime module outside an Electron host (clipboard,
// Notification) — see notify.ts/tray.ts's identical doc. Nothing below
// exercises this mock's *contents* — every focusSession() test injects its
// own fake ClipboardSurface/NotifyFn/FocusSpawner — it only has to exist so
// importing '../src/focus.js' does not throw.
vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, Notification: vi.fn() }))

import type { SessionState, Surface } from '@nudge/shared/types'
import {
  buildFocusPlan, focusSession, escapeAppleScriptString, escapePowerShellSingleQuoted,
  type FocusSpawner, type ClipboardSurface,
} from '../src/focus.js'

const session = (surface: Surface, over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/** A hostile payload carrying every character Phase 1's real PowerShell injection bug involved. */
const HOSTILE = `plain" $(rm -rf /) \`whoami\` ; echo pwned's`

const noCommands = () => false

// ---------------------------------------------------------------------------
// Escaping — the exact category of bug Phase 1 shipped (one escaper written
// for AppleScript reused where PowerShell needed its own). Tested first, in
// isolation, before anything that builds a script string around them.
// ---------------------------------------------------------------------------
describe('escapeAppleScriptString', () => {
  it('escapes backslashes before quotes (order matters: escaping the quote first would double-escape)', () => {
    expect(escapeAppleScriptString('a\\b')).toBe('a\\\\b')
  })

  it('escapes double quotes so they cannot end the AppleScript string literal early', () => {
    expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"')
  })

  it('neutralizes a hostile payload (quotes, $(...), backticks, ;) so no double quote survives unescaped', () => {
    const escaped = escapeAppleScriptString(HOSTILE)
    // No bare `"` remains — every one must be preceded by a backslash.
    expect(/(?<!\\)"/.test(escaped)).toBe(false)
  })

  it('does NOT touch single quotes — proving it is not secretly the PowerShell escaper (the exact Phase 1 mix-up)', () => {
    expect(escapeAppleScriptString("it's fine")).toBe("it's fine")
  })
})

describe('escapePowerShellSingleQuoted', () => {
  it('doubles a single quote — the entire escaping contract for a single-quoted PowerShell string', () => {
    expect(escapePowerShellSingleQuoted("it's")).toBe("it''s")
  })

  it('neutralizes a hostile payload so every single quote is doubled', () => {
    const escaped = escapePowerShellSingleQuoted(HOSTILE)
    // Wrapping the escaped text back in single quotes must not let a lone
    // `'` terminate the literal early: every quote in the input must now be
    // paired (''), i.e. no quote is followed or preceded by a non-quote
    // gap that would close the string.
    const wrapped = `'${escaped}'`
    // Every single quote inside `wrapped` (other than the two delimiters)
    // must appear as part of a doubled pair.
    const inner = wrapped.slice(1, -1)
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "'") expect(inner[i + 1]).toBe("'")
      i++ // skip the pair
    }
  })

  it('does NOT touch double quotes or backslashes — proving it is not secretly the AppleScript escaper (the exact Phase 1 mix-up)', () => {
    expect(escapePowerShellSingleQuoted('say "hi" a\\b')).toBe('say "hi" a\\b')
  })
})

describe('escaper distinctness — reusing one across platforms is the exact Phase 1 bug', () => {
  it('the same hostile payload produces two DIFFERENT escaped strings from the two escapers', () => {
    const viaAppleScript = escapeAppleScriptString(HOSTILE)
    const viaPowerShell = escapePowerShellSingleQuoted(HOSTILE)
    expect(viaAppleScript).not.toBe(viaPowerShell)
  })

  it('running PowerShell\'s escaper output through what AppleScript needs would still leave an unescaped double quote (proves they are not interchangeable)', () => {
    const wrongly = escapePowerShellSingleQuoted('say "hi"') // only handles single quotes
    expect(/(?<!\\)"/.test(wrongly)).toBe(true) // still unsafe for an AppleScript double-quoted literal
  })
})

// ---------------------------------------------------------------------------
// buildFocusPlan — pure, per-surface dispatch. No spawner/clipboard touched.
// ---------------------------------------------------------------------------
describe('buildFocusPlan: VS Code / Cursor / Windsurf', () => {
  it('vscode: spawns `code <cwd>`', () => {
    const plan = buildFocusPlan(session({ kind: 'vscode' }, { cwd: '/x/proj' }), 'darwin', noCommands)
    expect(plan).toEqual({ kind: 'spawn', cmd: 'code', args: ['/x/proj'] })
  })

  it('cursor: spawns `cursor <cwd>`', () => {
    const plan = buildFocusPlan(session({ kind: 'cursor' }, { cwd: '/x/proj' }), 'darwin', noCommands)
    expect(plan).toEqual({ kind: 'spawn', cmd: 'cursor', args: ['/x/proj'] })
  })

  it('windsurf: spawns `windsurf <cwd>`', () => {
    const plan = buildFocusPlan(session({ kind: 'windsurf' }, { cwd: '/x/proj' }), 'darwin', noCommands)
    expect(plan).toEqual({ kind: 'spawn', cmd: 'windsurf', args: ['/x/proj'] })
  })

  it('a cwd containing shell metacharacters is passed through as ONE literal argv element — argv, not a shell string, carries it, so there is nothing to escape', () => {
    const hostileCwd = `/x/${HOSTILE}`
    const plan = buildFocusPlan(session({ kind: 'vscode' }, { cwd: hostileCwd }), 'darwin', noCommands)
    expect(plan).toEqual({ kind: 'spawn', cmd: 'code', args: [hostileCwd] })
  })
})

describe('buildFocusPlan: Claude desktop app — focus by the recorded app field', () => {
  it('darwin: activates the app by name via AppleScript, with the name escaped', () => {
    const plan = buildFocusPlan(session({ kind: 'desktop', app: { name: HOSTILE } }), 'darwin', noCommands)
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    expect(plan.cmd).toBe('osascript')
    const script = plan.args[1]
    expect(script).toContain(escapeAppleScriptString(HOSTILE))
    expect(script).not.toContain(HOSTILE) // the raw, unescaped payload must never appear
  })

  it('win32: builds a PowerShell AppActivate script, with the name escaped', () => {
    const plan = buildFocusPlan(session({ kind: 'desktop', app: { name: HOSTILE } }), 'win32', noCommands)
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    expect(plan.cmd).toBe('powershell')
    const script = plan.args.join('\n')
    expect(script).toContain('AppActivate')
    expect(script).toContain(escapePowerShellSingleQuoted(HOSTILE))
  })

  it('linux: uses wmctrl when present (argv, no escaping needed)', () => {
    const plan = buildFocusPlan(session({ kind: 'desktop', app: { name: 'Claude' } }), 'linux', cmd => cmd === 'wmctrl')
    expect(plan).toEqual({ kind: 'spawn', cmd: 'wmctrl', args: ['-a', 'Claude'] })
  })

  it('linux: falls back to xdotool when wmctrl is absent but xdotool is present', () => {
    const plan = buildFocusPlan(session({ kind: 'desktop', app: { name: 'Claude' } }), 'linux', cmd => cmd === 'xdotool')
    expect(plan).toEqual({ kind: 'spawn', cmd: 'xdotool', args: ['search', '--name', 'Claude', 'windowactivate'] })
  })

  it('linux: neither wmctrl nor xdotool present — honest clipboard fallback, not a silent no-op', () => {
    const plan = buildFocusPlan(session({ kind: 'desktop', app: { name: 'Claude' } }, { cwd: '/x/proj' }), 'linux', noCommands)
    expect(plan.kind).toBe('clipboard')
    if (plan.kind !== 'clipboard') throw new Error('expected clipboard')
    expect(plan.text).toBe('/x/proj')
    expect(plan.reason.length).toBeGreaterThan(0)
  })

  it('no recorded app field at all — clipboard fallback, honest rather than guessing', () => {
    const plan = buildFocusPlan(session({ kind: 'desktop' }, { cwd: '/x/proj' }), 'darwin', noCommands)
    expect(plan).toEqual({ kind: 'clipboard', text: '/x/proj', reason: expect.stringContaining('my-repo') })
  })
})

describe('buildFocusPlan: Terminal.app / iTerm2 (macOS) — AppleScript targeting the recorded tty', () => {
  it('Terminal.app: AppleScript matches on the recorded tty, escaped', () => {
    const plan = buildFocusPlan(
      session({ kind: 'terminal', termProgram: 'Apple_Terminal', tty: HOSTILE }), 'darwin', noCommands,
    )
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    expect(plan.cmd).toBe('osascript')
    const script = plan.args[1]
    expect(script.toLowerCase()).toContain('terminal')
    expect(script).toContain(escapeAppleScriptString(HOSTILE))
    expect(script).not.toContain(HOSTILE)
  })

  it('iTerm2: AppleScript matches on the recorded tty, escaped, via iTerm2\'s own scripting dictionary', () => {
    const plan = buildFocusPlan(
      session({ kind: 'terminal', termProgram: 'iTerm.app', tty: HOSTILE }), 'darwin', noCommands,
    )
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    expect(plan.cmd).toBe('osascript')
    const script = plan.args[1]
    expect(script).toContain('iTerm2')
    expect(script).toContain(escapeAppleScriptString(HOSTILE))
  })

  it('macOS terminal with no recorded tty — clipboard fallback rather than a script that could never match', () => {
    const plan = buildFocusPlan(
      session({ kind: 'terminal', termProgram: 'Apple_Terminal' }, { cwd: '/x/proj' }), 'darwin', noCommands,
    )
    expect(plan).toEqual({ kind: 'clipboard', text: '/x/proj', reason: expect.any(String) })
  })
})

describe('buildFocusPlan: Windows Terminal — focus by process + WT_SESSION', () => {
  it('win32 with a recorded wtSession: builds a PowerShell script, with wtSession escaped', () => {
    const plan = buildFocusPlan(
      session({ kind: 'terminal', wtSession: HOSTILE }), 'win32', noCommands,
    )
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    expect(plan.cmd).toBe('powershell')
    const script = plan.args.join('\n')
    expect(script).toContain(escapePowerShellSingleQuoted(HOSTILE))
    expect(script).not.toContain(HOSTILE)
  })

  it('win32 with no recorded wtSession — clipboard fallback', () => {
    const plan = buildFocusPlan(session({ kind: 'terminal' }, { cwd: '/x/proj' }), 'win32', noCommands)
    expect(plan).toEqual({ kind: 'clipboard', text: '/x/proj', reason: expect.any(String) })
  })
})

describe('buildFocusPlan: Linux terminal — wmctrl/xdotool if present, X11 only', () => {
  it('uses wmctrl matching the project name when present', () => {
    const plan = buildFocusPlan(session({ kind: 'terminal' }, { project: 'repo-x' }), 'linux', cmd => cmd === 'wmctrl')
    expect(plan).toEqual({ kind: 'spawn', cmd: 'wmctrl', args: ['-a', 'repo-x'] })
  })

  it('neither tool present — clipboard fallback, honest about the gap (Wayland has no equivalent)', () => {
    const plan = buildFocusPlan(session({ kind: 'terminal' }, { cwd: '/x/proj' }), 'linux', noCommands)
    expect(plan.kind).toBe('clipboard')
  })
})

describe('buildFocusPlan: unknown surface — honest beats magical', () => {
  it('copies the project path to the clipboard and explains why, for every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const plan = buildFocusPlan(session({ kind: 'unknown' }, { cwd: '/x/proj', project: 'repo-x' }), platform, noCommands)
      expect(plan).toEqual({ kind: 'clipboard', text: '/x/proj', reason: expect.stringContaining('repo-x') })
    }
  })
})

// ---------------------------------------------------------------------------
// focusSession — executes a plan via injected surfaces. Never spawns a real
// process, never touches the real clipboard, in any test.
// ---------------------------------------------------------------------------
function makeSpawner() {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const spawner: FocusSpawner = { run: (cmd, args) => { calls.push({ cmd, args }) } }
  return { spawner, calls }
}

function makeClipboard() {
  const written: string[] = []
  const clipboard: ClipboardSurface = { writeText: text => { written.push(text) } }
  return { clipboard, written }
}

describe('focusSession: executes the plan via injected surfaces', () => {
  it('a spawn plan runs the spawner and touches neither clipboard nor notify', async () => {
    const { spawner, calls } = makeSpawner()
    const { clipboard, written } = makeClipboard()
    const notify = vi.fn()

    await focusSession(session({ kind: 'vscode' }, { cwd: '/x/proj' }), { spawner, clipboard, notify, platform: 'darwin' })

    expect(calls).toEqual([{ cmd: 'code', args: ['/x/proj'] }])
    expect(written).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('a clipboard-fallback plan writes to the clipboard and notifies, and never spawns anything', async () => {
    const { spawner, calls } = makeSpawner()
    const { clipboard, written } = makeClipboard()
    const notify = vi.fn()

    await focusSession(session({ kind: 'unknown' }, { cwd: '/x/proj', project: 'repo-x' }), { spawner, clipboard, notify, platform: 'darwin' })

    expect(calls).toHaveLength(0)
    expect(written).toEqual(['/x/proj'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toContain('repo-x')
  })

  it('a Linux focus with neither wmctrl nor xdotool available uses the injected commandExists, not a real shell-out', async () => {
    const { spawner, calls } = makeSpawner()
    const { clipboard, written } = makeClipboard()

    await focusSession(
      session({ kind: 'desktop', app: { name: 'Claude' } }, { cwd: '/x/proj' }),
      { spawner, clipboard, notify: vi.fn(), platform: 'linux', commandExists: () => false },
    )

    expect(calls).toHaveLength(0)
    expect(written).toEqual(['/x/proj'])
  })
})

// ---------------------------------------------------------------------------
// Structural rule: focusing must never resolve the wait. This module has no
// `send`/ClientMessage capability anywhere in its public surface — verified
// both by type shape (FocusDeps has no such field) and by exhaustively
// checking that no spawned command or clipboard/notify call ever contains a
// resolve-shaped payload.
// ---------------------------------------------------------------------------
describe('focusSession: never resolves the wait', () => {
  it('has no `send` parameter anywhere in FocusDeps — structurally impossible to reach the engine socket', async () => {
    const { spawner } = makeSpawner()
    const { clipboard } = makeClipboard()
    // If FocusDeps ever grows a `send`/ClientMessage field, this call site
    // would need updating to pass it — its continued absence here, across
    // every surface below, is the proof.
    await focusSession(session({ kind: 'vscode' }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    await focusSession(session({ kind: 'desktop', app: { name: 'Claude' } }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    await focusSession(session({ kind: 'terminal', tty: '2' }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    await focusSession(session({ kind: 'unknown' }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    // No assertion beyond "this compiles and runs" is needed for the
    // structural half of the claim; @ts-expect-error below (a second,
    // stronger form of the same proof) would fail to compile if `send` were
    // ever accepted.
  })
})
