import { describe, it, expect } from 'vitest'
import { DesktopNotifier, notifyCommand, soundCommand } from '../src/desktop.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { SessionState } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'Sales-Dashboard', cwd: '/a/Sales-Dashboard',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 0, turnStartedAt: null, lastEventAt: 0,
  message: 'Allow Bash(ls)?', snoozedUntil: null, pushFailed: false, ...over,
})

/** A payload exercising every PowerShell/AppleScript metacharacter of concern at once. */
const NASTY = 'in "quotes" $(calc) x\' ; Remove-Item -Recurse C:\\temp #'

/**
 * Mimics real PowerShell single-quoted string parsing: scans from the opening
 * quote at `openIdx` and returns the decoded value plus the index of the
 * closing quote. `''` inside the literal decodes to one literal `'`; a `'`
 * NOT followed by another `'` closes the string. This is independent of
 * desktop.ts — it re-derives what a PowerShell parser would actually see,
 * so it proves the escaping is safe rather than just mirroring the
 * implementation's own escape function back at itself.
 */
function psDecodeSingleQuoted(s: string, openIdx: number): { value: string; endIdx: number } {
  if (s[openIdx] !== "'") throw new Error(`expected opening quote at ${openIdx}, got ${JSON.stringify(s[openIdx])}`)
  let i = openIdx + 1
  let value = ''
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { value += "'"; i += 2; continue }
      return { value, endIdx: i }
    }
    value += s[i]
    i += 1
  }
  throw new Error('unterminated PowerShell single-quoted string')
}

/**
 * Mimics real AppleScript double-quoted string parsing: `\\` -> `\`,
 * `\"` -> `"`, everything else literal, until an unescaped `"` closes it.
 * Independent of desktop.ts for the same reason as psDecodeSingleQuoted.
 */
function asDecodeDoubleQuoted(s: string, openIdx: number): { value: string; endIdx: number } {
  if (s[openIdx] !== '"') throw new Error(`expected opening quote at ${openIdx}, got ${JSON.stringify(s[openIdx])}`)
  let i = openIdx + 1
  let value = ''
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      const next = s[i + 1]
      if (next === '\\' || next === '"') { value += next; i += 2; continue }
      value += c; i += 1; continue
    }
    if (c === '"') return { value, endIdx: i }
    value += c
    i += 1
  }
  throw new Error('unterminated AppleScript double-quoted string')
}

describe('notifyCommand', () => {
  it('uses osascript on darwin', () => {
    const c = notifyCommand('darwin', 'T', 'B')!
    expect(c.cmd).toBe('osascript')
    expect(c.args.join(' ')).toContain('display notification')
  })

  it('uses notify-send on linux', () => {
    const c = notifyCommand('linux', 'T', 'B')!
    expect(c.cmd).toBe('notify-send')
    expect(c.args).toContain('T')
  })

  it('uses powershell on win32', () => {
    const c = notifyCommand('win32', 'T', 'B')!
    expect(c.cmd).toBe('powershell')
  })

  it('returns null for an unsupported platform', () => {
    expect(notifyCommand('aix' as NodeJS.Platform, 'T', 'B')).toBeNull()
  })

  it('escapes double quotes so a message cannot break out of the script', () => {
    const c = notifyCommand('darwin', 'T', 'Allow "rm -rf"?')!
    expect(c.args.join(' ')).not.toMatch(/[^\\]"rm/)
  })

  it('round-trips a quote/subexpression/semicolon payload through AppleScript escaping (regression)', () => {
    const c = notifyCommand('darwin', NASTY, NASTY)!
    const script = c.args[1]

    const bodyOpenIdx = script.indexOf('"')
    const body = asDecodeDoubleQuoted(script, bodyOpenIdx)
    expect(body.value).toBe(NASTY)

    const rest = script.slice(body.endIdx + 1)
    const marker = ' with title "'
    expect(rest.startsWith(marker)).toBe(true)
    const titleOpenIdx = body.endIdx + 1 + marker.length - 1
    const title = asDecodeDoubleQuoted(script, titleOpenIdx)
    expect(title.value).toBe(NASTY)
    // the title's closing quote is the very last character of the script —
    // nothing from the payload survived past it to append AppleScript code.
    expect(title.endIdx).toBe(script.length - 1)
  })

  /**
   * Round 2, Finding 3: `escAppleScript` (via `notifyCommand`'s darwin
   * branch) was never exercised against a message containing a raw CR/LF —
   * exactly the payload category focus.ts's HOSTILE constant added in round
   * 1 for the OTHER escapers, but never ported here since packages/engine
   * was out of that task's scope. Doubling backslash/quote alone does not
   * make a line break safe: an AppleScript double-quoted literal cannot
   * contain one, so it would abort the whole `display notification`
   * statement mid-string — a silent no-op under fire-and-forget `osascript`
   * (nothing here checks its exit code), not a crash.
   */
  it('breaks a CR/LF out of the AppleScript literal via `" & return & "` instead of leaving a raw line break inside it', () => {
    const withBreaks = `${NASTY}\r\nStart-Process calc.exe #\\`
    const c = notifyCommand('darwin', withBreaks, withBreaks)!
    const script = c.args[1]

    // The failure mode: a raw CR or LF surviving anywhere in the compiled
    // script. Wherever one landed inside an still-open double-quoted
    // literal, the AppleScript compiler would end the statement right
    // there — everything after it either vanishes or (worse) runs as a
    // second, unintended statement.
    expect(script).not.toMatch(/[\r\n]/)

    // The fix mechanism itself: each line break is expressed as breaking
    // out of the literal, concatenating in the `return` constant, and
    // reopening a fresh literal.
    expect(script.split('" & return & "')).toHaveLength(3) // one break in body, one in title
  })

  it('neutralises a quote/subexpression/semicolon payload on win32 (title and body) — PowerShell', () => {
    const c = notifyCommand('win32', NASTY, NASTY)!
    const script = c.args.join(' ')

    // No interpolated value may sit inside a PowerShell double-quoted
    // string, since PS double-quotes expand $(...) / $var regardless of
    // backslash escaping.
    const openMarker = 'ShowBalloonTip(10000,\''
    const idx = script.indexOf(openMarker)
    expect(idx).toBeGreaterThan(-1)
    const titleOpenIdx = idx + openMarker.length - 1
    const title = psDecodeSingleQuoted(script, titleOpenIdx)
    expect(title.value).toBe(NASTY) // the payload's ' appears doubled and round-trips exactly

    const afterTitle = script.slice(title.endIdx + 1)
    expect(afterTitle.startsWith(",'")).toBe(true) // dangerous text stayed inside the single-quoted region
    const bodyOpenIdx = title.endIdx + 2
    const body = psDecodeSingleQuoted(script, bodyOpenIdx)
    expect(body.value).toBe(NASTY)

    // What follows the body's closing quote is the fixed template literal,
    // not attacker-controlled text — i.e. control never left the string.
    const afterBody = script.slice(body.endIdx + 1)
    expect(afterBody.startsWith(",'Info');Start-Sleep")).toBe(true)
  })
})

describe('soundCommand', () => {
  it('uses afplay on darwin', () => {
    expect(soundCommand('darwin', '/s/a.aiff')!.cmd).toBe('afplay')
  })
  it('uses paplay on linux', () => {
    expect(soundCommand('linux', '/s/a.aiff')!.cmd).toBe('paplay')
  })
  it('uses powershell on win32', () => {
    expect(soundCommand('win32', 'C:\\s\\a.wav')!.cmd).toBe('powershell')
  })

  it('neutralises a single-quote in a win32 file path — PowerShell', () => {
    const file = "C:\\Users\\o'brien\\nudge\\assets\\blocked.wav"
    const c = soundCommand('win32', file)!
    const script = c.args.join(' ')

    const openMarker = "SoundPlayer '"
    const idx = script.indexOf(openMarker)
    expect(idx).toBeGreaterThan(-1)
    const fileOpenIdx = idx + openMarker.length - 1
    const decoded = psDecodeSingleQuoted(script, fileOpenIdx)
    expect(decoded.value).toBe(file) // the path's ' round-trips exactly

    const rest = script.slice(decoded.endIdx + 1)
    expect(rest.startsWith(").PlaySync()")).toBe(true) // nothing escaped into a new statement
  })
})

describe('DesktopNotifier', () => {
  const spy = () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    return { spawner: { run: (cmd: string, args: string[]) => calls.push({ cmd, args }) }, calls }
  }

  it('shows the full message on the desktop — detail never leaves the machine here', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session(), 'blocked')
    const joined = calls.map(c => c.args.join(' ')).join(' ')
    expect(joined).toContain('Sales-Dashboard')
    expect(joined).toContain('Allow Bash(ls)?')
  })

  it('plays a sound for a tier that has one', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session(), 'blocked')
    expect(calls.some(c => c.cmd === 'afplay')).toBe(true)
  })

  it('stays silent for idle-short', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session({ tier: 'idle-short' }), 'idle-short')
    expect(calls.some(c => c.cmd === 'afplay')).toBe(false)
    expect(calls.some(c => c.cmd === 'osascript')).toBe(true)
  })

  it('falls back to the tier description when there is no message', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin')
      .alert(session({ message: null, tier: 'idle-long' }), 'idle-long')
    expect(calls.map(c => c.args.join(' ')).join(' ')).toContain('finished')
  })

  it('falls back to the tier description when the message is an empty string', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin')
      .alert(session({ message: '', tier: 'idle-long' }), 'idle-long')
    expect(calls.map(c => c.args.join(' ')).join(' ')).toContain('finished')
  })

  it('honours a custom sound path', () => {
    const cfg = mergeConfig({ tiers: { blocked: { sound: '/custom/ping.aiff' } } })
    const { spawner, calls } = spy()
    new DesktopNotifier(cfg as NudgeConfig, spawner, 'darwin').alert(session(), 'blocked')
    expect(calls.find(c => c.cmd === 'afplay')!.args[0]).toBe('/custom/ping.aiff')
  })

  it('does nothing on an unsupported platform rather than throwing', () => {
    const { spawner, calls } = spy()
    expect(() => new DesktopNotifier(DEFAULT_CONFIG, spawner, 'aix' as NodeJS.Platform)
      .alert(session(), 'blocked')).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})

/**
 * Round 2, Finding 1: `alert()` used to be the ONLY way to reach either the
 * banner or the sound, so `Engine#onLocal`'s round-1 fix (skip the whole
 * call while a GUI is connected) silently took the sound — and the
 * escalation ladder's repeat pings, since those are just more calls to the
 * same `onLocal` — down with the banner it meant to suppress. `alertSound()`
 * is the seam that lets the engine keep the sound (and repeats) alive while
 * dropping only the banner. Proven here independently of Engine: each half
 * can fire without the other.
 */
describe('DesktopNotifier: banner and sound are independently triggerable', () => {
  const spy = () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    return { spawner: { run: (cmd: string, args: string[]) => calls.push({ cmd, args }) }, calls }
  }

  it('alertSound() plays the configured sound WITHOUT spawning a banner', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alertSound('blocked')
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('afplay')
    expect(calls.some(c => c.cmd === 'osascript')).toBe(false)
  })

  it('alertSound() honours a per-tier sound: null — still no sound, and still no banner', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alertSound('idle-short') // DEFAULT_CONFIG: idle-short.sound === null
    expect(calls).toHaveLength(0)
  })

  it('alertSound() honours a configured custom .wav path, same as alert() does', () => {
    const cfg = mergeConfig({ tiers: { blocked: { sound: '/custom/ping.aiff' } } })
    const { spawner, calls } = spy()
    new DesktopNotifier(cfg as NudgeConfig, spawner, 'darwin').alertSound('blocked')
    expect(calls).toEqual([{ cmd: 'afplay', args: ['/custom/ping.aiff'] }])
  })

  it('alert() still fires both banner and sound together — alertSound() is additive, not a replacement', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session(), 'blocked')
    expect(calls.some(c => c.cmd === 'osascript')).toBe(true)
    expect(calls.some(c => c.cmd === 'afplay')).toBe(true)
  })
})
