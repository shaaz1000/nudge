import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

export interface Spawner { run(cmd: string, args: string[]): void }

const TIER_TEXT: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

const ASSETS = join(import.meta.dirname, '..', 'assets')

const realSpawner: Spawner = {
  run(cmd, args) {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
      p.on('error', () => {})   // a missing notify-send must never crash the engine
      p.unref()
    } catch { /* ignore */ }
  },
}

/** AppleScript string literal: backslash first, then double quote. */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * PowerShell SINGLE-quoted string literal. Single quotes suppress both
 * $(...) subexpression expansion and $variable interpolation, and backslash
 * is not an escape character, so doubling the quote is the whole contract.
 */
function escPowerShell(s: string): string {
  return s.replace(/'/g, "''")
}

export function notifyCommand(
  platform: NodeJS.Platform, title: string, body: string,
): { cmd: string; args: string[] } | null {
  switch (platform) {
    case 'darwin':
      return {
        cmd: 'osascript',
        args: ['-e', `display notification "${escAppleScript(body)}" with title "${escAppleScript(title)}"`],
      }
    case 'linux':
      return { cmd: 'notify-send', args: ['-a', 'Nudge', title, body] }
    case 'win32':
      return {
        cmd: 'powershell',
        args: ['-NoProfile', '-Command',
          `[reflection.assembly]::LoadWithPartialName('System.Windows.Forms')>$null;` +
          `$n=New-Object System.Windows.Forms.NotifyIcon;` +
          `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
          `$n.ShowBalloonTip(10000,'${escPowerShell(title)}','${escPowerShell(body)}','Info');Start-Sleep -s 6`],
      }
    default:
      return null
  }
}

export function soundCommand(
  platform: NodeJS.Platform, file: string,
): { cmd: string; args: string[] } | null {
  switch (platform) {
    case 'darwin': return { cmd: 'afplay', args: [file] }
    case 'linux':  return { cmd: 'paplay', args: [file] }
    case 'win32':  return {
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${escPowerShell(file)}').PlaySync()`],
    }
    default: return null
  }
}

/**
 * Phase 1 notifications are fire-and-forget platform CLIs, so there is no
 * click-to-jump. That arrives with the Electron shell in Phase 2.
 */
export class DesktopNotifier {
  constructor(
    private cfg: NudgeConfig,
    private spawner: Spawner = realSpawner,
    private platform: NodeJS.Platform = process.platform,
  ) {}

  alert(s: SessionState, tier: Tier): void {
    const title = `${s.project} needs you`
    const body = s.message || TIER_TEXT[tier]

    const n = notifyCommand(this.platform, title, body)
    if (n) this.spawner.run(n.cmd, n.args)

    const configured = this.cfg.tiers[tier].sound
    if (!configured) return
    const file = configured.includes('/') || configured.includes('\\')
      ? configured
      : join(ASSETS, `${configured}.wav`)
    const snd = soundCommand(this.platform, file)
    if (snd) this.spawner.run(snd.cmd, snd.args)
  }
}
