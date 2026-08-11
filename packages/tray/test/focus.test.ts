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
  type FocusSpawner, type ClipboardSurface, type FocusDeps,
} from '../src/focus.js'

const session = (surface: Surface, over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/**
 * A hostile payload carrying every character Phase 1's real PowerShell
 * injection bug involved, PLUS `\r`, `\n`, and a trailing backslash (review
 * round 1, Finding 1's methodology hardening) — a CR, an LF, and a lone
 * trailing `\`. The newline pair is exactly what the round-1 CRITICAL finding
 * exploited: a `#`-comment ends at a line break, not at a string's closing
 * quote, so `wtSession = 'abc\nStart-Process calc.exe #'` used to emit a
 * second, live, executable PowerShell line — a bug invisible to the original
 * HOSTILE constant because it had no newline in it. Every escaper (and every
 * script-builder that interpolates a value) is exercised against this widened
 * payload below, not just the branch that broke.
 */
const HOSTILE = `plain" $(rm -rf /) \`whoami\` ; echo pwned's\r\nStart-Process calc.exe #\\`

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

  // --- Review round 1, Finding 3 ---
  // `tty of t contains "<value>"` substring-matched, so a single-digit tty
  // (or any value that is a substring of a real device path, e.g. "2" inside
  // "/dev/ttys002") could match the WRONG tab and focus it — landing
  // somewhere wrong rather than failing honestly. Both scripts also called
  // `activate` unconditionally BEFORE searching, so the app came forward
  // regardless of whether anything actually matched.
  describe('Finding 3: exact match, not substring; activate only on a real match', () => {
    it('Terminal.app: compares with `is`, never `contains` — a short tty cannot substring-match a longer device path', () => {
      const plan = buildFocusPlan(
        session({ kind: 'terminal', termProgram: 'Apple_Terminal', tty: '2' }), 'darwin', noCommands,
      )
      if (plan.kind !== 'spawn') throw new Error('expected spawn')
      const script = plan.args[1]
      expect(script).toContain('if tty of t is "2"')
      expect(script).not.toContain('contains')
    })

    it('iTerm2: compares with `is`, never `contains`', () => {
      const plan = buildFocusPlan(
        session({ kind: 'terminal', termProgram: 'iTerm.app', tty: '2' }), 'darwin', noCommands,
      )
      if (plan.kind !== 'spawn') throw new Error('expected spawn')
      const script = plan.args[1]
      expect(script).toContain('if tty of sess is "2"')
      expect(script).not.toContain('contains')
    })

    it('Terminal.app: `activate` appears only inside the matched branch, after the search starts — never unconditionally up front', () => {
      const plan = buildFocusPlan(
        session({ kind: 'terminal', termProgram: 'Apple_Terminal', tty: '/dev/ttys002' }), 'darwin', noCommands,
      )
      if (plan.kind !== 'spawn') throw new Error('expected spawn')
      const script = plan.args[1]
      const matchLine = script.indexOf('if tty of t is')
      const activateLine = script.indexOf('activate')
      expect(matchLine).toBeGreaterThan(-1)
      expect(activateLine).toBeGreaterThan(matchLine) // activate is INSIDE the if, not before the search
    })

    it('iTerm2: `activate` appears only inside the matched branch', () => {
      const plan = buildFocusPlan(
        session({ kind: 'terminal', termProgram: 'iTerm.app', tty: '/dev/ttys002' }), 'darwin', noCommands,
      )
      if (plan.kind !== 'spawn') throw new Error('expected spawn')
      const script = plan.args[1]
      const matchLine = script.indexOf('if tty of sess is')
      const activateLine = script.indexOf('activate')
      expect(matchLine).toBeGreaterThan(-1)
      expect(activateLine).toBeGreaterThan(matchLine)
    })

    // "Failing visibly beats landing somewhere wrong": since `activate` no
    // longer fires unconditionally, a non-match must still tell the user
    // something, via the exact clipboard-copy + notification UX every other
    // "nothing to focus" case in this module already uses. `cwd`/`project`
    // are interpolated into this AppleScript for the first time (they never
    // were before this fix) — proven escaped here with the same HOSTILE
    // payload used for `tty`, not a separate assumption.
    it('Terminal.app: the script itself falls back to copying the cwd and notifying when no tab matches, with cwd/reason escaped', () => {
      const plan = buildFocusPlan(
        session({ kind: 'terminal', termProgram: 'Apple_Terminal', tty: '/dev/ttys002' }, { cwd: HOSTILE, project: HOSTILE }),
        'darwin', noCommands,
      )
      if (plan.kind !== 'spawn') throw new Error('expected spawn')
      const script = plan.args[1]
      expect(script).toContain('if not matched then')
      expect(script).toContain('set the clipboard to')
      expect(script).toContain('display notification')
      expect(script).toContain(escapeAppleScriptString(HOSTILE))
      expect(script).not.toContain(HOSTILE)
    })

    it('iTerm2: the script itself falls back to copying the cwd and notifying when no tab matches, with cwd/reason escaped', () => {
      const plan = buildFocusPlan(
        session({ kind: 'terminal', termProgram: 'iTerm.app', tty: '/dev/ttys002' }, { cwd: HOSTILE, project: HOSTILE }),
        'darwin', noCommands,
      )
      if (plan.kind !== 'spawn') throw new Error('expected spawn')
      const script = plan.args[1]
      expect(script).toContain('if not matched then')
      expect(script).toContain('set the clipboard to')
      expect(script).toContain('display notification')
      expect(script).toContain(escapeAppleScriptString(HOSTILE))
      expect(script).not.toContain(HOSTILE)
    })
  })
})

describe('buildFocusPlan: Windows Terminal — focus by process + WT_SESSION', () => {
  // --- Review round 1, Finding 1 (CRITICAL) ---
  // wtSession used to be interpolated into a `#`-comment line, escaped with
  // `escapePowerShellSingleQuoted` — an escaper whose contract only covers a
  // value INSIDE a single-quoted string literal, not a comment. A `#`
  // comment ends at the line break, not the string's closing quote, so
  // `wtSession = "abc\nStart-Process calc.exe #"` (exactly HOSTILE's
  // shape, post-hardening) emitted a second, live, executable PowerShell
  // line. Fixed by no longer interpolating wtSession into the script at all
  // — proven below by a fixed, wtSession-INDEPENDENT expected script, not
  // merely "the raw payload doesn't appear verbatim" (which the injection
  // payload never did even before the fix — it was the ESCAPED form that
  // broke out of the comment).
  it('win32 with a recorded wtSession: builds a PowerShell script with NO wtSession interpolation at all (Finding 1)', () => {
    const plan = buildFocusPlan(
      session({ kind: 'terminal', wtSession: HOSTILE }), 'win32', noCommands,
    )
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    expect(plan.cmd).toBe('powershell')
    const script = plan.args.join('\n')
    expect(script).toContain('AppActivate')
    expect(script).toContain('WindowsTerminal')
    // Neither the raw payload NOR its escaped form appears anywhere — the
    // script is byte-for-byte the same regardless of wtSession's value.
    expect(script).not.toContain(HOSTILE)
    expect(script).not.toContain(escapePowerShellSingleQuoted(HOSTILE))
    // The sharpest form of the proof: the script for a hostile wtSession is
    // IDENTICAL to the script for a boring one — wtSession has zero
    // influence over the emitted text.
    const boringPlan = buildFocusPlan(session({ kind: 'terminal', wtSession: 'w-1' }), 'win32', noCommands)
    if (boringPlan.kind !== 'spawn') throw new Error('expected spawn')
    expect(script).toBe(boringPlan.args.join('\n'))
  })

  // The concrete exploit the finding described: a newline followed by a live
  // PowerShell statement, disguised as trailing a `#` comment. Reproduced
  // directly (not just via the shared HOSTILE constant) so the regression
  // this fix closes is unambiguous on its own.
  it('a wtSession crafted as a comment-breakout payload cannot inject a second executable line (Finding 1 regression)', () => {
    const payload = 'abc\nStart-Process calc.exe #'
    const plan = buildFocusPlan(session({ kind: 'terminal', wtSession: payload }), 'win32', noCommands)
    if (plan.kind !== 'spawn') throw new Error('expected spawn')
    const script = plan.args[2] // the -Command script itself, not the whole argv
    expect(script).not.toContain('Start-Process')
    expect(script.split('\n')).toHaveLength(2) // exactly the two fixed lines below — nothing wtSession-derived
    expect(script).toBe([
      "$p = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue | Select-Object -First 1",
      'if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) }',
    ].join('\n'))
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
  // --- Review round 1, Finding 2 ---
  // The old version of this test called focusSession() four times and
  // contained ZERO `expect(...)` calls — it could not fail no matter what
  // FocusDeps looked like, so it protected nothing while appearing to. Its
  // own comment claimed a `@ts-expect-error` check "below" as a second,
  // stronger proof that never actually existed anywhere in the file. The
  // structural claim itself is true (FocusDeps at focus.ts:330-337 has no
  // `send`/ClientMessage field) — this replaces the vacuous test with the
  // real compile-time guard the old comment only claimed to have.
  //
  // Verified by temporarily adding `send?: (msg: unknown) => void` to
  // `FocusDeps` in focus.ts and re-running `tsc --build`: with `send` added,
  // this line's `@ts-expect-error` correctly reports "Unused '@ts-expect-error'
  // directive" (the object literal below no longer errors, because `send` is
  // now a real, accepted key) — proving the check actually exercises
  // FocusDeps's shape rather than passing vacuously. Reverted immediately
  // after confirming that; `tsc --build` is clean again with FocusDeps back
  // to its real shape. See the task report for the exact transcript.
  it('FocusDeps structurally cannot accept a `send`/ClientMessage field — enforced at compile time', () => {
    // @ts-expect-error `send` is not a key of FocusDeps — if this stops
    // erroring, FocusDeps grew exactly the field the class doc above (see
    // focusSession's "Critical rule") says it must never have, and
    // `tsc --build` fails on this file until it's removed again.
    const deps: FocusDeps = { send: (_msg: unknown) => {} }
    // Reached only if TS's excess-property check somehow didn't fire —
    // keeps this a real, runnable test rather than type-only dead code.
    expect(typeof deps).toBe('object')
  })

  it('exhaustively runs focusSession across every surface with no way to pass anything resolve-shaped', async () => {
    const { spawner, calls } = makeSpawner()
    const { clipboard, written } = makeClipboard()
    // If FocusDeps ever grows a `send`/ClientMessage field, this call site
    // would need updating to pass it — its continued absence here, across
    // every surface below, is the runtime half of the proof (the compile-time
    // half is the `@ts-expect-error` test above). Also checks that nothing
    // spawned or written even incidentally resembles a resolve/ack payload.
    await focusSession(session({ kind: 'vscode' }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    await focusSession(session({ kind: 'desktop', app: { name: 'Claude' } }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    await focusSession(session({ kind: 'terminal', tty: '2' }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    await focusSession(session({ kind: 'unknown' }), { spawner, clipboard, notify: vi.fn(), platform: 'darwin' })
    for (const call of calls) expect(JSON.stringify(call)).not.toContain('resolve')
    for (const text of written) expect(text).not.toContain('resolve')
  })
})
