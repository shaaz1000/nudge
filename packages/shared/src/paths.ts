import { homedir, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

export function nudgeHome(): string {
  return process.env.NUDGE_HOME ?? join(homedir(), '.nudge')
}

export function configPath(): string { return join(nudgeHome(), 'config.json') }
export function spoolDir(): string { return join(nudgeHome(), 'spool') }
export function dbPath(): string { return join(nudgeHome(), 'nudge.db') }
export function channelsDir(): string { return join(nudgeHome(), 'channels') }

/**
 * Named pipes on Windows are a flat, per-machine namespace with no
 * relationship to the filesystem, so — unlike a Unix socket — they can't be
 * scoped by directory. Left keyed only on the OS username, an explicit
 * NUDGE_HOME would silently do nothing on Windows: every engine and every
 * hook on the box would agree on the same one pipe no matter which home each
 * was pointed at, defeating the isolation NUDGE_HOME exists to provide
 * (concurrent test runs, more than one install). When NUDGE_HOME is
 * explicitly set, derive a stable, unique pipe name from its resolved path
 * instead: the same home always yields the same pipe, and different homes
 * always yield different ones. Leaving NUDGE_HOME unset keeps production
 * behaviour exactly as it was — one pipe per OS user.
 *
 * `platform` defaults to `process.platform` and exists so tests can exercise
 * the win32 branch on any host without actually running on Windows.
 */
export function socketPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const home = process.env.NUDGE_HOME
    if (home) {
      const hash = createHash('sha1').update(resolve(home)).digest('hex').slice(0, 16)
      return `\\\\.\\pipe\\nudge-${hash}`
    }
    return `\\\\.\\pipe\\nudge-${userInfo().username}`
  }
  return join(nudgeHome(), 'engine.sock')
}

/** Claude Code honours CLAUDE_CONFIG_DIR; fall back to ~/.claude. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'settings.json')
}
