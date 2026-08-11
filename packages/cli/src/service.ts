import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ServiceUnit {
  path: string
  contents: string
  installCmd: string[]
  /**
   * Finding I6: `nudge uninstall` used to remove only the Claude Code hooks,
   * leaving the LaunchAgent/systemd unit/Scheduled Task that `setup`
   * registered fully in place — so the engine kept auto-starting on every
   * login regardless of "uninstall". This is `installCmd`'s inverse: enough
   * to unregister the service. The caller (bin.ts) is still responsible for
   * deleting the unit file at `path`, the same way it already writes it.
   */
  uninstallCmd: string[]
}

export function serviceUnit(
  platform: NodeJS.Platform, execPath: string, scriptPath: string,
): ServiceUnit | null {
  switch (platform) {
    case 'darwin': {
      const path = join(homedir(), 'Library', 'LaunchAgents', 'com.nudge.engine.plist')
      return {
        path,
        contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nudge.engine</string>
  <key>ProgramArguments</key>
  <array><string>${execPath}</string><string>${scriptPath}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
        installCmd: ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, path],
        // Mirrors bootstrap's own domain-target + path shape (bootout accepts
        // the same two argument forms bootstrap does).
        uninstallCmd: ['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}`, path],
      }
    }

    case 'linux': {
      const path = join(homedir(), '.config', 'systemd', 'user', 'nudge-engine.service')
      return {
        path,
        contents: `[Unit]
Description=Nudge engine

[Service]
ExecStart=${execPath} ${scriptPath}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
        installCmd: ['systemctl', '--user', 'enable', '--now', 'nudge-engine.service'],
        uninstallCmd: ['systemctl', '--user', 'disable', '--now', 'nudge-engine.service'],
      }
    }

    case 'win32':
      return {
        path: '',
        contents: '',
        installCmd: [
          'schtasks', '/Create', '/F', '/TN', 'NudgeEngine',
          '/SC', 'ONLOGON', '/TR', `"${execPath}" "${scriptPath}"`,
        ],
        uninstallCmd: ['schtasks', '/Delete', '/TN', 'NudgeEngine', '/F'],
      }

    default:
      return null
  }
}
