import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ServiceUnit {
  path: string
  contents: string
  installCmd: string[]
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
      }

    default:
      return null
  }
}
