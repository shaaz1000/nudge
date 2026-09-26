import { homedir, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

export function nudgeHome(): string {
  // `||`, not `??`: an explicitly-set but empty NUDGE_HOME (e.g. a shell
  // wrapper that exports `NUDGE_HOME=` with nothing after the `=`) must fall
  // back to the default too. With `??`, '' is neither null nor undefined, so
  // every derived path (configPath, dbPath, socketPath, ...) would resolve
  // relative to the current working directory instead — and a launchd
  // daemon's cwd is `/`, so this silently pointed the engine at `/nudge.db`,
  // `/config.json`, etc. on the one platform (macOS + launchd) Nudge ships a
  // service unit for.
  return process.env.NUDGE_HOME || join(homedir(), '.nudge')
}

export function configPath(): string { return join(nudgeHome(), 'config.json') }
export function spoolDir(): string { return join(nudgeHome(), 'spool') }
export function dbPath(): string { return join(nudgeHome(), 'nudge.db') }
export function channelsDir(): string { return join(nudgeHome(), 'channels') }
/** Single-instance guard (finding C2) — see packages/engine/src/lock.ts. */
export function lockPath(): string { return join(nudgeHome(), 'engine.lock') }

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
/**
 * The listen/connect address for an arbitrary socket, derived from a directory
 * and a name.
 *
 * This exists because a socket address is NOT a file path on Windows. POSIX
 * uses a unix-domain socket, which really is a file inside a directory;
 * Windows uses a named pipe, where `\\.\pipe\<name>` is the only valid form
 * and `listen()` on a filesystem path fails with EACCES.
 *
 * `socketPath()` below handles the one real engine socket. This handles every
 * other case, which in practice means tests that need several independent
 * sockets: they used to build `join(tmpdir, 'engine.sock')` by hand, which is
 * correct on macOS and Linux and unusable on Windows, so thirteen test files
 * failed there for a reason that had nothing to do with the code under test.
 *
 * The name is hashed together with the directory so two tests using the same
 * name in different temp directories still get distinct pipes.
 */
export function socketAddress(
  dir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const hash = createHash('sha1').update(`${resolve(dir)}\0${name}`).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\nudge-${hash}`
  }
  return join(dir, name)
}

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
