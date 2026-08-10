import { describe, it, expect, vi } from 'vitest'
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
