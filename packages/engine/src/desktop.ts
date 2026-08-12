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

/**
 * AppleScript string literal: backslash first, then double quote, then a
 * raw CR/LF broken out of the literal via `" & return & "` (round 2,
 * Finding 3). Doubling backslash/quote alone is not enough — an
 * AppleScript double-quoted literal cannot contain a raw line break, so a
 * `hook`-supplied `s.message` containing one (e.g. a multi-line command
 * output) would otherwise abort compilation mid-string under this
 * fire-and-forget `osascript` call: a silent no-op, not a crash, since
 * nothing here observes the exit code. `" & return & "` closes the
 * literal, concatenates in AppleScript's own newline constant, and reopens
 * a fresh literal — valid wherever the original literal was, since `&` is
 * ordinary string concatenation.
 */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '" & return & "')
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
    this.#banner(s, tier)
    this.alertSound(tier)
  }

  #banner(s: SessionState, tier: Tier): void {
    const title = `${s.project} needs you`
    const body = s.message || TIER_TEXT[tier]
    const n = notifyCommand(this.platform, title, body)
    if (n) this.spawner.run(n.cmd, n.args)
  }

  /**
   * Round 2, Finding 1: split out of `alert()` so `Engine#onLocal` can play
   * just the configured per-tier sound (honouring an explicit `sound: null`
   * — see `@nudge/shared/config`'s DEFAULT_CONFIG, e.g. `idle-short`) while a
   * GUI client's own clickable banner is the one actually shown on screen.
   * The tray's own `Notifier` (packages/tray/src/notify.ts) always builds
   * with `silent: true` and has no `NudgeConfig` of its own, so it cannot
   * reproduce this — this is the only call that can, and it is also what
   * keeps the escalation ladder's repeat pings (escalation.ts's
   * `localRepeat`) audible instead of going fully silent while a GUI is
   * connected.
   */
  alertSound(tier: Tier): void {
    const configured = this.cfg.tiers[tier].sound
    if (!configured) return
    const file = configured.includes('/') || configured.includes('\\')
      ? configured
      : join(ASSETS, `${configured}.wav`)
    const snd = soundCommand(this.platform, file)
    if (snd) this.spawner.run(snd.cmd, snd.args)
  }
}
