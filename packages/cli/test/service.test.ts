import { describe, it, expect } from 'vitest'
import { serviceUnit } from '../src/service.js'

describe('serviceUnit', () => {
  it('produces a launchd plist on darwin with KeepAlive', () => {
    const u = serviceUnit('darwin', '/usr/bin/node', '/opt/nudge/engine/bin.js')!
    expect(u.path).toMatch(/Library\/LaunchAgents\/com\.nudge\.engine\.plist$/)
    expect(u.contents).toContain('<key>KeepAlive</key>')
    expect(u.contents).toContain('/opt/nudge/engine/bin.js')
    expect(u.installCmd[0]).toBe('launchctl')
  })

  it('produces a systemd user unit on linux with Restart=always', () => {
    const u = serviceUnit('linux', '/usr/bin/node', '/opt/nudge/engine/bin.js')!
    expect(u.path).toMatch(/systemd\/user\/nudge-engine\.service$/)
    expect(u.contents).toContain('Restart=always')
    expect(u.installCmd[0]).toBe('systemctl')
  })

  it('produces a schtasks invocation on win32 that runs at logon', () => {
    const u = serviceUnit('win32', 'C:\\node.exe', 'C:\\nudge\\bin.js')!
    expect(u.installCmd[0]).toBe('schtasks')
    expect(u.installCmd.join(' ')).toContain('ONLOGON')
  })

  it('returns null on an unsupported platform', () => {
    expect(serviceUnit('aix' as NodeJS.Platform, '/n', '/s')).toBeNull()
  })

  /**
   * Finding I6: `nudge uninstall` removed the Nudge hooks from Claude Code's
   * settings.json but left the LaunchAgent/systemd unit/Scheduled Task that
   * `setup` registered fully in place, so the engine kept auto-starting on
   * every login regardless — a supposedly-uninstalled tool that reappears on
   * next boot. `serviceUnit` now also describes how to reverse `installCmd`,
   * so `nudge uninstall` has something concrete to run.
   */
  describe('uninstallCmd', () => {
    it('darwin: bootout mirrors bootstrap\'s domain-target + path shape', () => {
      const u = serviceUnit('darwin', '/usr/bin/node', '/opt/nudge/engine/bin.js')!
      expect(u.uninstallCmd[0]).toBe('launchctl')
      expect(u.uninstallCmd).toContain('bootout')
      expect(u.uninstallCmd).toContain(u.path)
      // installCmd's own domain-target argument (gui/<uid>) is reused verbatim.
      expect(u.uninstallCmd).toContain(u.installCmd[2])
    })

    it('linux: disables and stops the unit in one call', () => {
      const u = serviceUnit('linux', '/usr/bin/node', '/opt/nudge/engine/bin.js')!
      expect(u.uninstallCmd[0]).toBe('systemctl')
      expect(u.uninstallCmd).toContain('--user')
      expect(u.uninstallCmd).toContain('disable')
      expect(u.uninstallCmd).toContain('--now')
      expect(u.uninstallCmd).toContain('nudge-engine.service')
    })

    it('win32: deletes the scheduled task without a confirmation prompt', () => {
      const u = serviceUnit('win32', 'C:\\node.exe', 'C:\\nudge\\bin.js')!
      expect(u.uninstallCmd[0]).toBe('schtasks')
      expect(u.uninstallCmd).toContain('/Delete')
      expect(u.uninstallCmd).toContain('NudgeEngine')
      expect(u.uninstallCmd).toContain('/F')
    })
  })
})
