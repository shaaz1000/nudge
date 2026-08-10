import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export function nudgeHome(): string {
  return process.env.NUDGE_HOME ?? join(homedir(), '.nudge')
}

export function configPath(): string { return join(nudgeHome(), 'config.json') }
export function spoolDir(): string { return join(nudgeHome(), 'spool') }
export function dbPath(): string { return join(nudgeHome(), 'nudge.db') }
export function channelsDir(): string { return join(nudgeHome(), 'channels') }

export function socketPath(): string {
  if (process.platform === 'win32') {
    // Named pipes are per-user by default; scope by username to avoid collisions.
    return `\\\\.\\pipe\\nudge-${userInfo().username}`
  }
  return join(nudgeHome(), 'engine.sock')
}

/** Claude Code honours CLAUDE_CONFIG_DIR; fall back to ~/.claude. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'settings.json')
}
