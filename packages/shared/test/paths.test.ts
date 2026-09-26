import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { nudgeHome, socketPath, configPath, spoolDir, dbPath, lockPath, socketAddress } from '../src/paths.js'

describe('paths', () => {
  const original = process.env.NUDGE_HOME
  beforeEach(() => { process.env.NUDGE_HOME = '/tmp/nudge-test-home' })
  afterEach(() => {
    if (original === undefined) delete process.env.NUDGE_HOME
    else process.env.NUDGE_HOME = original
  })

  it('honours NUDGE_HOME for every derived path', () => {
    expect(nudgeHome()).toBe('/tmp/nudge-test-home')
    expect(configPath()).toBe(join('/tmp/nudge-test-home', 'config.json'))
    expect(spoolDir()).toBe(join('/tmp/nudge-test-home', 'spool'))
    expect(dbPath()).toBe(join('/tmp/nudge-test-home', 'nudge.db'))
    expect(lockPath()).toBe(join('/tmp/nudge-test-home', 'engine.lock'))
  })

  it('produces a platform-appropriate socket path', () => {
    const p = socketPath()
    if (process.platform === 'win32') expect(p).toMatch(/^\\\\[.]\\pipe\\nudge-/)
    else expect(p).toBe(join('/tmp/nudge-test-home', 'engine.sock'))
  })

  /**
   * Small fix from the review triage: `nudgeHome()` used to read
   * `process.env.NUDGE_HOME ?? join(homedir(), '.nudge')`. An explicitly-set
   * but empty NUDGE_HOME (`NUDGE_HOME=`) is neither null nor undefined, so
   * `??` did not fall back — every derived path silently resolved relative
   * to the current working directory instead of the intended default. A
   * launchd daemon's cwd is `/`, so this pointed the engine at `/nudge.db`
   * rather than `~/.nudge/nudge.db`.
   */
  it('falls back to the default home when NUDGE_HOME is set but empty', () => {
    process.env.NUDGE_HOME = ''
    expect(nudgeHome()).toBe(join(homedir(), '.nudge'))
    expect(configPath()).toBe(join(homedir(), '.nudge', 'config.json'))
  })
})

/**
 * socketPath() takes an optional platform override precisely so this branch
 * is testable without actually running on Windows — real coverage of the
 * literal named-pipe path lives in the windows-latest CI leg; the branch
 * logic itself (does NUDGE_HOME actually change the pipe name, the way it
 * already changes the Unix socket path?) is verified here on every platform
 * this suite runs on.
 */
describe('socketPath on an injected win32 platform', () => {
  const original = process.env.NUDGE_HOME
  afterEach(() => {
    if (original === undefined) delete process.env.NUDGE_HOME
    else process.env.NUDGE_HOME = original
  })

  it('derives a distinct pipe name for each distinct NUDGE_HOME', () => {
    process.env.NUDGE_HOME = '/tmp/nudge-home-a'
    const a = socketPath('win32')
    process.env.NUDGE_HOME = '/tmp/nudge-home-b'
    const b = socketPath('win32')
    expect(a).toMatch(/^\\\\[.]\\pipe\\nudge-[0-9a-f]{16}$/)
    expect(b).toMatch(/^\\\\[.]\\pipe\\nudge-[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })

  it('resolves the same NUDGE_HOME to the same pipe name every time', () => {
    process.env.NUDGE_HOME = '/tmp/nudge-home-a'
    expect(socketPath('win32')).toBe(socketPath('win32'))
  })

  it('falls back to the per-user default when NUDGE_HOME is unset', () => {
    delete process.env.NUDGE_HOME
    expect(socketPath('win32')).toBe(`\\\\.\\pipe\\nudge-${userInfo().username}`)
  })
})

describe('socketAddress: a socket address is not a file path on Windows', () => {
  it('is a file inside the directory on posix', () => {
    expect(socketAddress('/tmp/x', 'engine.sock', 'darwin')).toBe('/tmp/x/engine.sock')
    expect(socketAddress('/tmp/x', 'engine.sock', 'linux')).toBe('/tmp/x/engine.sock')
  })

  it('is a named pipe on win32, never a path', () => {
    // Thirteen test files failed on Windows with EACCES because they built
    // join(tmpdir, 'engine.sock') and called listen() on it. Windows cannot
    // listen on a filesystem path; `\\.\pipe\<name>` is the only valid form.
    const a = socketAddress('C:\\Temp\\x', 'engine.sock', 'win32')
    expect(a.startsWith('\\\\.\\pipe\\')).toBe(true)
    expect(a).not.toContain('engine.sock')
  })

  it('gives different pipes to different names in the same directory', () => {
    const one = socketAddress('C:\\Temp\\x', 'a.sock', 'win32')
    const two = socketAddress('C:\\Temp\\x', 'b.sock', 'win32')
    expect(one).not.toBe(two)
  })

  it('gives different pipes to the same name in different directories', () => {
    const one = socketAddress('C:\\Temp\\one', 'engine.sock', 'win32')
    const two = socketAddress('C:\\Temp\\two', 'engine.sock', 'win32')
    expect(one).not.toBe(two)
  })

  it('is stable for the same inputs', () => {
    expect(socketAddress('C:\\Temp\\x', 'e.sock', 'win32'))
      .toBe(socketAddress('C:\\Temp\\x', 'e.sock', 'win32'))
  })
})
