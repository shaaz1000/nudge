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
})
